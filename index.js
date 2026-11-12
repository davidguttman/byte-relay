'use strict'

const http = require('node:http')
const { createApp } = require('./app')

function start () {
  const app = createApp()
  const config = app.locals.config
  const server = http.createServer({
    maxHeaderSize: 8192,
    headersTimeout: config.HEADERS_TIMEOUT_MS,
    requestTimeout: Math.max(config.HEADERS_TIMEOUT_MS, config.BODY_TIMEOUT_MS),
    connectionsCheckingInterval: 1000,
    keepAliveTimeout: 5000
  }, app)
  server.maxHeadersCount = 50
  server.maxRequestsPerSocket = 100
  // Includes incomplete handshakes/header uploads (before Express admission).
  server.maxConnections = config.MAX_CONNECTIONS + config.MAX_REQUESTS + 10
  server.on('close', () => app.locals.relay.close())
  server.on('error', () => {
    app.locals.relay.close()
    console.error('HTTP server failed')
    process.exitCode = 1
  })
  server.listen(config.PORT)
  return server
}

if (require.main === module) {
  try { start() } catch {
    console.error('Invalid configuration or startup failure')
    process.exitCode = 1
  }
}

module.exports = { start }
