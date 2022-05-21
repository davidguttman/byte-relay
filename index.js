const cors = require('cors')
const express = require('express')
const bodyParser = require('body-parser')

const Events = require('./events')
const SseStream = require('./ssestream')

const PORT = process.env.PORT || 3000

const app = express()

app.use(cors())
app.use(bodyParser.raw({ type: '*/*' }))
app.get('/:key', subscribe)
app.post('/:key', announce)

app.listen(PORT)
console.log('Server listening on port', PORT)

function subscribe (req, res) {
  const key = req.params.key
  console.log('new connection', key)

  const sseStream = new SseStream(req)
  sseStream.pipe(res)

  Events.signalEmitter.on(key, onData)

  res.once('close', () => {
    console.log('lost connection', key)
    Events.signalEmitter.off(key, onData)
    sseStream.unpipe(res)
  })

  function onData (data) {
    console.log('data', data)
    sseStream.write({data})
  }
}

function announce (req, res) {
  console.log(req.headers)
  res.sendStatus(201)
  res.end()
  const key = req.params.key
  console.log('req.body', req.body)
  const message = req.body.toString()
  Events.signal({ key, message })
}
