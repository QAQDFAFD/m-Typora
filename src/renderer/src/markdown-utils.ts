export interface Heading {
  level: number
  text: string
  /** 1-based line number in the markdown source. */
  line: number
}

/** Extracts ATX headings, ignoring anything inside fenced code or math blocks. */
export function extractHeadings(markdown: string): Heading[] {
  const headings: Heading[] = []
  let fence: string | null = null
  markdown.split('\n').forEach((raw, index) => {
    const line = raw.trimEnd()
    const fenceMatch = /^\s*(`{3,}|~{3,}|\$\$)/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (fence === null) fence = marker
      else if (marker.startsWith(fence[0])) fence = null
      return
    }
    if (fence !== null) return
    const match = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line)
    if (match) {
      headings.push({
        level: match[1].length,
        text: match[2].replace(/[*_`~]|\[([^\]]*)\]\([^)]*\)/g, '$1'),
        line: index + 1
      })
    }
  })
  return headings
}

export interface TextStats {
  words: number
  characters: number
  lines: number
  minutes: number
}

/** Counts CJK characters individually and other text by whitespace-separated words. */
export function countText(markdown: string): TextStats {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~\-|=]+/g, ' ')
  const cjk = text.match(/[぀-ヿ㐀-䶿一-鿿가-힯]/g)?.length ?? 0
  const latin = text.replace(/[぀-ヿ㐀-䶿一-鿿가-힯]/g, ' ').match(/[\p{L}\p{N}]+/gu)?.length ?? 0
  const words = cjk + latin
  return {
    words,
    characters: markdown.replace(/\s/g, '').length,
    lines: markdown === '' ? 0 : markdown.split('\n').length,
    minutes: Math.max(1, Math.round(words / 300))
  }
}

export function fileName(path: string | null): string {
  if (!path) return '未命名'
  return path.split(/[\\/]/).pop() ?? path
}

export function stripExtension(name: string): string {
  return name.replace(/\.(md|markdown|mdown|txt)$/i, '')
}

export function dirName(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index >= 0 ? path.slice(0, index) : ''
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
}
