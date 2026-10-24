import { imageSchema } from '@milkdown/kit/preset/commonmark'
import { $remark } from '@milkdown/kit/utils'
import type { Node as MdNode, Parent, Root } from 'mdast'

/** Attributes an `<img>` tag may have and still be edited as an image. */
const IMAGE_TAG_ATTRS = new Set(['src', 'alt', 'title', 'width', 'style'])
/** Typora sizes images with `style="zoom:50%;"`. */
const ZOOM_STYLE = /^\s*zoom\s*:\s*(\d+(?:\.\d+)?%)\s*;?\s*$/i
const WIDTH = /^\d+(?:\.\d+)?%?$/

interface SizedImage {
  src: string
  alt: string
  title: string
  width: string
  zoom: string
}

/** A lone `<img>` tag that only sets what the image node can hold, or null. */
function parseImageTag(html: string): SizedImage | null {
  const value = html.trim()
  if (!/^<img\b[^<>]*>$/i.test(value)) return null
  const img = new DOMParser().parseFromString(value, 'text/html').body.firstElementChild
  if (!(img instanceof HTMLImageElement) || !img.hasAttribute('src')) return null
  if (Array.from(img.attributes).some((attr) => !IMAGE_TAG_ATTRS.has(attr.name))) return null
  const width = img.getAttribute('width') ?? ''
  const style = img.getAttribute('style') ?? ''
  const zoom = style ? ZOOM_STYLE.exec(style)?.[1] : ''
  if ((width && !WIDTH.test(width)) || zoom === undefined) return null
  return { src: img.getAttribute('src') ?? '', alt: img.getAttribute('alt') ?? '', title: img.getAttribute('title') ?? '', width, zoom }
}

function imageNode(image: SizedImage): MdNode {
  return { type: 'image', url: image.src, alt: image.alt, title: image.title || null, data: { width: image.width, zoom: image.zoom } } as MdNode
}

/**
 * A resized image is saved as an `<img>` tag (Markdown has no image size). Reading it back
 * turns the tag into an image node again, so it can still be selected, edited and resized;
 * the same goes for Typora's `<img style="zoom:50%;">`.
 */
export const remarkSizedImages = $remark('mtyporaSizedImages', () => () => (tree: Root) => {
  const visit = (parent: Parent) => {
    parent.children.forEach((child, index) => {
      if (child.type === 'html') {
        const image = parseImageTag(child.value)
        if (!image) return
        // An <img> on a line of its own is an HTML block; it becomes a paragraph holding the image.
        const inline = parent.type === 'paragraph' || parent.type === 'heading' || parent.type === 'tableCell'
        parent.children[index] = (inline ? imageNode(image) : { type: 'paragraph', children: [imageNode(image)] }) as typeof child
      } else if ('children' in child) {
        visit(child as Parent)
      }
    })
  }
  visit(tree)
})

/** Attribute text kept readable: URLs keep their `&`s unless one would read as an entity. */
const quoteAttr = (value: string) => value.replace(/&(?=#?\w+;)/g, '&amp;').replace(/"/g, '&quot;')
const attr = (name: string, value: string) => (value ? ` ${name}="${quoteAttr(value)}"` : '')

/** Image nodes that remember a width (set by dragging) or Typora's zoom. */
export const sizedImageSchema = imageSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx)
  return {
    ...base,
    attrs: { ...base.attrs, width: { default: '', validate: 'string' }, zoom: { default: '', validate: 'string' } },
    toDOM: (node) => {
      const { src, alt, title, width, zoom } = node.attrs
      return ['img', { src, alt, title, ...(width ? { width } : {}), ...(zoom ? { style: `zoom:${zoom}` } : {}) }]
    },
    parseMarkdown: {
      match: ({ type }) => type === 'image',
      runner: (state, node, type) => {
        const data = (node.data ?? {}) as { width?: string; zoom?: string }
        state.addNode(type, {
          src: node.url as string,
          alt: (node.alt as string | null) ?? '',
          title: (node.title as string | null) ?? '',
          width: data.width ?? '',
          zoom: data.zoom ?? ''
        })
      }
    },
    toMarkdown: {
      match: (node) => node.type.name === 'image',
      runner: (state, node) => {
        const { src, alt, title, width, zoom } = node.attrs
        if (!width && !zoom) {
          state.addNode('image', undefined, undefined, { title, url: src, alt })
          return
        }
        const style = zoom ? ` style="zoom:${zoom};"` : ''
        state.addNode('html', undefined, `<img src="${quoteAttr(src)}"${attr('alt', alt)}${attr('title', title)}${attr('width', width)}${style} />`)
      }
    }
  }
})
