const redis = process.env.NODE_ENV === 'test'
  ? require('fakeredis')
  : require('redis')
const { host, port, password } = require('./config').redis

module.exports = function () {
  const client = redis.createClient({ host, port, password })

  client.on('connect', function () {
    console.log('Redis client connected')
  })

  client.on('error', (err) => {
    console.error('Redis error', err)
  })

  return client
}
