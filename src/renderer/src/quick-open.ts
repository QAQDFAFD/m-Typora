import { escapeHtml, fileName } from './markdown-utils'

/** Subsequence match; lower score is better. Returns -1 when `query` does not match. */
function fuzzyScore(query: string, target: string): number {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  const direct = t.indexOf(q)
  if (direct >= 0) return direct
  let score = 100
  let position = -1
  for (const ch of q) {
    const next = t.indexOf(ch, position + 1)
    if (next < 0) return -1
    score += next - position
    position = next
  }
  return score
}

/** Typora's "Open Quickly" palette: fuzzy search over recent files and the open folder. */
export class QuickOpen {
  private input: HTMLInputElement
  private list: HTMLElement
  private items: string[] = []
  private folderRoot: string | null = null
  private results: string[] = []
  private selected = 0

  constructor(private el: HTMLElement, private onPick: (path: string) => void) {
    el.innerHTML = `
      <div class="quick-open-panel" role="dialog" aria-label="快速打开">
        <input class="quick-open-input" type="text" placeholder="输入文件名" spellcheck="false" />
        <ul class="quick-open-list"></ul>
      </div>`
    this.input = el.querySelector('.quick-open-input')!
    this.list = el.querySelector('.quick-open-list')!
    this.input.addEventListener('input', () => this.filter())
    this.input.addEventListener('keydown', (event) => this.onKey(event))
    el.addEventListener('mousedown', (event) => {
      if (event.target === el) this.close()
    })
    this.list.addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('[data-index]')
      if (item) this.pick(Number(item.dataset.index))
    })
  }

  open(recent: string[], folderFiles: string[], folderRoot: string | null = null): void {
    this.folderRoot = folderRoot
    this.items = [...new Set([...recent, ...folderFiles])]
    this.el.hidden = false
    this.input.value = ''
    this.filter()
    this.input.focus()
  }

  close(): void {
    this.el.hidden = true
  }

  private displayPath(path: string): string {
    const root = this.folderRoot?.replace(/[\\/]+$/, '')
    if (root && (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))) {
      return path.slice(root.length + 1)
    }
    return path
  }

  private filter(): void {
    const query = this.input.value.trim()
    this.results = this.items
      .map((path) => {
        // Matches on the file name rank ahead of matches that only hit the directory.
        const nameScore = fuzzyScore(query, fileName(path))
        const pathScore = fuzzyScore(query, this.displayPath(path))
        return { path, score: nameScore >= 0 ? nameScore : pathScore >= 0 ? pathScore + 50 : -1 }
      })
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => a.score - b.score)
      .slice(0, 50)
      .map((entry) => entry.path)
    this.selected = 0
    this.render()
  }

  private render(): void {
    if (this.results.length === 0) {
      this.list.innerHTML = `<li class="quick-open-empty">${this.items.length === 0 ? '没有最近文件，请先打开文件夹' : '没有匹配的文件'}</li>`
      return
    }
    this.list.innerHTML = this.results
      .map((path, index) => {
        const shown = this.displayPath(path)
        return `
        <li class="quick-open-item${index === this.selected ? ' selected' : ''}" data-index="${index}" title="${escapeHtml(path)}">
          <span class="quick-open-name">${escapeHtml(fileName(path))}</span>
          <span class="quick-open-path">${escapeHtml(shown)}</span>
        </li>`
      })
      .join('')
    this.list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' })
  }

  private updateSelection(prev: number): void {
    this.list.children[prev]?.classList.remove('selected')
    const current = this.list.children[this.selected]
    if (!current) return
    current.classList.add('selected')
    current.scrollIntoView({ block: 'nearest' })
  }

  private onKey(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      this.close()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (this.results.length === 0) return
      const prev = this.selected
      const step = event.key === 'ArrowDown' ? 1 : -1
      this.selected = (this.selected + step + this.results.length) % this.results.length
      this.updateSelection(prev)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      this.pick(this.selected)
    }
  }

  private pick(index: number): void {
    const path = this.results[index]
    if (!path) return
    this.close()
    this.onPick(path)
  }
}
