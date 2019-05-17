/**
 * @class Post Message - WebSocket Wrapper
 */

class MessageSocket {
  /**
   *
   * @param messenger {PostMessenger} - post message channel
   */
  constructor(messenger) {
    this.CONNECTING = 0
    this.OPEN = 1
    this.CLOSING = 2
    this.CLOSED = 3
    this.messenger = messenger
    this.readyState = this.CONNECTING

    this.messenger.onmessage = (event) => {
      console.log('browser <-', event.data)
      if (this.readyState === this.OPEN) {
        this.onmessage && this.onmessage(event)
      } else {
        setTimeout(() => {
          this.onmessage && this.onmessage(event)
        }, 0)
      }
    }

    this.messenger.onclose = (event) => {
      console.log('close client PM WebSocket')
      this.onclose && this.onclose(event)
    }

    setTimeout(() => {
      this.readyState = this.OPEN
      this.onopen && this.onopen(event)
    }, 0)
  }

  /**
   * Send data to the worker
   * @param data {Object} - data to be sent to webworker
   */
  send (data) {
    console.log('browser ->', data)
    if (this.readyState === this.OPEN) {
      this.messenger.postMessage(data)
    } else {
      this.onerror && this.onerror(data)
    }
  }

  /**
   * Close the channel
   */
  close () {
    this.readyState = this.CLOSING
    this.messenger.close()
    delete this.onmessage
    this.onclose && this.onclose()
    this.readyState = this.CLOSED
  }
}

module.exports = MessageSocket
