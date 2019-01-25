/* eslint-disable jsx-a11y/accessible-emoji */
import React from 'react'
import { Provider, connect } from 'react-redux'
import { createStore } from 'redux'
import ContentEditable from 'react-contenteditable'
import { encode as firebaseEncode, decode as firebaseDecode } from 'firebase-encode'

import * as pkg from '../package.json'
import './App.css'
import logo from './logo-black.png'
import logoDark from './logo-white.png'
import logoInline from './logo-black-inline.png'
import logoDarkInline from './logo-white-inline.png'


/**************************************************************
 * Debug
 **************************************************************/

// setInterval(() => {
//   console.info("timestamp", timestamp())
// }, 1000)

// let debugCounter = 0
// const debugCount = () => <span className='debug'> {globalCounter = (globalCounter + 1) % 1000}</span>


/**************************************************************
 * Globals
 **************************************************************/

// maximum number of characters of children to allow expansion
const NESTING_CHAR_MAX = 250

// ms on startup before offline mode is enabled
const OFFLINE_TIMEOUT = 3000

const RENDER_DELAY = 50

const MAX_DISTANCE_FROM_CURSOR = 3

const HELPER_REMIND_ME_LATER_DURATION = 1000 * 60 * 60 * 2 // 2 hours
const HELPER_REMIND_ME_TOMORROW_DURATION = 1000 * 60 * 60 * 20 // 20 hours
const HELPER_CLOSE_DURATION = 1000//1000 * 60 * 5 // 5 minutes
const HELPER_NEWCHILD_DELAY = 1800
const HELPER_AUTOFOCUS_DELAY = 2400
const HELPER_SUPERSCRIPT_SUGGESTOR_DELAY = 1000 * 30
const HELPER_SUPERSCRIPT_DELAY = 800
const HELPER_CONTEXTVIEW_DELAY = 1800

const FADEOUT_DURATION = 400

const IS_MOBILE = /Mobile/.test(navigator.userAgent)

const firebaseConfig = {
  apiKey: "AIzaSyB7sj38woH-oJ7hcSwpq0lB7hUteyZMxNo",
  authDomain: "em-proto.firebaseapp.com",
  databaseURL: "https://em-proto.firebaseio.com",
  projectId: "em-proto",
  storageBucket: "em-proto.appspot.com",
  messagingSenderId: "91947960488"
}

// holds the timeout that waits for a certain amount of time after an edit before showing the newChild and superscript helpers
let newChildHelperTimeout
let autofocusHelperTimeout
let superscriptHelperTimeout


/**************************************************************
 * Initial State
 **************************************************************/

const initialState = {
  status: 'connecting',
  focus: decodeItemsUrl(),
  from: getFromFromUrl(),
  showContexts: decodeUrlContexts(),
  data: {
    root: {}
  },
  settings: {
    dark: JSON.parse(localStorage['settings-dark'] || 'false')
  },
  // cheap trick to re-render when data has been updated
  dataNonce: 0,
  helpers: {}
}

// initial data
for (let key in localStorage) {
  if (key.startsWith('data-')) {
    const value = key.substring(5)
    initialState.data[value] = JSON.parse(localStorage[key])
  }
}

// initial helper states
const helpers = ['welcome', 'home', 'newItem', 'newChild', 'newChildSuccess', 'autofocus', 'superscriptSuggestor', 'superscript', 'contextView', 'editIdentum', 'depthBar']
for (let i = 0; i < helpers.length; i++) {
  initialState.helpers[helpers[i]] = {
    complete: JSON.parse(localStorage['helper-complete-' + helpers[i]] || 'false'),
    hideuntil: JSON.parse(localStorage['helper-hideuntil-' + helpers[i]] || '0')
  }
}

// welcome helper
if (canShowHelper('welcome', initialState)) {
  initialState.showHelper = 'welcome'
}
// contextView helper
else if(canShowHelper('contextView')) {
  const items = decodeItemsUrl()
  if(!isRoot(items)) {
    initialState.showHelper = 'contextView'
    initialState.helperData = signifier(items)
  }
}


/**************************************************************
 * Helper Functions
 **************************************************************/

// parses the items from the url
// declare using traditional function syntax so it is hoisted
function decodeItemsUrl() {
  const urlComponents = window.location.pathname.slice(1)
  return urlComponents
    ? urlComponents.split('/').map(component => window.decodeURIComponent(component))
    : ['root']
}

const encodeItemsUrl = (items, from, showContexts) =>
  '/' + (isRoot(items)
    ? ''
    : items.map(item =>
      window.encodeURIComponent(item)).join('/')) +
      (from && from.length > 0
        ? '?from=' + window.encodeURIComponent(from.join('/'))
        : '') +
      (showContexts
        ? ((from && from.length > 0 ? '&' : '?') + 'contexts=true')
        : '')

// declare using traditional function syntax so it is hoisted
function getFromFromUrl() {
  const from = (new URL(document.location)).searchParams.get('from')
  return from
    ? from.split('/')
      .map(item => window.decodeURIComponent(item))
    : null
}

// declare using traditional function syntax so it is hoisted
function decodeUrlContexts() {
  return (new URL(document.location)).searchParams.get('contexts') === 'true'
}

const timestamp = () => (new Date()).toISOString()

/** Equality for lists of lists. */
const equalArrays = (a, b) =>
  a === b ||
  (a && b &&
  a.length === b.length &&
  a.every && b.every &&
  a.every(itemA => b.includes(itemA)) &&
  b.every(itemB => a.includes(itemB)))

const equalItemRanked = (a, b) =>
  a === b || (a && b && a.key === b.key && a.rank === b.rank)

const equalItemsRanked = (a, b) =>
  a && b && a.length === b.length && a.every && a.every((_, i) => equalItemRanked(a[i], b[i]))

/** Returns the index of the first element in list that starts with items. */
const deepIndexContains = (items, list) => {
  for(let i=0; i<list.length; i++) {
    // NOTE: this logic is probably not correct. It is unclear why the match is in the front of the list sometimes and at the end other times. It depends on from. Nevertheless, it is "working" at least for typical use cases.
    if (
      // items at beginning of list
      equalArrays(items, list[i].slice(0, items.length)) ||
      // items at end of list
      equalArrays(items, list[i].slice(list[i].length - items.length))
    ) return i
  }
  return -1
}

// gets a unique list of parents
// const uniqueParents = memberOf => {
//   const output = []
//   const dict = {}
//   for (let i=0; i<memberOf.length; i++) {
//     let key = memberOf[i].context.join('___SEP___')
//     if (!dict[key]) {
//       dict[key] = true
//       output.push(memberOf[i])
//     }
//   }
//   return output
// }

const flatMap = (list, f) => Array.prototype.concat.apply([], list.map(f))

/** Sums the length of all items in the list of items. */
// works on children with key or context
const sumChildrenLength = children => children.reduce((accum, child) => accum + ('key' in child ? child.key.length : signifier(child.context).length), 0)

// sorts the given item to the front of the list
const sortToFront = (items, listItemsRanked) => {
  if (listItemsRanked.length === 0) return []
  const list = listItemsRanked.map(unrank)
  const i = deepIndexContains(items, list)
  if (i === -1) throw new Error(`[${items}] not found in [${list.map(items => '[' + items + ']')}]`)
  return [].concat(
    [listItemsRanked[i]],
    listItemsRanked.slice(0, i),
    listItemsRanked.slice(i + 1)
  )
}

const compareByRank = (a, b) =>
  a.rank > b.rank ? 1 :
  a.rank < b.rank ? -1 :
  0

// sorts items emoji and whitespace insensitive
// const sorter = (a, b) =>
//   emojiStrip(a.toString()).trim().toLowerCase() >
//   emojiStrip(b.toString()).trim().toLowerCase() ? 1 : -1

// gets the signifying label of the given context.
// declare using traditional function syntax so it is hoisted
function signifier(items) { return items[items.length - 1] }

// returns true if the signifier of the given context exists in the data
const exists = items => !!store.getState().data[signifier(items)]

// gets the intersections of the given context; i.e. the context without the signifier
const intersections = items => items.slice(0, items.length - 1)

/** Returns a list of unique contexts that the given item is a member of. */
const getContexts = items => {
  const key = signifier(items)
  const cache = {}
  if (!exists(items)) {
    console.error(`getContexts: Unknown key "${key}", from context: ${items.join(',')}`)
    return []
  }
  return (store.getState().data[key].memberOf || [])
    .filter(member => {
      const exists = cache[encodeItems(member.context)]
      cache[encodeItems(member.context)] = true
      // filter out items that exist
      return !exists
    })
}

/** Returns a subset of items from the start to the given item (inclusive) */
const ancestors = (items, item) => items.slice(0, items.indexOf(item) + 1)

/** Returns a subset of items without all ancestors up to the given time (exclusive) */
// const disown = (items, item) => items.slice(items.indexOf(item))

/** Returns a subset of items without all ancestors up to the given time (exclusive) */
const unroot = (items, item) => isRoot(items.slice(0, 1))
  ? items.slice(1)
  : items

/** Returns true if the items or itemsRanked is the root item. */
// declare using traditional function syntax so it is hoisted
function isRoot(items) {
  return items.length === 1 && items[0] && (items[0].key === 'root' || items[0] === 'root')
}

// generates a flat list of all descendants
const getDescendants = (items, recur/*INTERNAL*/) => {
  const children = getChildrenWithRank(items)
  // only append current item in recursive calls
  return (recur ? [signifier(items)] : []).concat(
    flatMap(children, child => getDescendants(items.concat(child.key), true))
  )
}

// generates children with their ranking
// TODO: cache for performance, especially of the app stays read-only
const getChildrenWithRank = (items, data) => {
  data = data || store.getState().data
  return flatMap(Object.keys(data), key =>
    ((data[key] || []).memberOf || [])
      // .sort(compareByRank)
      // .map(member => { return member.context || member }) // TEMP: || member for backwards compatibility
      .map(member => {
        if (!member) {
          throw new Error(`Key "${key}" has  null parent`)
        }
        return {
          key,
          rank: member.rank || 0,
          isMatch: equalArrays(items, member.context || member)
        }
      })
    )
    // filter out non-matches
    .filter(match => match.isMatch)
    // remove isMatch attribute
    .map(({ key, rank}) => ({
      key,
      rank
    }))
    // sort by rank
    .sort(compareByRank)
}

// gets a new rank before the given item in a list but after the previous item
const getRankBefore = (value, context, rank) => {
  const children = getChildrenWithRank(context)
  const i = children.findIndex(child => child.key === value && child.rank === rank)

  const prevChild = children[i - 1]
  const nextChild = children[i]

  const newRank = prevChild
    ? (prevChild.rank + nextChild.rank) / 2
    : nextChild.rank - 1

  return newRank
}


// gets a new rank after the given item in a list but before the following item
const getRankAfter = (value, context, rank) => {
  const children = getChildrenWithRank(context)
  let i = children.findIndex(child => child.key === value && child.rank === rank)

  // quick hack for context view when rank has been supplied as 0
  if (i === -1) {
    i = children.findIndex(child => child.key === value)
  }

  const prevChild = children[i]
  const nextChild = children[i + 1]

  const newRank = nextChild
    ? (prevChild.rank + nextChild.rank) / 2
    : prevChild.rank + 1

  return newRank
}

// gets an items's previous sibling with its rank
const prevSibling = (value, context, rank) => {
  const siblings = getChildrenWithRank(context)
  let prev
  siblings.find(child => {
    if (child.key === value && child.rank === rank) {
      return true
    }
    else {
      prev = child
      return false
    }
  })
  return prev
}

// gets a rank that comes before all items in a context
const getPrevRank = (items, data) => {
  const children = getChildrenWithRank(items, data)
  return children.length > 0
    ? children[0].rank - 1
    : 0
}

// gets the next rank at the end of a list
const getNextRank = (items, data) => {
  const children = getChildrenWithRank(items, data)
  return children.length > 0
    ? children[children.length - 1].rank + 1
    : 0
}

const fillRank = items => items.map(item => ({ key: item, rank: 0 }))
const unrank = items => items.map(child => child.key)

// derived children are all grandchildren of the parents of the given context
// signifier rank is accurate; all other ranks are filled in 0
const getDerivedChildren = items =>
  getContexts(items)
    .filter(member => !isRoot(member))
    .map(member => fillRank(member.context).concat({
      key: signifier(items),
      rank: member.rank
    }))

/** Returns a new item less the given context. */
const removeContext = (item, context, rank) => {
  if (typeof item === 'string') throw new Error('removeContext expects an [object] item, not a [string] value.')
  return {
      value: item.value,
      memberOf: item.memberOf.filter(parent =>
        !(equalArrays(parent.context, context) && (rank == null || parent.rank === rank))
      ),
      lastUpdated: timestamp()
    }
}

// encode the items (and optionally rank) as a string for use in a className
const encodeItems = (items, rank) => items
  .map(item => item ? item.replace(/ /g, '_') : '')
  .join('__SEP__')
  + (rank ? '__SEP__' + rank : '')

/** Returns the editable DOM node of the given items */
const editableNode = (items, rank) => {
  return document.getElementsByClassName('editable-' + encodeItems(items, rank))[0]
}

// allow editable onFocus to be disabled temporarily
// this allows the selection to be re-applied after the onFocus event changes without entering an infinite focus loop
// this would not be a problem if the node was not re-rendered on state change
let disableOnFocus = false

// restores the selection to a given editable item
// and then dispatches setCursor
const restoreSelection = (itemsRanked, offset, dispatch) => {

  const items = unrank(itemsRanked)

  // only re-apply the selection the first time
  if (!disableOnFocus) {

    disableOnFocus = true

    // use current focusOffset if not provided as a parameter
    let focusOffset = offset != null
      ? offset
      : window.getSelection().focusOffset

    dispatch({ type: 'setCursor', itemsRanked })

    // re-apply selection
    setTimeout(() => {

      // wait until this "artificial" focus event fires before re-enabling onFocus
      setTimeout(() => {
        disableOnFocus = false
      }, 0)

      // re-apply the selection
      const el = editableNode(items, signifier(itemsRanked).rank)
      if (!el) {
        console.error(`restoreSelection: Could not find element "editable-${encodeItems(items, signifier(itemsRanked).rank)}"`)
        return
        // throw new Error(`Could not find element: "editable-${encodeItems(items)}"`)
      }
      if (el.childNodes.length === 0) {
        el.appendChild(document.createTextNode(''))
      }
      const textNode = el.childNodes[0]
      const range = document.createRange()
      const sel = window.getSelection()
      range.setStart(textNode, Math.min(focusOffset, textNode.textContent.length))
      range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(range)
    }, 0)
  }
}

/* Update the distance-from-cursor classes for all given elements (children or children-new) */
const autofocus = (els, items, enableAutofocusHelper) => {
  const baseDepth = decodeItemsUrl().length
  let autofocusHelperHiddenItems = []
  for (let i=0; i<els.length; i++) {

    const el = els[i]
    const hasDepth = el.hasAttribute('data-items-length')
    const firstChild = !hasDepth ? el.querySelector('.children') : null

    // if it does not have the attribute data-items-length, use first child's - 1
    // this is for the contexts view (see Children component)
    if (!hasDepth && !firstChild) return // skip missing children
    const depth = hasDepth
      ? +el.getAttribute('data-items-length')
      : +firstChild.getAttribute('data-items-length') - 1

    const distance = Math.max(0,
      Math.min(MAX_DISTANCE_FROM_CURSOR,
        items.length - depth - baseDepth
      )
    )

    // add class if it doesn't already have it
    if (!el.classList.contains('distance-from-cursor-' + distance)) {

      el.classList.remove('distance-from-cursor-0', 'distance-from-cursor-1', 'distance-from-cursor-2', 'distance-from-cursor-3')
      el.classList.add('distance-from-cursor-' + distance)

      if (distance >= 2 && enableAutofocusHelper) {
        autofocusHelperHiddenItems = autofocusHelperHiddenItems.concat(Array.prototype.map.call(el.children, child => child.firstChild.textContent))
      }
    }
  }

  // autofocus helper
  if (enableAutofocusHelper) {
    clearTimeout(autofocusHelperTimeout)
    autofocusHelperTimeout = setTimeout(() => {
      if (enableAutofocusHelper && autofocusHelperHiddenItems.length > 0 && canShowHelper('autofocus')) {
        store.dispatch({ type: 'showHelper', id: 'autofocus', data: autofocusHelperHiddenItems })
      }
    }, HELPER_AUTOFOCUS_DELAY)
  }
}

const removeAutofocus = els => {
  clearTimeout(autofocusHelperTimeout)
  for (let i=0; i<els.length; i++) {
    els[i].classList.remove('distance-from-cursor-0', 'distance-from-cursor-1', 'distance-from-cursor-2', 'distance-from-cursor-3')
  }
}

// declare using traditional function syntax so it is hoisted
function canShowHelper(id, state=store ? store.getState() : initialState) {
  return (!state.showHelper || state.showHelper === id) &&
    !state.helpers[id].complete &&
    state.helpers[id].hideuntil < Date.now()
}

// render a list of items as a sentence
const conjunction = items =>
  items.slice(0, items.length - 1).join(', ') + (items.length !== 2 ? ',' : '') + ' and ' + items[items.length - 1]

const numbers = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']
const spellNumber = n => numbers[n - 1] || n

const nextSiblings = el =>
  el.nextSibling
    ? [el.nextSibling].concat(nextSiblings(el.nextSibling))
    : []

const helperCleanup = () => {
  const helperContainer = document.querySelector('.helper-container')
  if (helperContainer) {
    helperContainer.classList.remove('helper-container')
  }
  const siblingsAfter = document.querySelectorAll('.sibling-after')
  for (let i=0; i<siblingsAfter.length; i++) {
    siblingsAfter[i].classList.remove('sibling-after')
  }
}

/**************************************************************
 * Reducer
 **************************************************************/

const appReducer = (state = initialState, action) => {
  // console.info('ACTION', action)
  return Object.assign({}, state, (({

    status: ({ value }) => ({
      status: value
    }),

    authenticated: ({ user, userRef }) => ({
      status: 'authenticated',
      user,
      userRef
    }),

    // force re-render
    render: ({ dataNonce }) => ({
      dataNonce: ++dataNonce
    }),

    data: ({ item, forceRender }) => ({
      data: item ? Object.assign({}, state.data, {
        [item.value]: item,
      }) : state.data,
      lastUpdated: timestamp(),
      dataNonce: state.dataNonce + (forceRender ? 1 : 0)
    }),

    delete: ({ value, forceRender }) => {

      setTimeout(() => {
        localStorage.removeItem('data-' + value)
        localStorage.lastUpdated = timestamp()
      })

      delete state.data[value]

      return {
        data: Object.assign({}, state.data),
        lastUpdated: timestamp(),
        dataNonce: state.dataNonce + (forceRender ? 1 : 0)
      }
    },

    navigate: ({ to, from, history, replace, showContexts }) => {
      if (equalArrays(state.focus, to) && equalArrays([].concat(getFromFromUrl()), [].concat(from)) && decodeUrlContexts() === state.showContexts) return state
      if (history !== false) {
        window.history[replace ? 'replaceState' : 'pushState'](
          state.focus,
          '',
          encodeItemsUrl(to, from, showContexts)
        )
      }

      setTimeout(() => {
        removeAutofocus(document.querySelectorAll('.children,.children-new'))
      })

      return {
        cursor: [],
        focus: to,
        from: from,
        showContexts
      }
    },

    newItemSubmit: ({ value, context, rank, ref, dataNonce }) => {

      // create item if non-existent
      const item = value in state.data
        ? state.data[value]
        : {
          id: value,
          value: value,
          memberOf: []
        }

      // add to context
      item.memberOf.push({
        context,
        rank
      })

      // get around requirement that reducers cannot dispatch actions
      setTimeout(() => {

        sync(value, {
          value: item.value,
          memberOf: item.memberOf,
          lastUpdated: timestamp()
        }, null, true)

        if (ref) {
          ref.textContent = ''
        }
      }, RENDER_DELAY)

      return {
        dataNonce: ++dataNonce
      }
    },

    // set both cursor (the transcendental signifier) and cursorEditing (the live value during editing)
    // the other contexts superscript uses cursorEditing when it is available
    setCursor: ({ itemsRanked }) => {

      clearTimeout(newChildHelperTimeout)
      clearTimeout(superscriptHelperTimeout)

      // if the cursor is being removed, remove the autofocus as well
      if (!itemsRanked) {
        setTimeout(() => {
          removeAutofocus(document.querySelectorAll('.children,.children-new'))
        })
      }

      return {
        cursor: itemsRanked,
        cursorEditing: itemsRanked
      }
    },

    existingItemChange: ({ oldValue, newValue, context, rank }) => {

      // items may exist for both the old value and the new value
      const itemOld = state.data[oldValue]
      const itemCollision = state.data[newValue]
      const items = unroot(context).concat(oldValue)
      const itemsNew = unroot(context).concat(newValue)
      const cursorNew = state.cursor.map(child => ({
        key: child.key === oldValue ? newValue : child.key,
        rank: child.rank
      }))

      // the old item less the context
      const newOldItem = itemOld.memberOf.length > 1
        ? removeContext(itemOld, context, rank)
        : null

      const itemNew = {
        value: newValue,
        memberOf: (itemCollision ? itemCollision.memberOf || [] : []).concat({
          context: context,
          rank // TODO: Add getNextRank(itemCillision.memberOf) ?
        }),
        lastUpdated: timestamp()
      }

      // update local data so that we do not have to wait for firebase
      state.data[newValue] = itemNew
      if (newOldItem) {
        state.data[oldValue] = newOldItem
      }
      else {
        delete state.data[oldValue]
      }

      setTimeout(() => {
        localStorage['data-' + newValue] = JSON.stringify(itemNew)
        if (newOldItem) {
          localStorage['data-' + oldValue] = JSON.stringify(newOldItem)
        }
        else {
          localStorage.removeItem('data-' + oldValue)
        }
      })

      // recursive function to change item within the context of all descendants
      // the inheritance is the list of additional ancestors built up in recursive calls that must be concatenated to itemsNew to get the proper context
      const recursiveUpdates = (items, inheritance=[]) => {

        return getChildrenWithRank(items, state.data).reduce((accum, child) => {
          const childItem = state.data[child.key]

          // remove and add the new context of the child
          const childNew = removeContext(childItem, items, child.rank)
          childNew.memberOf.push({
            context: itemsNew.concat(inheritance),
            rank: child.rank
          })

          // update local data so that we do not have to wait for firebase
          state.data[child.key] = childNew
          setTimeout(() => {
            localStorage['data-' + child.key] = JSON.stringify(childNew)
          })

          return Object.assign(accum,
            {
              ['data/data-' + child.key]: childNew
            },
            recursiveUpdates(items.concat(child.key), inheritance.concat(child.key))
          )
        }, {})
      }

      const updates = Object.assign(
        {
          ['data/data-' + firebaseEncode(oldValue)]: newOldItem,
          ['data/data-' + firebaseEncode(newValue)]: itemNew
        },
        // RECURSIVE
        recursiveUpdates(items)
      )

      if (state.userRef) {
        setTimeout(() => {
          state.userRef.update(updates)
        })
      }

      return Object.assign(
        {
          data: state.data,
          // update cursorEditing so that the other contexts superscript and depth-bar will re-render
          cursorEditing: cursorNew
        },
        canShowHelper('editIdentum', state) && itemOld.memberOf.length > 1 && !equalArrays(context, newOldItem.memberOf[0].context) ? {
          showHelper: 'editIdentum',
          helperData: {
            oldValue,
            newValue,
            context,
            rank,
            oldContext: newOldItem.memberOf[0].context
          }
        } : {}
      )
    },

    existingItemDelete: ({ items, rank }) => {

      const value = signifier(items)
      const item = state.data[value]
      const newItem = item.memberOf.length > 1
        ? removeContext(item, items.length > 1 ? intersections(items) : ['root'], rank)
        : null

      // update local data so that we do not have to wait for firebase
      if (newItem) {
        state.data[value] = newItem
      }
      else {
        delete state.data[value]
      }

      setTimeout(() => {
        if (newItem) {
          localStorage['data-' + value] = JSON.stringify(newItem)
        }
        else {
          localStorage.removeItem('data-' + value)
        }
      })

      // generates a firebase update object deleting the item and deleting/updating all descendants
      const recursiveDeletes = items => {
        return getChildrenWithRank(items, state.data).reduce((accum, child) => {
          const childItem = state.data[child.key]
          const childNew = childItem.memberOf.length > 1
            // update child with deleted context removed
            ? removeContext(childItem, items, child.rank)
            // if this was the only context of the child, delete the child
            : null

          // update local data so that we do not have to wait for firebase
          state.data[child.key] = childNew
          setTimeout(() => {
            if (childNew) {
              localStorage['data-' + child.key] = JSON.stringify(childNew)
            }
            else {
              localStorage.removeItem('data-' + child.key)
            }
          })

          return Object.assign(accum,
            { ['data/data-' + firebaseEncode(child.key)]: childNew }, // direct child
            recursiveDeletes(items.concat(child.key)) // RECURSIVE
          )
        }, {})
      }

      const updates = Object.assign({
        ['data/data-' + firebaseEncode(value)]: newItem
      }, newItem ? recursiveDeletes(items) : null)

      if (state.userRef) {
        setTimeout(() => {
          state.userRef.update(updates)
        })
      }

      return {
        data: Object.assign({}, state.data),
        dataNonce: state.dataNonce + 1
      }
    },

    dark: () => {
      localStorage['settings-dark'] = !state.settings.dark
      return {
        settings: Object.assign({}, state.settings, { dark: !state.settings.dark })
      }
    },

    helperComplete: ({ id }) => {
      localStorage['helper-complete-' + id] = true
      return {
        showHelper: null,
        helpers: Object.assign({}, state.helpers, {
          [id]: Object.assign({}, state.helpers[id], {
            complete: true
          })
        })
      }
    },

    helperRemindMeLater: ({ id, duration=0 }) => {

      if (state.cursorEditing && state.editing) {
        setTimeout(() => {
          restoreSelection(state.cursorEditing, 0, store.dispatch)
        }, 0)
      }

      const time = Date.now() + duration
      localStorage['helper-hideuntil-' + id] = time

      helperCleanup()

      return {
        showHelper: null,
        helpers: Object.assign({}, state.helpers, {
          [id]: Object.assign({}, state.helpers[id], {
            hideuntil: time
          })
        })
      }
    },

    expandContextItem: ({ itemsRanked }) => ({
      expandedContextItem: equalItemsRanked(state.expandedContextItem, itemsRanked)
        ? null
        : itemsRanked
    }),

    showHelper: ({ id, data }) =>
      canShowHelper(id, state)
        ? {
          showHelper: id,
          helperData: data
        }
        : {},

    // track editing independently of cursor to allow navigation when keyboard is hidden
    editing: ({ value }) => ({
      editing: value
    }),

  })[action.type] || (() => state))(action))
}

const store = createStore(appReducer)


/**************************************************************
 * LocalStorage && Firebase Setup
 **************************************************************/

// Set to offline mode in 5 seconds. Cancelled with successful login.
const offlineTimer = window.setTimeout(() => {
  store.dispatch({ type: 'status', value: 'offline' })
}, OFFLINE_TIMEOUT)

// firebase init
const firebase = window.firebase
if (firebase) {
  firebase.initializeApp(firebaseConfig)

  // delay presence detection to avoid initial disconnected state
  // setTimeout(() => {
  // }, 1000)
  const connectedRef = firebase.database().ref(".info/connected")
  connectedRef.on('value', snap => {
    const connected = snap.val()

    // update offline state
    // do not set to offline if in initial connecting state; wait for timeout
    if (connected || store.getState().status !== 'connecting') {
      store.dispatch({ type: 'status', value: connected ? 'connected' : 'offline' })
    }
  })

  // check if user is logged in
  firebase.auth().onAuthStateChanged(user => {

    // if not logged in, redirect to OAuth login
    if (!user) {
      store.dispatch({ type: 'offline', value: true })
      const provider = new firebase.auth.GoogleAuthProvider();
      firebase.auth().signInWithRedirect(provider)
      return
    }

    // disable offline mode
    window.clearTimeout(offlineTimer)

    // if logged in, save the user ref and uid into state
    const userRef = firebase.database().ref('users/' + user.uid)

    store.dispatch({
      type: 'authenticated',
      userRef,
      user
    })

    // update user information
    userRef.update({
      name: user.displayName,
      email: user.email
    })

    // load Firebase data
    userRef.on('value', snapshot => {
      const value = snapshot.val()

      // init root if it does not exist (i.e. local = false)
      if (!value.data || !value.data['data-root']) {
        sync('root')
      }
      // otherwise sync all data locally
      else {
        syncAll(value.data)
      }
    })

  })
}

// save to state, localStorage, and Firebase
const sync = (key, item={}, localOnly, forceRender, callback) => {

  const lastUpdated = timestamp()
  const timestampedItem = Object.assign({}, item, { lastUpdated })

  // state
  store.dispatch({ type: 'data', item: timestampedItem, forceRender })

  // localStorage
  localStorage['data-' + key] = JSON.stringify(timestampedItem)
  localStorage.lastUpdated = lastUpdated

  // firebase
  if (!localOnly && firebase) {
    store.getState().userRef.update({
      ['data/data-' + firebaseEncode(key)]: timestampedItem,
      lastUpdated
    }, callback)
  }

}

// save all firebase data to state and localStorage
const syncAll = data => {

  const state = store.getState()

  for (let key in data) {
    const item = data[key]
    const oldItem = state.data[firebaseDecode(key).slice(5)]

    if (!oldItem || item.lastUpdated > oldItem.lastUpdated) {
      // do not force render here, but after all values have been added
      store.dispatch({ type: 'data', item })
      localStorage[firebaseDecode(key)] = JSON.stringify(item)
    }
  }

  // delete local data that no longer exists in firebase
  for (let value in state.data) {
    if (!(('data-' + firebaseEncode(value)) in data)) {
      // do not force render here, but after all values have been deleted
      store.dispatch({ type: 'delete', value })
    }
  }

  // re-render after everything has been updated
  // only if there is no cursor, otherwise it interferes with editing
  if (!state.cursor) {
    store.dispatch({ type: 'render' })
  }
}


/**************************************************************
 * Window Events
 **************************************************************/

window.addEventListener('popstate', () => {
  store.dispatch({
    type: 'navigate',
    to: decodeItemsUrl(),
    from: getFromFromUrl(),
    showContexts: decodeUrlContexts(),
    history: false
  })
})

if (canShowHelper('superscriptSuggestor')) {
  const interval = setInterval(() => {
    const data = store.getState().data
    const rootChildren = Object.keys(data).filter(key =>
      data[key].memberOf &&
      data[key].memberOf.length > 0 &&
      data[key].memberOf[0].context.length === 1 &&
      data[key].memberOf[0].context[0] === 'root'
    )
    if (
      // no identums
      Object.keys(data).every(key => !data[key].memberOf || data[key].memberOf.length <= 1) &&
      // at least two contexts in the root
      Object.keys(data).filter(key =>
        data[key].memberOf &&
        data[key].memberOf.length > 0 &&
        data[key].memberOf[0].context.length === 1 &&
        rootChildren.includes(data[key].memberOf[0].context[0])
      ).length >= 2
    ) {
      clearInterval(interval)
      store.dispatch({ type: 'showHelper', id: 'superscriptSuggestor' })
    }
  }, HELPER_SUPERSCRIPT_SUGGESTOR_DELAY)
}

if (canShowHelper('depthBar')) {
  store.dispatch({ type: 'showHelper', id: 'depthBar' })
}

// global shortcuts: down, escape
// desktop only in case it improves performance
if (!IS_MOBILE) {

  window.addEventListener('keydown', e => {

    // down: press down with no focus to focus on first editable
    if (e.key === 'ArrowDown' && !store.getState().cursor) {
      const firstEditable = document.querySelector('.editable')
      if (firstEditable) {
        firstEditable.focus()
      }
    }
    // escape: remove cursor
    else if (e.key === 'Escape') {
      document.activeElement.blur()
      document.getSelection().removeAllRanges()
      store.dispatch({ type: 'setCursor' })
    }

  })

}


/**************************************************************
 * Components
 **************************************************************/

const AppComponent = connect(({ dataNonce, cursor, focus, from, showContexts, user, settings }) => ({ dataNonce,
  cursor,
  focus,
  from,
  showContexts,
  user,
  dark: settings.dark
}))((
    { dataNonce, cursor, focus, from, showContexts, user, dark, dispatch }) => {

  const directChildren = getChildrenWithRank(focus)

  const subheadings = directChildren.length > 0
    ? [fillRank(focus)]
    : sortToFront(from || focus, getDerivedChildren(focus))//.sort(sorter)

  const contexts = showContexts || directChildren.length === 0 ? getContexts(focus)
    // simulate rank as if these are sequential items in a novel context
    // TODO: somehow must sort
    .map((item, i) => ({
      context: item.context,
      rank: i
    })) : []

  return <div ref={() => {
    document.body.classList[dark ? 'add' : 'remove']('dark')
  }} className={
    'container' +
    // mobile safari must be detected because empty and full bullet points in Helvetica Neue have different margins
    (IS_MOBILE ? ' mobile' : '') +
    (/Chrome/.test(navigator.userAgent) ? ' chrome' : '') +
    (/Safari/.test(navigator.userAgent) ? ' safari' : '')
  }>

    <header>
      <HomeLink />
      <Status />
    </header>

    <div className={'content' + (from ? ' from' : '')} onClick={() => {
      // remove the cursor if the click goes all the way through to the content
      // if disableOnFocus is true, the click came from an Editable onFocus event and we should not reset the cursor
      if (!disableOnFocus) {
        const showHelper = store.getState().showHelper
        if (showHelper) {
          dispatch({ type: 'helperRemindMeLater', showHelper, HELPER_CLOSE_DURATION })
        }
        else {
          dispatch({ type: 'setCursor' })
          dispatch({ type: 'expandContextItem', items: null })
        }
      }
    }}>

        {/* These helpers are connected to helperData. We cannot connect AppComponent to helperData because we do not want it to re-render when a helper is shown. */}
        <HelperAutofocus />
        <HelperContextView />

        <Helper id='welcome' title='Welcome to em' center>
          <p><HomeLink inline /> is a tool that helps you become more aware of your own thinking process.</p>
          <p>The features of <HomeLink inline /> mirror the features of your mind—from the interconnectedness of ideas, to multiple contexts, to focus, and more.</p>
          <p>Lessons like this will introduce the features of <HomeLink inline /> one step at a time.</p>
          <p><b>Happy Sense-Making!</b></p>
        </Helper>


        { // only show suggestor if superscript helper is not completed/hidden
        canShowHelper('superscript') ? <Helper id='superscriptSuggestor' title="Just like in your mind, items can exist in multiple contexts in em." center>
          <p>For example, you may have "Todo" in both a "Work" context and a "Groceries" context.</p>
          <p><HomeLink inline /> allows you to easily view an item across multiple contexts without having to decide all the places it may go when it is first created.</p>
          <p><i>To see this in action, try entering an item that already exists in one context to a new context.</i></p>
        </Helper> : null}

      { /* Subheadings */ }
      <div onClick={e => {
          // stop propagation to prevent default content onClick (which removes the cursor)
          e.stopPropagation()
        }}
      >

        {showContexts || directChildren.length === 0

          // context view
          // data-items must be embedded in each Context as Item since paths are different for each one
          ? <div>
            {!isRoot(focus) ? <Subheading itemsRanked={fillRank(focus)} /> : null}
            <Children
              focus={focus}
              cursor={cursor}
              itemsRanked={fillRank(focus)}
              subheadingItems={unroot(focus)}
              children={contexts}
              expandable={true}
              contexts={true}
            />
            <NewItem context={focus} contexts={true} />
          </div>

          // items
          : subheadings.map((itemsRanked, i) => {

            const items = unrank(itemsRanked)

            const children = (directChildren.length > 0
              ? directChildren
              : getChildrenWithRank(items)
            )//.sort(sorter)

            // get a flat list of all grandchildren to determine if there is enough space to expand
            // const grandchildren = flatMap(children, child => getChildren(items.concat(child)))

            return <div
              key={i}
              // embed items so that autofocus can limit scope to one subheading
              className='subheading-items'
              data-items={encodeItems(items)}
            >
              { /* Subheading */ }
              {!isRoot(focus) ? (children.length > 0
                ? <Subheading itemsRanked={itemsRanked} />
                : <ul className='subheading-leaf-children'><li className='leaf'><Subheading itemsRanked={itemsRanked} /></li></ul>
              ) : null}

              {/* Subheading Children
                  Note: Override directChildren by passing children
              */}

              <Children focus={focus} cursor={cursor} itemsRanked={itemsRanked} subheadingItems={unroot(items)} children={children} expandable={true} />

              { /* New Item */ }
              {children.length > 0 ? <NewItem context={items} /> : null}

            </div>
          })
        }
      </div>
    </div>

    <ul className='footer list-none' onClick={() => {
      // remove the cursor when the footer is clicked (the other main area besides .content)
      dispatch({ type: 'setCursor' })
    }}>
      <li><a className='settings-dark' onClick={() => dispatch({ type: 'dark' })}>Dark Mode</a> | <a className='settings-logout' onClick={() => firebase && firebase.auth().signOut()}>Log Out</a></li><br/>
      <li><span className='dim'>Version: </span>{pkg.version}</li>
      {user ? <li><span className='dim'>Logged in as: </span>{user.email}</li> : null}
      {user ? <li><span className='dim'>User ID: </span><span className='mono'>{user.uid}</span></li> : null}
      <li><span className='dim'>Support: </span><a className='support-link' href='mailto:raine@clarityofheart.com'>raine@clarityofheart.com</a></li>
    </ul>

  </div>
})

const Status = connect(({ status }) => ({ status }))(({ status }) =>
  <div className='status'>
    {status === 'connecting' ? <span>Connecting...</span> : null}
    {status === 'offline' ? <span className='error'>Offline</span> : null}
  </div>
)

const HomeLink = connect(({ settings, focus, showHelper }) => ({
  dark: settings.dark,
  focus: focus,
  showHelper: showHelper
}))(({ dark, focus, showHelper, inline, dispatch }) =>
  <span className='home'>
    <a onClick={() => dispatch({ type: 'navigate', to: ['root'] })}><span role='img' arial-label='home'><img className='logo' src={inline ? (dark ? logoDarkInline : logoInline) : (dark ? logoDark : logo)} alt='em' width='24' /></span></a>
    {showHelper === 'home' ? <Helper id='home' title='Tap the "em" icon to return to the home context' arrow='arrow arrow-top arrow-topleft' /> : null}
  </span>
)

const Subheading = ({ itemsRanked, cursor=[], contexts }) => {
  // extend items with the items that are hidden from autofocus
  const items = unrank(itemsRanked)
  const hiddenItems = cursor.slice(items.length, cursor.length - MAX_DISTANCE_FROM_CURSOR + 1)
  const extendedItems = items.concat(hiddenItems)
  return <div className='subheading'>
    {extendedItems.map((item, i) => {
      const subitems = ancestors(extendedItems, item)
      return <span key={i} className={item === signifier(extendedItems) && !contexts ? 'subheading-focus' : ''}>
        <Link items={subitems} />
        <Superscript itemsRanked={fillRank(subitems)} cursor={cursor} />
        {i < items.length - 1 || contexts ? <span> + </span> : null}
      </span>
    })}
    {contexts ? <span> </span> : null}
  </div>
}

/** A recursive child element that consists of a <li> containing an <h3> and <ul> */
// subheadingItems passed to Editable to constrain autofocus
// cannot use itemsLive here else Editable gets re-rendered during editing
const Child = connect(({ expandedContextItem }) => ({ expandedContextItem }))(({ expandedContextItem, focus, cursor=[], itemsRanked, rank, subheadingItems, contexts, depth=0, count=0, dispatch }) => {

  const children = getChildrenWithRank(unrank(itemsRanked))

  // if rendering as a context and the item is the root, render home icon instead of Editable
  const homeContext = contexts && isRoot([signifier(intersections(itemsRanked))])

  return <li className={
    'child' +
    (children.length === 0 ? ' leaf' : '')
  }>
    <h3 className='child-heading' style={homeContext ? { height: '1em', marginLeft: 8 } : null}>

      {}

      {equalItemsRanked(itemsRanked, expandedContextItem) && itemsRanked.length > 2 ? <Subheading itemsRanked={intersections(intersections(itemsRanked))} contexts={contexts} />
        : contexts && itemsRanked.length > 2 ? <span className='ellipsis'><a onClick={() => {
          dispatch({ type: 'expandContextItem', itemsRanked })
        }}>... </a></span>
        : null}

      {homeContext
        ? <HomeLink/>
        : <Editable focus={focus} itemsRanked={itemsRanked} rank={rank} subheadingItems={subheadingItems} contexts={contexts} />}

      <Superscript itemsRanked={itemsRanked} cursor={cursor} contexts={contexts} />
    </h3>

    { /* Recursive Children */ }
    <Children focus={focus} cursor={cursor} itemsRanked={itemsRanked} subheadingItems={subheadingItems} children={children} count={count} depth={depth} />
  </li>
})

/*
  @focus: needed for Editable to determine where to restore the selection after delete
  @subheadingItems: needed for Editable to constrain autofocus
*/
const Children = connect(({ cursor }, props) => {
  return {
    // track the transcendental identifier if editing to trigger expand/collapse
    isEditing: (cursor || []).find(cursorItemRanked => equalItemRanked(cursorItemRanked, signifier(props.contexts ? intersections(props.itemsRanked) : props.itemsRanked)))
  }
})(({ isEditing, focus, cursor=[], itemsRanked, subheadingItems, children, expandable, contexts, count=0, depth=0 }) => {

  const show = (isRoot(itemsRanked) || isEditing || expandable) &&
    children.length > 0 &&
    count + sumChildrenLength(children) <= NESTING_CHAR_MAX

  // embed data-items-length so that distance-from-cursor can be set on each ul when there is a new cursor location (autofocus)
  // unroot items so ['root'] is not counted as 1
  return show ? <ul
      // data-items={contexts ? encodeItems(unroot(unrank(itemsRanked))) : null}
      // when in the contexts view, autofocus will look at the first child's data-items-length and subtract 1
      // this is because, unlike with normal items, each Context as Item has a different path and thus different items.length
      data-items-length={contexts ? null : unroot(itemsRanked).length}
      className='children'
    >
      {children.map((child, i) => {

        return <Child
          key={i}
          focus={focus}
          cursor={cursor}
          itemsRanked={contexts
            // replace signifier rank with rank from child when rendering contexts as children
            // i.e. Where Context > Item, use the Item rank while displaying Context
            ? fillRank(child.context).concat(intersections(itemsRanked), { key: signifier(itemsRanked).key, rank: child.rank })
            : unroot(itemsRanked).concat(child)}
          subheadingItems={subheadingItems}
          rank={child.rank}
          contexts={contexts}
          count={count + sumChildrenLength(children)} depth={depth + 1}
        />
      }
      )}
    </ul> : null
})

// renders a link with the appropriate label to the given context
const Link = connect()(({ items, label, from, dispatch }) => {
  const value = label || signifier(items)
  return <a href={encodeItemsUrl(items, from)} className='link' onClick={e => {
    e.preventDefault()
    document.getSelection().removeAllRanges()
    dispatch({ type: 'navigate', to: e.shiftKey ? [signifier(items)] : items, from: e.shiftKey ? decodeItemsUrl() : from })
  }}>{value}</a>
})

/*
  @subheadingItems: needed to constrain autofocus
  @contexts indicates that the item is a context rendered as a child, and thus needs to be displayed as the context while maintaining the correct items path
*/
const Editable = connect()(({ focus, itemsRanked, rank, subheadingItems, from, cursor, contexts, dispatch }) => {
  const items = unrank(itemsRanked)
  const value = signifier(contexts ? intersections(items) : items)
  const ref = React.createRef()
  const context = contexts && items.length > 2 ? intersections(intersections(items))
    : !contexts && items.length > 1 ? intersections(items)
    : ['root']

  // store the old value so that we have a transcendental signifier when it is changed
  let oldValue = value

  // used in all autofocus DOM queries
  let subheadingItemsQuery = subheadingItems && subheadingItems.length > 0
    ? `[data-items="${encodeItems(subheadingItems)}"] `
    : ''

  const setCursorOnItem = () => {
    // delay until after the render
    if (!disableOnFocus) {

      disableOnFocus = true
      setTimeout(() => {
        disableOnFocus = false
        // not needed with new contexts view; only needed if more than one subheading is shown at once
        // autofocus(document.querySelectorAll(subheadingItemsQuery + '.children'), items)
        // autofocus(document.querySelectorAll(subheadingItemsQuery + '.children-new'), items)
        autofocus(document.querySelectorAll('.children'), items, true)
        autofocus(document.querySelectorAll('.children-new'), items)
      }, 0)

      dispatch({ type: 'setCursor', itemsRanked })
    }
  }

  // add identifiable className for restoreSelection
  return <ContentEditable className={'editable editable-' + encodeItems(items, rank)} html={value} innerRef={el => {
      ref.current = el

      // update autofocus for children-new ("Add item") on render in order to reset distance-from-cursor after new focus when "Add item" was hidden.
      // autofocusing the children here causes significant preformance issues
      // instead, autofocus the children on blur
      if (el && subheadingItems) {
        autofocus(document.querySelectorAll(subheadingItemsQuery + '.children-new'), items)
      }
    }}
    onKeyDown={e => {

      /**************************
       * Delete
       **************************/
      if ((e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Escape') && e.target.innerHTML === '') {
        e.preventDefault()
        const prev = prevSibling('', context, rank)
        dispatch({ type: 'existingItemDelete', items: unroot(context.concat(ref.current.innerHTML)), rank })

        // normal delete: restore selection to prev item
        if (prev) {
          restoreSelection(
            intersections(itemsRanked).concat(prev),
            prev.key.length,
            dispatch
          )
        }
        else if (signifier(context) === signifier(focus)) {
          const next = getChildrenWithRank(context)[0]

          // delete from head of focus: restore selection to next item
          if (next) {
            restoreSelection(intersections(itemsRanked).concat(next), 0, dispatch)
          }

          // delete last item in focus
          else {
            dispatch({ type: 'setCursor' })
          }
        }
        // delete from first child: restore selection to context
        else {
          const contextRanked = items.length > 1 ? intersections(itemsRanked) : [{ key: 'root', rank: 0 }]
          restoreSelection(
            contextRanked,
            signifier(context).length,
            dispatch
          )
        }
      }

      /**************************
       * Enter
       **************************/
      else if (e.key === 'Enter') {
        e.preventDefault()

        // use the live-edited value
        const itemsLive = contexts
          ? intersections(intersections(items)).concat(ref.current.innerHTML).concat(signifier(items))
          : intersections(items).concat(ref.current.innerHTML)
        const itemsRankedLive = contexts
          ? intersections(intersections(itemsRanked).concat({ key: ref.current.innerHTML, rank })).concat(signifier(itemsRanked))
          : intersections(itemsRanked).concat({ key: ref.current.innerHTML, rank })

        // if shift key is pressed, add a child instead of a sibling
        const insertNewChild = e.metaKey
        const insertBefore = e.shiftKey
        const newRank = insertNewChild
          ? (insertBefore ? getPrevRank : getNextRank)(itemsLive)
          : (insertBefore ? getRankBefore : getRankAfter)(e.target.innerHTML, context, rank)

        // TODO: Add to the new '' context

        dispatch({
          type: 'newItemSubmit',
          context: insertNewChild ? itemsLive : context,
          rank: newRank,
          value: '',
          ref: ref.current
        })

        disableOnFocus = true
        setTimeout(() => {
          // track the transcendental identifier if editing
          disableOnFocus = false
          restoreSelection((insertNewChild ? itemsRankedLive : intersections(itemsRankedLive)).concat({ key: '', rank: newRank }), 0, dispatch)
        }, RENDER_DELAY)

        // newItem helper
        if(canShowHelper('newItem') && !insertNewChild && Object.keys(store.getState().data).length > 1) {
          dispatch({ type: 'showHelper', id: 'newItem', data: {
            itemsRanked: intersections(itemsRankedLive).concat({ key: '', rank: newRank })
          }})
        }
        // newChildSuccess helper
        else if (canShowHelper('newChildSuccess') && insertNewChild) {
          dispatch({ type: 'showHelper', id: 'newChildSuccess', data: {
            itemsRanked: itemsRankedLive.concat({ key: '', rank: newRank })
          }})
        }
      }

      /**************************
       * Up/Down
       **************************/
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {

        e.preventDefault()

        // focus on next element
        const currentNode = e.target
        const allElements = document.querySelectorAll('.editable')
        const currentIndex = Array.prototype.findIndex.call(allElements, el => currentNode.isEqualNode(el))
        if ((e.key === 'ArrowDown' && currentIndex < allElements.length - 1) ||
            (e.key === 'ArrowUp' && currentIndex > 0)) {
          allElements[currentIndex + (e.key === 'ArrowDown' ? 1 : -1)].focus()
        }
      }

    }}
    onClick={e => {
      // stop propagation to prevent default content onClick (which removes the cursor)
      e.stopPropagation()
    }}
    onTouchEnd={e => {
      const state = store.getState()
      if (
        // no cursor
        !state.cursorEditing ||
        // clicking a different item (when not editing)
        (!state.editing && !equalItemsRanked(itemsRanked, state.cursorEditing))) {

        // prevent focus to allow navigation with mobile keyboard down
        e.preventDefault()
        setCursorOnItem()
      }
    }}
    onFocus={() => {
      setCursorOnItem()
      dispatch({ type: 'editing', value: true })
    }}
    onBlur={() => {
      dispatch({ type: 'editing', value: false })
    }}
    onChange={e => {
      // NOTE: When Child components are re-rendered on edit, change is called with identical old and new values (?) causing an infinite loop
      const newValue = e.target.value
        .replace(/&nbsp;/g, '')
        .replace(/^(<br>)+|(<br>)+$/g, '')
      if (newValue !== oldValue) {
        const item = store.getState().data[oldValue]
        if (item) {
          dispatch({ type: 'existingItemChange', context, oldValue, newValue, rank })

          // store the value so that we have a transcendental signifier when it is changed
          oldValue = newValue

          // newChild and superscript helpers appear with a slight delay after editing
          clearTimeout(newChildHelperTimeout)
          clearTimeout(superscriptHelperTimeout)

          newChildHelperTimeout = setTimeout(() => {
            // edit the 3rd item (excluding root)
            if (Object.keys(store.getState().data).length > 3) {
              dispatch({ type: 'showHelper', id: 'newChild', data: { itemsRanked }})
            }
          }, HELPER_NEWCHILD_DELAY)

          superscriptHelperTimeout = setTimeout(() => {
            const data = store.getState().data
            // new item belongs to at least 2 contexts
            if (data[newValue].memberOf && data[newValue].memberOf.length >= 2) {
              dispatch({ type: 'showHelper', id: 'superscript', data: {
                value: newValue,
                num: data[newValue].memberOf.length,
                itemsRanked
              }})
            }
          }, HELPER_SUPERSCRIPT_DELAY)
        }
      }
    }}
  />
})

// renders superscript if there are other contexts
// optionally pass items (used by Subheading) or itemsRanked (used by Child)
const Superscript = connect(({ cursorEditing, showHelper, helperData }, props) => {

  // track the transcendental identifier if editing
  const editing = equalArrays(unrank(props.cursor || []), unrank(props.itemsRanked || [])) && exists(unrank(cursorEditing || []))

  const itemsRanked = props.contexts && props.itemsRanked
    ? intersections(props.itemsRanked)
    : props.itemsRanked

  const items = props.items || unrank(itemsRanked)

  const itemsLive = editing
    ? (props.contexts ? intersections(unrank(cursorEditing || [])) : unrank(cursorEditing || []))
    : items

  return {
    items,
    itemsLive,
    itemsRanked,
    // valueRaw is the signifier that is removed when contexts is true
    valueRaw: props.contexts ? signifier(unrank(props.itemsRanked)) : signifier(itemsLive),
    empty: signifier(itemsLive).length === 0, // ensure re-render when item becomes empty
    numContexts: exists(itemsLive) && getContexts(itemsLive).length,
    showHelper,
    helperData
  }
})(({ items, itemsLive, itemsRanked, valueRaw, empty, numContexts, showHelper, helperData, showSingle, contexts, dispatch }) => {

  const numDescendantCharacters = getDescendants(contexts ? itemsLive.concat(valueRaw) : itemsLive )
    .reduce((charCount, child) => charCount + child.length, 0)

  const DepthBar = () =>
    (contexts ? intersections(itemsLive) : itemsLive) && numDescendantCharacters ? <span className={'depth-bar' + (itemsLive.length > 1 && (getContexts(contexts ? intersections(itemsLive) : itemsLive).length > 1) ? ' has-other-contexts' : '')} style={{ width: Math.log(numDescendantCharacters) + 2 }} /> : null

  return !empty && numContexts > (showSingle ? 0 : 1) ?
    <span className='num-contexts'> {/* Make the container position:relative so that the helper is positioned correctly */}
      <sup>
        <a onClick={() => {
          dispatch({ type: 'navigate', to: [signifier(itemsLive)], from: intersections(itemsLive), showContexts: true })

          setTimeout(() => {
            dispatch({ type: 'showHelper', id: 'contextView', data: signifier(itemsLive) })
          }, HELPER_CONTEXTVIEW_DELAY)
        }}>{numContexts}</a>
      </sup>

      {showHelper === 'superscript' && equalItemsRanked(itemsRanked, helperData.itemsRanked) ? <Helper id='superscript' title="Superscripts indicate how many contexts an item appears in" style={{ top: 30, left: -19 }} arrow='arrow arrow-up arrow-upleft' opaque center>
        <p>In this case, {helperData && helperData.value}<sup>{helperData && helperData.num}</sup> indicates that "{helperData && helperData.value}" appears in {spellNumber(helperData && helperData.num)} different contexts.</p>
        <p><i>Tap the superscript to view all of {helperData && helperData.value}'s contexts.</i></p>
      </Helper> : null}

      {numDescendantCharacters >= 16 ? <Helper id='depthBar' title="The length of this bar indicates the number of items in this context." style={{ top: 30, left: -10 }} arrow='arrow arrow-up arrow-upleft' opaque>
      </Helper> : null}

      {/* render the depth-bar inside the superscript so that it gets re-rendered with it */}
      <DepthBar/>

    </span>

    // editIdentum fires from existingItemChanged which does not have access to itemsRanked
    // that is why this helper uses different logic for telling if it is on the correct item
    : showHelper === 'editIdentum' &&
      signifier(itemsLive) === helperData.newValue &&
      signifier(itemsRanked).rank === helperData.rank ? <EditIdentumHelper itemsLive={itemsLive} contexts={contexts} />

    : showHelper === 'newItem' && equalItemsRanked(itemsRanked, helperData.itemsRanked) ? <Helper id='newItem' title="You've added an item!" arrow='arrow arrow-up arrow-upleft' style={{ marginTop: 36, marginLeft: -140 }}>
        <p><i>Hit Enter to add an item below.</i></p>
        {IS_MOBILE ? null : <p><i>Hit Shift + Enter to add an item above.</i></p>}
      </Helper>

    : showHelper === 'newChild' && equalItemsRanked(itemsRanked, helperData.itemsRanked) && signifier(itemsLive) !== '' ? <Helper id='newChild' title="Any item can become a context" arrow='arrow arrow-up arrow-upleft' style={{ marginTop: 36, marginLeft: -51 }}>
        <p>Contexts are items that contain other items.</p>
        {IS_MOBILE ? null : <p><i>Hit Command + Enter to turn this item into a context.</i></p>}
      </Helper>

    : showHelper === 'newChildSuccess' && equalItemsRanked(itemsRanked, helperData.itemsRanked) ? <Helper id='newChildSuccess' title="You've created a context!" arrow='arrow arrow-up arrow-upleft' style={{ marginTop: 36, marginLeft: -140 }}>
        <p>In <HomeLink inline />, items can exist in multiple contexts, and there is no limit to an item's depth. </p>
        <p>Instead of using files and folders, use contexts to freely associate and categorize your thoughts.</p>
      </Helper>

    : <DepthBar/>
})

const NewItem = connect(({ cursor }, props) => {
  const children = getChildrenWithRank(props.context)
  return {
    show:  !children.length || children[children.length - 1].key !== ''
  }
})(({ show, context, contexts, dispatch }) => {
  const ref = React.createRef()

  return show ? <ul
      style={{ marginTop: 0 }}
      data-items-length={unroot(context).length}
      className='children-new'
  >
    <li className='leaf'><h3 className='child-heading'>
        <a className='add-new-item-placeholder'
          onClick={() => {
            const newRank = getNextRank(context)

            dispatch({
              type: 'newItemSubmit',
              context,
              rank: newRank,
              value: '',
              ref: ref.current
            })

            disableOnFocus = true
            setTimeout(() => {
              disableOnFocus = false
              restoreSelection(fillRank(unroot(context)).concat({ key: '', rank: newRank }), 0, dispatch)
            }, RENDER_DELAY)

          }}
        >Add {contexts ? 'context' : 'item'}</a>
      </h3>
    </li>
  </ul> : null
})

// needs to be a class component to use componentWillUnmount
class HelperComponent extends React.Component {

  constructor(props) {
    super(props)
    this.ref = React.createRef()
  }

  componentDidMount() {

    // for helpers that appear within the hierarchy, we have to do some hacky css patching to fix the stack order of next siblings and descendants.
    if (this.ref.current) {
      const closestParentItem = this.ref.current.parentNode.parentNode
      closestParentItem.parentNode.classList.add('helper-container')
      let siblingsAfter = nextSiblings(closestParentItem)
      for (let i=0; i<siblingsAfter.length; i++) {
        if (siblingsAfter[i].classList) {
          siblingsAfter[i].classList.add('sibling-after')
        }
      }
      siblingsAfter = nextSiblings(closestParentItem.parentNode)
      for (let i=0; i<siblingsAfter.length; i++) {
        if (siblingsAfter[i].classList) {
          siblingsAfter[i].classList.add('sibling-after')
        }
      }
    }

    // add a global escape listener
    this.escapeListener = e => {
      if (this.props.show && e.key === 'Escape') {
        e.stopPropagation()
        this.close(HELPER_CLOSE_DURATION)
        window.removeEventListener('keydown', this.escapeListener)
      }
    }

    // helper method to animate and close the helper
    this.close = duration => {
      const { id, dispatch } = this.props
      window.removeEventListener('keydown', this.escapeListener)
      helperCleanup()
      if (this.ref.current) {
        this.ref.current.classList.add('animate-fadeout')
      }
      setTimeout(() => {
        dispatch({ type: 'helperRemindMeLater', id, duration })
      }, FADEOUT_DURATION)
    }

    // use capturing so that this fires before the global window Escape which removes the cursor
    window.addEventListener('keydown', this.escapeListener, true)
  }

  componentWillUnmount() {
    helperCleanup()
    window.removeEventListener('keydown', this.escapeListener)
  }

  render() {
    const { show, id, title, arrow, center, opaque, style, positionAtCursor, top, children, dispatch } = this.props

    const sel = document.getSelection()
    const cursorCoords = sel.type !== 'None' ? sel.getRangeAt(0).getClientRects()[0] || {} : {}
    if (!show) return null

    return <div ref={this.ref} style={Object.assign({}, style, top ? { top: 55 } : null, positionAtCursor ? {
      top: cursorCoords.y,
      left: cursorCoords.x
    } : null )} className={`helper helper-${id} ${arrow} animate` +
        (center ? ' center' : '') +
        (opaque ? ' opaque' : '')
      }>
      {title ? <p className='helper-title'>{title}</p> : null}
      <div className='helper-text'>{children}</div>
      <div className='helper-actions'>
        <a onClick={() => { dispatch({ type: 'helperComplete', id }) }}>Got it!</a>
        <span> </span><a onClick={() => this.close(HELPER_REMIND_ME_LATER_DURATION)}>Remind me later</a>
        <span> </span><a onClick={() => this.close(HELPER_REMIND_ME_TOMORROW_DURATION)}>Remind me tomorrow</a>
      </div>
      <a className='helper-close' onClick={() => this.close(HELPER_CLOSE_DURATION)}><span>✕</span></a>
    </div>
  }
}

const Helper = connect(({ showHelper }, props) => ({ show: showHelper === props.id }))(HelperComponent)

const HelperAutofocus = connect(({ helperData }) => ({ helperData }))(({ helperData }) =>
    <Helper id='autofocus' title={(helperData && helperData.map ? conjunction(helperData.slice(0, 3).map(value => `"${value}"`).concat(helperData.length > 3 ? (`${spellNumber(helperData.length - 3)} other item` + (helperData.length > 4 ? 's' : '')) : [])) : 'no items') + ' have been hidden by autofocus'} center>
    <p>Autofocus follows your attention, controlling the number of items shown at once.</p>
    <p>When you move the selection, nearby items return to view.</p>
  </Helper>
)

const HelperContextView = connect(({ helperData }) => ({ helperData }))(({ helperData }) =>
  <Helper id='contextView' title={`This view shows a new way of looking at "${helperData}"`} center>
    <p>Instead of all items within the "{helperData}" context, here you see all contexts that "{helperData}" is in.</p>
    <p><i>Tap the <HomeLink inline /> icon in the upper left corner to return to the home context.</i></p>
  </Helper>
)

const EditIdentumHelper = connect(({ helperData }) => ({ helperData }))(({ helperData, itemsLive, contexts }) =>
  <Helper id='editIdentum' title="When you edit an item, it is only changed in its current context" style={{ top: 40, left: 0 }} arrow='arrow arrow-up arrow-upleft' opaque>
    <p>Now "{helperData.newValue}" exists in "{contexts ? signifier(itemsLive) : signifier(intersections(itemsLive))}" and "{helperData.oldValue}" exists in "{signifier(helperData.oldContext)}".</p>
  </Helper>
)

const App = () => <Provider store={store}>
  <AppComponent/>
</Provider>

export default App
