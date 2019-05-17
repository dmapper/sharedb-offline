const { Duplex } = require('stream')

/**
 * @class Worker Duplex JSON stream that uses PostMessages to communicate
 */
class MessageStream extends Duplex {
  /**
   *
   * @param messenger {PostMessenger} - post message communicate channel
   */
  constructor(messenger) {
    super({
      objectMode: true,
      allowHalfOpen: false,
      emitClose: false
    })

    this.messenger = messenger
    this.messenger.onmessage = (event) => {
      const data = event.data
      console.log('worker <-', data)
      this.push(JSON.parse(data))
    }

    this.messenger.onclose = () => {
      console.log('close worker stream')
      this.push(null)
    }
  }

  _read () {}

  _write(data, encoding, callback) {
    console.log('worker ->', JSON.stringify(data))
    this.messenger.postMessage(JSON.stringify(data))
    callback()
  }
}

module.exports = MessageStream
