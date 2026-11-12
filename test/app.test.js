'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { createApp } = require('../app')

// Real IncomingMessage-compatible readable + real ServerResponse, with no socket,
// listen(), supertest, or network. Responses are captured at the write boundary.
function request (app, method, url, chunks = [], headers = {}) {
  const req = new http.IncomingMessage({ remoteAddress: '127.0.0.1' })
  Object.assign(req, { method, url, headers, httpVersionMajor: 1, httpVersionMinor: 1 })
  const res = new http.ServerResponse(req)
  const output = []
  res.write = chunk => { output.push(Buffer.from(chunk)); return true }
  res.flushHeaders = () => {}
  res.end = chunk => { if (chunk) output.push(Buffer.from(chunk)); res.finished = true; res.emit('finish'); return res }
  res.destroy = () => { res.emit('close'); return res }
  app(req, res)
  for (const chunk of chunks) req.push(Buffer.from(chunk))
  req.complete = true
  req.push(null)
  return new Promise(resolve => setImmediate(() => resolve({ req, res, output, body: Buffer.concat(output).toString() })))
}
function setup (env = {}) { return createApp({ env }) }

test('health is GET exact, minimal, independent of channel quotas and query parsing', async () => {
  const app = setup()
  try {
    const health = await request(app, 'GET', '/health?x[y]=z')
    assert.equal(health.res.statusCode, 200)
    assert.deepEqual(JSON.parse(health.body), { status: 'ok' })
    for (const path of ['/health/extra', '/health/']) {
      assert.equal((await request(app, 'GET', path)).res.statusCode, 404)
    }
    assert.equal((await request(app, 'POST', '/health')).res.statusCode, 405)
    assert.equal((await request(app, 'HEAD', '/health')).res.statusCode, 405)
    assert.equal(app.get('query parser'), false); assert.equal(app.get('trust proxy'), false)
  } finally { app.locals.relay.close() }
})

test('raw POST accepts no content-type, decodes UTF8, preserves 201 and open CORS', async () => {
  const app = setup()
  try {
    const sub = await request(app, 'GET', '/demo')
    const posted = await request(app, 'POST', '/demo', [Buffer.from('hello\nworld')])
    assert.equal(posted.res.statusCode, 201)
    assert.equal(posted.res.getHeader('access-control-allow-origin'), '*')
    assert.equal(sub.res.getHeader('content-type'), 'text/event-stream; charset=utf-8')
    const empty = await request(app, 'POST', '/demo')
    assert.equal(empty.res.statusCode, 201)
    assert.equal(Buffer.concat(sub.output).toString(), ':ok\n\ndata: hello\ndata: world\n\ndata: \n\n')
  } finally { app.locals.relay.close() }
})

test('reject oversized declared or streamed bodies, compression, malformed paths, controls, huge keys and HEAD subscription', async () => {
  const app = setup({ MAX_BODY_BYTES: '4', MAX_KEY_BYTES: '16' })
  try {
    const cases = [
      ['POST', '/a', [], { 'content-length': '5' }, 413],
      ['POST', '/a', ['123', '45'], {}, 413],
      ['POST', '/a', [], { 'content-encoding': 'gzip' }, 415],
      ['GET', '/%00bad', [], {}, 400],
      ['GET', '/%E0%A4%A', [], {}, 400],
      ['GET', '/abcdefghijklmnopq', [], {}, 400],
      ['HEAD', '/a', [], {}, 405]
    ]
    for (const [method, path, chunks, headers, status] of cases) {
      const result = await request(app, method, path, chunks, headers)
      assert.equal(result.res.statusCode, status, path)
      assert.doesNotMatch(result.body, /Error:|node_modules|stack|%00bad/)
    }
    assert.equal(app.locals.relay.stats().connections, 0)
    assert.equal(app.locals.relay.stats().requests, 0)
  } finally { app.locals.relay.close() }
})

test('global ingress byte budget rejects before broadcast, including chunked bodies', async () => {
  const app = setup({ GLOBAL_BODY_BYTES_PER_SECOND: '4' })
  try {
    assert.equal((await request(app, 'POST', '/a', ['1234'])).res.statusCode, 201)
    assert.equal((await request(app, 'POST', '/a', ['5'])).res.statusCode, 429)
  } finally { app.locals.relay.close() }
})

test('preflight stays open but is subject to global admission', async () => {
  const app = setup({ GLOBAL_REQUESTS_PER_SECOND: '1' })
  try {
    assert.equal((await request(app, 'OPTIONS', '/x')).res.statusCode, 204)
    assert.equal((await request(app, 'OPTIONS', '/y')).res.statusCode, 429)
  } finally { app.locals.relay.close() }
})

test('aborted uploads destroy the response and release body listeners and admission', async () => {
  const app = setup()
  const req = new http.IncomingMessage({ remoteAddress: '127.0.0.1' })
  Object.assign(req, { method: 'POST', url: '/a', headers: {} })
  const res = new http.ServerResponse(req)
  let destroyed = false
  res.destroy = () => { destroyed = true; res.emit('close'); return res }
  try {
    app(req, res)
    req.emit('data', Buffer.from('partial'))
    req.emit('aborted')
    assert.equal(destroyed, true)
    assert.equal(app.locals.relay.stats().requests, 0)
    assert.equal(req.listenerCount('data'), 0)
    assert.equal(req.listenerCount('end'), 0)
  } finally { app.locals.relay.close() }
})

test('bootstrap imports never listen and HTTP hardening uses validated config', () => {
  const original = http.createServer
  let options; let handler; let listened
  http.createServer = (opts, fn) => {
    options = opts; handler = fn
    return { on () {}, listen (port) { listened = port } }
  }
  try {
    const { start } = require('../index')
    assert.equal(listened, undefined)
    const server = start()
    assert.equal(listened, handler.locals.config.PORT)
    assert.equal(options.maxHeaderSize, 8192)
    assert.equal(options.headersTimeout, handler.locals.config.HEADERS_TIMEOUT_MS)
    assert.equal(server.maxConnections, handler.locals.config.MAX_CONNECTIONS + handler.locals.config.MAX_REQUESTS + 10)
    handler.locals.relay.close()
  } finally { http.createServer = original }
})

test('incomplete request close releases body and admission without relying on aborted', () => {
  const app = setup()
  const req = new http.IncomingMessage({ remoteAddress: '127.0.0.1' })
  Object.assign(req, { method: 'POST', url: '/a', headers: {} })
  const res = new http.ServerResponse(req)
  res.destroy = () => { res.emit('close'); return res }
  try {
    app(req, res)
    req.emit('data', Buffer.from('partial'))
    req.emit('close')
    assert.equal(app.locals.relay.stats().requests, 0)
    assert.equal(req.listenerCount('data'), 0)
  } finally { app.locals.relay.close() }
})

test('asynchronous body processing failures return sanitized errors without leaking admission', async () => {
  const app = setup()
  app.locals.relay.publish = () => { throw new Error('private-key and payload must not leak') }
  try {
    const result = await request(app, 'POST', '/a', ['hello'])
    assert.equal(result.res.statusCode, 500)
    assert.equal(result.body, 'Internal server error')
    assert.equal(app.locals.relay.stats().requests, 0)
  } finally { app.locals.relay.close() }
})
