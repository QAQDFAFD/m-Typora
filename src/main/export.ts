import { BrowserWindow, dialog, shell } from 'electron'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExportOptions, HtmlExportOptions, PdfExportOptions, PdfMargin } from '../shared/api'

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
}

const FONT_TYPES: Record<string, string> = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' }

/** Page margins in inches. */
const MARGINS: Record<PdfMargin, number> = { default: 0.7, none: 0, narrow: 0.4, wide: 1 }

async function chooseTarget(win: BrowserWindow, name: string, options: ExportOptions, ext: 'html' | 'pdf'): Promise<string | null> {
  // Like Typora, exports start next to the document.
  const defaultPath = options.docPath ? join(dirname(options.docPath), `${name}.${ext}`) : `${name}.${ext}`
  const result = await dialog.showSaveDialog(win, {
    defaultPath,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
  })
  return result.canceled || !result.filePath ? null : result.filePath
}

function afterExport(target: string, options: ExportOptions): void {
  if (options.after === 'open') void shell.openPath(target)
  if (options.after === 'reveal') shell.showItemInFolder(target)
}

/**
 * The renderer links local images by absolute file:// URL. In the saved page they become
 * paths relative to the HTML file (so the folder can be moved or shared together), or
 * data: URLs when the images should travel inside the page.
 */
async function localizeImages(html: string, target: string, embed: boolean): Promise<string> {
  const urls = new Set([...html.matchAll(/\ssrc="(file:\/\/[^"]+)"/g)].map((match) => match[1]))
  let result = html
  for (const url of urls) {
    let path: string
    try {
      path = fileURLToPath(url.replace(/&amp;/g, '&'))
    } catch {
      continue
    }
    let replacement: string | null = null
    if (embed) {
      const data = await readFile(path).catch(() => null)
      if (data) replacement = `data:${IMAGE_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'};base64,${data.toString('base64')}`
    } else {
      const rel = relative(dirname(target), path)
      // Another drive on Windows: keep the absolute URL.
      if (!/^[a-z]:/i.test(rel)) replacement = rel.split(sep).map(encodeURIComponent).join('/')
    }
    if (replacement) result = result.split(`src="${url}"`).join(`src="${replacement}"`)
  }
  return result
}

/** The app's own fonts (inside the app bundle, or the dev server) travel inside the page. */
async function embedFonts(html: string): Promise<string> {
  const urls = new Set([...html.matchAll(/url\("((?:file|https?):\/\/[^"]+\.(?:woff2?|ttf|otf))"\)/g)].map((match) => match[1]))
  let result = html
  for (const url of urls) {
    if (url.startsWith('http') && !/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) continue
    const data = url.startsWith('file:')
      ? await readFile(fileURLToPath(url)).catch(() => null)
      : await fetch(url).then((response) => (response.ok ? response.arrayBuffer() : null)).then((buffer) => (buffer ? Buffer.from(buffer) : null)).catch(() => null)
    if (!data) continue
    const type = FONT_TYPES[extname(new URL(url).pathname).toLowerCase()] ?? 'application/octet-stream'
    result = result.split(`url("${url}")`).join(`url("data:${type};base64,${data.toString('base64')}")`)
  }
  return result
}

export async function exportHtml(win: BrowserWindow, name: string, html: string, options: HtmlExportOptions): Promise<string | null> {
  const target = await chooseTarget(win, name, options, 'html')
  if (!target) return null
  await writeFile(target, await embedFonts(await localizeImages(html, target, options.embedImages)), 'utf8')
  afterExport(target, options)
  return target
}

/** Loads the standalone page in a hidden window, waits for fonts and images, then prints it. */
export async function exportPdf(win: BrowserWindow, name: string, html: string, options: PdfExportOptions): Promise<string | null> {
  const target = await chooseTarget(win, name, options, 'pdf')
  if (!target) return null
  const dir = await mkdtemp(join(tmpdir(), 'm-typora-pdf-'))
  const page = join(dir, 'export.html')
  const printer = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { sandbox: true, contextIsolation: true } })
  try {
    await writeFile(page, html, 'utf8')
    await printer.loadFile(page)
    await printer.webContents.executeJavaScript(
      `Promise.all([document.fonts.ready, ...[...document.images].map((img) => img.complete ? null : new Promise((done) => { img.onload = img.onerror = done }))])`
    )
    const margin = MARGINS[options.margin] ?? MARGINS.default
    const pdf = await printer.webContents.printToPDF({
      printBackground: true,
      pageSize: options.pageSize,
      margins: { top: margin, bottom: margin, left: margin, right: margin }
    })
    await writeFile(target, pdf)
  } finally {
    printer.destroy()
    await rm(dir, { recursive: true, force: true })
  }
  afterExport(target, options)
  return target
}
