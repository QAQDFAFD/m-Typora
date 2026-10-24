import type { Mark, MarkType } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, TextSelection, type EditorState, type PluginView } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'

const key = new PluginKey<boolean>('mtypora-link-editor')
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

/** Opens the link editor for the link at the caret (or makes the selection a link first). */
export function openLinkEditor(view: EditorView): boolean {
  const { state } = view
  const { from, to, empty } = state.selection
  const type = state.schema.marks.link
  if (!type) return false
  if (!empty && !linkAt(state, from)) {
    view.dispatch(state.tr.addMark(from, to, type.create({ href: '' })).setMeta(key, true))
    return true
  }
  if (!linkAt(state, from)) return false
  view.dispatch(state.tr.setMeta(key, true))
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
      if (event.key === 'Enter') {
        event.preventDefault()
        this.commit()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        this.close(true)
      }
    })
    this.input.addEventListener('blur', () => {
      if (!this.box.hidden) this.commit()
    })
    view.dom.addEventListener('mouseover', this.onHover)
  }

  update(view: EditorView): void {
    this.view = view
    const open = key.getState(view.state)
    const link = linkAt(view.state, view.state.selection.from)
    if (!open || !link) {
      if (!this.box.hidden && document.activeElement !== this.input) this.box.hidden = true
      return
    }
    this.range = { from: link.from, to: link.to }
    if (this.box.hidden) {
      this.input.value = String(link.mark.attrs.href ?? '')
      this.box.hidden = false
      this.place(link.from)
      requestAnimationFrame(() => {
        this.input.focus()
        this.input.select()
      })
    }
  }

  destroy(): void {
    this.view.dom.removeEventListener('mouseover', this.onHover)
    this.box.remove()
  }

  private onHover = (event: MouseEvent): void => {
    const anchor = (event.target as HTMLElement).closest?.('a')
    if (anchor && !anchor.dataset.hint) {
      const href = anchor.getAttribute('href') ?? ''
      anchor.title = `${href}\n${isMac ? '⌘' : 'Ctrl'} + 单击打开链接`
      anchor.dataset.hint = '1'
    }
  }

  private place(pos: number): void {
    const host = this.box.parentElement
    if (!host) return
    const zoom = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--zoom')) || 1
    const coords = this.view.coordsAtPos(pos)
    const hostRect = host.getBoundingClientRect()
    this.box.style.left = `${(coords.left - hostRect.left) / zoom}px`
    this.box.style.top = `${(coords.bottom - hostRect.top) / zoom + 4}px`
  }

  private commit(): void {
    const range = this.range
    const type = this.view.state.schema.marks.link
    if (!range || !type) return this.close(false)
    const href = this.input.value.trim()
    const tr = this.view.state.tr.removeMark(range.from, range.to, type)
    if (href) tr.addMark(range.from, range.to, type.create({ href }))
    tr.setSelection(TextSelection.create(tr.doc, range.to)).setMeta(key, false)
    this.box.hidden = true
    this.view.dispatch(tr)
    this.view.focus()
  }

  private close(refocus: boolean): void {
    this.box.hidden = true
    this.view.dispatch(this.view.state.tr.setMeta(key, false))
    if (refocus) this.view.focus()
  }
}

export const linkEditorPlugin = $prose(
  () =>
    new Plugin<boolean>({
      key,
      state: {
        init: () => false,
        // Stays open only while the caret remains inside the link being edited.
        apply: (tr, open, _old, state) => (tr.getMeta(key) as boolean | undefined) ?? (open && linkAt(state, state.selection.from) !== null)
      },
      view: (view) => new LinkEditorView(view)
    })
)
