'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough, Duplex } = require('node:stream')
const { IncomingMessage, ServerResponse } = require('node:http')
const { createRelay } = require('../events')
const { loadConfig } = require('../config')
const { encodeData } = require('../ssestream')

class Response extends EventEmitter {
  constructor () { super(); this.frames = []; this.writableLength = 0; this.headers = {}; this.statusCode = 200 }
  setHeader (name, value) { this.headers[name.toLowerCase()] = value }
  flushHeaders () { this.headersSent = true }
  write (frame) { this.frames.push(frame); return this.writeResult !== false }
  end (body) { this.body = body; this.writableEnded = true; this.emit('finish') }
  destroy () { this.destroyed = true; this.emit('close') }
}
function pair (key = 'ordinary', source = '127.0.0.1') {
  const req = new PassThrough()
  req.params = { key }; req.headers = {}; req.socket = { remoteAddress: source }; req.method = 'GET'
  return { req, res: new Response() }
}
function setup (overrides = {}) {
  let now = 0
  const timers = new Set()
  const config = { ...loadConfig({}), ...overrides }
  const relay = createRelay(config, {
    now: () => now,
    setInterval: fn => { timers.add(fn); return fn },
    clearInterval: fn => timers.delete(fn)
  })
  return { relay, config, timers, advance: ms => { now += ms; for (const fn of [...timers]) fn() } }
}
function subscribe (relay, key, source) { const p = pair(key, source); relay.subscribe(p.req, p.res); return p }

test('real ServerResponse delivers valid large frames after transient auto-cork backpressure', async () => {
  for (const body of [Buffer.alloc(65536, 'a'), Buffer.alloc(9362, '\n')]) {
    const wire = []
    const socket = new Duplex({
      read () {},
      write (chunk, encoding, callback) { wire.push(Buffer.from(chunk)); callback() }
    })
    socket.remoteAddress = '127.0.0.1'
    const req = new IncomingMessage(socket)
    Object.assign(req, {
      method: 'GET', params: { key: 'ordinary' }, complete: true,
      httpVersion: '1.1', httpVersionMajor: 1, httpVersionMinor: 1
    })
    const res = new ServerResponse(req)
    res.assignSocket(socket)
    const { relay } = setup()
    try {
      relay.subscribe(req, res)
      await new Promise(resolve => setImmediate(resolve))
      wire.length = 0
      const frame = encodeData(body)
      assert.ok(Buffer.byteLength(frame) > res.writableHighWaterMark)
      assert.equal(relay.publish('ordinary', body), 201)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(res.destroyed, false)
      assert.equal(relay.stats().connections, 1)
      // Verify the actual HTTP chunk and SSE payload, not merely subscription survival.
      assert.equal(Buffer.concat(wire).toString(), `${Buffer.byteLength(frame).toString(16)}\r\n${frame}\r\n`)
      wire.length = 0
      assert.equal(relay.publish('ordinary', Buffer.from('after drain')), 201)
      await new Promise(resolve => setImmediate(resolve))
      assert.match(Buffer.concat(wire).toString(), /data: after drain\n\n/)
      assert.equal(res.destroyed, false)
    } finally {
      relay.close()
      socket.destroy()
    }
  }
})

test('untrusted reserved names are isolated and never expose channel metadata', () => {
  const { relay } = setup()
  const listeners = ['error', 'newListener', 'removeListener', '__proto__'].map(k => subscribe(relay, k))
  const secret = subscribe(relay, 'private-channel')
  secret.res.emit('close')
  for (const p of listeners) assert.deepEqual(p.res.frames, [':ok\n\n'])
  for (const key of ['error', 'newListener', 'removeListener', '__proto__']) assert.equal(relay.publish(key, Buffer.from('hello')), 201)
  for (const p of listeners) assert.deepEqual(p.res.frames, [':ok\n\n', 'data: hello\n\n'])
  relay.close()
})

test('connection bounds total, per source and per channel; rejected connections do not allocate', () => {
  for (const overrides of [{ MAX_CONNECTIONS: 1 }, { MAX_CONNECTIONS_PER_SOURCE: 1 }, { MAX_CONNECTIONS_PER_CHANNEL: 1 }]) {
    const { relay } = setup(overrides)
    subscribe(relay, 'a')
    const denied = subscribe(relay, 'a')
    assert.equal(denied.res.statusCode, 429)
    assert.equal(relay.stats().connections, 1)
    relay.close()
    assert.deepEqual(relay.stats(), { connections: 0, channels: 0, sources: 0, requests: 0, rateSources: 0 })
  }
})

test('every close, abort, error and lifetime path releases listeners and one shared timer', () => {
  for (const [side, event] of [['res', 'close'], ['res', 'error'], ['req', 'aborted'], ['req', 'error']]) {
    const { relay, timers } = setup()
    const p = subscribe(relay)
    p[side].emit(event)
    assert.equal(relay.stats().connections, 0)
    assert.equal(p.res.listenerCount('close'), 0)
    assert.equal(p.res.listenerCount('drain'), 0)
    assert.equal(p.req.listenerCount('aborted'), 0)
    relay.close(); assert.equal(timers.size, 0)
  }
  const { relay, advance } = setup({ HEARTBEAT_MS: 10, MAX_CONNECTION_MS: 30 })
  const p = subscribe(relay)
  advance(10); assert.equal(p.res.frames.at(-1), ':heartbeat\n\n')
  advance(20); assert.equal(p.res.destroyed, true); assert.equal(relay.stats().connections, 0)
  relay.close()
})

test('backpressure waits for drain with one bounded writable backlog and no application queue', () => {
  const { relay } = setup()
  const p = subscribe(relay)
  p.res.writeResult = false
  relay.publish('ordinary', Buffer.from('hi'))
  assert.equal(p.res.destroyed, undefined)
  assert.equal(relay.stats().connections, 1)
  p.res.writeResult = true
  p.res.emit('drain')
  relay.publish('ordinary', Buffer.from('drained'))
  assert.equal(p.res.frames.at(-1), 'data: drained\n\n')
  p.res.writeResult = false
  relay.publish('ordinary', Buffer.from('blocked'))
  const count = p.res.frames.length
  relay.publish('ordinary', Buffer.from('no extra backlog'))
  assert.equal(p.res.destroyed, true)
  assert.equal(p.res.frames.length, count)
  assert.equal(relay.stats().connections, 0)
  const q = subscribe(relay); q.res.writableLength = 999999999
  relay.publish('ordinary', Buffer.from('hi'))
  assert.equal(q.res.destroyed, true); assert.equal(q.res.frames.length, 1)
  relay.close()
})

test('SSE framing safely encodes newlines, preserves empty messages and limits UTF8 expansion', () => {
  assert.equal(encodeData(Buffer.from('x\r\nevent: bad\r\ny')), 'data: x\ndata: event: bad\ndata: y\n\n')
  assert.equal(encodeData(Buffer.alloc(0)), 'data: \n\n')
  const { relay } = setup({ GLOBAL_FANOUT_BYTES_PER_SECOND: 20 })
  const p = subscribe(relay)
  assert.equal(relay.publish('ordinary', Buffer.from('\n\n\n')), 429)
  assert.equal(p.res.frames.length, 1)
  relay.close()
})

test('fanout accounting multiplies encoded bytes by subscribers and atomic rejection sends nothing', () => {
  const { relay } = setup({ GLOBAL_FANOUT_BYTES_PER_SECOND: 25 })
  const a = subscribe(relay); const b = subscribe(relay, 'ordinary', '127.0.0.2')
  assert.equal(relay.publish('ordinary', Buffer.from('hello')), 429)
  assert.equal(a.res.frames.length, 1); assert.equal(b.res.frames.length, 1)
  relay.close()
})

test('admission rate and tracking maps are bounded, expire, and do not trust XFF', () => {
  const { relay, advance } = setup({ REQUESTS_PER_SOURCE_PER_SECOND: 1, MAX_RATE_SOURCES: 1 })
  const a = pair(); a.req.headers['x-forwarded-for'] = '1.2.3.4'
  assert.equal(relay.admit(a.req, a.res), true)
  const b = pair(); b.req.headers['x-forwarded-for'] = '5.6.7.8'
  assert.equal(relay.admit(b.req, b.res), false); assert.equal(b.res.statusCode, 429)
  const c = pair('a', '127.0.0.2')
  assert.equal(relay.admit(c.req, c.res), false)
  assert.equal(relay.stats().rateSources, 1)
  a.res.end(); advance(2000)
  assert.equal(relay.admit(c.req, c.res), true)
  c.res.end(); relay.close()
})

test('inflight request bounds release on response finish and abort', () => {
  const { relay } = setup({ MAX_REQUESTS: 1 })
  const a = pair(); assert.equal(relay.admit(a.req, a.res), true)
  const b = pair(); assert.equal(relay.admit(b.req, b.res), false)
  a.req.emit('aborted'); assert.equal(relay.stats().requests, 0)
  assert.equal(relay.admit(b.req, b.res), true)
  b.res.end(); assert.equal(relay.stats().requests, 0)
  relay.close()
})

test('config fails closed on malformed, zero, negative, infinite, huge or unknown numeric values', () => {
  for (const value of ['', '0', '-1', '1.5', 'Infinity', 'NaN', '1e3', '9999999999999999999', ' 20']) {
    assert.throws(() => loadConfig({ MAX_CONNECTIONS: value }), /MAX_CONNECTIONS/)
  }
  assert.throws(() => loadConfig({ PORT: '65536' }), /PORT/)
  assert.equal(loadConfig({ MAX_CONNECTIONS: '2' }).MAX_CONNECTIONS, 2)
})

module.exports = { Response, pair }

test('stalled admitted requests time out, release capacity and close cleanly', () => {
  const { relay, advance } = setup({ BODY_TIMEOUT_MS: 10 })
  const p = pair()
  assert.equal(relay.admit(p.req, p.res), true)
  advance(10)
  assert.equal(p.res.statusCode, 408)
  assert.equal(relay.stats().requests, 0)
  assert.equal(p.req.listenerCount('aborted'), 0)
  relay.close()
})

test('global and per-source inflight bounds are independent; fanout budget refills', () => {
  const { relay, advance } = setup({ MAX_REQUESTS_PER_SOURCE: 1, GLOBAL_FANOUT_BYTES_PER_SECOND: 20 })
  const p = pair(); const q = pair(); const r = pair('a', '127.0.0.2')
  assert.equal(relay.admit(p.req, p.res), true)
  assert.equal(relay.admit(q.req, q.res), false)
  assert.equal(relay.admit(r.req, r.res), true)
  p.res.end(); r.res.end()
  subscribe(relay)
  assert.equal(relay.publish('ordinary', Buffer.from('hello')), 201)
  assert.equal(relay.publish('ordinary', Buffer.from('hello')), 429)
  advance(1000)
  assert.equal(relay.publish('ordinary', Buffer.from('hello')), 201)
  relay.close()
})

test('write exceptions and initial backpressure have bounded lifetime and release listeners', () => {
  const { relay, advance, config } = setup()
  const p = pair(); p.res.write = () => { throw new Error('test only') }
  relay.subscribe(p.req, p.res)
  assert.equal(relay.stats().connections, 0)
  const q = pair(); q.res.writeResult = false
  relay.subscribe(q.req, q.res)
  assert.equal(relay.stats().connections, 1)
  advance(config.MAX_CONNECTION_MS)
  assert.equal(relay.stats().connections, 0)
  assert.equal(q.res.destroyed, true)
  assert.equal(q.res.listenerCount('drain'), 0)
  relay.close()
})

test('raw body cap precedes serialization and worst-case newlines are budgeted by wire bytes', () => {
  const { relay } = setup({ MAX_BODY_BYTES: 1048576 })
  subscribe(relay)
  const frame = encodeData(Buffer.alloc(1048576, '\n'))
  assert.equal(Buffer.byteLength(frame), 7340040)
  assert.equal(relay.publish('ordinary', Buffer.alloc(1048577)), 413)
  relay.close()
})

test('all numeric configuration fields enforce their bounds', () => {
  for (const key of Object.keys(loadConfig({}))) {
    for (const value of ['', '0', '-1', 'NaN', 'Infinity', '9007199254740992']) {
      assert.throws(() => loadConfig({ [key]: value }), new RegExp(key))
    }
  }
})
