import { HocuspocusProvider } from '@hocuspocus/provider'
import { isFunction } from 'lodash'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import DocLogAction from '../../@types/DocLogAction'
import Index from '../../@types/IndexType'
import Lexeme from '../../@types/Lexeme'
import PushBatch from '../../@types/PushBatch'
import State from '../../@types/State'
import Thought from '../../@types/Thought'
import ThoughtDb from '../../@types/ThoughtDb'
import ThoughtId from '../../@types/ThoughtId'
import alert from '../../action-creators/alert'
import createThoughtActionCreator from '../../action-creators/createThought'
import updateThoughtsActionCreator from '../../action-creators/updateThoughts'
import { HOME_TOKEN, SCHEMA_LATEST } from '../../constants'
import { accessToken, tsid, websocketThoughtspace } from '../../data-providers/yjs/index'
import getLexemeSelector from '../../selectors/getLexeme'
import getThoughtByIdSelector from '../../selectors/getThoughtById'
import isContextViewActive from '../../selectors/isContextViewActive'
import thoughtToPath from '../../selectors/thoughtToPath'
import store from '../../stores/app'
import offlineStatusStore from '../../stores/offlineStatusStore'
import syncStatusStore from '../../stores/syncStatus'
import groupObjectBy from '../../util/groupObjectBy'
import hashThought from '../../util/hashThought'
import headValue from '../../util/headValue'
import initialState from '../../util/initialState'
import keyValueBy from '../../util/keyValueBy'
import mergeBatch from '../../util/mergeBatch'
import removeContext from '../../util/removeContext'
import storage from '../../util/storage'
import taskQueue from '../../util/taskQueue'
import thoughtToDb from '../../util/thoughtToDb'
import throttleConcat from '../../util/throttleConcat'
import { DataProvider } from '../DataProvider'
import {
  encodeDocLogDocumentName,
  encodeLexemeDocumentName,
  encodeThoughtDocumentName,
  parseDocumentName,
} from './documentNameEncoder'
import replicationController from './replicationController'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { clearDocument } = require('y-indexeddb') as { clearDocument: (name: string) => Promise<void> }

/**********************************************************************
 * Types
 **********************************************************************/

/** A Lexeme database type that defines contexts as separate keys. */
type LexemeDb = Omit<Lexeme, 'contexts'> & {
  [`cx-{string}`]: boolean
}

// YMap takes a generic type representing the union of values
// Individual values must be explicitly type cast, e.g. thoughtMap.get('childrenMap') as Y.Map<ThoughtId>
type ValueOf<T> = T[keyof T]
type ThoughtYjs = ValueOf<Omit<ThoughtDb, 'childrenMap'> & { childrenMap: Y.Map<ThoughtId> }>
type LexemeYjs = ValueOf<Omit<LexemeDb, 'contexts'> & { contexts: Y.Map<true> }>

/** A partial YMapEvent that can be more easily constructed than a complete YMapEvent. */
interface SimpleYMapEvent<T> {
  target: Y.Map<T>
  transaction: {
    origin: any
  }
}

/** A weak cancellable promise. The cancel function must be added to an existing promise and then cast to a Cancellable Promise. Promise chains created with then are not cancellable. */
interface CancellablePromise<T> extends Promise<T> {
  cancel: () => void
}

/**********************************************************************
 * Constants
 **********************************************************************/

/** Number of milliseconds after which to retry a failed IndexeddbPersistence sync. */
const IDB_ERROR_RETRY = 1000

/** Number of milliseconds to throttle dispatching updateThoughts on thought/lexeme change. */
const UPDATE_THOUGHTS_THROTTLE = 100

/**********************************************************************
 * Helper Functions
 **********************************************************************/

/** Attaches a cancel function to a promise. It is up to you to abort any functionality after the cancel function is called. */
const cancellable = <T>(p: Promise<T>, cancel: () => void) => {
  const promise = p as CancellablePromise<T>
  promise.cancel = cancel
  return promise
}

/** Returns true if the Thought or its parent is in State. */
const isThoughtLoaded = (state: State, thought: Thought | undefined): boolean =>
  !!(thought && (getThoughtByIdSelector(state, thought.parentId) || getThoughtByIdSelector(state, thought.id)))

/** Returns true if the Lexeme or one of its contexts are in State. */
const isLexemeLoaded = (state: State, key: string, lexeme: Lexeme | undefined): boolean =>
  !!((lexeme && getLexemeSelector(state, key)) || lexeme?.contexts.some(cxid => getThoughtByIdSelector(state, cxid)))

/** Dispatches updateThoughts with all updates in the throttle period. */
const updateThoughtsThrottled = throttleConcat<PushBatch, void>((batches: PushBatch[]) => {
  const merged = batches.reduce(mergeBatch, {
    thoughtIndexUpdates: {},
    lexemeIndexUpdates: {},
    lexemeIndexUpdatesOld: {},
  })

  // dispatch on next tick, since the leading edge is synchronous and can be triggered during a reducer
  setTimeout(() => {
    store.dispatch(updateThoughtsActionCreator({ ...merged, local: false, remote: false, repairCursor: true }))
  })
}, UPDATE_THOUGHTS_THROTTLE)

/**********************************************************************
 * Module variables
 **********************************************************************/

// map of all YJS thought Docs loaded into memory
// keyed by ThoughtId
// parallel to thoughtIndex and lexemeIndex
const thoughtDocs: Map<ThoughtId, Y.Doc> = new Map()
const thoughtPersistence: Map<ThoughtId, IndexeddbPersistence> = new Map()
const thoughtWebsocketProvider: Map<ThoughtId, HocuspocusProvider> = new Map()
const thoughtSynced: Map<ThoughtId, Promise<void>> = new Map()
const thoughtWebsocketSynced: Map<ThoughtId, Promise<void>> = new Map()
const lexemeDocs: Map<string, Y.Doc> = new Map()
const lexemePersistence: Map<string, IndexeddbPersistence> = new Map()
const lexemeWebsocketProvider: Map<string, HocuspocusProvider> = new Map()
const lexemeSynced: Map<string, Promise<void>> = new Map()
const lexemeWebsocketSynced: Map<string, Promise<void>> = new Map()

// doclog is an append-only log of all thought ids and lexeme keys that are updated.
// Since Thoughts and Lexemes are stored in separate docs, we need a unified list of all ids to replicate.
// They are stored as Y.Arrays to allow for replication deltas instead of repeating full replications, and regular compaction.
// Deletes must be marked, otherwise there is no way to differentiate it from an update (because there is no way to tell if a websocket has no data for a thought, or just has not yet returned any data.)
const doclog = new Y.Doc()

const doclogPersistence = new IndexeddbPersistence(encodeDocLogDocumentName(tsid), doclog)
doclogPersistence.whenSynced.catch(e => {
  const errorMessage = `Error loading doclog: ${e.message}`
  console.error(errorMessage, e)
  store.dispatch(alert(errorMessage))
})

// eslint-disable-next-line no-new
new HocuspocusProvider({
  websocketProvider: websocketThoughtspace,
  name: encodeDocLogDocumentName(tsid),
  document: doclog,
  token: accessToken,
})

/**********************************************************************
 * Module variables
 **********************************************************************/

const replication = replicationController({
  // begin paused, and only start after initial pull has completed
  autostart: false,
  doc: doclog,
  storage,
  next: async ({ action, id, type }) => {
    if (action === DocLogAction.Update) {
      await (type === 'thought'
        ? replicateThought(id as ThoughtId, { background: true })
        : replicateLexeme(id, { background: true }))
    } else if (action === DocLogAction.Delete) {
      updateThoughtsThrottled({
        thoughtIndexUpdates: {},
        lexemeIndexUpdates: {},
        // override thought/lexemeIndexUpdates based on type
        [`${type}IndexUpdates`]: {
          [id]: null,
        },
        lexemeIndexUpdatesOld: {},
      })

      if (type === 'thought') {
        await deleteThought(id as ThoughtId)
      } else if (type === 'lexeme') {
        await deleteLexeme(id)
      }
    } else {
      throw new Error('Unknown DocLogAction: ' + action)
    }
  },
  onStep: ({ completed, index, total, value }) => {
    syncStatusStore.update({ replicationProgress: completed / total })
  },
  onEnd: () => {
    syncStatusStore.update({ replicationProgress: 1 })
  },
})

// limit the number of thoughts and lexemes that are updated in the Y.Doc at once
const updateQueue = taskQueue<void>({
  // concurrency above 16 make the % go in bursts as batches of tasks are processed and awaited all at once
  // this may vary based on # of cores and network conditions
  concurrency: 16,
  onStep: ({ completed, total }) => {
    syncStatusStore.update({ savingProgress: completed / total })
  },
  onEnd: () => {
    syncStatusStore.update({ savingProgress: 1 })
  },
})

// pause replication during pushing and pulling
syncStatusStore.subscribeSelector(
  ({ isPulling, savingProgress }) => savingProgress < 1 || isPulling,
  isPushingOrPulling => {
    if (isPushingOrPulling) {
      replication.pause()
    } else {
      // because replicationQueue starts paused, this line starts it for the first time after the initial pull
      replication.start()
    }
  },
)

/**********************************************************************
 * Methods
 **********************************************************************/

/** Updates a yjs thought doc. Converts childrenMap to a nested Y.Map for proper children merging. Resolves when transaction is committed and IDB is synced (not when websocket is synced). */
// NOTE: Ids are added to the thought log in updateThoughts for efficiency. If updateThought is ever called outside of updateThoughts, we will need to push individual thought ids here.
const updateThought = async (id: ThoughtId, thought: Thought): Promise<void> => {
  if (!thoughtDocs.has(id)) {
    replicateThought(id)
  }
  const thoughtDoc = thoughtDocs.get(id)!

  // Must add afterTransaction handler BEFORE transact.
  // Resolves after in-memory transaction is complete, not after synced with providers.
  const transactionPromise = new Promise<void>(resolve => thoughtDoc.once('afterTransaction', resolve))

  const idbSynced = thoughtPersistence.get(thought.id)?.whenSynced.catch(e => {
    // AbortError happens if the app is closed during replication.
    // Not sure if the timeout will be preserved, but at least we can retry.
    if (e.name === 'AbortError' || e.message.includes('[AbortError]')) {
      setTimeout(() => {
        updateThought(id, thought)
      }, IDB_ERROR_RETRY)
      return
    }
    const errorMessage = `Error saving thought ${id}: ${e.message}`
    console.error(errorMessage, e)
    store.dispatch(alert(errorMessage))
  })

  thoughtDoc.transact(() => {
    const thoughtMap = thoughtDoc.getMap<ThoughtYjs>()
    Object.entries(thoughtToDb(thought)).forEach(([key, value]) => {
      // merge childrenMap Y.Map
      if (key === 'childrenMap') {
        let childrenMap = thoughtMap.get('childrenMap') as Y.Map<ThoughtId>

        // create new Y.Map for new thought
        if (!childrenMap) {
          childrenMap = new Y.Map()
          thoughtMap.set('childrenMap', childrenMap)
        }

        // delete children from the yjs thought that are no longer in the state thought
        childrenMap.forEach((childKey: string, childId: string) => {
          if (!value[childId]) {
            childrenMap.delete(childId)
          }
        })

        // add children that are not in the yjs thought
        Object.entries(thought.childrenMap).forEach(([key, childId]) => {
          if (!childrenMap.has(key)) {
            childrenMap.set(key, childId)
          }
        })
      }
      // other keys
      else {
        thoughtMap.set(key, value)
      }
    })
  }, thoughtDoc.clientID)

  await Promise.all([transactionPromise, idbSynced])
}

/** Updates a yjs lexeme doc. Converts contexts to a nested Y.Map for proper context merging. Resolves when transaction is committed and IDB is synced (not when websocket is synced). */
// NOTE: Keys are added to the lexeme log in updateLexemes for efficiency. If updateLexeme is ever called outside of updateLexemes, we will need to push individual keys here.
const updateLexeme = async (
  key: string,
  lexemeNew: Lexeme,
  // undefined only if Lexeme is completely new
  lexemeOld: Lexeme | undefined,
): Promise<void> => {
  // get the old Lexeme to determine context deletions
  // TODO: Pass the diffed contexts all the way through from updateThouhgts.
  // The YJS Lexeme should be the same as the old Lexeme in State, since they are synced.
  // If the Lexeme has not yet been loaded from YJS, then we can ignore deletions, as a Lexeme normally cannot be deleted before it has been loaded. Unless the user creates and deletes the Lexeme so quickly that IDB is still loading (?).
  // In light of all that, it would be better to get the deletions directly from the reducer.

  if (!lexemeDocs.has(key)) {
    await replicateLexeme(key)
  }
  const lexemeDoc = lexemeDocs.get(key)
  const lexemeReplicated = getLexeme(lexemeDoc)
  const contextsOld = new Set(lexemeOld?.contexts)

  // The Lexeme may be deleted if the user creates and deletes a thought very quickly
  if (!lexemeDoc) return

  // Must add afterTransaction handler BEFORE transact.
  // Resolves after in-memory transaction is complete, not after synced with providers.
  const transactionPromise = new Promise<void>(resolve => lexemeDoc.once('afterTransaction', resolve))

  const idbSynced = lexemePersistence.get(key)?.whenSynced.catch(e => {
    // AbortError happens if the app is closed during replication.
    // Not sure if the timeout will be preserved, but at least we can retry.
    if (e.name === 'AbortError' || e.message.includes('[AbortError]')) {
      setTimeout(() => {
        updateLexeme(key, lexemeNew, lexemeOld)
      }, IDB_ERROR_RETRY)
      return
    }
    const errorMessage = `Error saving lexeme: ${e.message}`
    console.error(errorMessage, e)
    store.dispatch(alert(errorMessage))
  })

  lexemeDoc.transact(() => {
    const lexemeMap = lexemeDoc.getMap<LexemeYjs>()
    Object.entries(lexemeNew).forEach(([key, value]) => {
      if (key === 'contexts') {
        const contextsNew = new Set(value)

        // add contexts to YJS that have been added to state
        lexemeNew.contexts.forEach(cxid => {
          if (!contextsOld.has(cxid)) {
            lexemeMap.set(`cx-${cxid}`, true)
          }
        })

        // delete contexts that have been deleted, i.e. exist in lexemeOld but not lexemeNew
        lexemeOld?.contexts.forEach(cxid => {
          if (!contextsNew.has(cxid)) {
            lexemeMap.delete(`cx-${cxid}`)
          }
        })
      }
      // other keys
      else {
        lexemeMap.set(key, value)
      }
    })

    // If the Lexeme was pending, we need to update state with the new Lexeme with merged cxids.
    // Otherwise, Redux state can become out of sync with YJS, and additional edits can result in missing Lexeme cxids.
    // (It is not entirely clear how this occurs, as the delete case does not seem to be triggered.)
    if (!lexemeOld && lexemeReplicated) {
      onLexemeChange({
        target: lexemeDoc.getMap(),
        transaction: {
          origin: lexemePersistence.get(key),
        },
      })
    }
  }, lexemeDoc.clientID)

  await Promise.all([transactionPromise, idbSynced])
}

/** Handles the Thought observe event. Ignores events from self. */
const onThoughtChange = (e: SimpleYMapEvent<ThoughtYjs>) => {
  const thoughtDoc = e.target.doc!
  if (e.transaction.origin === thoughtDoc.clientID) return

  const thought = getThought(thoughtDoc)
  if (!thought) return

  store.dispatch((dispatch, getState) => {
    // if parent is pending, the thought must be marked pending.
    // Note: Do not clear pending from the parent, because other children may not be loaded.
    // The next pull should handle that automatically.
    // TODO: Do we need to use fresh State when updateThoughtsThrottled resolves?
    const state = getState()
    const thoughtInState = getThoughtByIdSelector(state, thought.id)
    const parentInState = getThoughtByIdSelector(state, thought.parentId)
    const pending = thoughtInState?.pending || parentInState?.pending

    updateThoughtsThrottled({
      thoughtIndexUpdates: {
        [thought.id]: {
          ...thought,
          ...(pending ? { pending } : null),
        },
      },
      lexemeIndexUpdates: {},
      lexemeIndexUpdatesOld: {},
    })
  })
}

/** Handles the Lexeme observe event. Ignores events from self. */
const onLexemeChange = (e: {
  target: Y.Map<LexemeYjs>
  transaction: {
    origin: any
  }
}) => {
  const lexemeDoc = e.target.doc!
  if (e.transaction.origin === lexemeDoc.clientID) return

  const lexeme = getLexeme(lexemeDoc)
  if (!lexeme) return

  // we can assume id is defined since lexeme doc guids are always in the format `${tsid}/lexeme/${id}`
  const { id: key } = parseDocumentName(lexemeDoc.guid) as { id: string }

  updateThoughtsThrottled({
    thoughtIndexUpdates: {},
    lexemeIndexUpdates: {
      [key]: lexeme,
    },
    lexemeIndexUpdatesOld: {},
  })
}

/** Replicates a thought from the persistence layers to state, IDB, and the Websocket server. Does nothing if the thought is already replicated, or is being replicated. Otherwise creates a new, empty YDoc that can be updated concurrently while replicating. */
export const replicateThought = async (
  id: ThoughtId,
  {
    background,
    remote = true,
  }: {
    /**
     * Replicate in the background, meaning:
     * - *Do not update Redux state.
     * - Do not store thought doc in memory.
     * - Destroy IndexedDBPersistence after sync.
     * - Destroy HocuspocusProvider after sync.
     * *Redux state *will* be updated if the thought is already loaded. This ensures that remote changes are rendered.
     */
    background?: boolean
    /** Sync with websocket server. Default: true. This is currently set to false during export. */
    remote?: boolean
  } = {},
): Promise<Thought | undefined> => {
  const documentName = encodeThoughtDocumentName(tsid, id)
  const doc = thoughtDocs.get(id) || new Y.Doc({ guid: documentName })
  const thoughtMap = doc.getMap<ThoughtYjs>()

  // if the doc has already been initialized and added to thoughtDocs, return immediately
  // disable y-indexeddb during tests because of TransactionInactiveError in fake-indexeddb
  // disable hocuspocus during tests because of infinite loop in sinon runAllAsync
  if (thoughtDocs.get(id) || process.env.NODE_ENV === 'test') {
    const idbSynced = thoughtSynced.get(id)
    const websocketSynced = thoughtWebsocketSynced.get(id)
    return Promise.all([idbSynced, background ? websocketSynced : null]).then(() => getThought(doc))
  }

  // set up idb and websocket persistence and subscribe to changes
  const persistence = new IndexeddbPersistence(documentName, doc)
  const websocketProvider = remote
    ? new HocuspocusProvider({
        websocketProvider: websocketThoughtspace,
        name: documentName,
        document: doc,
        token: accessToken,
      })
    : null

  const websocketSynced = websocketProvider
    ? new Promise<void>(resolve => {
        /** Resolves when synced fires. */
        const onSynced = () => {
          websocketProvider.off('synced', onSynced)
          resolve()
        }
        websocketProvider.on('synced', onSynced)
      })
    : null

  const idbSynced = persistence.whenSynced
    .then(() => {
      // If the websocket is still connecting for the first time when IDB is synced and non-empty, change the status to reconnecting to dismiss "Connecting..." and render the available thoughts. See: NoThoughts.tsx.
      if (!background && id === HOME_TOKEN) {
        const rootThought = getThought(doc)
        const hasRootChildren = Object.keys(rootThought?.childrenMap || {}).length > 0
        if (hasRootChildren) {
          offlineStatusStore.update(statusOld =>
            statusOld === 'preconnecting' || statusOld === 'connecting' ? 'reconnecting' : statusOld,
          )
        }
      }
    })
    .catch(e => {
      // AbortError happens if the app is closed during replication.
      // Not sure if the timeout will be preserved, but we can at least try to re-replicate.
      if (e.name === 'AbortError' || e.message.includes('[AbortError]')) {
        freeThought(id)
        setTimeout(() => {
          replicateThought(id, { background, remote })
        }, IDB_ERROR_RETRY)
        return
      }
      const errorMessage = `Error loading thought ${id}: ${e.message}`
      console.error(errorMessage, e)
      store.dispatch(alert(errorMessage))
    })

  // if foreground replication (i.e. pull), set thoughtDocs entry so that further calls to replicateThought will not re-replicate
  if (!background) {
    thoughtDocs.set(id, doc)
    thoughtSynced.set(id, idbSynced)
    thoughtPersistence.set(id, persistence)
    if (websocketProvider) {
      thoughtWebsocketProvider.set(id, websocketProvider)
      thoughtWebsocketSynced.set(id, websocketSynced!)
    }
  }

  // always wait for IDB to sync
  await idbSynced

  // if background replication, wait until websocket has synced
  if (background) {
    if (remote) {
      await websocketSynced
    }

    // After the initial replication, if the thought or its parent is already loaded, update Redux state, even in background mode.
    // Otherwise remote changes will not be rendered.
    const thought = getThought(doc)
    if (isThoughtLoaded(store.getState(), thought)) {
      thoughtDocs.set(id, doc)
      thoughtSynced.set(id, idbSynced)
      thoughtPersistence.set(id, persistence)
      if (websocketProvider) {
        thoughtWebsocketProvider.set(id, websocketProvider)
      }
      onThoughtChange({
        target: doc.getMap(),
        transaction: {
          origin: websocketProvider,
        },
      })
      thoughtMap.observe(onThoughtChange)
    } else {
      doc.destroy()
      websocketProvider?.destroy()
      return thought
    }
  } else {
    // During foreground replication, if there is no value in IndexedDB, wait for the websocket to sync before resolving.
    // Otherwise, db.getThoughtById will return undefined to getDescendantThoughts and the pull will end prematurely.
    // This can be observed when a thought appears pending on load and its child is missing.
    if (!getThought(doc) && offlineStatusStore.getState() !== 'offline') {
      // abort websocketSynced if the user goes offline
      let unsubscribe: null | (() => void) = null
      const offline = new Promise<void>(resolve => {
        unsubscribe = offlineStatusStore.subscribe(status => {
          if (status === 'offline') {
            unsubscribe?.()
            resolve()
          }
        })
      })
      await Promise.race([websocketSynced, offline]).then(unsubscribe)
    }

    // Note: onThoughtChange is not pending-aware.
    // Subscribe to changes after first sync to ensure that pending is set properly.
    // If thought is updated as non-pending first (i.e. before pull), then mergeUpdates will not set pending by design.
    thoughtMap.observe(onThoughtChange)
  }

  // repair
  websocketSynced?.then(() => repairThought(id, doc))

  return getThought(doc)
}

/** Replicates a Lexeme from the persistence layers to state, IDB, and the Websocket server. Does nothing if the Lexeme is already replicated, or is being replicated. Otherwise creates a new, empty YDoc that can be updated concurrently while syncing. */
export const replicateLexeme = async (
  key: string,
  {
    background,
  }: {
    /**
     * Do not store thought doc in memory.
     * Do not update thoughtIndex.
     * Destroy IndexedDBPersistence after sync.
     * Destroy HocuspocusProvider after sync.
     */
    background?: boolean
  } = {},
): Promise<Lexeme | undefined> => {
  const documentName = encodeLexemeDocumentName(tsid, key)
  const doc = lexemeDocs.get(key) || new Y.Doc({ guid: documentName })
  const lexemeMap = doc.getMap<LexemeYjs>()

  // set up persistence and subscribe to changes
  // disable during tests because of TransactionInactiveError in fake-indexeddb
  // disable during tests because of infinite loop in sinon runAllAsync
  if (lexemeDocs.get(key) || process.env.NODE_ENV === 'test') {
    const idbSynced = lexemeSynced.get(key)
    const websocketSynced = lexemeWebsocketSynced.get(key)
    return Promise.all([idbSynced, background ? websocketSynced : null]).then(() => getLexeme(doc))
  }

  // set up idb and websocket persistence and subscribe to changes
  const persistence = new IndexeddbPersistence(documentName, doc)
  const websocketProvider = new HocuspocusProvider({
    websocketProvider: websocketThoughtspace,
    name: documentName,
    document: doc,
    token: accessToken,
  })

  const websocketSynced = new Promise<void>(resolve => {
    /** Resolves when synced fires. */
    const onSynced = () => {
      websocketProvider.off('synced', onSynced)
      resolve()
    }
    websocketProvider.on('synced', onSynced)
  })

  // if replicating in the background, destroy the IndexeddbProvider once synced
  const idbSynced = persistence.whenSynced.catch(e => {
    // AbortError happens if the app is closed during replication.
    // Not sure if the timeout will be preserved, but we can at least try to re-replicate.
    if (e.name === 'AbortError' || e.message.includes('[AbortError]')) {
      freeLexeme(key)
      setTimeout(() => {
        replicateLexeme(key, { background })
      }, IDB_ERROR_RETRY)
      return
    }
    const errorMessage = `Error loading lexeme ${key}: ${e.message}`
    console.error(errorMessage, e)
    store.dispatch(alert(errorMessage))
  }) as Promise<void>

  // if foreground replication (i.e. pull), set the lexemeDocs entry so that further calls to replicateLexeme will not re-replicate
  if (!background) {
    lexemeDocs.set(key, doc)
    lexemeSynced.set(key, idbSynced)
    lexemeWebsocketSynced.set(key, websocketSynced)
    lexemePersistence.set(key, persistence)
    lexemeWebsocketProvider.set(key, websocketProvider)
  }

  // Start observing before websocketSynced since we don't need to worry about pending (See: replicateThought).
  // This will be unobserved in background replication.
  lexemeMap.observe(onLexemeChange)

  // always wait for IDB to sync
  await idbSynced

  if (background) {
    // do not resolve background replication until websocket has synced
    await websocketSynced

    // After the initial replication, if the lexeme or any of its contexts are already loaded, update Redux state, even in background mode.
    // Otherwise remote changes will not be rendered.
    if (isLexemeLoaded(store.getState(), key, getLexeme(doc))) {
      lexemeDocs.set(key, doc)
      lexemeSynced.set(key, idbSynced)
      lexemePersistence.set(key, persistence)
      lexemeWebsocketProvider.set(key, websocketProvider)
      onLexemeChange({
        target: doc.getMap(),
        transaction: {
          origin: websocketProvider,
        },
      })
    } else {
      // destroy the providers once fully synced
      const lexeme = getLexeme(doc)
      lexemeMap.unobserve(onLexemeChange)
      doc.destroy()
      websocketProvider.destroy()
      return lexeme
    }
  }

  return getLexeme(doc)
}

/** Gets a Thought from a thought Y.Doc. */
const getThought = (thoughtDoc: Y.Doc | undefined): Thought | undefined => {
  if (!thoughtDoc) return
  const thoughtMap = thoughtDoc.getMap()
  if (thoughtMap.size === 0) return
  const thoughtRaw = thoughtMap.toJSON()
  return {
    ...thoughtRaw,
    // TODO: Why is childrenMap sometimes a YMap and sometimes a plain object?
    // toJSON is not recursive so we need to toJSON childrenMap as well
    // It is possible that this was fixed in later versions of yjs after v13.5.41
    childrenMap: thoughtRaw.childrenMap.toJSON ? thoughtRaw.childrenMap.toJSON() : thoughtRaw.childrenMap,
  } as Thought
}

/** Gets a Lexeme from a lexeme Y.Doc. */
const getLexeme = (lexemeDoc: Y.Doc | undefined): Lexeme | undefined => {
  if (!lexemeDoc) return
  const lexemeMap = lexemeDoc.getMap()
  if (lexemeMap.size === 0) return
  const lexemeRaw = lexemeMap.toJSON() as LexemeDb
  const lexeme = Object.entries(lexemeRaw).reduce<Partial<Lexeme>>(
    (acc, [key, value]) => {
      const cxid = key.split('cx-')[1] as ThoughtId | undefined
      return {
        ...acc,
        [cxid ? 'contexts' : key]: cxid ? [...(acc.contexts || []), cxid] : value,
      }
    },
    { contexts: [] },
  )
  return lexeme as Lexeme
}

/** Destroys the thoughtDoc and associated providers without deleting the persisted data. */
export const freeThought = (id: ThoughtId): void => {
  // Destroying the doc does not remove top level shared type observers, so we need to unobserve onLexemeChange.
  // YJS logs an error if the event handler does not exist, which can occur when rapidly deleting thoughts.
  // Unfortunately there is no way to catch this, since YJS logs it directly to the console, so we have to override the YJS internals.
  // https://github.com/yjs/yjs/blob/5db1eed181b70cb6a6d7eab66c7e6d752f70141a/src/utils/EventHandler.js#L58
  const thoughtMap: Y.Map<ThoughtYjs> | undefined = thoughtDocs.get(id)?.getMap<ThoughtYjs>()
  const listeners = thoughtMap?._eH.l.slice(0) || []
  if (listeners.some(l => l === onThoughtChange)) {
    thoughtMap?.unobserve(onThoughtChange)
  }

  // IndeeddbPersistence is automatically destroyed when the Doc is destroyed, but HocuspocusProvider is not
  thoughtDocs.get(id)?.destroy()
  thoughtWebsocketProvider.get(id)?.destroy()
  thoughtDocs.delete(id)
  thoughtPersistence.delete(id)
  thoughtSynced.delete(id)
  thoughtWebsocketProvider.delete(id)
}

/** Deletes a thought and clears the doc from IndexedDB. Resolves when local database is deleted. */
const deleteThought = async (id: ThoughtId): Promise<void> => {
  const persistence = thoughtPersistence.get(id)

  try {
    // if there is no persistence in memory (e.g. because the thought has not been loaded or has been deallocated by freeThought), then we need to manually delete it from the db
    const deleted = persistence ? persistence.clearData() : clearDocument(encodeThoughtDocumentName(tsid, id))
    freeThought(id)
    await deleted
  } catch (e: any) {
    // Ignore NotFoundError, which indicates that the object stores have already been deleted.
    // This is currently expected on load, when the thoughtReplicationCursor is synced with the doclog
    // TODO: Update the thoughtReplicationCursor immediateley rather than waiting till the next reload (is the order of updates preserved even when integrating changes from other clients?)
    if (e.name !== 'NotFoundError') {
      throw e
    }
  }
}

/** Destroys the lexemeDoc and associated providers without deleting the persisted data. */
export const freeLexeme = (key: string): void => {
  // Destroying the doc does not remove top level shared type observers, so we need to unobserve onLexemeChange.
  // YJS logs an error if the event handler does not exist, which can occur when rapidly deleting thoughts.
  // Unfortunately there is no way to catch this, since YJS logs it directly to the console, so we have to override the YJS internals.
  // https://github.com/yjs/yjs/blob/5db1eed181b70cb6a6d7eab66c7e6d752f70141a/src/utils/EventHandler.js#L58
  const lexemeMap: Y.Map<LexemeYjs> | undefined = lexemeDocs.get(key)?.getMap<LexemeYjs>()
  const listeners = lexemeMap?._eH.l.slice(0) || []
  if (listeners.some(l => l === onLexemeChange)) {
    lexemeMap?.unobserve(onLexemeChange)
  }

  // IndeeddbPersistence is automatically destroyed when the Doc is destroyed, but HocuspocusProvider is not
  lexemeDocs.get(key)?.destroy()
  lexemeWebsocketProvider.get(key)?.destroy()
  lexemeDocs.delete(key)
  lexemePersistence.delete(key)
  lexemeSynced.delete(key)
  lexemeWebsocketProvider.delete(key)
}

/** Deletes a Lexeme and clears the doc from IndexedDB. The server-side doc will eventually get deleted by the doclog replicationController. Resolves when the local database is deleted. */
const deleteLexeme = async (key: string): Promise<void> => {
  const persistence = lexemePersistence.get(key)

  // When deleting a Lexeme, clear out the contexts first to ensure that if a new Lexeme with the same key gets created, it doesn't accidentally pull the old contexts.
  const lexemeOld = getLexeme(lexemeDocs.get(key) || persistence?.doc || lexemeWebsocketProvider.get(key)?.document)
  if (lexemeOld) {
    await updateLexeme(key, { ...lexemeOld, contexts: [] }, lexemeOld)
  }

  try {
    // if there is no persistence in memory (e.g. because the thought has not been loaded or has been deallocated by freeThought), then we need to manually delete it from the db
    const deleted = persistence ? persistence.clearData() : clearDocument(encodeLexemeDocumentName(tsid, key))
    freeLexeme(key)
    await deleted
  } catch (e: any) {
    // See: deleteThought NotFoundError handler
    if (e.name !== 'NotFoundError') {
      throw e
    }
  }
}

/** Updates shared thoughts and lexemes. Resolves when IDB is synced (not when websocket is synced). */
// Note: Does not await updates, but that could be added.
export const updateThoughts = ({
  thoughtIndexUpdates,
  lexemeIndexUpdates,
  lexemeIndexUpdatesOld,
  schemaVersion,
}: {
  thoughtIndexUpdates: Index<ThoughtDb | null>
  lexemeIndexUpdates: Index<Lexeme | null>
  lexemeIndexUpdatesOld: Index<Lexeme | undefined>
  schemaVersion: number
}) => {
  // group thought updates and deletes so that we can use the db bulk functions
  const { update: thoughtUpdates, delete: thoughtDeletes } = groupObjectBy(thoughtIndexUpdates, (id, thought) =>
    thought ? 'update' : 'delete',
  ) as {
    update?: Index<ThoughtDb>
    delete?: Index<null>
  }

  // group lexeme updates and deletes so that we can use the db bulk functions
  const { update: lexemeUpdates, delete: lexemeDeletes } = groupObjectBy(lexemeIndexUpdates, (id, lexeme) =>
    lexeme ? 'update' : 'delete',
  ) as {
    update?: Index<Lexeme>
    delete?: Index<null>
  }

  const updatePromise = updateQueue.add([
    ...Object.entries(thoughtUpdates || {}).map(
      ([id, thought]) =>
        () =>
          updateThought(id as ThoughtId, thought),
    ),
    ...Object.entries(lexemeUpdates || {}).map(
      ([key, lexeme]) =>
        () =>
          updateLexeme(key, lexeme, lexemeIndexUpdatesOld[key]),
    ),
  ])

  // When thought ids are pushed to the doclog, the first log is trimmed if it matches the last log.
  // This is done to reduce the growth of the doclog during the common operation of editing a single thought.
  // The only cost is that any clients that go offline will not replicate a delayed contiguous edit when reconnecting.
  const ids = Object.keys(thoughtIndexUpdates || {}) as ThoughtId[]
  const thoughtLogs: [ThoughtId, DocLogAction][] = ids.map(id => [
    id,
    thoughtIndexUpdates[id] ? DocLogAction.Update : DocLogAction.Delete,
  ])

  const keys = Object.keys(lexemeIndexUpdates || {})
  const lexemeLogs: [string, DocLogAction][] = keys.map(key => [
    key,
    lexemeIndexUpdates[key] ? DocLogAction.Update : DocLogAction.Delete,
  ])

  // eslint-disable-next-line fp/no-mutating-methods
  replication.log({ thoughtLogs, lexemeLogs })
  const deletePromise = updateQueue.add([
    ...(Object.keys(thoughtDeletes || {}) as ThoughtId[]).map(id => () => deleteThought(id)),
    ...Object.keys(lexemeDeletes || {}).map(key => () => deleteLexeme(key)),
  ])

  return Promise.all([updatePromise, deletePromise])
}

/** Clears all thoughts and lexemes from the db. */
export const clear = async () => {
  const deleteThoughtPromises = Array.from(thoughtDocs, ([id, doc]) => deleteThought(id as ThoughtId))
  const deleteLexemePromises = Array.from(lexemeDocs, ([key, doc]) => deleteLexeme(key))

  await Promise.all([...deleteThoughtPromises, ...deleteLexemePromises])

  // reset to initialState, otherwise a missing ROOT error will occur when thought observe is triggered
  const state = initialState()
  const thoughtIndexUpdates = keyValueBy(state.thoughts.thoughtIndex, (id, thought) => ({
    [id]: thoughtToDb(thought),
  }))
  const lexemeIndexUpdates = state.thoughts.lexemeIndex

  await updateThoughts({
    thoughtIndexUpdates,
    lexemeIndexUpdates,
    lexemeIndexUpdatesOld: {},
    schemaVersion: SCHEMA_LATEST,
  })
}

/** Gets a thought from the thoughtIndex. Replicates the thought if not already done. */
export const getLexemeById = (key: string) => replicateLexeme(key)

/** Gets multiple thoughts from the lexemeIndex by key. */
export const getLexemesByIds = (keys: string[]): Promise<(Lexeme | undefined)[]> => Promise.all(keys.map(getLexemeById))

/** Gets a thought from the thoughtIndex. Replicates the thought if not already done. */
export const getThoughtById = (id: ThoughtId) => replicateThought(id)

/** Gets multiple contexts from the thoughtIndex by ids. O(n). */
export const getThoughtsByIds = (ids: ThoughtId[]): Promise<(Thought | undefined)[]> =>
  Promise.all(ids.map(getThoughtById))

/** Replicates an entire subtree, starting at a given thought. Replicates in the background (not populating the Redux state). Does not wait for Websocket to sync. */
export const replicateTree = (
  id: ThoughtId,
  {
    remote = true,
    onThought,
  }: {
    /** Sync with Websocket. Default: true. */
    remote?: boolean
    onThought?: (thought: Thought, thoughtIndex: Index<Thought>) => void
  } = {},
): CancellablePromise<Index<Thought>> => {
  // no significant performance gain above concurrency 4
  const queue = taskQueue<void>({ concurrency: 4 })
  const thoughtIndex: Index<Thought> = {}
  let abort = false

  /** Creates a task to replicate a thought and add it to the thoughtIndex. Queues up children replication. */
  const replicateTask = (id: ThoughtId) => async () => {
    const thought = await replicateThought(id, { background: true, remote })
    if (!thought || abort) return
    thoughtIndex[id] = thought
    onThought?.(thought, thoughtIndex)

    queue.add(Object.values(thought.childrenMap).map(replicateTask))
  }

  queue.add([replicateTask(id)])

  // return a promise that can cancel the replication
  const promise = queue.end.then(() => thoughtIndex)
  return cancellable(promise, () => {
    queue.clear()
    abort = true
  })
}

/** Checks for and repairs data integrity issues that are detected after a thought is fully replicated. Namely, it can remove Lexeme contexts that no longer have a corresponding thought, and it can restore Lexeme context parent's that have been removed. Unfortunately, data integrity issues are quite possible given that Thoughts and Lexemes are stored in separate Docs. */
const repairThought = (id: ThoughtId, doc: Y.Doc) => {
  // Repair Lexeme with invalid context by removing cxid of missing thought.
  // This can happen if thoughts with the same value are rapidly created and deleted, though it is rare.
  const state = store.getState()
  const cursorValue = state.cursor ? headValue(state, state.cursor) : null
  const cursorLexeme =
    state.cursor && isContextViewActive(state, state.cursor) ? getLexemeSelector(state, cursorValue!) : null

  if (cursorLexeme?.contexts.includes(id)) {
    const thought = getThought(doc)

    // check for missing context
    // a thought should never be undefined after IDB and the Websocket server have synced
    if (!thought) {
      console.warn(`Thought ${id} missing from IndexedDB and Websocket server.`)

      store.dispatch(
        updateThoughtsActionCreator({
          thoughtIndexUpdates: {},
          lexemeIndexUpdates: {
            [hashThought(cursorValue!)]: removeContext(state, cursorLexeme, id),
          },
        }),
      )
      console.warn(`Removed context ${id} from Lexeme ${cursorLexeme.lemma} with no corresponding thought.`, {
        cursorLexeme,
      })
    }
    // repair invalid parent
    else {
      // replicating the parent should use the cached synced promise
      replicateThought(thought.parentId, { background: true }).then(parent => {
        if (parent) {
          const childKey = isFunction(thought.value) ? thought.value : thought.id
          if (!parent.childrenMap[childKey]) {
            // restore thought to parent
            store.dispatch((dispatch, getState) => {
              dispatch([
                // delete the thought from its Lexeme first, as it may be incorrect and it will be recreated in createThought
                updateThoughtsActionCreator({
                  thoughtIndexUpdates: {},
                  lexemeIndexUpdates: {
                    [hashThought(cursorValue!)]: removeContext(getState(), cursorLexeme, id),
                  },
                }),
                // add the missing thought to its parent
                createThoughtActionCreator({
                  id: thought.id,
                  path: thoughtToPath(getState(), parent.id),
                  value: thought.value,
                  rank: thought.rank,
                }),
              ])
            })
            console.warn(
              `Repaired invalid Lexeme context: Thought ${id} restored to its parent ${thought.parentId} after not found in providers.`,
            )
          }
        } else {
          console.error(`Thought ${id} has a missing parent ${thought.parentId}.`)
        }
      })
    }
  }
}

const db: DataProvider = {
  clear,
  freeLexeme,
  freeThought,
  getLexemeById,
  getLexemesByIds,
  getThoughtById,
  getThoughtsByIds,
  updateThoughts,
}

export default db
