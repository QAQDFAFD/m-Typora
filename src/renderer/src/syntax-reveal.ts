import type { Mark, Node as ProseNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'

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

const revealKey = new PluginKey<boolean>('mtypora-syntax-reveal')

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

function buildDecorations(state: EditorState): DecorationSet {
  const { $from, $to } = state.selection
  if (!$from.parent.inlineContent || !$from.sameParent($to)) return DecorationSet.empty
  const start = $from.start()
  const decorations: Decoration[] = []
  for (const run of markRuns($from.parent, start)) {
    if ($to.pos < run.from || $from.pos > run.to) continue
    const [before, after] = DELIMITERS[run.mark.type.name](run.mark)
    const id = `${run.mark.type.name}-${run.from}`
    decorations.push(
      Decoration.widget(run.from, () => delimiter(before, 'open'), { side: -1, key: `${id}-o-${before}`, ignoreSelection: true }),
      Decoration.widget(run.to, () => delimiter(after, 'close'), { side: 1, key: `${id}-c-${after}`, ignoreSelection: true })
    )
  }
  return DecorationSet.create(state.doc, decorations)
}

/**
 * Typora's signature behavior: inline Markdown syntax (`**`, `*`, `` ` ``, `~~`, `[..](..)`)
 * is hidden, and revealed only around the styled text that contains the caret.
 */
export const syntaxRevealPlugin = $prose(
  () =>
    new Plugin<boolean>({
      key: revealKey,
      state: {
        init: () => false,
        apply: (tr, focused) => tr.getMeta(revealKey) ?? focused
      },
      props: {
        decorations(state) {
          return revealKey.getState(state) ? buildDecorations(state) : DecorationSet.empty
        },
        handleDOMEvents: {
          focus: (view) => {
            view.dispatch(view.state.tr.setMeta(revealKey, true))
            return false
          },
          blur: (view) => {
            view.dispatch(view.state.tr.setMeta(revealKey, false))
            return false
          }
        }
      }
    })
)
