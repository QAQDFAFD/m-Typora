import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'

export const focusKey = new PluginKey('mtypora-focus')

/**
 * Marks the top-level block that holds the cursor with `.md-focus`.
 * Focus mode dims every other block through CSS; typewriter mode
 * uses the `onCursorMove` callback to keep the caret vertically centered.
 */
export function createFocusPlugin(onCursorMove: (view: EditorView) => void) {
  return $prose(
    () =>
      new Plugin({
        key: focusKey,
        props: {
          decorations(state) {
            const { $head } = state.selection
            if ($head.depth < 1) return DecorationSet.empty
            const from = $head.before(1)
            const to = from + $head.node(1).nodeSize
            return DecorationSet.create(state.doc, [Decoration.node(from, to, { class: 'md-focus' })])
          }
        },
        view: () => ({
          update(view, prevState) {
            if (!prevState.selection.eq(view.state.selection) || !prevState.doc.eq(view.state.doc)) {
              onCursorMove(view)
            }
          }
        })
      })
  )
}
