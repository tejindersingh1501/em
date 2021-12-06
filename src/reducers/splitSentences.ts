import _ from 'lodash'
import { head, pathToContext, reducerFlow, splitSentence } from '../util'
import { editableRender, editingValue, editThought, newThought, setCursor } from '../reducers'
import { getThoughtById, rootedParentOf, simplifyPath } from '../selectors'
import getTextContentFromHTML from '../device/getTextContentFromHTML'
import { State } from '../@types'

/** Split thought by sentences. Create new thought for each sentence. Thought value, on which cursor is on, replace with first sentence. */
const splitSentences = (state: State) => {
  const { cursor } = state
  if (!cursor) return state
  const thoughts = pathToContext(state, cursor)
  const cursorContext = rootedParentOf(state, thoughts)
  const cursorThought = getThoughtById(state, head(cursor))
  const { value, rank } = cursorThought

  const sentences = splitSentence(value)

  if (sentences.length <= 1) {
    return state
  }

  const [firstSentence, ...otherSentences] = sentences
  const newCursor = cursor

  const reducers = [
    editThought({
      oldValue: value,
      newValue: firstSentence,
      context: cursorContext,
      path: simplifyPath(state, cursor),
      rankInContext: rank,
    }),
    ...otherSentences.map(sentence => newThought({ value: sentence })),
    setCursor({ path: newCursor, offset: getTextContentFromHTML(firstSentence).length }),
    editingValue({ value: firstSentence }),
    editableRender,
  ]

  return reducerFlow(reducers)(state)
}

export default _.curryRight(splitSentences)
