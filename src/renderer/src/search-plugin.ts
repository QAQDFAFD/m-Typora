import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'

export interface SearchQuery {
  text: string
  caseSensitive: boolean
  wholeWord: boolean
}

interface Match {
  from: number
  to: number
}

interface SearchState {
  query: SearchQuery
  matches: Match[]
  current: number
}

const searchKey = new PluginKey<SearchState>('mtypora-search')
const EMPTY: SearchState = { query: { text: '', caseSensitive: false, wholeWord: false }, matches: [], current: -1 }

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findMatches(doc: ProseNode, query: SearchQuery): Match[] {
  if (!query.text) return []
  const source = query.wholeWord ? `\\b${escapeRegExp(query.text)}\\b` : escapeRegExp(query.text)
  const pattern = new RegExp(source, query.caseSensitive ? 'gu' : 'giu')
  const matches: Match[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    // Search each textblock as one string so matches can span marks.
    let text = ''
    const offsets: number[] = []
    node.forEach((child, offset) => {
      if (child.isText) {
        for (let i = 0; i < child.text!.length; i++) offsets.push(pos + 1 + offset + i)
        text += child.text
      }
    })
    for (const found of text.matchAll(pattern)) {
      if (found[0].length === 0) continue
      const from = offsets[found.index!]
      const to = offsets[found.index! + found[0].length - 1] + 1
      matches.push({ from, to })
    }
    return false
  })
  return matches
}

function nearest(matches: Match[], pos: number): number {
  if (matches.length === 0) return -1
  const index = matches.findIndex((match) => match.from >= pos)
  return index === -1 ? 0 : index
}

export const searchPlugin = $prose(
  () =>
    new Plugin<SearchState>({
      key: searchKey,
      state: {
        init: () => EMPTY,
        apply(tr, value, _old, state) {
          const meta = tr.getMeta(searchKey) as Partial<SearchState> | undefined
          if (meta?.query) {
            const matches = findMatches(state.doc, meta.query)
            return { query: meta.query, matches, current: meta.current ?? nearest(matches, state.selection.from) }
          }
          if (meta?.current !== undefined) return { ...value, current: meta.current }
          if (tr.docChanged && value.query.text) {
            const matches = findMatches(state.doc, value.query)
            return { ...value, matches, current: Math.min(value.current, matches.length - 1) }
          }
          return value
        }
      },
      props: {
        decorations(state) {
          const { matches, current } = searchKey.getState(state) ?? EMPTY
          if (matches.length === 0) return DecorationSet.empty
          return DecorationSet.create(
            state.doc,
            matches.map((match, index) =>
              Decoration.inline(match.from, match.to, { class: index === current ? 'md-search-hit md-search-current' : 'md-search-hit' })
            )
          )
        }
      }
    })
)

export function searchStatus(state: EditorState): { total: number; current: number } {
  const { matches, current } = searchKey.getState(state) ?? EMPTY
  return { total: matches.length, current }
}

export function setSearchQuery(view: EditorView, query: SearchQuery): void {
  view.dispatch(view.state.tr.setMeta(searchKey, { query }))
}

export function clearSearch(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(searchKey, { query: EMPTY.query }))
}

function reveal(view: EditorView, match: Match): void {
  const node = view.domAtPos(match.from).node
  const element = node instanceof HTMLElement ? node : node.parentElement
  element?.scrollIntoView({ block: 'center' })
}

/** Moves to the next (dir = 1) or previous (dir = -1) match and scrolls it into view. */
export function stepSearch(view: EditorView, dir: 1 | -1): void {
  const { matches, current } = searchKey.getState(view.state) ?? EMPTY
  if (matches.length === 0) return
  const next = (current + dir + matches.length) % matches.length
  view.dispatch(view.state.tr.setMeta(searchKey, { current: next }))
  reveal(view, matches[next])
}

export function replaceCurrent(view: EditorView, replacement: string): void {
  const { matches, current } = searchKey.getState(view.state) ?? EMPTY
  const match = matches[current]
  if (!match) return
  const tr = view.state.tr.insertText(replacement, match.from, match.to)
  tr.setSelection(TextSelection.create(tr.doc, match.from + replacement.length))
  view.dispatch(tr)
  const after = searchKey.getState(view.state) ?? EMPTY
  if (after.matches.length > 0) {
    const index = nearest(after.matches, match.from + replacement.length)
    view.dispatch(view.state.tr.setMeta(searchKey, { current: index }))
    reveal(view, after.matches[index])
  }
}

export function replaceAll(view: EditorView, replacement: string): number {
  const { matches } = searchKey.getState(view.state) ?? EMPTY
  if (matches.length === 0) return 0
  const tr = view.state.tr
  for (let i = matches.length - 1; i >= 0; i--) tr.insertText(replacement, matches[i].from, matches[i].to)
  view.dispatch(tr)
  return matches.length
}
