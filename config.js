'use strict'

// Explicit upper bounds prevent accidental effectively-unlimited deployments.
const limits = {
  PORT: [3000, 65535],
  MAX_KEY_BYTES: [256, 4096],
  MAX_BODY_BYTES: [65536, 1048576],
  MAX_CONNECTIONS: [1000, 10000],
  MAX_CONNECTIONS_PER_SOURCE: [20, 10000],
  MAX_CONNECTIONS_PER_CHANNEL: [100, 10000],
  MAX_REQUESTS: [100, 1000],
  MAX_REQUESTS_PER_SOURCE: [10, 1000],
  GLOBAL_REQUESTS_PER_SECOND: [200, 10000],
  REQUESTS_PER_SOURCE_PER_SECOND: [20, 1000],
  MAX_RATE_SOURCES: [10000, 100000],
  GLOBAL_BODY_BYTES_PER_SECOND: [1048576, 104857600],
  GLOBAL_FANOUT_BYTES_PER_SECOND: [8388608, 1073741824],
  MAX_BACKLOG_BYTES: [524288, 8388608],
  HEARTBEAT_MS: [15000, 60000],
  MAX_CONNECTION_MS: [300000, 3600000],
  BODY_TIMEOUT_MS: [10000, 60000],
  HEADERS_TIMEOUT_MS: [10000, 60000]
}

function loadConfig (env = process.env) {
  const config = {}
  for (const [name, [fallback, max]] of Object.entries(limits)) {
    const value = env[name] === undefined ? String(fallback) : env[name]
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
      throw new Error(`Invalid ${name}: expected integer between 1 and ${max}`)
    }
    config[name] = Number(value)
  }
  return Object.freeze(config)
}

module.exports = { loadConfig }
