const { EventEmitter } = require('events')

const db = require('./db')
const pub = db()
const sub = db()

const PUBSUB_KEY = 'events'

const signalEmitter = new EventEmitter()

sub.on('message', function (channel, data) {
  try {
    const { key, message } = JSON.parse(data)
    return signalEmitter.emit(key, message)
  } catch (err) {
    return console.error(err)
  }
})
sub.subscribe(PUBSUB_KEY)

module.exports = {
  signal,
  signalEmitter
}

function signal ({ key, message }) {
  pub.publish(PUBSUB_KEY, JSON.stringify({
    key,
    message
  }))
}
