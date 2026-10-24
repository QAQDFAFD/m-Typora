import { remarkStringifyOptionsCtx, type Editor } from '@milkdown/kit/core'
import { remarkGFMPlugin } from '@milkdown/kit/preset/gfm'
import { gfmTableToMarkdown } from 'mdast-util-gfm-table'

/** An "unsafe" pattern from mdast-util-to-markdown: a character that may need escaping. */
interface UnsafeRule {
  character: string
  atBreak?: boolean | null
  inConstruct?: string | string[] | null
}

const inPhrasing = (rule: UnsafeRule) =>
  rule.inConstruct === 'phrasing' || (Array.isArray(rule.inConstruct) && rule.inConstruct.includes('phrasing'))
// Core markdown and the GFM footnote extension both register "[" rules.
const isBracketRule = (rule: UnsafeRule) => rule.character === '[' && (Boolean(rule.atBreak) || inPhrasing(rule))
const isTildeRule = (rule: UnsafeRule) => rule.character === '~' && inPhrasing(rule)

/**
 * True when no `[` in this text can start a link, reference, footnote or task marker,
 * so Typora-style literals like `[toc]`, `> [!NOTE]` or `array[0]` can be written unescaped.
 */
function bracketsAreLiteral(value: string, after: string, inListItem: boolean): boolean {
  if (!value.includes('[')) return true
  if (value.includes('[^')) return false
  if (inListItem && /(^|\n)\s*\[[ xX]\]/.test(value)) return false
  const stack: number[] = []
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '[') stack.push(i)
    else if (ch === ']' && stack.length > 0) {
      const open = stack.pop()!
      const next = value[i + 1] ?? after
      if (next === '(' || next === '[') return false
      const atLineStart = open === 0 || value[open - 1] === '\n'
      if (next === ':' && atLineStart) return false
    }
  }
  // An unclosed "[" could pair with text in a following node.
  return stack.length === 0
}

/** Single tildes are plain text once single-tilde strikethrough is off; only "~~" needs escaping. */
function tildesAreLiteral(value: string, before: string, after: string): boolean {
  return !value.includes('~~') && !(value.startsWith('~') && before === '~') && !(value.endsWith('~') && after === '~')
}

const WIDE_CHAR = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/

/** Display width used to line up table columns: CJK characters count double. */
function displayWidth(value: string): number {
  let width = 0
  for (const ch of value) width += WIDE_CHAR.test(ch) ? 2 : 1
  return width
}

const gfmTable = gfmTableToMarkdown({ stringLength: displayWidth })

/** Gives every delimiter cell at least three characters (`---`, `:--`, `:-:`, `--:`). */
function widenDelimiterRow(table: string): string {
  const lines = table.split('\n')
  if (lines.length < 2) return table
  lines[1] = lines[1].replace(/(:?)(-+)(:?)/g, (_m, before: string, dashes: string, after: string) => {
    const min = 3 - before.length - after.length
    return before + dashes.padEnd(Math.max(dashes.length, min, 1), '-') + after
  })
  return lines.join('\n')
}

/**
 * Makes saved Markdown match what Typora writes:
 * - "-" bullets, "---" rules, "*" emphasis and strong;
 * - `~x~` is subscript text, not strikethrough (only `~~x~~` strikes through);
 * - brackets and tildes are escaped only where they would otherwise change meaning;
 * - table columns line up by display width, and delimiter cells keep at least `---`.
 */
export function configureMarkdown(editor: Editor): void {
  editor.config((ctx) => {
    ctx.set(remarkGFMPlugin.options.key, { singleTilde: false })
    ctx.update(remarkStringifyOptionsCtx, (prev) => {
      const baseText = prev.handlers!.text!
      return {
        ...prev,
        bullet: '-' as const,
        rule: '-' as const,
        emphasis: '*' as const,
        strong: '*' as const,
        handlers: {
          ...prev.handlers,
          table: (node, parent, state, info) => widenDelimiterRow(gfmTable.handlers!.table!(node, parent, state, info)),
          text: (node, parent, state, info) => {
            const inListItem = state.stack.includes('listItem')
            const relaxBrackets = bracketsAreLiteral(node.value, info.after, inListItem)
            const relaxTildes = tildesAreLiteral(node.value, info.before, info.after)
            if (!relaxBrackets && !relaxTildes) return baseText(node, parent, state, info)
            const saved = state.unsafe
            state.unsafe = saved.filter((rule) => !((relaxBrackets && isBracketRule(rule)) || (relaxTildes && isTildeRule(rule))))
            try {
              return baseText(node, parent, state, info)
            } finally {
              state.unsafe = saved
            }
          }
        }
      }
    })
  })
}
