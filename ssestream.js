'use strict'

// Raw HTTP bytes retain the original UTF-8 decoding contract (invalid sequences
// become U+FFFD). Prefix every line, including empty lines, to prevent SSE injection.
function encodeData (body) {
  return body.toString('utf8').split(/\r\n|\r|\n/).map(line => `data: ${line}\n`).join('') + '\n'
}

module.exports = { encodeData }
