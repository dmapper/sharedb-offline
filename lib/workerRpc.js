const _ = require('lodash')

function shallowClone(object) {
  var out = {};
  for (var key in object) {
    out[key] = object[key];
  }
  return out;
}

function castToDoc(id, snapshot) {
  var data = snapshot.data
  var doc = data
  doc._id = id
  doc._type = snapshot.type
  doc._v = snapshot.v
  return doc
}

function castToSnapshot(doc) {
  var id = doc._id;
  var version = doc._v;
  var type = doc._type;
  var data = doc._data;
  var meta = doc._m;
  var opLink = doc._o;
  if (type == null) {
    return new MongoSnapshot(id, version, null, undefined, meta, opLink);
  }
  if (doc.hasOwnProperty('_data')) {
    return new MongoSnapshot(id, version, type, data, meta, opLink);
  }
  data = shallowClone(doc);
  delete data._id;
  delete data._v;
  delete data._type;
  delete data._m;
  delete data._o;
  return new MongoSnapshot(id, version, type, data, meta, opLink);
}

function MongoSnapshot(id, version, type, data, meta, opLink) {
  this.id = id;
  this.v = version;
  this.type = type;
  this.data = data;
  if (meta) this.m = meta;
  if (opLink) this._opLink = opLink;
}


module.exports = (db) => {
  const syncWorkerBrowser = async (payload = {}) => {
    const { readOnlyCollections, clear } = payload
    const {store} = db
    const allCollections = await store.getCollections()
    const docCollections = allCollections.filter((name) => {
      return name.split('_').length === 1
    })
    const opsCollections = allCollections.filter((name) => {
      return name.split('_').length === 2
    })

    const ops = {}
    const collections = {}

    for (const opCollection of opsCollections) {
      const docs = await store.getCollectionDocs(opCollection)
      ops[opCollection] = ops[opCollection] || {}

      for (const doc of docs) {
        ops[opCollection][doc.d] = ops[opCollection][doc.d] || []
        ops[opCollection][doc.d].push(doc)
      }

      for (const docId in ops[opCollection]) {
        ops[opCollection][docId] = _.sortBy(ops[opCollection][docId], ['v'])
      }
    }

    for (const docCollection of docCollections) {
      const docs = await store.getCollectionDocs(docCollection)

      collections[docCollection] = collections[docCollection] || {}

      for (const doc of docs) {
        collections[docCollection][doc._id] = castToSnapshot(doc)
        console.log(docCollection, castToSnapshot(doc))
      }
    }

    const clearCollection = async (collectionName) => {
      const docIds = await store.getCollectionDocIds(collectionName)
      for (const docId of docIds) {
        await store.removeDoc(collectionName, docId)
      }
    }

    if (clear) {
      for (const collectionName of docCollections) {
        if (readOnlyCollections.indexOf(collectionName) !== -1) continue
        await clearCollection(collectionName)
        await clearCollection(`o_${collectionName}`)
      }
    }

    return {ops, collections}
  }

  const syncBrowserWorker = async ({collections = {}, clear, readOnlyCollections= []}) => {
    const {store} = db

    let index = 0
    for (const collectionName in collections) {
      const collection = collections[collectionName]
      for (const docId in collection) {
        const doc = _.pick(collection[docId], ['data', 'v', 'type'])
        const {ops} = collection[docId]

        await store.setDoc(collectionName, docId, castToDoc(docId, doc))

        for (const op of ops) {
          op.m = {
            ts: Date.now(),
          }
          await new Promise((resolve, reject) => {
            // if (op.create && op.v === null) op.v = op.v++

            db._writeOp(collectionName, docId, op, {}, (err) => {
              if (err) return reject(err)
              resolve()
            })
          })
        }

        index++
      }
    }
    return index
  }

  /**
   * Get pairs (docId, version) for collections
   * @param collections [String]
   */
  const getDocumentsVersions = async (collections = []) => {
    const results = {}
    const {store} = db
    for (const collectionName of collections) {
      results[collectionName] = results[collectionName] || {}
      const docs = await store.getCollectionDocs(collectionName)

      for (const doc of docs) {
        results[collectionName][doc._id] = doc._v
      }
    }
    return results
  }

  /**
   * Delete documents
   * @param collections Object
   */
  const deleteDocuments = async (collections) => {
    const {store} = db
    for (const collectionName in collections) {
      const docIds = collections[collectionName]
      for (const docId of docIds) {
        await store.removeDoc(collectionName, docId)
      }
    }
  }

  /**
   * Update documents
   * @param collections Object
   */
  const updateDocuments = async (collections) => {
    const {store} = db
    for (const collectionName in collections) {
      const docs = collections[collectionName]
      for (const docId in docs) {
        const doc = docs[docId]
        await store.setDoc(collectionName, docId, doc)
      }
    }
  }

  /**
   * Delete old documents and create new
   * @param collections Object
   */
  const updateDocumentsFull = async (collections) => {
    const {store} = db
    for (const collectionName in collections) {
      // Remove old
      const docIds = await store.getCollectionDocIds(collectionName)

      for (const docId of docIds) {
        await store.removeDoc(collectionName, docId)
      }
      // Save new
      const docs = collections[collectionName]
      for (const docId in docs) {
        const doc = docs[docId]
        await store.setDoc(collectionName, docId, doc)
      }
    }
  }

  return {
    syncWorkerBrowser,
    syncBrowserWorker,
    getDocumentsVersions,
    deleteDocuments,
    updateDocuments,
    updateDocumentsFull
  }

}
