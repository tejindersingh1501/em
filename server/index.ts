import { Server } from '@hocuspocus/server'
import level from 'level'
import { LeveldbPersistence } from 'y-leveldb'
import * as Y from 'yjs'
import DocLogAction from '../src/@types/DocLogAction'
import Share from '../src/@types/Share'
import ThoughtId from '../src/@types/ThoughtId'
import {
  encodeDocLogDocumentName,
  encodeLexemeDocumentName,
  encodePermissionsDocumentName,
  encodeThoughtDocumentName,
  parseDocumentName,
} from '../src/data-providers/yjs/documentNameEncoder'
import replicationController from '../src/data-providers/yjs/replicationController'
import timestamp from '../src/util/timestamp'

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error'

const port = process.env.PORT ? +process.env.PORT : 8080

// contains a top level map for each thoughtspace Map<Share> mapping token -> permission
const permissionsServerDoc = new Y.Doc()

/** Shows the first n characters of a string and replaces the rest with an ellipsis. */
const mask = (s: string, n = 4) => `${s.slice(0, n)}...`

/** Gets a permissionsServerDoc by name that is synced by the server. */
const getYDoc = (name: string): Y.Doc | undefined => server.documents.get(name)

/** Make text gray in the console. */
const gray = (s: string) => `\x1B[90m${s}\x1b[0m`

/** Logs a message to the console with an ISO timestamp. Optionally takes a console method for its last argument. Defaults to info. */
const log = (...args: [...any, ...([ConsoleMethod] | [])]) => {
  // prepend timestamp
  if (process.env.LOG_TIMESTAMPS) {
    args = [gray(new Date().toISOString()), ...args]
  }
  // default to console.info
  // override the method by passing { method: 'error' } as the last argument
  let method: ConsoleMethod = 'info'
  const lastArg = args[args.length - 1]
  if (typeof lastArg === 'object' && Object.keys(lastArg).length === 1 && lastArg.method) {
    args = args.slice(0, -1)
    method = lastArg.method
  }

  // eslint-disable-next-line no-console
  console[method](...args)
}

// meta information about the doclog, mainly the thoughtReplicationCursor
const doclogMeta: level.LevelDB<string, string> | undefined = process.env.DB_DOCLOGMETA
  ? level(process.env.DB_DOCLOGMETA, { valueEncoding: 'json' })
  : undefined

const ldbPermissions = process.env.YPERMISSIONS ? new LeveldbPersistence(process.env.YPERMISSIONS) : undefined
const ldbThoughtspace = process.env.YPERSISTENCE ? new LeveldbPersistence(process.env.YPERSISTENCE) : undefined

/** Syncs a doc with leveldb. */
const syncLevelDb = async ({ db, docName, doc }: { db: any; docName: string; doc: Y.Doc }) => {
  const docPersisted = await db.getYDoc(docName)
  const updates = Y.encodeStateAsUpdate(doc)
  db.storeUpdate(docName, updates)
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(docPersisted))
  doc.on('update', update => {
    db.storeUpdate(docName, update)
  })
}

/** Authenticates a document request with the given access token. Handles Docs for Thoughts, Lexemes, and Permissions. Assigns the token as owner if it is a new document. Throws an error if the access token is not authorized. */
export const onAuthenticate = async ({ token, documentName }: { documentName: string; token: string }) => {
  const { tsid } = parseDocumentName(documentName)
  // the server-side permissions map
  // stores the permissions for all thoughtspaces as Map<Index<Share>> (indexed by tsid and access token)
  // only accessible on the server
  const permissionsServerMap = permissionsServerDoc.getMap<Share>(tsid)

  // if the document has no owner, automatically assign the current user as owner
  if (permissionsServerMap.size === 0) {
    log(`assigning owner ${mask(token)} to new thoughtspace ${tsid}`)
    permissionsServerMap.set(token, { accessed: timestamp(), created: timestamp(), name: 'Owner', role: 'owner' })
  }

  // authenicate existing owner
  // authenticate new documents
  if (permissionsServerMap.get(token)?.role !== 'owner') {
    throw new Error('Not authorized')
  }

  // passed forward as data.context to later hooks
  return { token }
}

/** Syncs permissions to permissionsClientDoc on load. The permissionsServerDoc cannot be exposed since it contains permissions for all thoughtspaces. This must be done in onLoadDocument when permissionsClientDoc has been created through the websocket connection. */
export const onLoadDocument = async ({
  context,
  document,
  documentName,
}: {
  context: { token: string }
  document: Y.Doc
  documentName: string
}) => {
  const { token } = context
  const { tsid, type } = parseDocumentName(documentName)
  const permissionsDocName = encodePermissionsDocumentName(tsid)
  const permissionsServerMap = permissionsServerDoc.getMap<Share>(tsid)
  const permission = permissionsServerMap.get(token)

  if (!permission || permission.role !== 'owner') return

  // Copy permissions from the server-side permissions doc to the client-side permission doc.
  // The server-side permissions doc keeps all permissions for all documents in memory.
  // The client-side permissions doc uses authentication and can be exposed to the client via websocket.
  // update last accessed time on auth
  if (type === 'permissions') {
    permissionsServerMap.set(token, { ...permission, accessed: timestamp() })

    const permissionsClientDoc = getYDoc(permissionsDocName)
    if (!permissionsClientDoc) return

    const permissionsClientMap = permissionsClientDoc.getMap<Share>()

    // sync client permissions to server
    // TODO: Maybe we can 2-way sync only the updates for this tsid
    permissionsClientMap?.observe(e => {
      e.changes.keys.forEach((change, key) => {
        if (change.action === 'delete') {
          permissionsServerMap.delete(key)
        } else {
          permissionsServerMap.set(key, permissionsClientMap.get(key)!)
        }
      })
    })

    // copy server permissions to client
    permissionsServerMap.forEach((permission: Share, token: string) => {
      permissionsClientMap.set(token, permission)
    })
    // persist non-permissions docs
  } else if (ldbThoughtspace) {
    syncLevelDb({ db: ldbThoughtspace, docName: documentName, doc: document })
  }

  if (type === 'doclog') {
    /** Use a replicationController to track thought and lexeme deletes in the doclog. Clears persisted documents that have been deleted. */
    replicationController({
      doc: document,
      next: async ({ action, id, type }) => {
        if (action === DocLogAction.Delete) {
          const name =
            type === 'thought' ? encodeThoughtDocumentName(tsid, id as ThoughtId) : encodeLexemeDocumentName(tsid, id)
          await ldbThoughtspace?.clearDocument(name)
        }
      },

      // storage interface for doclogMeta that prepends the tsid.
      storage: {
        getItem: async (key: string) => {
          let results: any = null
          try {
            results = await doclogMeta?.get(encodeDocLogDocumentName(tsid, key))
          } catch (e) {
            // get will fail with "Key not found" the first time
            // ignore it and replication cursors will be set in next replication
          }

          return results
        },
        setItem: (key: string, value: string) => doclogMeta?.put(encodeDocLogDocumentName(tsid, key), value),
      },
    })
  }
}

// persist permissions to YPERMISSIONS with leveldb
// TODO: encrypt
if (ldbPermissions) {
  syncLevelDb({ db: ldbPermissions, docName: 'permissions', doc: permissionsServerDoc })
}

const server = Server.configure({
  port,
  onAuthenticate,
  onLoadDocument,
})

server.listen()
