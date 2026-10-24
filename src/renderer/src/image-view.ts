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
  private source: HTMLInputElement

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
    this.placeholder = document.createElement('span')
    this.placeholder.className = 'md-image-placeholder'
    this.source = document.createElement('input')
    this.source.className = 'md-image-source'
    this.source.spellcheck = false
    this.source.hidden = true
    this.dom.append(this.source, this.img, this.placeholder)
    this.source.addEventListener('keydown', (event) => this.onSourceKey(event))
    this.source.addEventListener('blur', () => this.commitSource())
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
    this.autosize()
    // A freshly inserted empty image goes straight to editing its path.
    if (!this.node.attrs.src) {
      requestAnimationFrame(() => {
        this.source.focus()
        const caret = this.source.value.indexOf('](') + 2
        this.source.setSelectionRange(caret, caret)
      })
    }
  }

  deselectNode(): void {
    this.dom.classList.remove('selected')
    if (document.activeElement !== this.source) this.source.hidden = true
  }

  stopEvent(event: Event): boolean {
    return event.target === this.source
  }

  ignoreMutation(): boolean {
    return true
  }

  private render(): void {
    const { src, alt, title } = this.node.attrs
    this.img.hidden = !src
    this.placeholder.hidden = Boolean(src)
    this.placeholder.textContent = alt || '图片'
    if (src) this.img.src = this.resolve(src)
    this.img.alt = alt ?? ''
    this.img.title = title ?? ''
  }

  private autosize(): void {
    this.source.style.width = `${Math.max(8, this.source.value.length + 1)}ch`
  }

  private onSourceKey(event: KeyboardEvent): void {
    this.autosize()
    if (event.key === 'Enter') {
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
