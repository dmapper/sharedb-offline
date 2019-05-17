const { EventEmitter } = require('events')
const uuid = require('uuid/v1')

// type = 'request'/'answer'
class RPC {
  constructor(messenger) {
    this.messenger = messenger
    this.ee = new EventEmitter()
    this.messenger.onmessage = this._onMessage
  }

  run = (actionName, payload) => {
    return new Promise((resolve, reject) => {
      const id = uuid()

      // getting response
      this.ee.on(`${actionName}.${id}`, (data) => {
        const { payload, error } = data
        if (error) return reject(error)
        resolve(payload)
      })

      this._sendMessage(actionName, id, payload, 'request')
    })
  }

  registerHandler = (actionName, fnAsync) => {
    this.ee.on(`${actionName}`, (data) => {
      const { id, payload } = data
      fnAsync(payload).then((result) => {
        this._sendMessage(actionName, id, result, 'answer')
      }).catch((error) => {
        this._sendMessage(actionName, id, null, 'answer', error)
      })
    })
  }

  _onMessage = (event) => {
    const data = JSON.parse(event.data)
    const { id, type, action, payload } = data
    if (type === 'request') {
      // Need to run one of the registered handlers
      if (this.ee.listenerCount(action) === 0) {
        console.warn('RPC - action received but there is no listeners', data)
      }
      this.ee.emit(action, data)
    }
    if (type === 'answer') {
      // Need to run one of the registered response handlers (by request id)
      if (this.ee.listenerCount(`${action}.${id}`) === 0) {
        console.warn('RPC - action received but there is no listeners', data)
      }
      this.ee.emit(`${action}.${id}`, data)
    }
  }

  _sendMessage = (action, id, payload, type, error) => {
    const data = {
      id,
      type,
      action,
      payload
    }
    if (error) data.error = error
    this.messenger.postMessage(JSON.stringify(data))
  }
}

module.exports = RPC
