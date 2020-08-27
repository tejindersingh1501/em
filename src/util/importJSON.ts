import _ from 'lodash'
import { Child, Context, Lexeme, ParentEntry, Path } from '../types'
import { State } from './initialState'
import { EM_TOKEN, ROOT_TOKEN } from '../constants'
import { getRankAfter, getThought, getThoughts, nextSibling } from '../selectors'

// util
import {
  addThought,
  contextOf,
  createId,
  equalPath,
  equalThoughtRanked,
  hashContext,
  hashThought,
  head,
  headRank,
  pathToContext,
  removeContext,
  rootedContextOf,
  timestamp,
} from '../util'
import { Block } from '../action-creators/importText'
import { GenericObject } from '../utilTypes'

interface ImportHtmlOptions {
  skipRoot? : boolean,
}

interface RankInfo {
  rank: number,
  deepLevel: number,
}

/** Recursively calculate rank offset for a given position based on thoughts before and their children. Increment offset each time we pop out of context. */
const getRankOffset = (thoughts: Block[], position?: number): number => {
  const before = !position ? [...thoughts] : thoughts.slice(0, position)
  const result = before.map(thought => thought.children.length > 0 ? 1 + getRankOffset(thought.children) : 1).reduce((acc, val) => acc + val, 0)
  return position ? result : result + 1
}

/** Prepare thoughts for saving, skip root if necessary. */
const prepare = (skipRoot: boolean | undefined, thoughts: Block[]) => {
  if (!skipRoot) return thoughts
  const head = _.head(thoughts)
  if (!head) return thoughts
  const tail = _.tail(thoughts)
  return head.children.length > 0 ? [...head.children, ...tail] : tail
}

/** Calculate last thought of the first level, as this is where the selection will be restored to. */
const calculateLastThoughtFirstLevel = (rankStart: number, rankIncrement: number, thoughtsJSON: Block[]) => {
  const lastThoughtFirstLevelIndex = thoughtsJSON.length - 1
  const lastThoughtFirstLevel = thoughtsJSON[lastThoughtFirstLevelIndex]
  const rankOffset = lastThoughtFirstLevelIndex === 0 ? 0 : getRankOffset(thoughtsJSON, lastThoughtFirstLevelIndex)
  return { value: lastThoughtFirstLevel.scope, rank: rankStart + rankOffset * rankIncrement }
}

/** Return map of thought ranks. */
const createRankMap = (blocks: Block[], rankStart: number, rankIncrement: number) => {
  /** Recursively return last child in tree with maximum depth. Return undefined if block has no children. */
  const getLastChildDeep = (block: Block): Block | undefined => {
    const { children } = block
    const lastChild = _.last(children)
    if (!lastChild) return
    return lastChild.children.length > 0 ? getLastChildDeep(lastChild) : lastChild
  }

  /** Recursively calculate rank for each thought. */
  const calculateRanks = (blocks: Block[], rankMap: Map<Block, RankInfo>, rankStart: number, deepLevel = 0) => {
    blocks.forEach((block, index, blocks) => {
      if (index === 0) {
        rankMap.set(block, {
          rank: rankStart,
          deepLevel
        })
        calculateRanks(block.children, rankMap, rankStart + 1 * rankIncrement, deepLevel + 1)
        return
      }
      const prevSibling = blocks[index - 1]
      const prevRankedBlock = getLastChildDeep(prevSibling)
      if (!prevRankedBlock) {
        const prevSiblingRankInfo = rankMap.get(prevSibling)!
        rankMap.set(block, {
          rank: prevSiblingRankInfo.rank + 1 * rankIncrement,
          deepLevel
        })
        calculateRanks(block.children, rankMap, prevSiblingRankInfo.rank + 2 * rankIncrement, deepLevel + 1)
        return
      }
      const prevRankInfo = rankMap.get(prevRankedBlock)!
      rankMap.set(block, {
        rank: prevRankInfo.rank + (1 + prevRankInfo.deepLevel) * rankIncrement,
        deepLevel
      })
      calculateRanks(block.children, rankMap, prevRankInfo.rank + (2 + prevRankInfo.deepLevel) * rankIncrement, deepLevel + 1)
    })
  }

  const rankMap = new Map<Block, RankInfo>()
  calculateRanks(blocks, rankMap, rankStart)
  return rankMap
}

/** Recursively iterate through thoughtsJSON and call insertThought for each thought individually to save it. */
const saveThoughts = (context: Context, rankMap: Map<Block, RankInfo>, thoughtsJSON: Block[], insertThought: (value: string, context: Context, rank: number) => void) => {
  thoughtsJSON.forEach(thought => {
    const { rank } = rankMap.get(thought)!
    insertThought(thought.scope, context, rank)
    if (thought.children.length > 0) {
      saveThoughts([...context, thought.scope], rankMap, thought.children, insertThought)
    }
  })
}

/** Return number of contexts in ThoughtJSON array. */
const getContextsNum = (thoughts: Block[]): number => {
  return thoughts.map(thought => thought.children.length > 0 ? 1 + getContextsNum(thought.children) : 1).reduce((acc, val) => acc + val, 0)
}

/** Calculate rankIncrement value based on rank of next sibling or its absence. */
const getRankIncrement = (thoughtsJSON: Block[], state: State, context: Context, destThought: Child, rankStart: number) => {
  const numContexts = getContextsNum(thoughtsJSON)
  const destValue = destThought.value
  const destRank = destThought.rank
  const next = nextSibling(state, destValue, context, destRank) // paste after last child of current thought
  const rankIncrement = next ? (next.rank - rankStart) / (numContexts || 1) : 1 // prevent divide by zero
  return rankIncrement
}

/** Return start context for saving thoughts. */
const getStartContext = (thoughtsRanked: Path) => {
  const importCursor = equalPath(thoughtsRanked, [{ value: EM_TOKEN, rank: 0 }])
    ? thoughtsRanked
    : contextOf(thoughtsRanked)
  return pathToContext(importCursor)
}

/** Convert JSON to thoughts update. */
export const importJSON = (state: State, thoughtsRanked: Path, thoughtsJSON: Block[], { skipRoot }: ImportHtmlOptions = { skipRoot: false }) => {
  const thoughtIndexUpdates: GenericObject<Lexeme> = {}
  const contextIndexUpdates: GenericObject<ParentEntry> = {}
  const context = pathToContext(contextOf(thoughtsRanked))
  const destThought = head(thoughtsRanked)
  const destEmpty = destThought.value === '' && getThoughts(state, pathToContext(thoughtsRanked)).length === 0
  const thoughtIndex = { ...state.thoughts.thoughtIndex }
  const rankStart = getRankAfter(state, thoughtsRanked)
  const rankIncrement = getRankIncrement(thoughtsJSON, state, context, destThought, rankStart)

  // if the thought where we are pasting is empty, replace it instead of adding to it
  if (destEmpty) {
    const thought = getThought(state, '')
    if (thought && thought.contexts && thought.contexts.length > 1) {
      thoughtIndexUpdates[hashThought('')] = removeContext(thought, context, headRank(thoughtsRanked))
      const rootedContext = pathToContext(rootedContextOf(thoughtsRanked))
      const contextEncoded = hashContext(rootedContext)
      contextIndexUpdates[contextEncoded] = {
        ...contextIndexUpdates[contextEncoded],
        children: getThoughts(state, rootedContext)
          .filter(child => !equalThoughtRanked(child, destThought)),
        lastUpdated: timestamp(),
      }
    }
  }

  const lastThoughtFirstLevel = calculateLastThoughtFirstLevel(rankStart, rankIncrement, thoughtsJSON)

  /** Insert the given value at the context. Modifies contextIndex and thoughtIndex. */
  const insertThought = (value: string, context: Context, rank: number) => {
    value = value.trim()
    const id = createId()
    const rootContext = context.length > 0 ? context : [ROOT_TOKEN]
    const thoughtNew = addThought(
      {
        thoughts: {
          thoughtIndex
        }
      },
      value,
      rank,
      id,
      rootContext
    )

    thoughtIndex[hashThought(value)] = thoughtNew
    thoughtIndexUpdates[hashThought(value)] = thoughtNew

    // update contextIndexUpdates
    const contextEncoded = hashContext(rootContext)
    const childrenUpdates = contextIndexUpdates[contextEncoded] ? contextIndexUpdates[contextEncoded].children : []
    contextIndexUpdates[contextEncoded] = {
      ...contextIndexUpdates[contextEncoded],
      children: [...childrenUpdates, {
        value,
        rank,
        id,
        lastUpdated: timestamp(),
      }],
      lastUpdated: timestamp(),
    }
  }

  const startContext = getStartContext(thoughtsRanked)
  const thoughts = prepare(skipRoot, thoughtsJSON)
  const rankMap = createRankMap(thoughts, rankStart, rankIncrement)
  saveThoughts(startContext, rankMap, thoughts, insertThought)
  return {
    contextIndexUpdates,
    lastThoughtFirstLevel,
    thoughtIndexUpdates,
  }
}
