import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { highlightCode } from '@lezer/highlight'
import katex from 'katex'
import { codeHighlightStyle } from './code-theme'
import { renderDiagramSvg } from './diagrams'
import { escapeHtml } from './markdown-utils'

export interface CodeBlockSource {
  language: string
  code: string
}

export interface ExportPage {
  title: string
  /** The live `.ProseMirror` element; it is cloned, never modified. */
  editor: HTMLElement
  /** Every code block of the document, in document order. */
  codeBlocks: CodeBlockSource[]
  dark: boolean
  /**
   * 'pdf' is printed right here and keeps every font; 'html' keeps the text fonts' Latin
   * faces (embedded by the main process) and loads KaTeX's fonts from its CDN.
   */
  target: 'html' | 'pdf'
}

/** Editing aids rendered inside the document that have no place in an export. */
const EDITING_ONLY = [
  '.md-hidden-syntax',
  '.md-meta',
  '.md-meta-inline',
  '.md-image-source',
  '.md-image-resize',
  '.ProseMirror-gapcursor',
  '.ProseMirror-separator',
  '.column-resize-handle'
].join(',')

const EDITING_CLASSES = ['md-focus', 'md-search-hit', 'md-search-current', 'selected', 'ProseMirror-selectednode', 'md-emoji-source']

/** Extra rules so the page scrolls and prints like a document, not like the app window. */
const PAGE_CSS = `
html, body { height: auto !important; overflow: visible !important; }
body { margin: 0; }
#write { zoom: 1 !important; min-height: 0; }
#write .milkdown-code-block pre.md-code {
  margin: 0;
  padding: 0 8px;
  overflow: visible;
  white-space: pre-wrap;
  word-break: break-word;
  font: 0.9em/1.6 var(--monospace);
  color: var(--code-fg);
  background: none;
  border: 0;
}
#write .md-math-block { margin: 1em 0; text-align: center; overflow-x: auto; }
#write .md-diagram { margin: 1em 0; text-align: center; }
#write .md-toc a { color: inherit; text-decoration: none; }
@media print {
  #write { max-width: none; padding: 0; }
  #write .milkdown-code-block, #write table, #write img, #write .md-diagram, #write .md-math-block { break-inside: avoid; }
  #write :is(h1, h2, h3, h4, h5, h6) { break-after: avoid; }
}
`

async function highlighted(code: string, language: string): Promise<string> {
  const description = language ? LanguageDescription.matchLanguageName(languages, language, true) : null
  try {
    const support = description ? (description.support ?? (await description.load())) : null
    if (!support) return escapeHtml(code)
    let html = ''
    highlightCode(
      code,
      support.language.parser.parse(code),
      codeHighlightStyle,
      (text, classes) => (html += classes ? `<span class="${classes}">${escapeHtml(text)}</span>` : escapeHtml(text)),
      () => (html += '\n')
    )
    return html
  } catch {
    return escapeHtml(code)
  }
}

/** Code blocks are CodeMirror editors (only partly rendered when long); rebuild them. */
async function renderCodeBlock(block: CodeBlockSource, dark: boolean): Promise<HTMLElement> {
  const language = block.language.trim().toLowerCase()
  if (['latex', 'tex', 'math', 'katex'].includes(language)) {
    const math = document.createElement('div')
    math.className = 'md-math-block'
    math.innerHTML = katex.renderToString(block.code, { displayMode: true, throwOnError: false })
    return math
  }
  if (language === 'mermaid') {
    const svg = await renderDiagramSvg(block.code, dark).catch(() => null)
    if (svg) {
      const diagram = document.createElement('div')
      diagram.className = 'md-diagram'
      diagram.innerHTML = svg
      return diagram
    }
  }
  const wrapper = document.createElement('div')
  wrapper.className = 'milkdown-code-block'
  const pre = document.createElement('pre')
  pre.className = 'md-code'
  if (language) pre.dataset.language = language
  pre.innerHTML = `<code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${await highlighted(block.code, block.language)}</code>`
  wrapper.append(pre)
  return wrapper
}

function absolutizeUrls(css: string, base: string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, _quote: string, url: string) => {
    if (/^(data:|#)/i.test(url)) return match
    try {
      return `url("${new URL(url, base).href}")`
    } catch {
      return match
    }
  })
}

/** For a standalone HTML file: the Latin face of each text font; KaTeX comes from its CDN. */
function keepFontFace(rule: CSSFontFaceRule): boolean {
  if (/^["']?KaTeX_/i.test(rule.style.getPropertyValue('font-family'))) return false
  const range = rule.style.getPropertyValue('unicode-range')
  return !range || /U\+0+(-|,|$)/i.test(range)
}

/** Every stylesheet the editor uses (themes, KaTeX, CodeMirror's injected styles). */
function collectCss(target: ExportPage['target']): string {
  const sheets = [...Array.from(document.styleSheets), ...document.adoptedStyleSheets]
  const parts = sheets.map((sheet) => {
    try {
      return Array.from(sheet.cssRules)
        .filter((rule) => target === 'pdf' || !(rule instanceof CSSFontFaceRule) || keepFontFace(rule))
        .map((rule) => absolutizeUrls(rule.cssText, sheet.href ?? document.baseURI))
        .join('\n')
    } catch {
      return ''
    }
  })
  parts.push(codeHighlightStyle.module?.getRules() ?? '')
  return parts.join('\n')
}

/** Headings get ids so the [toc] entries can link to them. */
function linkToc(root: HTMLElement): void {
  const headings = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
  headings.forEach((heading, index) => {
    if (!heading.id) heading.id = `heading-${index + 1}`
  })
  root.querySelectorAll('.md-toc').forEach((toc) => {
    toc.querySelectorAll<HTMLElement>('.md-toc-item').forEach((item, index) => {
      const heading = headings[index]
      if (!heading) return
      const link = document.createElement('a')
      link.href = `#${heading.id}`
      link.textContent = item.textContent
      item.replaceChildren(link)
    })
  })
}

/**
 * A standalone page that looks like the document does in the editor (Typora exports its
 * rendered view, with the current theme): the rendered DOM without editing aids, code
 * blocks rebuilt from the source, and the app's stylesheets inlined.
 */
export async function buildExportPage(page: ExportPage): Promise<string> {
  const clone = page.editor.cloneNode(true) as HTMLElement
  clone.removeAttribute('contenteditable')
  clone.removeAttribute('translate')
  clone.querySelectorAll(EDITING_ONLY).forEach((el) => el.remove())
  clone.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'))
  clone.querySelectorAll('[draggable]').forEach((el) => el.removeAttribute('draggable'))
  for (const name of EDITING_CLASSES) clone.querySelectorAll(`.${name}`).forEach((el) => el.classList.remove(name))
  clone.querySelectorAll('.md-image').forEach((image) => {
    if (image.querySelector('.md-image-frame:not([hidden]) img')) image.querySelector('.md-image-placeholder')?.remove()
    else image.querySelector('.md-image-frame')?.remove()
  })

  const blocks = Array.from(clone.querySelectorAll<HTMLElement>('.milkdown-code-block'))
  await Promise.all(
    blocks.map(async (el, index) => {
      const source = page.codeBlocks[index]
      if (source) el.replaceWith(await renderCodeBlock(source, page.dark))
    })
  )
  linkToc(clone)

  const root = document.documentElement
  const vars = ['--base-font-size', '--write-max-width'].map((name) => `${name}: ${root.style.getPropertyValue(name)};`).join(' ')
  const milkdown = page.editor.parentElement
  const katexFonts =
    page.target === 'html' && clone.querySelector('.katex')
      ? `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@${katex.version}/dist/katex.min.css">\n`
      : ''
  return `<!doctype html>
<html lang="zh-CN" data-theme="${escapeHtml(root.dataset.theme ?? 'github')}" data-platform="${escapeHtml(root.dataset.platform ?? '')}" data-image-align="${escapeHtml(root.dataset.imageAlign ?? 'center')}" style="${escapeHtml(vars)} --zoom: 1;">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)}</title>
${katexFonts}<style>
${collectCss(page.target)}
${PAGE_CSS}
</style>
</head>
<body>
<div id="write" class="write"><div id="wysiwyg" class="wysiwyg"><div class="${escapeHtml(milkdown?.className ?? 'milkdown')}"><div class="ProseMirror">
${clone.innerHTML}
</div></div></div></div>
</body>
</html>
`
}

/** "HTML (without styles)": the document's plain semantic HTML. */
export function buildPlainHtml(title: string, bodyHtml: string): string {
  const container = document.createElement('div')
  container.innerHTML = bodyHtml
  // Block math is stored as a ```LaTeX code block; render it for the export.
  container.querySelectorAll<HTMLElement>('pre[data-language]').forEach((pre) => {
    const language = pre.dataset.language!.toLowerCase()
    if (language === 'latex' || language === 'tex' || language === 'math') {
      const block = document.createElement('div')
      block.className = 'math-block'
      block.innerHTML = katex.renderToString(pre.textContent ?? '', { displayMode: true, throwOnError: false, output: 'mathml' })
      pre.replaceWith(block)
    } else {
      pre.querySelector('code')?.classList.add(`language-${language}`)
    }
  })
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body>
${container.innerHTML}
</body>
</html>
`
}
