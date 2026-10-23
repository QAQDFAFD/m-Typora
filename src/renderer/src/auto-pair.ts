import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { $prose } from '@milkdown/kit/utils'

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '“': '”', '‘': '’', '（': '）', '【': '】', '《': '》' }
const CLOSERS = new Set(Object.values(PAIRS))
const QUOTES = new Set(['"', "'"])

/** Auto-pairs brackets and quotes, and types over an auto-inserted closer (Typora's default). */
export function createAutoPairPlugin(enabled: () => boolean) {
  return $prose(
    () =>
      new Plugin({
        key: new PluginKey('mtypora-auto-pair'),
        props: {
          handleTextInput(view, from, to, text) {
            if (!enabled() || text.length !== 1) return false
            const { state } = view
            const $from = state.doc.resolve(from)
            if ($from.parent.type.spec.code || $from.marks().some((mark) => mark.type.spec.code)) return false
            const next = state.doc.textBetween(to, Math.min(to + 1, $from.end()), '')

            // Typing the closer that is already right after the caret just steps over it.
            if (CLOSERS.has(text) && from === to && next === text) {
              view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, to + 1)))
              return true
            }

            const closer = PAIRS[text]
            if (!closer) return false
            const prev = state.doc.textBetween(Math.max($from.start(), from - 1), from, '')
            // Don't pair apostrophes in words like "don't", or before existing text.
            if (QUOTES.has(text) && /[\p{L}\p{N}]/u.test(prev)) return false
            if (from === to && next && /[\p{L}\p{N}]/u.test(next)) return false

            const selected = state.doc.textBetween(from, to, '')
            const tr = state.tr.insertText(`${text}${selected}${closer}`, from, to)
            tr.setSelection(TextSelection.create(tr.doc, from + 1, from + 1 + selected.length))
            view.dispatch(tr)
            return true
          },
          handleKeyDown(view, event) {
            if (!enabled() || event.key !== 'Backspace') return false
            const { state } = view
            const { $from, empty } = state.selection
            if (!empty || $from.parent.type.spec.code) return false
            const prev = state.doc.textBetween(Math.max($from.start(), $from.pos - 1), $from.pos, '')
            const next = state.doc.textBetween($from.pos, Math.min($from.end(), $from.pos + 1), '')
            // Deleting an empty pair removes both halves.
            if (prev && PAIRS[prev] === next) {
              view.dispatch(state.tr.delete($from.pos - 1, $from.pos + 1))
              return true
            }
            return false
          }
        }
      })
  )
}
