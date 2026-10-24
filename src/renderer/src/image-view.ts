import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView, type NodeView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'

const IMAGE_SOURCE = /^!\[([^\]]*)\]\(\s*<?([^\s>)]*)>?(?:\s+"([^"]*)")?\s*\)$/
const MIN_WIDTH = 24

function imageSource(node: ProseNode): string {
  const { alt, src, title } = node.attrs
  return `![${alt ?? ''}](${src ?? ''}${title ? ` "${title}"` : ''})`
}

/**
 * Inline image rendered like Typora: the picture itself, and its Markdown source
 * (`![alt](src "title")`) in an editable box while the image is selected. A handle on the
 * picture's corner resizes it.
 */
class ImageView implements NodeView {
  dom: HTMLElement
  private img: HTMLImageElement
  private frame: HTMLElement
  private handle: HTMLElement
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
    this.handle = document.createElement('span')
    this.handle.className = 'md-image-resize'
    this.handle.title = '拖动调整大小，双击恢复原始大小'
    this.handle.addEventListener('mousedown', (event) => this.startResize(event))
    this.handle.addEventListener('dblclick', (event) => {
      event.preventDefault()
      this.setSize('')
    })
    this.frame = document.createElement('span')
    this.frame.className = 'md-image-frame'
    this.frame.append(this.img, this.handle)
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
    this.dom.append(this.source, this.frame, this.placeholder)
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
    return event.target === this.source || event.target === this.handle
  }

  ignoreMutation(): boolean {
    return true
  }

  private showPlaceholder(broken: boolean): void {
    this.frame.hidden = broken
    this.placeholder.hidden = !broken
    this.placeholder.classList.toggle('broken', broken && Boolean(this.node.attrs.src))
    this.placeholder.title = broken && this.node.attrs.src ? `无法加载图片：${this.node.attrs.src}` : ''
  }

  private render(): void {
    const { src, alt, title, width, zoom } = this.node.attrs
    this.placeholder.textContent = alt || '图片'
    if (!src) this.showPlaceholder(true)
    else if (this.img.getAttribute('src') !== this.resolve(src)) {
      this.frame.hidden = false
      this.placeholder.hidden = true
    }
    if (src) this.img.src = this.resolve(src)
    this.img.alt = alt ?? ''
    this.img.title = title ?? ''
    this.img.style.width = width ? (width.endsWith('%') ? width : `${width}px`) : ''
    this.img.style.zoom = zoom ?? ''
  }

  /**
   * Dragging the corner handle sets the image's width (the height follows). A centered
   * image grows on both sides, so it changes by twice the distance to stay under the pointer;
   * a right-aligned one has its handle on the left.
   */
  private startResize(event: MouseEvent): void {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const rect = this.img.getBoundingClientRect()
    // Page zoom: pointer distances are in screen pixels, widths in CSS pixels.
    const scale = rect.width / (this.img.offsetWidth || rect.width || 1)
    const start = { x: event.clientX, width: this.img.offsetWidth }
    const block = this.dom.parentElement
    const align = block ? getComputedStyle(block).textAlign : 'left'
    const factor = align === 'center' ? 2 : align === 'right' || align === 'end' ? -1 : 1
    const max = Math.max(MIN_WIDTH, block?.clientWidth ?? Infinity)
    let width = start.width
    this.dom.classList.add('resizing')
    const onMove = (move: MouseEvent) => {
      width = Math.round(Math.min(max, Math.max(MIN_WIDTH, start.width + ((move.clientX - start.x) * factor) / scale)))
      this.img.style.width = `${width}px`
      this.img.style.zoom = ''
      this.handle.dataset.size = `${width} × ${Math.round(this.img.offsetHeight)}`
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      this.dom.classList.remove('resizing')
      delete this.handle.dataset.size
      if (width !== start.width) this.setSize(String(width))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /** Stores a width in pixels ('' for the image's own size); one undoable step. */
  private setSize(width: string): void {
    const pos = this.getPos()
    if (pos === undefined) return
    if (width === this.node.attrs.width && !this.node.attrs.zoom) {
      this.render()
      return
    }
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, width, zoom: '' })
    this.view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, pos)))
    // The handle took the press without focusing the editor; ⌘Z should undo the resize.
    this.view.focus()
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

/** A paragraph holding nothing but images (and line breaks): it follows the image alignment. */
function isImageParagraph(node: ProseNode): boolean {
  let images = 0
  let other = false
  node.forEach((child) => {
    if (child.type.name === 'image') images++
    else if (child.type.name !== 'hardbreak' && !(child.isText && !child.text!.trim())) other = true
  })
  return images > 0 && !other
}

function imageParagraphs(doc: ProseNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return true
    if (isImageParagraph(node)) decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'md-image-paragraph' }))
    return false
  })
  return DecorationSet.create(doc, decorations)
}

export function createImagePlugin(resolve: (src: string) => string) {
  const key = new PluginKey<DecorationSet>('mtypora-image')
  return $prose(
    () =>
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_config, state) => imageParagraphs(state.doc),
          apply: (tr, set) => (tr.docChanged ? imageParagraphs(tr.doc) : set)
        },
        props: {
          decorations: (state) => key.getState(state),
          nodeViews: {
            image: (node, view, getPos) => new ImageView(node, view, getPos, resolve)
          }
        }
      })
  )
}
