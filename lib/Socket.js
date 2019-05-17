const MessageSocket = require('./MessageSocket')
const RPC = require('./RPC')
const ms = require('ms')
const _ = require('lodash')
const log = require('log-with-style')
const { EventEmitter } = require('events')
const json0 = require('ot-json0').type

const delay = ms => (new Promise(done => setTimeout(done, ms)))

const States = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED_WS: 'connectedWS',
  CONNECTED_PM: 'connectedPM',
  SYNCING_BROWSER_WORKER: 'syncBrowserWorker',
  SYNCING_WORKER_BROWSER: 'syncWorkerBrowser'
}

/**
 * Generic Socket that can switch between WebSocket/PostMessage
 * @param options {Object}
 * @param options.workerMessenger
 * @param options.url String
 * @param options.subscribeDoc fn
 * @param options.unsubscribeDoc fn
 * @param options.readOnlyCollections [String]
 * @constructor
 */

function Socket(options) {
  this.options = options
  this.ee = new EventEmitter()
  this.workerMessenger = options.workerMessenger
  this.subscribeDoc = options.subscribeDoc
  this.unsubscribeDoc = options.unsubscribeDoc
  this.readOnlyCollections = this.readOnlyCollections || []

  this.rpc = new RPC(this.workerMessenger.open('rpc'))
  this.setState(States.DISCONNECTED)

  this._attemptNum = 0

  this.setState(States.CONNECTING)
  this._createWebSocket()
}


Socket.prototype._createWebSocket = function() {
  // console.log('Creating WS')
  this._ws_socket = new WebSocket(this.options.url)
  this._ws_messageQueue = []

  this._ws_socket.onmessage = this._ws_onmessage.bind(this)
  this._ws_socket.onopen = this._ws_onopen.bind(this)
  this._ws_socket.onclose = this._ws_onclose.bind(this)
}

Socket.prototype._createPostMessage = function() {
  // console.log('Creating PM')
  this._pm_socket = new MessageSocket(this.workerMessenger.open('sharedb'))
  this._pm_messageQueue = []

  this._pm_socket.onmessage = this._pm_onmessage.bind(this)
  this._pm_socket.onopen = this._pm_onopen.bind(this)
  this._pm_socket.onclose = this._pm_onclose.bind(this)
}

Socket.prototype._ws_onmessage = function(message) {
  if (this.getState() === States.CONNECTED_WS) {
    this.onmessage && this.onmessage({data: JSON.parse(message.data)})
  } else {
    this._ws_messageQueue.push({data: JSON.parse(message.data)})
  }
}

Socket.prototype._ws_onopen = async function(event) {
  this._attemptNum = 0
  this._ws_messageQueue = []
  switch (this.getState()) {
    case (States.CONNECTED_PM):
      this.setState(States.DISCONNECTED)
      this.onclose && this.onclose({})
      this.setState(States.CONNECTING)
      await this.syncWorkerBrowser()
      this._pm_close()
      this.setState(States.CONNECTED_WS)
      this.onopen && this.onopen({})
      this._ws_flush()
      break
    case (States.CONNECTING):
      this.setState(States.CONNECTED_WS)
      this.onopen && this.onopen({})
      break
    case (States.SYNCING_WORKER_BROWSER):
      console.warn('ws_open event while we are in a process of syncing data', this.getState())
      break

    case (States.SYNCING_BROWSER_WORKER):

      // We need to wait until the sync is over and than switch to WS
      const handler = async ({state}) => {
        try {
          if (state !== States.CONNECTED_PM) return
          this.ee.removeListener('state', handler)
          this.setState(States.DISCONNECTED)
          this.onclose && this.onclose({})
          this.setState(States.CONNECTING)
          await this.syncWorkerBrowser()
          this._pm_close()
          this.setState(States.CONNECTED_WS)
          this.onopen && this.onopen({})
          this._ws_flush()
        } catch (err) {
          console.log('Error while connecting to WS', err)
        }
      }
      this.ee.on('state', handler)

      break
    default: {
      console.log('unhandled _ws_onopen event', event, this.getState())
    }
  }
}

Socket.prototype.syncBrowserWorker = async function () {
  this.setState(States.SYNCING_BROWSER_WORKER)

  const collections = {}
  for (const collectionName in this.connection.collections) {
    const collection = this.connection.collections[collectionName]
    const collectionCopy = {}

    for (const docId in collection) {
      const doc = collection[docId]

      if (!doc.type) continue

      if (doc.inflightOp) {
        doc.pendingOps.unshift(doc.inflightOp)
        doc.inflightOp = null;
      }

      // the doc is created but didn't saved into the db
      // don't sent this doc during sync
      // it will be saved normal way
      if (doc.version === null  && doc.pendingOps.length >=1 && doc.pendingOps[0].create) continue

      const ops = doc.pendingOps.map(it => {
        return {..._.pick(it, ['op', 'create', 'del'])}
      })

      // Clear ops in the doc
      doc.pendingOps = []

      // Set versions for ops + increase the version in doc
      ops.forEach((op) => {
        op.v = doc.version || 0
        doc.version++
      })

      collectionCopy[docId] = {
        data: doc.data,
        v: doc.version,
        type: doc.type.uri,
        ops: ops
      }
    }

    if (_.keys(collectionCopy).length > 0) {
      collections[collectionName] = collectionCopy
    }
  }

  // console.log('syncBrowserWorker', collections)

  // Copy Everything from connection into worker
  // sharedb-mingo using rpc

  await this.rpc.run('syncBrowserWorker', {
    collections,
    clear: true,
    readOnlyCollections: this.readOnlyCollections
  })

  this.setState(States.CONNECTED_PM)

  // switching global socket into open state
  this.onopen && this.onopen({})
  this._pm_flush()
}

Socket.prototype.syncWorkerBrowser = async function () {

  const getSharedbDoc = (collectionName, docId) => {
    const { connection } = this
    return connection.collections[collectionName] && connection.collections[collectionName][docId]
  }

  this.setState(States.SYNCING_WORKER_BROWSER)

  const {
    collections = {},
    ops = {}
  } = await this.rpc.run('syncWorkerBrowser', {
    clear: true,
    readOnlyCollections: this.readOnlyCollections
  })

  const getOps = (collectionName, docId) => {
    const oCollectionName = `o_${ collectionName }`
    return (ops[oCollectionName] || {})[docId]
  }

  const getSnapshotVersion = (ops = []) => {
    if (ops[0].create) {
      return null
    }
    return ops[0].v
  }

  for (const collectionName in collections) {
    const collection = collections[collectionName]

    for (const docId in collection) {
      const snapshot = collection[docId]
      const docOps = getOps(collectionName, docId) || []
      let sharedbDoc = getSharedbDoc(collectionName, docId)

      // Документ не менялся - ничего не делаем
      if (docOps.length === 0) {
        console.log('Doc was not changed')
        continue
      }

      // The doc is already unloaded from sharedb - this is OK
      // will load and update
      let unloaded = false
      if (!sharedbDoc) {
        // Create sharedb doc
        sharedbDoc = this.connection.get(collectionName, docId)
        // Need to set version hera as it is handled in ingestSnapshot
        snapshot.v = getSnapshotVersion(docOps, snapshot)
        sharedbDoc.ingestSnapshot(snapshot)
        unloaded = true
      }

      if (!docOps || docOps.length === 0) {
        throw Error('Sync PM->WS: no ops' + docId)
      }

      // Move inflightOp into pendingOps
      if (sharedbDoc.inflightOp) {
        sharedbDoc.pendingOps.unshift(snapshot.inflightOp)
        sharedbDoc.inflightOp = null
      }

      // Change version to what is needed
      // We need to set "old" version of the doc
      // The same that was before the connection was broken
      sharedbDoc.version = getSnapshotVersion(docOps, snapshot)

      // Add our ops into pendingOps

      const ops = docOps.slice(0).map(op => {
        return {
          ...(_.pick(op, ['op', 'create', 'del'])),
          callbacks: [],
          type: json0,
        }
      })

      if (unloaded) {
        // Take into account doc ref counters

        this.subscribeDoc && this.subscribeDoc(collectionName, docId) // подписываемся
        // after saving the last op into db
        ops[ops.length - 1].callbacks.push(() => {
          this.unsubscribeDoc && this.unsubscribeDoc(collectionName, docId) // отписываемся
        })
      }

      // add to the beginning of the array
      sharedbDoc.pendingOps.unshift(...ops)

      // console.log('doc ops', docOps)
      // console.log('ops', ops)
      // console.log('snapshot', sharedbDoc.data)
      // console.log('version', sharedbDoc.version)
    }
  }
}

Socket.prototype._ws_onclose = async function (event) {
  // console.log('WebSocket: onclose')

  // this.onclose && this.onclose(event)

  switch (this.getState()) {
    case (States.CONNECTED_WS):
      this.onclose && this.onclose({})
      this.setState(States.DISCONNECTED)

    case (States.DISCONNECTED):
      this.setState(States.CONNECTING)
    case (States.CONNECTING):
      await delay(this._getTimeout())
      this._createWebSocket()

      await delay(ms('3s'))
      // start pm connection only once
      if (!this._pm_socket) {
        // Start connecting ot PM a little after
        this._createPostMessage()
      }
      break

    case (States.CONNECTED_PM):
      await delay(this._getTimeout())
      this._createWebSocket()
      break


    default: {
      console.log('unhandled _ws_onclose event', event, this.getState())
    }
  }
  this._attemptNum++
}

Socket.prototype._getTimeout = function(){
  var base = 2000
  var increment = 400 * this._attemptNum
  var maxTimeout = base + increment
  return getRandom(maxTimeout / 3, maxTimeout)
}

Socket.prototype._pm_onmessage = function(data) {
  if (this.getState() === States.CONNECTED_PM) {
    this.onmessage && this.onmessage(data)
  } else {
    this._pm_messageQueue.push(data)
  }
}

Socket.prototype._ws_flush = function () {
  for (const message of this._ws_messageQueue) {
    this.onmessage && this.onmessage(message)
  }
  this._ws_messageQueue = []
}

Socket.prototype._pm_flush = function () {
  for (const message of this._pm_messageQueue) {
    this.onmessage && this.onmessage(message)
  }
  this._pm_messageQueue = []
}

Socket.prototype._pm_onopen = async function(event) {

  switch (this.getState()) {
    case (States.CONNECTED_WS):
      // If we are opening pm-socket
      // but ws-socket is already opened - silently close
      // the new pm-socket

      this._pm_socket.onmessage = null
      this._pm_socket.onopen = null
      this._pm_socket.onclose = null
      this._pm_socket.close()
      this._pm_socket = null
      break
    case (States.DISCONNECTED):
    case (States.CONNECTING):
      await this.syncBrowserWorker()
      break
    default:
      console.log('Error _pm_onopen - wrong state', this.getState())
  }
}

Socket.prototype._pm_close = async function(event) {
  this._pm_socket.onmessage = null
  this._pm_socket.onopen = null
  this._pm_socket.onclose = null
  this._pm_socket.close()
  this._pm_socket = null
}

Socket.prototype._pm_onclose = function(event) {
}

Socket.prototype.send = function(data){

  switch (this.getState()) {
    case (States.CONNECTED_WS):
      if (typeof data !== 'string') {
        data = JSON.stringify(data)
      }
      this._ws_socket.send(data)
      break

    case (States.CONNECTED_PM):
      this._pm_socket.send(data)
      break
    default: {
      console.error('Socket.prototype.send - WRONG STATE', this.getState())
    }
  }
}

Socket.prototype.close = function(){

}

/**
 * Set new state
 * @param state {States} - new global socket state
 */
Socket.prototype.setState = function(state) {
  const oldState = this.mainState
  log(`STATE: [c='color:red']${ state }[c]`)
  this.mainState = state
  this.ee.emit('state', {state: state})

  if (oldState === States.CONNECTED_PM || state === States.CONNECTED_PM) {
    this.ee.emit('offline', state === States.CONNECTED_PM)
  }
}

/**
 *
 * @returns {States}
 */
Socket.prototype.getState = function() {
  return this.mainState
}

// WebSocket constants
Socket.prototype.CONNECTING = 0
Socket.prototype.OPEN = 1
Socket.prototype.CLOSING = 2
Socket.prototype.CLOSED = 3

function getRandom(min, max){
  return Math.random() * (max - min) + min
}

module.exports = Socket
