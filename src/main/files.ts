import { open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import type { SearchHit, TreeNode } from '../shared/api'

const MARKDOWN_FILE = /\.(md|markdown|mdown|txt)$/i
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'out', 'build'])
const MAX_DEPTH = 6
const EXCERPT_BYTES = 2048

/** Reads a folder as a tree containing only Markdown files and folders that have some. */
export async function readTree(root: string, depth = 0): Promise<TreeNode[]> {
  if (depth > MAX_DEPTH) return []
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const folders: TreeNode[] = []
  const files: TreeNode[] = []

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      const children = await readTree(path, depth + 1)
      if (children.length > 0) folders.push({ name: entry.name, path, children })
    } else if (MARKDOWN_FILE.test(entry.name)) {
      const [info, head] = await Promise.all([stat(path), readHead(path)])
      files.push({ name: entry.name, path, mtime: info.mtimeMs, excerpt: excerptOf(head) })
    }
  }

  const byName = (a: TreeNode, b: TreeNode) => a.name.localeCompare(b.name, undefined, { numeric: true })
  return [...folders.sort(byName), ...files.sort(byName)]
}

async function readHead(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(EXCERPT_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, EXCERPT_BYTES, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/** First two readable lines: front-matter title, headings and paragraph text, with syntax removed. */
export function excerptOf(markdown: string): string[] {
  const lines: string[] = []
  let body = markdown
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown)
  if (frontMatter) {
    const title = /^title:\s*["']?(.+?)["']?\s*$/m.exec(frontMatter[1])
    if (title) lines.push(title[1])
    body = markdown.slice(frontMatter[0].length)
  }
  let inFence = false
  for (const raw of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~|\$\$)/.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    // Table rows read as their cell text; delimiter rows are skipped.
    if (/^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*$/.test(raw)) continue
    const line = /^\s*\|/.test(raw) ? raw.split('|').map((cell) => cell.trim()).filter(Boolean).join('  ') : raw
    const text = line
      .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]|<[^>]+>/g, '')
      .trim()
    if (!text || /^([-*_=|:\s])+$/.test(text)) continue
    lines.push(text)
    if (lines.length >= 2) break
  }
  return lines
}

const MAX_HITS_PER_FILE = 20

/** Case and width folding, so "ＡＢＣ", "abc" and "Abc" all match. */
function fold(text: string): string {
  return text.normalize('NFKC').toLowerCase()
}

/** A source line as it reads on screen: Markdown syntax removed, link and image text kept. */
function plainLine(line: string): string {
  return line
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/(\*\*|__|==|~~|[*_~^`])/g, '')
    .replace(/\s*\|\s*/g, ' ')
    .trim()
}

/** A short excerpt of `text` around the first matching term. */
function excerpt(text: string, terms: string[]): string {
  const folded = fold(text)
  const found = terms.map((term) => folded.indexOf(term)).filter((i) => i >= 0)
  const at = found.length > 0 ? Math.min(...found) : 0
  const start = Math.max(0, at - 40)
  return `${start > 0 ? '…' : ''}${text.slice(start, start + 160).trim()}`
}

/**
 * Searches every Markdown file below `root`, like Typora's folder search: the text is
 * matched as it reads (bold, links and other syntax ignored), a phrase may continue on
 * the next line of the same paragraph, several words separated by spaces must all
 * appear, and file names match too (a hit with line 0).
 */
export async function searchFolder(root: string, query: string): Promise<SearchHit[]> {
  const terms = fold(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []
  const matches = (text: string) => {
    const folded = fold(text)
    return terms.every((term) => folded.includes(term))
  }
  const files: string[] = []
  const collect = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (node.children) collect(node.children)
      else files.push(node.path)
    }
  }
  collect(await readTree(root))

  const hits: SearchHit[] = []
  for (const path of files) {
    const fileHits: SearchHit[] = []
    if (matches(basename(path).replace(MARKDOWN_FILE, ''))) fileHits.push({ path, line: 0, text: '' })

    const lines = (await readFile(path, 'utf8').catch(() => '')).split(/\r?\n/)
    let paragraph: Array<{ line: number; text: string; hit: boolean }> = []
    let inFence = false
    const flushParagraph = () => {
      // A phrase split over the lines of one paragraph only matches the joined text.
      if (paragraph.length > 1 && !paragraph.some((part) => part.hit)) {
        const joined = paragraph.map((part) => part.text).join(' ')
        if (matches(joined)) fileHits.push({ path, line: paragraph[0].line, text: excerpt(joined, terms) })
      }
      paragraph = []
    }
    for (let i = 0; i < lines.length && fileHits.length < MAX_HITS_PER_FILE; i++) {
      const raw = lines[i]
      if (/^\s*(```|~~~)/.test(raw)) {
        inFence = !inFence
        flushParagraph()
      }
      const plain = inFence ? raw.trim() : plainLine(raw)
      const hit = matches(plain) || matches(raw)
      if (hit) fileHits.push({ path, line: i + 1, text: excerpt(matches(plain) ? plain : raw.trim(), terms) })
      if (inFence || !plain) flushParagraph()
      else paragraph.push({ line: i + 1, text: plain, hit })
    }
    flushParagraph()
    hits.push(...fileHits.sort((a, b) => a.line - b.line))
  }
  return hits.sort((a, b) => relative(root, a.path).localeCompare(relative(root, b.path)) || a.line - b.line)
}
