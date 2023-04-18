const { EventEmitter } = require('events')

const signalEmitter = new EventEmitter()

module.exports = {
  signal,
  signalEmitter
}

function signal ({ key, message }) {
  signalEmitter.emit(key, message)
}
