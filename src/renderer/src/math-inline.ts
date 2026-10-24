import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state'
import { $prose } from '@milkdown/kit/utils'

const EDITOR = '.milkdown-latex-inline-edit'

function selectedMath(state: EditorState): NodeSelection | null {
  const { selection } = state
  return selection instanceof NodeSelection && selection.node.type.name === 'math_inline' ? selection : null
}

/**
 * Crepe edits inline math in a pop-up that only applies the formula on Enter, so clicking
 * elsewhere silently dropped the edit. Like Typora, keep what was typed when the caret
 * leaves the formula; Esc leaves it unchanged.
 */
export const mathInlineEditPlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey('mtypora-math-inline-edit'),
      view(view) {
        let pending: { pos: number; original: string; value: string } | null = null
        const editorOf = (target: EventTarget | null) => (target instanceof Element ? target.closest(EDITOR) : null)

        const record = (event: Event) => {
          const box = editorOf(event.target)
          const math = selectedMath(view.state)
          if (!box || !math) return
          const value = box.querySelector('.ProseMirror')?.textContent ?? ''
          pending = { pos: math.from, original: math.node.attrs.value, value }
        }
        const onKeyDown = (event: KeyboardEvent) => {
          const math = selectedMath(view.state)
          if (event.key !== 'Escape' || !editorOf(event.target) || !math) return
          event.preventDefault()
          event.stopPropagation()
          pending = null
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, math.to)))
          view.focus()
        }
        document.addEventListener('input', record, true)
        document.addEventListener('keyup', record, true)
        document.addEventListener('keydown', onKeyDown, true)

        return {
          update(view) {
            if (!pending || selectedMath(view.state)?.from === pending.pos) return
            const { pos, original, value } = pending
            pending = null
            if (value === original) return
            // Not while ProseMirror is still applying the selection change that closed the pop-up.
            setTimeout(() => {
              const node = view.isDestroyed ? null : view.state.doc.nodeAt(pos)
              if (node?.type.name === 'math_inline' && node.attrs.value === original) {
                view.dispatch(view.state.tr.setNodeAttribute(pos, 'value', value))
              }
            })
          },
          destroy() {
            document.removeEventListener('input', record, true)
            document.removeEventListener('keyup', record, true)
            document.removeEventListener('keydown', onKeyDown, true)
          }
        }
      }
    })
)
