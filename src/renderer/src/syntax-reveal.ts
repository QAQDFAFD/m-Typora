import type { Mark, Node as ProseNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $prose, $useKeymap } from '@milkdown/kit/utils'
import { editorHasFocus } from './extended-syntax'

/** Markdown delimiters per mark, shown around the styled run that holds the caret. */
const DELIMITERS: Record<string, (mark: Mark) => [string, string]> = {
  strong: () => ['**', '**'],
  emphasis: () => ['*', '*'],
  inlineCode: () => ['`', '`'],
  strike_through: () => ['~~', '~~'],
  link: (mark) => ['[', `](${mark.attrs.href}${mark.attrs.title ? ` "${mark.attrs.title}"` : ''})`]
}

interface Run {
  mark: Mark
  from: number
  to: number
}

/**
 * Both sides of a delimiter are the same document position. By default the caret sits next
 * to the text (after an opening `**`, before a closing one); `outside` records that it is
 * in front of the opening delimiter or after the closing one instead.
 */
interface Outside {
  pos: number
  side: 'open' | 'close'
}

interface RevealState {
  focused: boolean
  outside: Outside | null
}

const revealKey = new PluginKey<RevealState>('mtypora-syntax-reveal')

/** Contiguous ranges of each supported mark inside one textblock. */
function markRuns(block: ProseNode, start: number): Run[] {
  const runs: Run[] = []
  const open = new Map<string, Run>()
  block.forEach((child, offset) => {
    const from = start + offset
    const to = from + child.nodeSize
    const present = new Set<string>()
    for (const mark of child.marks) {
      if (!DELIMITERS[mark.type.name]) continue
      present.add(mark.type.name)
      const run = open.get(mark.type.name)
      if (run && run.to === from && run.mark.eq(mark)) {
        run.to = to
      } else {
        const next = { mark, from, to }
        runs.push(next)
        open.set(mark.type.name, next)
      }
    }
    for (const name of open.keys()) if (!present.has(name)) open.delete(name)
  })
  return runs
}

function delimiter(text: string, side: 'open' | 'close'): HTMLElement {
  const span = document.createElement('span')
  span.className = `md-meta md-meta-${side}`
  span.textContent = text
  return span
}

function buildDecorations(state: EditorState, outside: Outside | null): DecorationSet {
  const { $from, $to } = state.selection
  if (!$from.parent.inlineContent || !$from.sameParent($to)) return DecorationSet.empty
  const start = $from.start()
  const decorations: Decoration[] = []
  for (const run of markRuns($from.parent, start)) {
    if ($to.pos < run.from || $from.pos > run.to) continue
    const [before, after] = DELIMITERS[run.mark.type.name](run.mark)
    const id = `${run.mark.type.name}-${run.from}`
    // The caret is drawn on the side of a widget away from its `side`. `marks: []` keeps
    // the delimiters plain either way (a widget otherwise takes the marks on its side).
    const openSide = outside?.side === 'open' && outside.pos === run.from ? 1 : -1
    const closeSide = outside?.side === 'close' && outside.pos === run.to ? -1 : 1
    const spec = { ignoreSelection: true, marks: [] }
    decorations.push(
      Decoration.widget(run.from, () => delimiter(before, 'open'), { ...spec, side: openSide, key: `${id}-o${openSide}-${before}` }),
      Decoration.widget(run.to, () => delimiter(after, 'close'), { ...spec, side: closeSide, key: `${id}-c${closeSide}-${after}` })
    )
  }
  return DecorationSet.create(state.doc, decorations)
}

/** The collapsed caret and the styled runs of its textblock. */
function caretRuns(state: EditorState): { pos: number; runs: Run[] } | null {
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty || !selection.$from.parent.inlineContent) return null
  return { pos: selection.from, runs: markRuns(selection.$from.parent, selection.$from.start()) }
}

/** Moves the caret across a delimiter without moving it in the document. */
function setOutside(tr: Transaction, outside: Outside | null, run: Run | undefined): Transaction {
  tr.setMeta(revealKey, { outside })
  // Text typed outside the delimiters is not styled, also when it comes from an IME.
  return tr.setStoredMarks(outside && run ? run.mark.removeFromSet(tr.selection.$from.marks()) : null)
}

/**
 * Deleting one character of a delimiter, as in Typora: the run is no longer valid Markdown
 * styling, so it turns back into its source text (`**bold**` → `**bold*`), which can then be
 * edited like any other text — typing the `*` back restyles it.
 */
function deleteDelimiterChar(state: EditorState, run: Run, which: 'open' | 'close', at: 'start' | 'end'): Transaction {
  let [open, close] = DELIMITERS[run.mark.type.name](run.mark)
  const cut = (text: string) => (at === 'end' ? text.slice(0, -1) : text.slice(1))
  if (which === 'open') open = cut(open)
  else close = cut(close)
  const tr = state.tr.setStoredMarks(null).removeMark(run.from, run.to, run.mark)
  if (close) tr.insertText(close, run.to)
  if (open) tr.insertText(open, run.from)
  // The caret stays where the deleted character was.
  const caret = which === 'open' ? run.from + (at === 'end' ? open.length : 0) : run.to + open.length + (at === 'end' ? close.length : 0)
  return tr.setSelection(TextSelection.create(tr.doc, caret)).setMeta(revealKey, { outside: null })
}

type DelimiterKey = 'Backspace' | 'Delete' | 'ArrowLeft' | 'ArrowRight'

function delimiterKey(state: EditorState, key: DelimiterKey): Transaction | null {
  const reveal = revealKey.getState(state)
  const caret = reveal?.focused ? caretRuns(state) : null
  if (!reveal || !caret) return null
  const { pos, runs } = caret
  const outside = reveal.outside?.pos === pos ? reveal.outside.side : null
  const opening = runs.find((run) => run.from === pos)
  const closing = runs.find((run) => run.to === pos)
  switch (key) {
    case 'ArrowRight':
      if (outside === 'open' && opening) return setOutside(state.tr, null, opening)
      if (!outside && closing) return setOutside(state.tr, { pos, side: 'close' }, closing)
      return null
    case 'ArrowLeft':
      if (outside === 'close' && closing) return setOutside(state.tr, null, closing)
      if (!outside && opening) return setOutside(state.tr, { pos, side: 'open' }, opening)
      return null
    case 'Backspace':
      if (outside === 'close' && closing) return deleteDelimiterChar(state, closing, 'close', 'end')
      if (!outside && opening) return deleteDelimiterChar(state, opening, 'open', 'end')
      return null
    case 'Delete':
      if (outside === 'open' && opening) return deleteDelimiterChar(state, opening, 'open', 'start')
      if (!outside && closing) return deleteDelimiterChar(state, closing, 'close', 'start')
      return null
  }
}

const keyCommand = (key: DelimiterKey) => ({
  shortcuts: key,
  // Before the heading and list keymaps: `# **x**` with the caret after the `**` deletes a `*`.
  priority: 400,
  command: () => (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    const tr = delimiterKey(state, key)
    if (!tr) return false
    dispatch?.(tr.scrollIntoView())
    return true
  }
})

/** Typora lets the caret step over a revealed delimiter and delete its characters. */
export const syntaxRevealKeymap = $useKeymap('mtyporaSyntaxRevealKeymap', {
  DelimiterBackspace: keyCommand('Backspace'),
  DelimiterDelete: keyCommand('Delete'),
  DelimiterLeft: keyCommand('ArrowLeft'),
  DelimiterRight: keyCommand('ArrowRight')
})

/** The revealed delimiters around `pos`, with their run. */
function delimitersAt(view: EditorView, pos: number): Array<{ el: HTMLElement; side: 'open' | 'close'; run: Run | undefined }> {
  const caret = caretRuns(view.state)
  return Array.from(view.dom.querySelectorAll<HTMLElement>('.md-meta-open, .md-meta-close'))
    .filter((el) => view.posAtDOM(el, 0) === pos)
    .map((el) => {
      const side = el.classList.contains('md-meta-open') ? ('open' as const) : ('close' as const)
      return { el, side, run: caret?.runs.find((run) => (side === 'open' ? run.from : run.to) === pos) }
    })
}

/** Puts the caret at `pos`, outside the delimiter on `side` (or next to the text for null). */
function placeCaret(view: EditorView, pos: number, side: 'open' | 'close' | null, run: Run | undefined): void {
  const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, pos))
  view.dispatch(setOutside(tr, side ? { pos, side } : null, run))
  view.focus()
}

/**
 * Typora's signature behavior: inline Markdown syntax (`**`, `*`, `` ` ``, `~~`, `[..](..)`)
 * is hidden, and revealed only around the styled text that contains the caret. The caret can
 * be put on either side of a revealed delimiter, and its characters can be deleted.
 */
export const syntaxRevealPlugin = $prose(
  () =>
    new Plugin<RevealState>({
      key: revealKey,
      state: {
        // Opening a file rebuilds the state while the editor keeps DOM focus.
        init: () => ({ focused: editorHasFocus(), outside: null }),
        apply: (tr, prev) => {
          const meta = tr.getMeta(revealKey) as Partial<RevealState> | undefined
          if (meta) return { ...prev, ...meta }
          return prev.outside && (tr.docChanged || tr.selectionSet) ? { ...prev, outside: null } : prev
        }
      },
      props: {
        decorations(state) {
          const reveal = revealKey.getState(state)
          return reveal?.focused ? buildDecorations(state, reveal.outside) : DecorationSet.empty
        },
        // Clicking past the end of a closing delimiter (or before an opening one) puts the caret there.
        handleClick(view, pos, event) {
          if (!revealKey.getState(view.state)?.focused || (event.target as HTMLElement).closest?.('.md-meta')) return false
          const hit = delimitersAt(view, pos).find(({ el, side }) => {
            const rect = el.getBoundingClientRect()
            if (event.clientY < rect.top || event.clientY > rect.bottom) return false
            return side === 'close' ? event.clientX >= rect.right : event.clientX <= rect.left
          })
          if (!hit?.run) return false
          placeCaret(view, pos, hit.side, hit.run)
          return true
        },
        handleDOMEvents: {
          // A click on a delimiter puts the caret on the nearer side of it, never inside it.
          mousedown: (view, event) => {
            const el = (event.target as HTMLElement).closest?.<HTMLElement>('.md-meta-open, .md-meta-close')
            if (!el || event.button !== 0 || event.shiftKey || !view.dom.contains(el)) return false
            event.preventDefault()
            const pos = view.posAtDOM(el, 0)
            const target = delimitersAt(view, pos).find((item) => item.el === el)
            const rect = el.getBoundingClientRect()
            const outer = target?.side === 'close' ? event.clientX >= rect.left + rect.width / 2 : event.clientX < rect.left + rect.width / 2
            placeCaret(view, pos, outer && target?.run ? target.side : null, target?.run)
            return true
          },
          focus: (view) => {
            view.dispatch(view.state.tr.setMeta(revealKey, { focused: true }))
            return false
          },
          blur: (view) => {
            view.dispatch(view.state.tr.setMeta(revealKey, { focused: false, outside: null }))
            return false
          }
        }
      }
    })
)
