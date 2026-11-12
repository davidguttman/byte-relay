'use strict'

const { performance } = require('node:perf_hooks')
const { encodeData } = require('./ssestream')

const messages = {
  400: 'Bad request', 404: 'Not found', 405: 'Method not allowed',
  408: 'Request timeout', 413: 'Payload too large', 415: 'Unsupported content encoding',
  429: 'Rate or capacity limit exceeded', 500: 'Internal server error', 503: 'Service unavailable'
}
function reject (res, status) {
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) { res.destroy(); return }
  res.statusCode = status
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Connection', 'close')
  if (status === 429) res.setHeader('Retry-After', '1')
  res.end(messages[status] || messages[500])
}

function createRelay (config, clock = {}) {
  const now = clock.now || (() => performance.now())
  const channels = new Map()
  const sources = new Map()
  const rates = new Map()
  const connections = new Set()
  const requests = new Set()
  let closed = false
  function bucket (capacity) { return { capacity, tokens: capacity, at: now() } }
  const globalRate = bucket(config.GLOBAL_REQUESTS_PER_SECOND)
  const ingress = bucket(config.GLOBAL_BODY_BYTES_PER_SECOND)
  const egress = bucket(config.GLOBAL_FANOUT_BYTES_PER_SECOND)
  function take (b, amount) {
    const time = now()
    b.tokens = Math.min(b.capacity, b.tokens + Math.max(0, time - b.at) * b.capacity / 1000)
    b.at = time
    if (amount > b.tokens) return false
    b.tokens -= amount
    return true
  }
  function pruneRates () {
    for (const [source, b] of rates) if (now() - b.at >= 1000) rates.delete(source)
  }
  function sourceOf (req) { return req.socket.remoteAddress || 'unknown' }
  function sourceState (source) {
    if (!sources.has(source)) sources.set(source, { connections: 0, requests: 0 })
    return sources.get(source)
  }
  function pruneSource (source, state) { if (!state.connections && !state.requests) sources.delete(source) }

  function admit (req, res) {
    if (closed) { reject(res, 503); return false }
    if (!take(globalRate, 1)) { reject(res, 429); return false }
    const source = sourceOf(req)
    if (!rates.has(source)) {
      if (rates.size >= config.MAX_RATE_SOURCES) pruneRates()
      if (rates.size >= config.MAX_RATE_SOURCES) { reject(res, 429); return false }
      rates.set(source, bucket(config.REQUESTS_PER_SOURCE_PER_SECOND))
    }
    if (!take(rates.get(source), 1)) { reject(res, 429); return false }
    const state = sources.get(source)
    if (requests.size >= config.MAX_REQUESTS || (state && state.requests >= config.MAX_REQUESTS_PER_SOURCE)) {
      reject(res, 429); return false
    }
    const current = sourceState(source)
    current.requests++
    const ticket = { started: now(), res, release }
    requests.add(ticket)
    function release () {
      if (!requests.delete(ticket)) return
      current.requests--
      pruneSource(source, current)
      req.off('aborted', release); req.off('error', release); req.off('close', requestClosed)
      res.off('close', release); res.off('finish', release); res.off('error', release)
    }
    function requestClosed () { if (!req.complete) { release(); if (!res.destroyed) res.destroy() } }
    req.once('aborted', release); req.once('error', release); req.once('close', requestClosed)
    res.once('close', release); res.once('finish', release); res.once('error', release)
    req.releaseAdmission = release
    return true
  }

  function subscribe (req, res) {
    if (closed) { reject(res, 503); return }
    const key = req.params.key
    const source = sourceOf(req)
    const state = sources.get(source)
    if (connections.size >= config.MAX_CONNECTIONS ||
      (state && state.connections >= config.MAX_CONNECTIONS_PER_SOURCE) ||
      (channels.get(key)?.size || 0) >= config.MAX_CONNECTIONS_PER_CHANNEL) {
      reject(res, 429); return
    }
    const current = sourceState(source)
    current.connections++
    let backpressured = false
    const client = { req, res, started: now(), heartbeat: now(), cleanup, send }
    connections.add(client)
    if (!channels.has(key)) channels.set(key, new Set())
    channels.get(key).add(client)
    function cleanup () {
      if (!connections.delete(client)) return
      const members = channels.get(key)
      members.delete(client)
      if (!members.size) channels.delete(key)
      current.connections--
      pruneSource(source, current)
      req.off('aborted', disconnect); req.off('error', disconnect); req.off('close', requestClosed)
      res.off('close', disconnect); res.off('error', disconnect); res.off('finish', disconnect)
      res.off('drain', drained)
    }
    function disconnect () { cleanup(); if (!res.destroyed) res.destroy() }
    function drained () { backpressured = false }
    function send (frame, bytes = Buffer.byteLength(frame)) {
      if (!connections.has(client)) return
      // A false write already accepted this frame; auto-corking can produce it
      // even for healthy readers. Let Node drain that one bounded backlog, but
      // disconnect on another send while blocked instead of queueing more data.
      if (res.destroyed || res.writableEnded || backpressured ||
        res.writableLength + bytes > config.MAX_BACKLOG_BYTES) { disconnect(); return }
      try { backpressured = !res.write(frame) } catch { disconnect() }
    }
    function requestClosed () { if (!req.complete) disconnect() }
    req.once('aborted', disconnect); req.once('error', disconnect); req.once('close', requestClosed)
    res.once('close', disconnect); res.once('error', disconnect); res.once('finish', disconnect)
    res.on('drain', drained)
    req.releaseAdmission?.()
    try {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      res.flushHeaders()
      send(':ok\n\n')
    } catch { disconnect() }
  }

  function publish (key, body) {
    if (closed) return 503
    if (body.length > config.MAX_BODY_BYTES) return 413
    const members = channels.get(key)
    if (!members?.size) return 201
    const frame = encodeData(body) // Once, not once per subscriber.
    const bytes = Buffer.byteLength(frame)
    if (!take(egress, bytes * members.size)) return 429
    for (const client of members) client.send(frame, bytes)
    return 201
  }

  const interval = (clock.setInterval || setInterval)(() => {
    pruneRates()
    const time = now()
    for (const ticket of requests) {
      if (time - ticket.started >= config.BODY_TIMEOUT_MS) { reject(ticket.res, 408); ticket.release() }
    }
    for (const client of connections) {
      if (time - client.started >= config.MAX_CONNECTION_MS) {
        client.cleanup(); client.res.destroy()
      } else if (time - client.heartbeat >= config.HEARTBEAT_MS) {
        client.heartbeat = time
        if (take(egress, 12)) client.send(':heartbeat\n\n', 12)
      }
    }
  }, Math.min(1000, config.HEARTBEAT_MS, config.MAX_CONNECTION_MS, config.BODY_TIMEOUT_MS))
  interval.unref?.()

  return {
    admit, subscribe, publish,
    consumeBytes: bytes => take(ingress, bytes),
    stats: () => ({ connections: connections.size, channels: channels.size, sources: sources.size, requests: requests.size, rateSources: rates.size }),
    close () {
      closed = true
      ;(clock.clearInterval || clearInterval)(interval)
      for (const client of connections) { client.cleanup(); client.res.destroy() }
      for (const ticket of requests) { reject(ticket.res, 503); ticket.release() }
      rates.clear()
    }
  }
}
module.exports = { createRelay, reject }
