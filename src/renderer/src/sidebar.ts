import type { SearchHit, SidebarView, TreeNode } from '../../shared/api'
import type { Heading } from './markdown-utils'
import { escapeHtml, fileName } from './markdown-utils'

interface SidebarHandlers {
  onOpenFile(path: string): void
  onOpenFolder(): void
  onNewFile(): void
  onSelectHeading(index: number): void
  onViewChange(view: SidebarView): void
  onSearch(query: string): Promise<SearchHit[]>
  onOpenHit(hit: SearchHit, query: string): void
}

const VIEW_TITLES: Record<SidebarView, string> = {
  articles: '文档',
  tree: '文件',
  outline: '大纲',
  search: '搜索'
}

const ICONS = {
  plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>',
  // Two stacked pages, so it no longer looks like the outline's indented lines.
  articles: '<svg viewBox="0 0 16 16"><path d="M5.5 1.5h5l3 3v8h-8z M10.5 1.5v3h3"/><path d="M3.5 4v10.5h7"/></svg>',
  tree: '<svg viewBox="0 0 16 16"><path d="M2.5 4.5h4l1.2 1.5h5.8v6.5h-11z"/></svg>',
  outline: '<svg viewBox="0 0 16 16"><path d="M3 4h10M5 8h8M7 12h6"/></svg>',
  search: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/></svg>',
  folder: '<svg viewBox="0 0 16 16" class="tree-glyph"><path d="M1.5 4h4.5l1.5 1.5h7v7.5h-13z"/></svg>',
  file: '<svg viewBox="0 0 16 16" class="tree-glyph"><path d="M4 1.5h5.5l3 3v10h-8.5z M9.5 1.5v3h3"/></svg>',
  chevron: '<svg viewBox="0 0 10 10" class="chevron"><path d="M3.5 1.5 7 5 3.5 8.5"/></svg>'
}

/** Expand / collapse arrow; empty for leaves so labels stay aligned. */
function disclosure(hasChildren: boolean, collapsed: boolean, toggle?: number): string {
  if (!hasChildren) return '<span class="disclosure"></span>'
  const attrs = toggle === undefined ? '' : ` data-toggle="${toggle}"`
  return `<span class="disclosure${collapsed ? '' : ' expanded'}"${attrs}>${ICONS.chevron}</span>`
}

/** Relative time in the short English form Typora's article list uses. */
function relativeTime(mtime: number | undefined): string {
  if (!mtime) return ''
  const seconds = Math.max(0, (Date.now() - mtime) / 1000)
  const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? '' : 's'} ago`
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return unit(Math.floor(seconds / 60), 'minute')
  if (seconds < 86400) return unit(Math.floor(seconds / 3600), 'hour')
  if (seconds < 86400 * 30) return unit(Math.floor(seconds / 86400), 'day')
  if (seconds < 86400 * 365) return unit(Math.floor(seconds / (86400 * 30)), 'month')
  return unit(Math.floor(seconds / (86400 * 365)), 'year')
}

function flattenFiles(nodes: TreeNode[], parent: string): Array<TreeNode & { folder: string }> {
  const files = nodes.filter((n) => !n.children).map((n) => ({ ...n, folder: parent }))
  const nested = nodes.filter((n) => n.children).flatMap((n) => flattenFiles(n.children!, n.name))
  return [...files, ...nested]
}

/** Escapes `text` and marks every occurrence of each space-separated word of `query`. */
function highlightTerms(text: string, query: string): string {
  const terms = query.normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean)
  const lower = text.normalize('NFKC').toLowerCase()
  // Lengths can change under NFKC; only highlight when the folded text lines up.
  if (lower.length !== text.length || terms.length === 0) return escapeHtml(text)
  const marked = new Array<boolean>(text.length).fill(false)
  for (const term of terms) {
    for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) marked.fill(true, at, at + term.length)
  }
  let html = ''
  for (let i = 0; i < text.length; ) {
    let j = i
    while (j < text.length && marked[j] === marked[i]) j++
    html += marked[i] ? `<mark>${escapeHtml(text.slice(i, j))}</mark>` : escapeHtml(text.slice(i, j))
    i = j
  }
  return html
}

/** Left panel: article list, file tree, outline and folder search, like Typora's sidebar. */
export class Sidebar {
  private view: SidebarView = 'outline'
  private root: string | null = null
  private tree: TreeNode[] = []
  private headings: Heading[] = []
  private activeFile: string | null = null
  private activeHeading = -1
  private collapsedFolders = new Set<string>()
  private collapsedHeadings = new Set<number>()
  private searchQuery = ''
  private searchHits: SearchHit[] = []
  private searchTimer = 0

  private titleEl: HTMLElement
  private body: HTMLElement

  constructor(private el: HTMLElement, private handlers: SidebarHandlers) {
    el.innerHTML = `
      <div class="sidebar-header"><span class="sidebar-title"></span></div>
      <div class="sidebar-body"></div>
      <div class="sidebar-footer">
        <button class="sidebar-button" data-action="new" title="新建文件">${ICONS.plus}</button>
        <span class="spacer"></span>
        <button class="sidebar-button" data-view="articles" title="文档列表 (⌃⌘2)">${ICONS.articles}</button>
        <button class="sidebar-button" data-view="tree" title="文件树 (⌃⌘3)">${ICONS.tree}</button>
        <button class="sidebar-button" data-view="outline" title="大纲 (⌃⌘1)">${ICONS.outline}</button>
        <button class="sidebar-button" data-view="search" title="搜索 (⇧⌘F)">${ICONS.search}</button>
      </div>`
    this.titleEl = el.querySelector('.sidebar-title')!
    this.body = el.querySelector('.sidebar-body')!

    el.querySelector('.sidebar-footer')!.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('button')
      if (!button) return
      if (button.dataset.action === 'new') this.handlers.onNewFile()
      if (button.dataset.view) this.handlers.onViewChange(button.dataset.view as SidebarView)
    })
    this.body.addEventListener('click', (event) => this.onBodyClick(event))
  }

  getView(): SidebarView {
    return this.view
  }

  setView(view: SidebarView): void {
    this.view = view
    this.titleEl.textContent = VIEW_TITLES[view]
    this.el.querySelectorAll<HTMLElement>('[data-view]').forEach((button) => {
      button.classList.toggle('active', button.dataset.view === view)
    })
    this.render()
    if (view === 'search') this.body.querySelector<HTMLInputElement>('.search-input')?.focus()
  }

  setFolder(root: string, tree: TreeNode[]): void {
    this.root = root
    this.tree = tree
    if (this.view === 'articles' || this.view === 'tree') this.render()
  }

  hasFolder(): boolean {
    return this.root !== null
  }

  folder(): string | null {
    return this.root
  }

  allFiles(): string[] {
    return flattenFiles(this.tree, '').map((file) => file.path)
  }

  setActiveFile(path: string | null): void {
    this.activeFile = path
    if (this.view === 'articles' || this.view === 'tree') this.render()
  }

  setHeadings(headings: Heading[]): void {
    const same =
      headings.length === this.headings.length &&
      headings.every((h, i) => h.text === this.headings[i].text && h.level === this.headings[i].level)
    this.headings = headings
    if (!same && this.view === 'outline') this.render()
  }

  setActiveHeading(index: number): void {
    if (index === this.activeHeading) return
    this.activeHeading = index
    this.body.querySelectorAll<HTMLElement>('[data-heading]').forEach((item) => {
      item.classList.toggle('active', Number(item.dataset.heading) === index)
    })
  }

  /** Re-runs the folder search (e.g. after the folder changed). */
  showSearch(query: string): void {
    this.searchQuery = query
    this.setView('search')
    void this.runSearch()
  }

  private render(): void {
    switch (this.view) {
      case 'articles':
        return this.renderArticles()
      case 'tree':
        return this.renderTree()
      case 'outline':
        return this.renderOutline()
      case 'search':
        return this.renderSearch()
    }
  }

  private emptyFolder(): void {
    this.body.innerHTML = `
      <div class="sidebar-empty">
        <p>还没有打开文件夹</p>
        <button class="sidebar-open-folder" data-action="open-folder">打开文件夹…</button>
      </div>`
  }

  private renderArticles(): void {
    if (!this.root) return this.emptyFolder()
    const list = flattenFiles(this.tree, fileName(this.root))
    this.body.innerHTML = `<ul class="article-list">${list
      .map((file) => {
        const dot = file.name.lastIndexOf('.')
        const base = dot > 0 ? file.name.slice(0, dot) : file.name
        const ext = dot > 0 ? file.name.slice(dot) : ''
        return `
          <li class="article${file.path === this.activeFile ? ' active' : ''}" data-path="${escapeHtml(file.path)}" title="${escapeHtml(file.path)}">
            <div class="article-meta"><span>${escapeHtml(file.folder)}</span><span>${relativeTime(file.mtime)}</span></div>
            <div class="article-name"><b>${escapeHtml(base)}</b><span class="article-ext">${escapeHtml(ext)}</span></div>
            ${(file.excerpt ?? []).map((line) => `<div class="article-excerpt">${escapeHtml(line)}</div>`).join('')}
          </li>`
      })
      .join('')}</ul>`
  }

  private renderTree(): void {
    if (!this.root) return this.emptyFolder()
    const list = document.createElement('ul')
    list.className = 'file-tree'
    const rootRow = document.createElement('li')
    rootRow.innerHTML = `<div class="tree-row tree-root" data-action="open-folder" title="${escapeHtml(this.root)}">${ICONS.folder}<span class="tree-label">${escapeHtml(fileName(this.root))}</span></div>`
    list.append(rootRow)
    this.appendTreeNodes(list, this.tree, 1)
    this.body.replaceChildren(list)
  }

  private appendTreeNodes(list: HTMLElement, nodes: TreeNode[], depth: number): void {
    for (const node of nodes) {
      const item = document.createElement('li')
      const row = document.createElement('div')
      const isFolder = Boolean(node.children)
      const collapsed = this.collapsedFolders.has(node.path)
      row.className = `tree-row${node.path === this.activeFile ? ' active' : ''}`
      row.dataset.path = node.path
      row.dataset.kind = isFolder ? 'folder' : 'file'
      row.style.paddingLeft = `${8 + depth * 16}px`
      row.title = node.path
      row.innerHTML = `${disclosure(isFolder, collapsed)}${isFolder ? ICONS.folder : ICONS.file}`
      const label = document.createElement('span')
      label.className = 'tree-label'
      label.textContent = node.name
      row.append(label)
      item.append(row)
      if (isFolder && !collapsed) {
        const children = document.createElement('ul')
        this.appendTreeNodes(children, node.children!, depth + 1)
        item.append(children)
      }
      list.append(item)
    }
  }

  private renderOutline(): void {
    if (this.headings.length === 0) {
      this.body.innerHTML = '<div class="sidebar-empty"><p>无大纲</p></div>'
      return
    }
    const minLevel = Math.min(...this.headings.map((h) => h.level))
    const list = document.createElement('ul')
    list.className = 'outline'
    let hiddenBelow = Infinity
    this.headings.forEach((heading, index) => {
      if (heading.level <= hiddenBelow) hiddenBelow = Infinity
      const hasChildren = (this.headings[index + 1]?.level ?? 0) > heading.level
      const collapsed = this.collapsedHeadings.has(index)
      const item = document.createElement('li')
      item.dataset.heading = String(index)
      item.className = `outline-item level-${heading.level}${index === this.activeHeading ? ' active' : ''}`
      item.style.paddingLeft = `${10 + (heading.level - minLevel) * 16}px`
      item.hidden = hiddenBelow !== Infinity
      item.title = heading.text
      item.innerHTML = disclosure(hasChildren, collapsed, index)
      const label = document.createElement('span')
      label.className = 'outline-label'
      label.textContent = heading.text
      item.append(label)
      list.append(item)
      if (collapsed && hiddenBelow === Infinity) hiddenBelow = heading.level
    })
    this.body.replaceChildren(list)
  }

  private renderSearch(): void {
    this.body.innerHTML = `
      <div class="search-box">
        <input class="search-input" type="search" placeholder="${this.root ? '在文件夹中搜索' : '请先打开文件夹'}" value="${escapeHtml(this.searchQuery)}" ${this.root ? '' : 'disabled'} />
      </div>
      <div class="search-results"></div>`
    const input = this.body.querySelector<HTMLInputElement>('.search-input')!
    input.addEventListener('input', () => {
      this.searchQuery = input.value
      window.clearTimeout(this.searchTimer)
      this.searchTimer = window.setTimeout(() => void this.runSearch(), 200)
    })
    this.renderSearchResults()
  }

  private async runSearch(): Promise<void> {
    this.searchHits = this.root && this.searchQuery.trim() ? await this.handlers.onSearch(this.searchQuery) : []
    if (this.view === 'search') this.renderSearchResults()
  }

  private renderSearchResults(): void {
    const container = this.body.querySelector('.search-results')
    if (!container) return
    if (!this.searchQuery.trim()) {
      container.innerHTML = ''
      return
    }
    if (this.searchHits.length === 0) {
      container.innerHTML = '<div class="sidebar-empty"><p>没有找到结果</p></div>'
      return
    }
    container.innerHTML = this.searchHits
      .map((hit, index) => {
        const header =
          hit.path !== this.searchHits[index - 1]?.path
            ? `<div class="search-file" data-hit="${index}" title="${escapeHtml(hit.path)}">${highlightTerms(fileName(hit.path), this.searchQuery)}</div>`
            : ''
        // Line 0 is a file-name match: the file header alone represents it.
        return hit.line === 0 ? header : `${header}<div class="search-hit" data-hit="${index}">${highlightTerms(hit.text, this.searchQuery)}</div>`
      })
      .join('')
  }

  private onBodyClick(event: MouseEvent): void {
    const target = event.target as HTMLElement
    if (target.closest('[data-action="open-folder"]')) return this.handlers.onOpenFolder()

    const toggle = target.closest<HTMLElement>('[data-toggle]')
    if (toggle) {
      const index = Number(toggle.dataset.toggle)
      if (this.collapsedHeadings.has(index)) this.collapsedHeadings.delete(index)
      else this.collapsedHeadings.add(index)
      return this.renderOutline()
    }

    const heading = target.closest<HTMLElement>('[data-heading]')
    if (heading) return this.handlers.onSelectHeading(Number(heading.dataset.heading))

    const hit = target.closest<HTMLElement>('[data-hit]')
    if (hit) return this.handlers.onOpenHit(this.searchHits[Number(hit.dataset.hit)], this.searchQuery.trim())

    const node = target.closest<HTMLElement>('[data-path]')
    if (!node) return
    const path = node.dataset.path!
    if (node.dataset.kind === 'folder') {
      if (this.collapsedFolders.has(path)) this.collapsedFolders.delete(path)
      else this.collapsedFolders.add(path)
      this.renderTree()
    } else {
      this.handlers.onOpenFile(path)
    }
  }
}
