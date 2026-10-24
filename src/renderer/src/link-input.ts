import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { $prose } from '@milkdown/kit/utils'

/** `[text](url "title")` or `![alt](src "title")` right before the caret. */
const LINK_SOURCE = /(!?)\[([^[\]\n]*)\]\(([^()\s]+)(?:\s+"([^"\n]*)")?$/

/**
 * Typora turns typed `[text](url)` into a link and `![alt](src)` into an image the moment
 * the closing parenthesis is typed — including when auto-pairing already inserted it.
 * Registered before the auto-pair plugin so it sees the `)` first.
 */
export const linkInputPlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey('mtypora-link-input'),
      props: {
        handleTextInput(view, from, to, text) {
          if (text !== ')' || from !== to) return false
          const { state } = view
          const $from = state.doc.resolve(from)
          if ($from.parent.type.spec.code || $from.marks().some((mark) => mark.type.spec.code)) return false
          const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 500), $from.parentOffset, undefined, '￼')
          const match = LINK_SOURCE.exec(before)
          if (!match) return false
          const [source, bang, label, href, title] = match
          const start = from - source.length
          // An auto-paired ")" already after the caret belongs to this link.
          const end = state.doc.textBetween(from, Math.min(from + 1, $from.end()), '') === ')' ? from + 1 : from
          const { schema } = state
          const tr = state.tr
          if (bang) {
            if (!schema.nodes.image) return false
            tr.replaceWith(start, end, schema.nodes.image.create({ src: href, alt: label, title: title ?? '' }))
            tr.setSelection(TextSelection.create(tr.doc, start + 1))
          } else {
            const link = schema.marks.link
            if (!link || !label) return false
            const marks = $from.marks().filter((mark) => mark.type !== link)
            tr.replaceWith(start, end, schema.text(label, [...marks, link.create({ href, title: title ?? null })]))
            tr.setSelection(TextSelection.create(tr.doc, start + label.length)).removeStoredMark(link)
          }
          view.dispatch(tr)
          return true
        }
      }
    })
)
