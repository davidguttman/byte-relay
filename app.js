'use strict'

const express = require('express')
const { loadConfig } = require('./config')
const { createRelay, reject } = require('./events')

function readBody (req, res, relay, config) {
  let chunks = []
  let size = 0
  let done = false
  function cleanup () {
    if (done) return
    done = true
    chunks = []
    req.off('data', onData); req.off('end', onEnd); req.off('aborted', onAbort); req.off('error', onAbort); req.off('close', onClose)
    res.off('close', onAbort); res.off('finish', onAbort); res.off('error', onAbort)
  }
  function fail (status) { cleanup(); req.pause(); reject(res, status) }
  function onAbort () {
    cleanup()
    req.pause()
    if (!res.destroyed && !res.writableEnded) res.destroy()
  }
  function onClose () { if (!req.complete) onAbort() }
  function onData (chunk) {
    size += chunk.length
    if (size > config.MAX_BODY_BYTES) { fail(413); return }
    if (!relay.consumeBytes(chunk.length)) { fail(429); return }
    chunks.push(chunk)
  }
  function onEnd () {
    if (done) return
    try {
      const body = Buffer.concat(chunks, size)
      cleanup()
      const status = relay.publish(req.params.key, body)
      if (status !== 201) { reject(res, status); return }
      res.statusCode = 201
      res.end()
    } catch {
      cleanup()
      reject(res, 500)
    }
  }
  req.on('data', onData); req.once('end', onEnd); req.once('aborted', onAbort); req.once('error', onAbort); req.once('close', onClose)
  res.once('close', onAbort); res.once('finish', onAbort); res.once('error', onAbort)
}

function createApp ({ env = process.env, clock } = {}) {
  const config = loadConfig(env)
  const app = express()
  const relay = createRelay(config, clock)
  app.locals.relay = relay
  app.locals.config = config
  app.disable('x-powered-by')
  app.disable('etag')
  app.set('query parser', false)
  app.set('trust proxy', false)
  app.enable('case sensitive routing')
  app.enable('strict routing')
  app.use((req, res, next) => {
    // Open anonymous relay by design. Do not enable credentialed CORS.
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'no-store')
    if (req.path === '/health') {
      if (req.method !== 'GET') { reject(res, 405); return }
      res.json({ status: 'ok' }); return
    }
    // Bounds apply even to malformed paths, unsupported methods and preflights.
    if (!relay.admit(req, res)) return
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.statusCode = 204; res.end(); return
    }
    if (req.method !== 'GET' && req.method !== 'POST') { reject(res, 405); return }
    next()
  })
  app.param('key', (req, res, next, key) => {
    if (!key || Buffer.byteLength(key) > config.MAX_KEY_BYTES || /[\u0000-\u001f\u007f-\u009f]/u.test(key)) {
      reject(res, 400); return
    }
    next()
  })
  app.get('/:key', relay.subscribe)
  app.post('/:key', (req, res) => {
    if (req.headers['content-encoding'] && req.headers['content-encoding'].toLowerCase() !== 'identity') {
      reject(res, 415); return
    }
    const length = req.headers['content-length']
    if (length !== undefined) {
      if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) { reject(res, 400); return }
      if (Number(length) > config.MAX_BODY_BYTES) { reject(res, 413); return }
    }
    readBody(req, res, relay, config)
  })
  app.use((req, res) => reject(res, 404))
  app.use((error, req, res, next) => {
    reject(res, error instanceof URIError ? 400 : 500)
  })
  return app
}

module.exports = { createApp }
