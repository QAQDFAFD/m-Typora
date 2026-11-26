import type { Mark, MarkType } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, TextSelection, type EditorState, type PluginView } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'

type LinkMode = { kind: 'edit' } | { kind: 'insert'; pos: number } | null

const key = new PluginKey<LinkMode>('mtypora-link-editor')
const isMac = /Mac/i.test(navigator.platform)

/** The link run (same href) that contains `pos`, if any. */
function linkAt(state: EditorState, pos: number): { from: number; to: number; mark: Mark } | null {
  const type = state.schema.marks.link as MarkType | undefined
  if (!type) return null
  const $pos = state.doc.resolve(pos)
  const parent = $pos.parent
  const start = $pos.start()
  let found: { from: number; to: number; mark: Mark } | null = null
  let run: { from: number; to: number; mark: Mark } | null = null
  parent.forEach((child, offset) => {
    const from = start + offset
    const mark = type.isInSet(child.marks)
    if (mark && run && run.to === from && run.mark.eq(mark)) run.to = from + child.nodeSize
    else run = mark ? { from, to: from + child.nodeSize, mark } : null
    if (run && run.from <= pos && pos <= run.to) found = { ...run }
  })
  return found
}

/** Opens the link editor for the link at the caret, selection, or inserts a new link at the caret. */
export function openLinkEditor(view: EditorView): boolean {
  const { state } = view
  const { from, to, empty, $from } = state.selection
  const type = state.schema.marks.link
  if (!type) return false
  if (!empty && !linkAt(state, from)) {
    view.dispatch(state.tr.addMark(from, to, type.create({ href: '' })).setMeta(key, { kind: 'edit' }))
    return true
  }
  if (linkAt(state, from)) {
    view.dispatch(state.tr.setMeta(key, { kind: 'edit' }))
    return true
  }
  if (!empty || !$from.parent.inlineContent || $from.parent.type.spec.code) return false
  view.dispatch(state.tr.setMeta(key, { kind: 'insert', pos: from }))
  return true
}

/**
 * Typora-style link handling: ⌘K edits the URL in a small box under the link, and hovering
 * a link only hints how to open it (instead of a floating action toolbar).
 */
class LinkEditorView implements PluginView {
  private box: HTMLElement
  private input: HTMLInputElement
  private range: { from: number; to: number } | null = null
  private insertPos: number | null = null
  private attrs: Record<string, unknown> = {}

  constructor(private view: EditorView) {
    this.box = document.createElement('div')
    this.box.className = 'md-link-editor'
    this.box.hidden = true
    this.input = document.createElement('input')
    this.input.placeholder = '输入链接地址'
    this.input.spellcheck = false
    this.box.append(this.input)
    view.dom.parentElement?.append(this.box)

    this.input.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        this.commit(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        this.close(true)
      }
    })
    this.input.addEventListener('blur', () => {
      if (!this.box.hidden) this.commit(false)
    })
    view.dom.addEventListener('mouseover', this.onHover)
  }

  update(view: EditorView): void {
    this.view = view
    const mode = key.getState(view.state)
    if (mode?.kind === 'insert') {
      this.insertPos = mode.pos
      this.range = null
      this.attrs = {}
      if (this.box.hidden) this.openAt('', mode.pos)
      return
    }
    const link = mode?.kind === 'edit' ? linkAt(view.state, view.state.selection.from) : null
    if (!link) {
      if (!this.box.hidden && document.activeElement !== this.input) {
        this.box.hidden = true
        this.insertPos = null
      }
      return
    }
    this.insertPos = null
    this.range = { from: link.from, to: link.to }
    this.attrs = { ...link.mark.attrs }
    if (this.box.hidden) this.openAt(String(link.mark.attrs.href ?? ''), link.from)
  }

  destroy(): void {
    this.view.dom.removeEventListener('mouseover', this.onHover)
    this.box.remove()
  }

  private openAt(value: string, pos: number): void {
    this.input.value = value
    this.box.hidden = false
    this.place(pos)
    requestAnimationFrame(() => {
      this.input.focus()
      this.input.select()
    })
  }

  private onHover = (event: MouseEvent): void => {
    const anchor = (event.target as HTMLElement).closest?.('a')
    if (!anchor) return
    const href = anchor.getAttribute('href') ?? ''
    if (anchor.dataset.hintHref === href) return
    if (anchor.dataset.origTitle === undefined) anchor.dataset.origTitle = anchor.getAttribute('title') ?? ''
    const orig = anchor.dataset.origTitle
    const hint = `${href}\n${isMac ? '⌘' : 'Ctrl'} + 单击打开链接`
    anchor.title = orig ? `${orig}\n${hint}` : hint
    anchor.dataset.hintHref = href
  }

  private place(pos: number): void {
    const host = this.box.parentElement
    if (!host) return
    const zoom = Number.parseFloat(document.documentElement.style.getPropertyValue('--zoom')) || 1
    const coords = this.view.coordsAtPos(pos)
    const hostRect = host.getBoundingClientRect()
    const maxLeft = Math.max(0, hostRect.width / zoom - (this.box.offsetWidth || 328))
    const left = Math.max(0, Math.min((coords.left - hostRect.left) / zoom, maxLeft))
    this.box.style.left = `${left}px`
    this.box.style.top = `${(coords.bottom - hostRect.top) / zoom + 4}px`
  }

  private commit(refocus: boolean): void {
    const type = this.view.state.schema.marks.link
    if (!type) return this.close(refocus)
    const href = this.input.value.trim()
    if (this.insertPos !== null) {
      const pos = this.insertPos
      this.insertPos = null
      if (!href) return this.close(refocus)
      const { state } = this.view
      const node = state.schema.text(href, [type.create({ href })])
      const tr = state.tr.insert(pos, node)
      tr.setSelection(TextSelection.create(tr.doc, pos + href.length)).removeStoredMark(type).setMeta(key, null)
      this.box.hidden = true
      this.view.dispatch(tr)
      if (refocus) this.view.focus()
      return
    }
    const range = this.range
    if (!range) return this.close(refocus)
    const tr = this.view.state.tr.removeMark(range.from, range.to, type)
    if (href) tr.addMark(range.from, range.to, type.create({ ...this.attrs, href }))
    tr.setSelection(TextSelection.create(tr.doc, range.to)).setMeta(key, null)
    this.box.hidden = true
    this.view.dispatch(tr)
    if (refocus) this.view.focus()
  }

  private close(refocus: boolean): void {
    this.insertPos = null
    this.box.hidden = true
    this.view.dispatch(this.view.state.tr.setMeta(key, null))
    if (refocus) this.view.focus()
  }
}

export const linkEditorPlugin = $prose(
  () =>
    new Plugin<LinkMode>({
      key,
      state: {
        init: () => null,
        // Stays open only while the caret remains inside the link (or insert anchor) being edited.
        apply: (tr, open, _old, state) => {
          const next = tr.getMeta(key) as LinkMode | undefined
          if (next !== undefined) return next
          if (open?.kind === 'edit') return linkAt(state, state.selection.from) ? open : null
          if (open?.kind === 'insert') return !tr.docChanged && state.selection.empty && state.selection.from === open.pos ? open : null
          return null
        }
      },
      view: (view) => new LinkEditorView(view)
    })
)
