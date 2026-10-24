import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { SearchHit, TreeNode } from '../shared/api'

const MARKDOWN_FILE = /\.(md|markdown|mdown|txt)$/i
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'out', 'build'])
const MAX_DEPTH = 6
const EXCERPT_BYTES = 2048
const MAX_SEARCH_HITS = 300

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

/** Case-insensitive plain-text search across every Markdown file below `root`. */
export async function searchFolder(root: string, query: string): Promise<SearchHit[]> {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const hits: SearchHit[] = []
  const files: string[] = []
  const collect = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (node.children) collect(node.children)
      else files.push(node.path)
    }
  }
  collect(await readTree(root))

  for (const path of files) {
    const content = await readFile(path, 'utf8').catch(() => '')
    const lines = content.split(/\r?\n/)
    for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        hits.push({ path, line: i + 1, text: lines[i].trim().slice(0, 200) })
      }
    }
    if (hits.length >= MAX_SEARCH_HITS) break
  }
  return hits.sort((a, b) => relative(root, a.path).localeCompare(relative(root, b.path)))
}
