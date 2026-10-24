import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView, NodeView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'

const IMAGE_SOURCE = /^!\[([^\]]*)\]\(\s*<?([^\s>)]*)>?(?:\s+"([^"]*)")?\s*\)$/

function imageSource(node: ProseNode): string {
  const { alt, src, title } = node.attrs
  return `![${alt ?? ''}](${src ?? ''}${title ? ` "${title}"` : ''})`
}

/**
 * Inline image rendered like Typora: the picture itself, and its Markdown source
 * (`![alt](src "title")`) in an editable box while the image is selected.
 */
class ImageView implements NodeView {
  dom: HTMLElement
  private img: HTMLImageElement
  private placeholder: HTMLElement
  private source: HTMLTextAreaElement
  /** Draggable ancestors switched off while the path is edited (they swallow text selection). */
  private undraggable: HTMLElement[] = []

  constructor(
    private node: ProseNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private resolve: (src: string) => string
  ) {
    this.dom = document.createElement('span')
    this.dom.className = 'md-image'
    this.img = document.createElement('img')
    this.img.draggable = false
    // A broken or unreachable image still needs something to click (to fix its path).
    this.img.addEventListener('error', () => this.showPlaceholder(true))
    this.img.addEventListener('load', () => this.showPlaceholder(false))
    this.placeholder = document.createElement('span')
    this.placeholder.className = 'md-image-placeholder'
    // A text area, not an input: long URLs wrap with the page instead of running off it.
    this.source = document.createElement('textarea')
    this.source.className = 'md-image-source'
    this.source.spellcheck = false
    this.source.rows = 1
    this.source.hidden = true
    this.dom.append(this.source, this.img, this.placeholder)
    this.source.addEventListener('keydown', (event) => this.onSourceKey(event))
    this.source.addEventListener('mousedown', () => {
      this.allowTextSelection()
      // While the image is node-selected the page selection contains this box, and a press
      // inside a selection is taken as the start of dragging it — not of selecting text.
      const selection = getSelection()
      if (selection && selection.rangeCount > 0 && selection.getRangeAt(0).intersectsNode(this.source)) selection.removeAllRanges()
    })
    this.source.addEventListener('focus', () => this.allowTextSelection())
    this.source.addEventListener('blur', () => {
      this.restoreDragging()
      this.commitSource()
    })
    this.render()
  }

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  selectNode(): void {
    this.dom.classList.add('selected')
    this.source.hidden = false
    this.source.value = imageSource(this.node)
    // A freshly inserted empty image goes straight to editing its path.
    if (!this.node.attrs.src) this.focusSource(3)
  }

  /**
   * ProseMirror may pull focus back into the editor while it syncs the node selection,
   * so make sure the caret really lands in the path box.
   */
  private focusSource(attempts: number): void {
    setTimeout(() => {
      if (this.source.hidden || document.activeElement === this.source) return
      this.source.focus()
      const caret = this.source.value.indexOf('](') + 2
      this.source.setSelectionRange(caret, caret)
      if (attempts > 1) this.focusSource(attempts - 1)
    }, 30)
  }

  deselectNode(): void {
    this.dom.classList.remove('selected')
    if (document.activeElement !== this.source) this.source.hidden = true
  }

  /**
   * ProseMirror makes a selected node draggable; inside a draggable element the browser
   * starts a node drag instead of selecting text, so part of a URL could not be selected.
   */
  private allowTextSelection(): void {
    for (let el: HTMLElement | null = this.dom; el; el = el.parentElement) {
      if (el.draggable && !this.undraggable.includes(el)) {
        el.draggable = false
        this.undraggable.push(el)
      }
    }
  }

  private restoreDragging(): void {
    for (const el of this.undraggable) el.draggable = true
    this.undraggable = []
  }

  destroy(): void {
    this.restoreDragging()
  }

  stopEvent(event: Event): boolean {
    return event.target === this.source
  }

  ignoreMutation(): boolean {
    return true
  }

  private showPlaceholder(broken: boolean): void {
    this.img.hidden = broken
    this.placeholder.hidden = !broken
    this.placeholder.classList.toggle('broken', broken && Boolean(this.node.attrs.src))
    this.placeholder.title = broken && this.node.attrs.src ? `无法加载图片：${this.node.attrs.src}` : ''
  }

  private render(): void {
    const { src, alt, title } = this.node.attrs
    this.placeholder.textContent = alt || '图片'
    if (!src) this.showPlaceholder(true)
    else if (this.img.getAttribute('src') !== this.resolve(src)) {
      this.img.hidden = false
      this.placeholder.hidden = true
    }
    if (src) this.img.src = this.resolve(src)
    this.img.alt = alt ?? ''
    this.img.title = title ?? ''
  }

  private onSourceKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault()
      this.commitSource()
      this.leave()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      this.source.value = imageSource(this.node)
      this.leave()
    }
  }

  private commitSource(): void {
    const pos = this.getPos()
    const match = IMAGE_SOURCE.exec(this.source.value.trim())
    if (pos === undefined || !match) return
    const [, alt, src, title] = match
    const attrs = { ...this.node.attrs, alt, src, title: title ?? '' }
    if (attrs.alt === this.node.attrs.alt && attrs.src === this.node.attrs.src && attrs.title === (this.node.attrs.title ?? '')) return
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, attrs)
    this.view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, pos)))
  }

  /** Puts the caret right after the image and gives focus back to the editor. */
  private leave(): void {
    const pos = this.getPos()
    this.source.hidden = true
    if (pos === undefined) return
    this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, pos + this.node.nodeSize)))
    this.view.focus()
  }
}

export function createImagePlugin(resolve: (src: string) => string) {
  return $prose(
    () =>
      new Plugin({
        key: new PluginKey('mtypora-image'),
        props: {
          nodeViews: {
            image: (node, view, getPos) => new ImageView(node, view, getPos, resolve)
          }
        }
      })
  )
}
