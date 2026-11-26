import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration as CmDecoration, type DecorationSet as CmDecorationSet, EditorView as CmEditorView } from '@codemirror/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { findTextMatches, type SearchQuery } from './search-match'

export { findTextMatches, type SearchQuery } from './search-match'

interface Match {
  from: number
  to: number
}

interface SearchState {
  query: SearchQuery
  matches: Match[]
  current: number
}

interface CodeSearchRange {
  from: number
  to: number
  current: boolean
}

const searchKey = new PluginKey<SearchState>('mtypora-search')
const EMPTY: SearchState = { query: { text: '', caseSensitive: false, wholeWord: false }, matches: [], current: -1 }

const setCodeSearchHighlights = StateEffect.define<CodeSearchRange[]>()
const hitMark = CmDecoration.mark({ class: 'md-search-hit' })
const currentHitMark = CmDecoration.mark({ class: 'md-search-hit md-search-current' })

const codeSearchField = StateField.define<CmDecorationSet>({
  create: () => CmDecoration.none,
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setCodeSearchHighlights)) {
        const items = effect.value
          .filter((item) => item.from < item.to && item.to <= tr.state.doc.length)
          .map((item) => (item.current ? currentHitMark : hitMark).range(item.from, item.to))
        return CmDecoration.set(items, true)
      }
    }
    return tr.docChanged ? decorations.map(tr.changes) : decorations
  },
  provide: (field) => CmEditorView.decorations.from(field)
})

/** Highlights ProseMirror find-bar matches inside nested CodeMirror code fences. */
export const codeBlockSearchHighlight: Extension = codeSearchField

function findMatches(doc: ProseNode, query: SearchQuery): Match[] {
  if (!query.text) return []
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
    for (const found of findTextMatches(text, query)) {
      const from = offsets[found.index]
      const to = offsets[found.index + found.length - 1] + 1
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

function codeEditorAt(view: EditorView, pos: number): CmEditorView | null {
  const dom = view.nodeDOM(pos)
  if (!(dom instanceof HTMLElement)) return null
  const cmDom = dom.matches('.cm-editor') ? dom : dom.querySelector<HTMLElement>('.cm-editor')
  return cmDom ? CmEditorView.findFromDOM(cmDom) : null
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
            const current =
              matches.length === 0 ? -1 : value.current < 0 ? nearest(matches, state.selection.from) : Math.min(value.current, matches.length - 1)
            return { ...value, matches, current }
          }
          return value
        }
      },
      props: {
        decorations(state) {
          const { matches, current } = searchKey.getState(state) ?? EMPTY
          if (matches.length === 0) return DecorationSet.empty
          const ranges: Decoration[] = []
          for (let index = 0; index < matches.length; index++) {
            const match = matches[index]
            // Nested CodeMirror blocks draw their own highlights via codeBlockSearchHighlight.
            if (state.doc.resolve(match.from).parent.type.name === 'code_block') continue
            ranges.push(Decoration.inline(match.from, match.to, { class: index === current ? 'md-search-hit md-search-current' : 'md-search-hit' }))
          }
          return ranges.length > 0 ? DecorationSet.create(state.doc, ranges) : DecorationSet.empty
        }
      },
      view: () => {
        const synced = new WeakMap<CmEditorView, string>()
        let hasActiveCodeHits = false
        return {
          update(view) {
            const { matches, current } = searchKey.getState(view.state) ?? EMPTY
            if (matches.length === 0 && !hasActiveCodeHits) return
            let active = false
            view.state.doc.descendants((node, pos) => {
              if (node.type.name !== 'code_block') return !node.isTextblock
              const cm = codeEditorAt(view, pos)
              if (!cm) return false
              const start = pos + 1
              const end = start + node.content.size
              const hits: CodeSearchRange[] = []
              for (let i = 0; i < matches.length; i++) {
                const m = matches[i]
                if (m.from >= start && m.to <= end) hits.push({ from: m.from - start, to: m.to - start, current: i === current })
              }
              if (hits.length > 0) active = true
              const signature = hits.map((h) => `${h.from}:${h.to}:${h.current ? 1 : 0}`).join(',')
              const prev = synced.get(cm) ?? ''
              if (prev !== signature) {
                synced.set(cm, signature)
                cm.dispatch({ effects: setCodeSearchHighlights.of(hits) })
              }
              return false
            })
            hasActiveCodeHits = active
          }
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
  const $from = view.state.doc.resolve(match.from)
  if ($from.parent.type.name === 'code_block') {
    const pos = $from.before()
    const dom = view.nodeDOM(pos)
    if (dom instanceof HTMLElement) dom.scrollIntoView({ block: 'center' })
    const cm = codeEditorAt(view, pos)
    if (cm) {
      const local = Math.max(0, Math.min(match.from - (pos + 1), cm.state.doc.length))
      cm.dispatch({ effects: CmEditorView.scrollIntoView(local, { y: 'center' }) })
    }
    return
  }
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
