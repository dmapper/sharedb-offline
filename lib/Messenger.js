const uuid = require('uuid/v1')
const {EventEmitter} = require('events')

/**
 * @class Global class that handle PostMessages and can create individual PostMessenger
 */
class Messenger extends EventEmitter {
  constructor (context) {
    super()
    this.context = context
    this.postMessengers = {}
    // this.isServer = isServer

    this.context.onmessage = (event) => {
      const data = JSON.parse(event.data)
      const {type, payload, id, systemMessage} = data
      if (systemMessage) {

        if (systemMessage === 'open') {
          const postMessenger = new this.createMessenger(type, id)
          this.emit(type, postMessenger)
        }
        if (systemMessage === 'close') {
          const postMessenger = new this.createMessenger(type, id)
          postMessenger.close(true)
        }

      } else {
        let processed = false
        if (this.postMessengers[type]) {
          if (this.postMessengers[type][id]) {
            const postMessenger = this.postMessengers[type][id]
            if (postMessenger.onmessage) {
              postMessenger.onmessage({data: payload})
              processed = true
            }
          }
        }
        if (!processed) {
          console.warn(`MESSENGER - getting '${type}'-message but there is no handler to process`, data, systemMessage)
        }
      }
    }
  }

  // Only for clients
  open = (scope) => {
    const postMessenger = this.createMessenger(scope)
    postMessenger.open()
    return postMessenger
  }

  createMessenger = (scope, id) => {
    if (!id) {
      id = uuid()
    }

    const postMessenger = new PostMessenger(this, scope, id)
    this.postMessengers[scope] = this.postMessengers[scope] || {}
    this.postMessengers[scope][id] = postMessenger

    return postMessenger
  }

  postMessage  = (type, id, payload, systemMessage) => {
    const data = {type, id, payload, systemMessage}
    this.context.postMessage(JSON.stringify(data))
  }

  destroyMessenger = (scope, id) => {
    if (this.postMessengers[scope]) {
      delete this.postMessengers[scope][id]
    }
  }
}

/**
 * @class Post Message communicate channel
 */

class PostMessenger extends EventEmitter {
  constructor (messenger, scope, id) {
    super()
    this.messenger = messenger
    this.scope = scope
    this.id = id
  }

  postMessage = (data) => {
    this.messenger.postMessage(this.scope, this.id, data)
  }

  open = () => {
    this.messenger.postMessage(this.scope, this.id, null, 'open')
  }

  close = (dontSend = false) => {
    if (!dontSend) {
      this.messenger.postMessage(this.scope, this.id, null, 'close')
    }
    setTimeout(() => {
      this.messenger.destroyMessenger(this.scope, this.id)

      // TODO check if this stops the JSON stream
      //  but doesn't bread websocket
      this.onclose && this.onclose()
    }, 0)
  }

  // onmessage = (data) => {
  //   console.error('onmessage is not implemented', this.scope, this.id, data)
  // }

}

module.exports = Messenger
