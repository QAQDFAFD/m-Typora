import { editorViewCtx } from '@milkdown/kit/core'
import { $useKeymap } from '@milkdown/kit/utils'

/**
 * Backspace at the start of a heading turns it into a paragraph in one press, as in
 * Typora (Milkdown's default lowers the level one step per press: ### → ## → # → text).
 */
export const headingKeymap = $useKeymap('mtyporaHeadingKeymap', {
  HeadingToParagraph: {
    shortcuts: 'Backspace',
    priority: 300,
    command: (ctx) => () => {
      const view = ctx.get(editorViewCtx)
      const { state } = view
      const { $from, empty } = state.selection
      if (!empty || $from.parent.type.name !== 'heading' || $from.parentOffset !== 0) return false
      view.dispatch(state.tr.setBlockType($from.before(), $from.after(), state.schema.nodes.paragraph).scrollIntoView())
      return true
    }
  }
})
