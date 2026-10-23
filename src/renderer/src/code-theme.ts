import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

/**
 * Code-fence highlighting in the classic CodeMirror palette Typora's default theme uses.
 * Colors come from CSS variables so every theme (including Night) can restyle them.
 */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: 'var(--cm-keyword)' },
  { tag: [t.atom, t.bool, t.null], color: 'var(--cm-atom)' },
  { tag: [t.number], color: 'var(--cm-number)' },
  { tag: [t.definition(t.variableName), t.function(t.definition(t.variableName)), t.definition(t.propertyName)], color: 'var(--cm-def)' },
  { tag: [t.variableName, t.special(t.variableName)], color: 'var(--cm-variable)' },
  { tag: [t.local(t.variableName), t.definition(t.local(t.variableName))], color: 'var(--cm-variable-2)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--cm-variable-3)' },
  { tag: [t.propertyName], color: 'var(--cm-property)' },
  { tag: [t.operator], color: 'var(--cm-operator)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--cm-comment)' },
  { tag: [t.string, t.docString], color: 'var(--cm-string)' },
  { tag: [t.special(t.string), t.regexp, t.escape, t.special(t.brace)], color: 'var(--cm-string-2)' },
  { tag: [t.meta, t.processingInstruction], color: 'var(--cm-meta)' },
  { tag: [t.tagName], color: 'var(--cm-tag)' },
  { tag: [t.attributeName], color: 'var(--cm-attribute)' },
  { tag: [t.link, t.url], color: 'var(--cm-link)', textDecoration: 'underline' },
  { tag: [t.heading], color: 'var(--cm-header)', fontWeight: 'bold' },
  { tag: [t.strong], fontWeight: 'bold' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strikethrough], textDecoration: 'line-through' },
  { tag: [t.invalid], color: 'var(--cm-error)' }
])

const chrome = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--code-fg)' },
  '.cm-content': { caretColor: 'var(--text-color)', fontFamily: 'var(--monospace)' },
  '.cm-cursor': { borderLeftColor: 'var(--text-color)' },
  '.cm-gutters': { display: 'none' },
  '&.cm-focused': { outline: 'none' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--select-text-bg-color)' }
})

export const codeFenceTheme = [chrome, syntaxHighlighting(highlight)]
export const sourceHighlight = syntaxHighlighting(highlight)
