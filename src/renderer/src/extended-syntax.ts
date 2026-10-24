import DOMPurify from 'dompurify'
import { gemoji } from 'gemoji'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, type EditorState, type Selection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'

/**
 * Renders Typora's extended syntax without touching the document text, so saving is
 * always lossless: ==highlight==, ^sup^, ~sub~, :emoji:, inline HTML (<u>, <span>, <br>,
 * <img>), HTML blocks, `> [!NOTE]` callouts and `[toc]`. As in Typora, the raw syntax
 * reappears while the caret is inside it.
 */

const EMOJI = new Map(gemoji.flatMap((entry) => entry.names.map((name) => [name, entry.emoji] as const)))
const CALLOUT_TITLES: Record<string, string> = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' }
const INLINE_HTML_TAGS = new Set(['u', 'span', 'kbd', 'mark', 'sup', 'sub', 'b', 'strong', 'i', 'em', 's', 'del', 'ins', 'small', 'big', 'font', 'abbr', 'cite', 'q'])
const SAFE_STYLE = /^(color|background|background-color|font-size|font-weight|font-style|font-family|text-decoration|letter-spacing)$/i
const OBJECT = '￼'

type Range = [number, number]

type Construct =
  | { kind: 'span'; from: number; to: number; markers: Range[]; inner: Range; nodeName: string; className: string; style?: string; markerNodes?: boolean }
  | { kind: 'emoji'; from: number; to: number; emoji: string }
  | { kind: 'html'; from: number; to: number; html: string; block: boolean }
  | { kind: 'callout'; quote: Range; firstBlock: Range; marker: Range; type: string; markerOnly: boolean }
  | { kind: 'toc'; from: number; to: number }

interface State {
  focused: boolean
  constructs: Construct[]
}

const key = new PluginKey<State>('mtypora-extended-syntax')

// ------------------------------------------------------------------ scanning

/** Flattens a textblock to a string plus the doc position of every character. */
function flatten(block: ProseNode, start: number) {
  let text = ''
  const positions: number[] = []
  const code: boolean[] = []
  const atoms: Array<{ pos: number; node: ProseNode }> = []
  block.forEach((child, offset) => {
    const pos = start + offset
    if (child.isText) {
      const inCode = child.marks.some((mark) => mark.type.spec.code)
      for (let i = 0; i < child.text!.length; i++) {
        positions.push(pos + i)
        code.push(inCode)
      }
      text += child.text
    } else {
      atoms.push({ pos, node: child })
      positions.push(pos)
      code.push(true)
      text += OBJECT
    }
  })
  positions.push(start + block.content.size)
  return { text, positions, code, atoms }
}

function sanitizeStyle(attributes: string, tag: string): string | undefined {
  const declarations: string[] = []
  const style = /style\s*=\s*"([^"]*)"|style\s*=\s*'([^']*)'/i.exec(attributes)
  for (const part of (style?.[1] ?? style?.[2] ?? '').split(';')) {
    const [prop, ...rest] = part.split(':')
    const value = rest.join(':').trim()
    if (prop && value && SAFE_STYLE.test(prop.trim()) && !/url\(|expression|javascript:/i.test(value)) {
      declarations.push(`${prop.trim()}: ${value}`)
    }
  }
  if (tag === 'font') {
    const color = /color\s*=\s*"?([#\w]+)"?/i.exec(attributes)
    if (color) declarations.push(`color: ${color[1]}`)
  }
  return declarations.length ? declarations.join('; ') : undefined
}

/** Whether a raw HTML fragment is a complete element that can be rendered on its own. */
function isCompleteHtml(value: string): boolean {
  const html = value.trim()
  const open = /^<([a-z][\w-]*)\b[^>]*?(\/?)>/i.exec(html)
  if (!open) return false
  const tag = open[1].toLowerCase()
  if (open[2] === '/' || ['img', 'br', 'hr', 'input', 'video', 'audio'].includes(tag)) return true
  return new RegExp(`</${tag}\\s*>$`, 'i').test(html)
}

function scanTextblock(block: ProseNode, start: number, constructs: Construct[]): void {
  const { text, positions, code, atoms } = flatten(block, start)
  const overlapsCode = (a: number, b: number) => code.slice(a, b).some(Boolean)
  const pos = (index: number) => positions[index]

  const spans: Array<[RegExp, string, string]> = [
    [/==(?=\S)([^=\n]*?\S)==/g, 'mark', 'md-highlight'],
    [/(?<!\^)\^(?=\S)([^\s^]+?)\^(?!\^)/g, 'sup', 'md-sup'],
    [/(?<!~)~(?![~\s])([^\s~]+?)~(?!~)/g, 'sub', 'md-sub']
  ]
  for (const [pattern, nodeName, className] of spans) {
    for (const match of text.matchAll(pattern)) {
      const a = match.index!
      const b = a + match[0].length
      if (overlapsCode(a, b) || match[0].includes(OBJECT)) continue
      const marker = (match[0].length - match[1].length) / 2
      constructs.push({
        kind: 'span',
        from: pos(a),
        to: pos(b - 1) + 1,
        markers: [
          [pos(a), pos(a + marker - 1) + 1],
          [pos(b - marker), pos(b - 1) + 1]
        ],
        inner: [pos(a + marker), pos(b - marker - 1) + 1],
        nodeName,
        className
      })
    }
  }

  for (const match of text.matchAll(/:([a-z0-9_+-]+):/g)) {
    const emoji = EMOJI.get(match[1])
    const a = match.index!
    const b = a + match[0].length
    if (emoji && !overlapsCode(a, b)) constructs.push({ kind: 'emoji', from: pos(a), to: pos(b - 1) + 1, emoji })
  }

  // Inline HTML: pair <tag ...> … </tag> atoms, render self-contained ones.
  const htmlAtoms = atoms.filter((atom) => atom.node.type.name === 'html')
  const stack: Array<{ tag: string; attrs: string; pos: number }> = []
  for (const atom of htmlAtoms) {
    const value = String(atom.node.attrs.value ?? '').trim()
    const open = /^<([a-z][a-z0-9]*)\b([^>]*)>$/i.exec(value)
    const close = /^<\/([a-z][a-z0-9]*)\s*>$/i.exec(value)
    if (open && INLINE_HTML_TAGS.has(open[1].toLowerCase()) && !open[2].trim().endsWith('/')) {
      stack.push({ tag: open[1].toLowerCase(), attrs: open[2], pos: atom.pos })
    } else if (close) {
      const index = stack.map((entry) => entry.tag).lastIndexOf(close[1].toLowerCase())
      if (index < 0) continue
      const opener = stack[index]
      stack.length = index
      if (atom.pos > opener.pos + 1) {
        constructs.push({
          kind: 'span',
          from: opener.pos,
          to: atom.pos + 1,
          markers: [
            [opener.pos, opener.pos + 1],
            [atom.pos, atom.pos + 1]
          ],
          inner: [opener.pos + 1, atom.pos],
          nodeName: opener.tag === 'font' ? 'span' : opener.tag,
          className: 'md-inline-html',
          style: sanitizeStyle(opener.attrs, opener.tag),
          markerNodes: true
        })
      }
    } else if (isCompleteHtml(value)) {
      const onlyChild = block.childCount === 1
      constructs.push({ kind: 'html', from: atom.pos, to: atom.pos + 1, html: value, block: onlyChild })
    }
  }

  if (/^\[toc\]$/i.test(text.trim()) && block.type.name === 'paragraph') {
    constructs.push({ kind: 'toc', from: start, to: start + block.content.size })
  }
}

function scan(doc: ProseNode): Construct[] {
  const constructs: Construct[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'blockquote') {
      const first = node.firstChild
      if (first?.isTextblock) {
        const match = /^\[!(note|tip|important|warning|caution)\][ \t]*\n?/i.exec(first.textContent)
        if (match) {
          const blockStart = pos + 2
          constructs.push({
            kind: 'callout',
            quote: [pos, pos + node.nodeSize],
            firstBlock: [pos + 1, pos + 1 + first.nodeSize],
            marker: [blockStart, blockStart + match[0].length],
            type: match[1].toLowerCase(),
            markerOnly: match[0].length >= first.textContent.length
          })
        }
      }
    }
    if (node.isTextblock && !node.type.spec.code) {
      scanTextblock(node, pos + 1, constructs)
      return false
    }
    return true
  })
  return constructs
}

// -------------------------------------------------------------- decorations

export function editorHasFocus(): boolean {
  return document.activeElement?.closest('.ProseMirror') != null
}

function isActive(state: State, selection: Selection, from: number, to: number): boolean {
  return state.focused && selection.from <= to && selection.to >= from
}

function renderHtml(html: string, resolveImage: (src: string) => string, block: boolean): HTMLElement {
  const host = document.createElement(block ? 'div' : 'span')
  host.className = block ? 'md-html-block' : 'md-html-inline'
  host.contentEditable = 'false'
  host.innerHTML = DOMPurify.sanitize(html, { ADD_ATTR: ['target'] })
  host.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src')
    if (src) img.src = resolveImage(src)
  })
  return host
}

function renderToc(view: EditorView): HTMLElement {
  const toc = document.createElement('div')
  toc.className = 'md-toc'
  toc.contentEditable = 'false'
  const headings: Array<{ level: number; text: string; pos: number }> = []
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') headings.push({ level: node.attrs.level, text: node.textContent, pos })
    return !node.isTextblock
  })
  const minLevel = Math.min(...headings.map((h) => h.level), 6)
  for (const heading of headings) {
    const item = document.createElement('div')
    item.className = `md-toc-item md-toc-h${heading.level}`
    item.style.paddingLeft = `${(heading.level - minLevel) * 2}em`
    item.textContent = heading.text
    item.addEventListener('mousedown', (event) => {
      event.preventDefault()
      const dom = view.nodeDOM(heading.pos)
      if (dom instanceof HTMLElement) dom.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
    toc.append(item)
  }
  return toc
}

function headingSignature(doc: ProseNode): string {
  const parts: string[] = []
  doc.descendants((node) => {
    if (node.type.name === 'heading') parts.push(`${node.attrs.level}:${node.textContent}`)
    return !node.isTextblock
  })
  return parts.join('|')
}

function buildDecorations(editorState: EditorState, state: State, resolveImage: (src: string) => string): DecorationSet {
  const { selection, doc } = editorState
  const decorations: Decoration[] = []
  const meta = (from: number, to: number, active: boolean) =>
    Decoration.inline(from, to, { class: active ? 'md-meta-inline' : 'md-hidden-syntax' })

  for (const c of state.constructs) {
    switch (c.kind) {
      case 'span': {
        const active = isActive(state, selection, c.from, c.to)
        for (const [from, to] of c.markers) {
          decorations.push(c.markerNodes ? Decoration.node(from, to, { class: active ? 'md-html-tag' : 'md-hidden-syntax' }) : meta(from, to, active))
        }
        const attrs: Record<string, string> = { nodeName: c.nodeName, class: c.className }
        if (c.style) attrs.style = c.style
        if (c.inner[1] > c.inner[0]) decorations.push(Decoration.inline(c.inner[0], c.inner[1], attrs))
        break
      }
      case 'emoji':
        if (isActive(state, selection, c.from, c.to)) {
          decorations.push(Decoration.inline(c.from, c.to, { class: 'md-emoji-source' }))
        } else {
          decorations.push(
            Decoration.inline(c.from, c.to, { class: 'md-hidden-syntax' }),
            Decoration.widget(c.from, () => Object.assign(document.createElement('span'), { className: 'md-emoji', textContent: c.emoji }), {
              side: -1,
              key: `emoji-${c.emoji}`
            })
          )
        }
        break
      case 'html':
        if (!isActive(state, selection, c.from, c.to)) {
          decorations.push(
            Decoration.node(c.from, c.to, { class: 'md-hidden-syntax' }),
            Decoration.widget(c.from, () => renderHtml(c.html, resolveImage, c.block), { side: -1, key: `html-${c.block}-${c.html}` })
          )
        } else {
          decorations.push(Decoration.node(c.from, c.to, { class: 'md-html-tag' }))
        }
        break
      case 'callout': {
        const [from, to] = c.marker
        const $head = selection.$head
        const active = state.focused && $head.pos >= c.firstBlock[0] && $head.pos <= Math.max(to, c.firstBlock[0] + 1) + 1
        decorations.push(
          Decoration.node(c.quote[0], c.quote[1], { class: `md-alert md-alert-${c.type}`, 'data-alert-title': CALLOUT_TITLES[c.type] }),
          meta(from, to, active)
        )
        if (c.markerOnly && !active) decorations.push(Decoration.node(c.firstBlock[0], c.firstBlock[1], { class: 'md-alert-marker-line' }))
        break
      }
      case 'toc': {
        const active = isActive(state, selection, c.from, c.to)
        decorations.push(
          Decoration.widget(c.from, (view) => renderToc(view), { side: -1, key: `toc-${headingSignature(doc)}` }),
          Decoration.inline(c.from, c.to, { class: active ? 'md-meta-inline' : 'md-hidden-syntax' })
        )
        break
      }
    }
  }
  return DecorationSet.create(doc, decorations)
}

export function createExtendedSyntaxPlugin(resolveImage: (src: string) => string) {
  return $prose(
    () =>
      new Plugin<State>({
        key,
        state: {
          // Opening a file rebuilds the state while the editor keeps DOM focus.
          init: (_config, state) => ({ focused: editorHasFocus(), constructs: scan(state.doc) }),
          apply(tr, value, _old, state) {
            const focused = (tr.getMeta(key) as boolean | undefined) ?? value.focused
            const constructs = tr.docChanged ? scan(state.doc) : value.constructs
            return focused === value.focused && constructs === value.constructs ? value : { focused, constructs }
          }
        },
        props: {
          decorations(state) {
            const value = key.getState(state)
            return value && value.constructs.length > 0 ? buildDecorations(state, value, resolveImage) : DecorationSet.empty
          },
          handleDOMEvents: {
            focus: (view) => {
              view.dispatch(view.state.tr.setMeta(key, true))
              return false
            },
            blur: (view) => {
              view.dispatch(view.state.tr.setMeta(key, false))
              return false
            }
          }
        }
      })
  )
}
