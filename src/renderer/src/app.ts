import type { EditorView } from '@milkdown/kit/prose/view'
import type { MenuCommand, SearchHit, SidebarView, ThemeId } from '../../shared/api'
import { bridge, isDesktop } from './bridge'
import { buildHtmlDocument } from './export'
import { FindBar } from './findbar'
import { FrontMatterBlock, joinFrontMatter, splitFrontMatter } from './front-matter'
import { countText, dirName, extractHeadings, fileName, stripExtension, type Heading } from './markdown-utils'
import { PreferencesDialog } from './preferences'
import { loadPrefs, savePrefs, type Prefs } from './prefs'
import { QuickOpen } from './quick-open'
import { clearSearch, replaceAll, replaceCurrent, searchStatus, setSearchQuery, stepSearch } from './search-plugin'
import { Sidebar } from './sidebar'
import { SourceEditor } from './source'
import { WELCOME_MARKDOWN } from './welcome'
import { WysiwygEditor } from './wysiwyg'

type Mode = 'wysiwyg' | 'source'

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const MARKDOWN_PATH = /\.(md|markdown|mdown|txt)$/i
const LINE_WIDTHS = { default: '1024px', wide: '1280px', full: 'none' } as const

export class App {
  private path: string | null = null
  /** Exact text on disk and the editor's normalized rendering of it; either counts as "clean". */
  private savedText = ''
  private savedNormalized = ''
  private dirty = false
  private mode: Mode = 'wysiwyg'
  private prefs: Prefs = loadPrefs()

  private root = document.documentElement
  private scroller = $('#scroller')
  private writeEl = $('#write')
  private sourceRoot = $('#source')
  private titleEl = $('#title')
  private footer = $('#footer')
  private wordCountButton = $<HTMLButtonElement>('#word-count')
  private wordCountPopover = $('#word-count-popover')

  private wysiwyg: WysiwygEditor
  private source: SourceEditor
  private frontMatter: FrontMatterBlock
  private sidebar: Sidebar
  private findBar: FindBar
  private quickOpen: QuickOpen
  private preferences: PreferencesDialog

  private refreshTimer = 0
  private autoSaveTimer = 0
  private footerTimer = 0

  constructor() {
    this.wysiwyg = new WysiwygEditor({
      root: $('#wysiwyg'),
      onChange: () => this.onContentChange(),
      onCursorMove: (view) => this.keepCursorCentered(view),
      resolveImage: (src) => this.resolveImage(src),
      uploadImage: (file) => this.storeImage(file),
      autoPair: () => this.prefs.autoPair,
      isDark: () => this.prefs.theme === 'night'
    })
    this.source = new SourceEditor(this.sourceRoot, () => this.onContentChange())
    this.frontMatter = new FrontMatterBlock(
      $('#front-matter'),
      () => this.onContentChange(),
      () => this.wysiwyg.focusStart()
    )
    this.sidebar = new Sidebar($('#sidebar'), {
      onOpenFile: (path) => this.openPath(path),
      onOpenFolder: () => this.run('open-folder'),
      onNewFile: () => this.run('new'),
      onSelectHeading: (index) => this.revealHeading(index),
      onViewChange: (view) => this.showSidebarView(view, false),
      onSearch: (query) => (this.sidebar.folder() ? bridge.searchFolder(this.sidebar.folder()!, query) : Promise.resolve([])),
      onOpenHit: (hit, query) => this.openSearchHit(hit, query)
    })
    this.findBar = new FindBar($('#findbar'), {
      onQuery: (query) => {
        setSearchQuery(this.wysiwyg.view(), query)
        this.updateFindCount()
      },
      onStep: (dir) => {
        stepSearch(this.wysiwyg.view(), dir)
        this.updateFindCount()
      },
      onReplace: (text) => {
        replaceCurrent(this.wysiwyg.view(), text)
        this.updateFindCount()
      },
      onReplaceAll: (text) => {
        replaceAll(this.wysiwyg.view(), text)
        this.updateFindCount()
      },
      onClose: () => this.closeFindBar()
    })
    this.quickOpen = new QuickOpen($('#quick-open'), (path) => this.openPath(path))
    this.preferences = new PreferencesDialog($('#preferences'), (patch) => this.updatePrefs(patch))
  }

  async start(): Promise<void> {
    this.root.dataset.platform = bridge.platform
    this.sidebar.setView(this.prefs.sidebarView)
    this.applyPrefs()
    await this.wysiwyg.whenReady()
    this.load(null, '')

    bridge.onMenu((command) => this.run(command))
    bridge.onOpenPath((path) => this.openPath(path))
    this.bindUi()
    if (!isDesktop) this.bindWebShortcuts()

    if (isDesktop && this.prefs.lastFolder) {
      const folder = this.prefs.lastFolder
      bridge.readFolder(folder).then((tree) => tree.length > 0 && this.sidebar.setFolder(folder, tree))
    }
    this.wysiwyg.focus()
  }

  // ---------------------------------------------------------------- commands

  async run(command: MenuCommand): Promise<void> {
    if (command.startsWith('theme-')) return this.updatePrefs({ theme: command.slice(6) as ThemeId })

    switch (command) {
      case 'new':
        if (await this.confirmLeave()) this.load(null, '')
        return
      case 'open': {
        if (!(await this.confirmLeave())) return
        const file = await bridge.openFileDialog()
        if (file) this.load(file.path, file.content)
        return
      }
      case 'open-quickly':
        return this.quickOpen.open(this.prefs.recentFiles, this.sidebar.allFiles())
      case 'open-folder': {
        const folder = await bridge.openFolderDialog()
        if (folder) this.showFolder(folder.root, folder.tree)
        return
      }
      case 'save':
        await this.save(false)
        return
      case 'save-as':
        await this.save(true)
        return
      case 'save-and-close':
        if (await this.save(false)) bridge.closeWindow()
        return
      case 'rename':
        return this.path ? this.startRename() : void this.save(true)
      case 'reveal-in-finder':
        if (this.path) bridge.revealInFinder(this.path)
        return
      case 'copy-path':
        if (this.path) await navigator.clipboard.writeText(this.path)
        return
      case 'export-html':
      case 'export-html-plain': {
        const title = stripExtension(fileName(this.path))
        await bridge.exportHtml(title, buildHtmlDocument(title, this.renderHtml(), command === 'export-html'))
        return
      }
      case 'export-pdf':
        await bridge.exportPdf(stripExtension(fileName(this.path)))
        return
      case 'print':
        return bridge.print()
      case 'preferences':
        return this.preferences.open(this.prefs)
      case 'quick-start':
        if (await this.confirmLeave()) this.load(null, WELCOME_MARKDOWN)
        return

      case 'undo':
      case 'redo':
        if (this.isTypingInField()) return void document.execCommand(command)
        this.activeEditor().exec(command)
        return
      case 'find':
      case 'replace':
        if (this.mode === 'source') return void this.source.exec(command)
        return this.findBar.open(command === 'replace', this.selectedPlainText())
      case 'find-next':
      case 'find-prev':
        if (this.mode === 'source') return void this.source.exec(command)
        if (!this.findBar.isOpen()) return this.findBar.open(false, this.selectedPlainText())
        stepSearch(this.wysiwyg.view(), command === 'find-next' ? 1 : -1)
        return this.updateFindCount()
      case 'copy-markdown':
        await navigator.clipboard.writeText(this.mode === 'source' ? this.source.selectedText() : this.wysiwyg.selectionAs().markdown)
        return
      case 'copy-html':
        await navigator.clipboard.writeText(this.mode === 'source' ? this.source.selectedText() : this.wysiwyg.selectionAs().html)
        return
      case 'front-matter':
        if (this.mode === 'source') return
        if (this.frontMatter.get() === null) {
          this.frontMatter.set('')
          this.onContentChange()
        }
        return this.frontMatter.focus()

      case 'toggle-source':
        return this.setMode(this.mode === 'source' ? 'wysiwyg' : 'source')
      case 'toggle-sidebar':
        return this.updatePrefs({ sidebar: !this.prefs.sidebar })
      case 'view-outline':
        return this.showSidebarView('outline', true)
      case 'view-articles':
        return this.showSidebarView('articles', true)
      case 'view-tree':
        return this.showSidebarView('tree', true)
      case 'view-search':
        return this.showSidebarView('search', false)
      case 'toggle-focus':
        return this.updatePrefs({ focus: !this.prefs.focus })
      case 'toggle-typewriter':
        return this.updatePrefs({ typewriter: !this.prefs.typewriter })
      case 'toggle-statusbar':
        return this.updatePrefs({ statusBar: !this.prefs.statusBar })
      case 'zoom-in':
        return this.updatePrefs({ zoom: Math.min(2, round(this.prefs.zoom + 0.1)) })
      case 'zoom-out':
        return this.updatePrefs({ zoom: Math.max(0.6, round(this.prefs.zoom - 0.1)) })
      case 'zoom-reset':
        return this.updatePrefs({ zoom: 1 })

      default:
        // Paragraph and Format commands go to whichever editor is visible.
        this.activeEditor().exec(command)
    }
  }

  /** Load / save hooks for the dev-only round-trip check (see roundtrip.ts). */
  testHarness() {
    return {
      load: (markdown: string) => this.load(null, markdown),
      save: () => this.currentMarkdown(),
      html: () => this.writeEl.querySelector('.ProseMirror')?.innerHTML ?? ''
    }
  }

  private activeEditor(): WysiwygEditor | SourceEditor {
    return this.mode === 'source' ? this.source : this.wysiwyg
  }

  private isTypingInField(): boolean {
    const active = document.activeElement
    return active instanceof HTMLInputElement || (active instanceof HTMLTextAreaElement && !active.closest('.cm-editor'))
  }

  // --------------------------------------------------------------- documents

  private load(path: string | null, content: string): void {
    this.path = path
    const { yaml, body } = splitFrontMatter(content)
    this.frontMatter.set(yaml)
    this.wysiwyg.setMarkdown(body, true)
    if (this.mode === 'source') this.source.setMarkdown(content)
    this.savedText = content
    this.savedNormalized = joinFrontMatter(yaml, this.wysiwyg.getMarkdown())
    if (path) this.rememberRecent(path)
    this.setDirty(false)
    this.sidebar.setActiveFile(path)
    this.scroller.scrollTop = 0
    this.refreshDerived()
    if (this.findBar.isOpen()) this.closeFindBar()
  }

  private async openPath(path: string): Promise<void> {
    if (!MARKDOWN_PATH.test(path)) {
      const tree = await bridge.readFolder(path)
      this.showFolder(path, tree)
      return
    }
    if (path === this.path || !(await this.confirmLeave())) return
    try {
      const file = await bridge.readFile(path)
      this.load(file.path, file.content)
    } catch (error) {
      alert(`无法打开文件：${path}\n${(error as Error).message}`)
    }
  }

  private async openSearchHit(hit: SearchHit, query: string): Promise<void> {
    await this.openPath(hit.path)
    if (this.path !== hit.path) return
    if (this.mode === 'source') return this.source.revealLine(hit.line)
    this.findBar.open(false, query)
    stepSearch(this.wysiwyg.view(), 1)
    this.updateFindCount()
  }

  private showFolder(root: string, tree: Awaited<ReturnType<typeof bridge.readFolder>>): void {
    this.sidebar.setFolder(root, tree)
    const view = this.prefs.sidebarView === 'outline' || this.prefs.sidebarView === 'search' ? 'articles' : this.prefs.sidebarView
    this.updatePrefs({ lastFolder: root, sidebar: true, sidebarView: view })
  }

  private async refreshFolder(): Promise<void> {
    const root = this.sidebar.folder()
    if (root) this.sidebar.setFolder(root, await bridge.readFolder(root))
  }

  /** Returns false when the user cancels; saves or discards otherwise. */
  private async confirmLeave(): Promise<boolean> {
    if (!this.dirty) return true
    const choice = await bridge.confirmDiscard(fileName(this.path))
    if (choice === 'cancel') return false
    if (choice === 'save') return this.save(false)
    return true
  }

  private async save(saveAs: boolean): Promise<boolean> {
    const content = this.currentMarkdown()
    const target = await bridge.saveFile(saveAs ? null : this.path, content)
    if (!target) return false
    const isNewFile = isDesktop && target !== this.path
    if (isDesktop) this.path = target
    this.savedText = content
    this.savedNormalized = content
    this.setDirty(false)
    if (this.path) this.rememberRecent(this.path)
    this.sidebar.setActiveFile(this.path)
    if (isNewFile || this.sidebar.getView() === 'articles') void this.refreshFolder()
    return true
  }

  private currentMarkdown(): string {
    if (this.mode === 'source') return this.source.getMarkdown()
    return joinFrontMatter(this.frontMatter.get(), this.wysiwyg.getMarkdown())
  }

  private onContentChange(): void {
    const markdown = this.currentMarkdown()
    this.setDirty(markdown !== this.savedText && markdown !== this.savedNormalized)
    this.hideFooterWhileTyping()
    window.clearTimeout(this.refreshTimer)
    this.refreshTimer = window.setTimeout(() => this.refreshDerived(), 150)
    if (this.findBar.isOpen()) this.updateFindCount()
    if (this.prefs.autoSave && this.path && this.dirty) {
      window.clearTimeout(this.autoSaveTimer)
      this.autoSaveTimer = window.setTimeout(() => void this.save(false), 1000)
    }
  }

  private setDirty(dirty: boolean): void {
    this.dirty = dirty
    const name = fileName(this.path)
    this.titleEl.textContent = name
    this.root.classList.toggle('doc-edited', dirty)
    bridge.setTitle(name, dirty, this.path)
    bridge.setDirty(dirty)
    this.syncMenu()
  }

  private rememberRecent(path: string): void {
    const recentFiles = [path, ...this.prefs.recentFiles.filter((p) => p !== path)].slice(0, 30)
    this.prefs = { ...this.prefs, recentFiles }
    savePrefs(this.prefs)
  }

  // -------------------------------------------------------------- title bar

  private startRename(): void {
    const title = this.titleEl
    const original = title.textContent ?? ''
    title.contentEditable = 'plaintext-only'
    title.classList.add('renaming')
    title.focus()
    const range = document.createRange()
    range.setStart(title.firstChild ?? title, 0)
    range.setEnd(title.firstChild ?? title, stripExtension(original).length)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)

    const finish = async (commit: boolean) => {
      title.removeEventListener('keydown', onKey)
      title.removeEventListener('blur', onBlur)
      title.contentEditable = 'false'
      title.classList.remove('renaming')
      const next = (title.textContent ?? '').trim()
      if (!commit || !next || next === original || !this.path) {
        title.textContent = original
        return
      }
      try {
        this.path = await bridge.renameFile(this.path, next)
        this.setDirty(this.dirty)
        this.rememberRecent(this.path)
        this.sidebar.setActiveFile(this.path)
        void this.refreshFolder()
      } catch (error) {
        title.textContent = original
        alert((error as Error).message)
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault()
        void finish(event.key === 'Enter')
        this.wysiwyg.focus()
      }
    }
    const onBlur = () => void finish(true)
    title.addEventListener('keydown', onKey)
    title.addEventListener('blur', onBlur)
  }

  // ------------------------------------------------------- outline and stats

  private refreshDerived(): void {
    const body = this.mode === 'source' ? this.source.getMarkdown() : this.wysiwyg.getMarkdown()
    const stats = countText(splitFrontMatter(body).body)
    this.wordCountButton.textContent = `${stats.words.toLocaleString()} 词`
    this.wordCountPopover.innerHTML = `
      <div><b>${stats.words.toLocaleString()}</b> 词</div>
      <div><b>${stats.characters.toLocaleString()}</b> 字符</div>
      <div><b>${stats.lines.toLocaleString()}</b> 行</div>
      <div>阅读时间 <b>${stats.minutes}</b> 分钟</div>`
    this.sidebar.setHeadings(this.currentHeadings(body))
    this.updateActiveHeading()
  }

  private currentHeadings(markdown: string): Heading[] {
    if (this.mode === 'source') return extractHeadings(markdown)
    return this.wysiwyg.headingElements().map((el, index) => ({
      level: Number(el.tagName.slice(1)),
      text: el.textContent?.trim() || '(空标题)',
      line: index
    }))
  }

  private revealHeading(index: number): void {
    if (this.mode === 'source') {
      const heading = extractHeadings(this.source.getMarkdown())[index]
      if (heading) this.source.revealLine(heading.line)
      return
    }
    const target = this.wysiwyg.headingElements()[index]
    if (!target) return
    const top = target.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top + this.scroller.scrollTop
    this.scroller.scrollTo({ top: top - 20, behavior: 'smooth' })
    this.sidebar.setActiveHeading(index)
  }

  private updateActiveHeading(): void {
    if (this.mode === 'source') return
    const limit = this.scroller.getBoundingClientRect().top + 60
    let active = -1
    this.wysiwyg.headingElements().forEach((el, index) => {
      if (el.getBoundingClientRect().top <= limit) active = index
    })
    this.sidebar.setActiveHeading(active)
  }

  // ------------------------------------------------------------- find bar

  private selectedPlainText(): string | undefined {
    const text = window.getSelection()?.toString() ?? ''
    return text && !text.includes('\n') ? text : undefined
  }

  private updateFindCount(): void {
    const { total, current } = searchStatus(this.wysiwyg.view().state)
    this.findBar.setCount(current, total)
  }

  private closeFindBar(): void {
    this.findBar.close()
    clearSearch(this.wysiwyg.view())
    this.wysiwyg.focus()
  }

  // ------------------------------------------------------------ view modes

  private setMode(mode: Mode): void {
    if (mode === this.mode) return
    if (mode === 'source') {
      this.source.setMarkdown(this.currentMarkdown())
      if (this.findBar.isOpen()) this.closeFindBar()
    } else {
      const { yaml, body } = splitFrontMatter(this.source.getMarkdown())
      this.frontMatter.set(yaml)
      this.wysiwyg.setMarkdown(body, false)
    }
    this.mode = mode
    this.writeEl.hidden = mode === 'source'
    this.sourceRoot.hidden = mode !== 'source'
    this.root.classList.toggle('source-mode', mode === 'source')
    this.refreshDerived()
    this.syncMenu()
    if (mode === 'source') this.source.focus()
    else this.wysiwyg.focus()
  }

  private showSidebarView(view: SidebarView, toggle: boolean): void {
    // The View menu shortcuts toggle the sidebar off when it already shows that view.
    if (toggle && this.prefs.sidebar && this.prefs.sidebarView === view) return this.updatePrefs({ sidebar: false })
    this.sidebar.setView(view)
    this.updatePrefs({ sidebar: true, sidebarView: view })
    if (view === 'outline') this.refreshDerived()
  }

  /** Typewriter mode: keep the caret in the vertical middle of the viewport. */
  private keepCursorCentered(view: EditorView): void {
    if (!this.prefs.typewriter || this.mode !== 'wysiwyg' || !view.hasFocus()) return
    const caret = view.coordsAtPos(view.state.selection.head)
    const box = this.scroller.getBoundingClientRect()
    this.scroller.scrollBy({ top: caret.top - (box.top + box.height / 2), behavior: 'smooth' })
  }

  private updatePrefs(patch: Partial<Prefs>): void {
    this.prefs = { ...this.prefs, ...patch }
    savePrefs(this.prefs)
    this.applyPrefs()
  }

  private applyPrefs(): void {
    const { root, prefs } = this
    root.dataset.theme = prefs.theme
    root.style.setProperty('--zoom', String(prefs.zoom))
    root.style.setProperty('--base-font-size', `${prefs.fontSize}px`)
    root.style.setProperty('--write-max-width', LINE_WIDTHS[prefs.lineWidth])
    root.style.setProperty('--sidebar-width', `${prefs.sidebarWidth}px`)
    root.classList.toggle('sidebar-open', prefs.sidebar)
    root.classList.toggle('focus-mode', prefs.focus)
    root.classList.toggle('typewriter-mode', prefs.typewriter)
    root.classList.toggle('statusbar-hidden', !prefs.statusBar)
    if (this.sidebar.getView() !== prefs.sidebarView) this.sidebar.setView(prefs.sidebarView)
    this.syncMenu()
  }

  private syncMenu(): void {
    bridge.syncMenu({
      source: this.mode === 'source',
      sidebar: this.prefs.sidebar,
      sidebarView: this.prefs.sidebarView,
      focus: this.prefs.focus,
      typewriter: this.prefs.typewriter,
      statusBar: this.prefs.statusBar,
      theme: this.prefs.theme,
      hasFile: this.path !== null
    })
  }

  // ----------------------------------------------------------------- images

  private resolveImage(src: string): string {
    if (/^(https?:|data:|blob:|file:)/i.test(src) || !isDesktop || !this.path) return src
    const absolute = src.startsWith('/') ? src : `${dirName(this.path)}/${src}`
    return `file://${encodeURI(absolute)}`
  }

  private async storeImage(file: File): Promise<string> {
    if (isDesktop && this.path) {
      return bridge.saveAsset(this.path, file.name || 'image.png', await file.arrayBuffer())
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
  }

  private renderHtml(): string {
    if (this.mode === 'source') this.wysiwyg.setMarkdown(splitFrontMatter(this.source.getMarkdown()).body, false)
    return this.wysiwyg.toHtml()
  }

  // --------------------------------------------------------------------- UI

  private bindUi(): void {
    this.scroller.addEventListener('scroll', () => this.updateActiveHeading(), { passive: true })
    $('#toggle-sidebar').addEventListener('click', () => this.run('toggle-sidebar'))
    $('#toggle-mode').addEventListener('click', () => this.run('toggle-source'))
    $('#title-menu').addEventListener('click', () => bridge.showTitleMenu(this.path !== null))

    this.wordCountButton.addEventListener('click', (event) => {
      event.stopPropagation()
      this.wordCountPopover.hidden = !this.wordCountPopover.hidden
    })
    document.addEventListener('click', () => (this.wordCountPopover.hidden = true))

    // Clicking below the last block puts the caret at the end, like a page.
    this.scroller.addEventListener('mousedown', (event) => {
      if ((event.target === this.scroller || event.target === this.writeEl) && this.mode === 'wysiwyg') {
        event.preventDefault()
        this.wysiwyg.focusEnd()
      }
    })

    const editorHost = $('#wysiwyg')
    // ⌘-click opens links, as in Typora; a plain click just places the caret.
    editorHost.addEventListener('click', (event) => {
      const link = (event.target as HTMLElement).closest('a')
      if (link && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        bridge.openExternal(link.getAttribute('href') ?? '')
      }
    })
    if (isDesktop) {
      document.addEventListener('contextmenu', (event) => {
        if (!(event.target as HTMLElement).closest('#wysiwyg, #source')) return
        event.preventDefault()
        bridge.showContextMenu(this.activeEditor().hasSelection())
      })
    }

    // The status bar fades in on mouse movement and hides while typing.
    window.addEventListener('mousemove', () => this.revealFooter(), { passive: true })
    this.footer.addEventListener('mouseenter', () => window.clearTimeout(this.footerTimer))
    window.addEventListener('focus', () => this.root.classList.remove('window-blurred'))
    window.addEventListener('blur', () => this.root.classList.add('window-blurred'))

    this.bindSidebarResizer()
  }

  private revealFooter(): void {
    this.root.classList.add('footer-visible')
    window.clearTimeout(this.footerTimer)
    this.footerTimer = window.setTimeout(() => {
      if (!this.footer.matches(':hover') && this.wordCountPopover.hidden) this.root.classList.remove('footer-visible')
    }, 2500)
  }

  private hideFooterWhileTyping(): void {
    if (this.footer.matches(':hover')) return
    window.clearTimeout(this.footerTimer)
    this.root.classList.remove('footer-visible')
  }

  private bindSidebarResizer(): void {
    const handle = $('#sidebar-resizer')
    handle.addEventListener('mousedown', (event) => {
      event.preventDefault()
      this.root.classList.add('resizing')
      const onMove = (move: MouseEvent) => {
        const width = Math.min(480, Math.max(180, move.clientX))
        this.root.style.setProperty('--sidebar-width', `${width}px`)
        this.prefs.sidebarWidth = width
      }
      const onUp = () => {
        this.root.classList.remove('resizing')
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        savePrefs(this.prefs)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    })
  }

  /**
   * In the browser there is no native menu, so mirror its main shortcuts.
   * Capture phase so editor keymaps (e.g. CodeMirror's Mod-/) do not win.
   */
  private bindWebShortcuts(): void {
    const plain: Record<string, MenuCommand> = {
      '/': 'toggle-source',
      s: 'save',
      o: 'open',
      n: 'new',
      f: 'find',
      g: 'find-next',
      ',': 'preferences',
      '0': 'paragraph',
      '1': 'heading-1',
      '2': 'heading-2',
      '3': 'heading-3',
      '4': 'heading-4',
      '5': 'heading-5',
      '6': 'heading-6',
      '=': 'heading-up',
      '-': 'heading-down',
      k: 'link',
      u: 'underline',
      l: 'select-line',
      e: 'select-styled',
      d: 'select-word',
      '\\': 'clear-format'
    }
    const shifted: Record<string, MenuCommand> = { l: 'toggle-sidebar', o: 'open-quickly', f: 'view-search', s: 'save-as', g: 'find-prev', c: 'copy-markdown' }
    const alt: Record<string, MenuCommand> = { t: 'table', c: 'code-fence', b: 'math-block', q: 'quote', o: 'ordered-list', u: 'bullet-list', x: 'task-list', f: 'replace' }
    window.addEventListener(
      'keydown',
      (event) => {
        let command: MenuCommand | undefined
        if (event.key === 'F8') command = 'toggle-focus'
        else if (event.key === 'F9') command = 'toggle-typewriter'
        else if (event.metaKey || event.ctrlKey) {
          const key = event.code.startsWith('Key') ? event.code.slice(3).toLowerCase() : event.code.startsWith('Digit') ? event.code.slice(5) : event.key
          if (event.altKey) command = alt[key]
          else if (event.shiftKey) command = shifted[key]
          else command = plain[key]
        }
        if (command) {
          event.preventDefault()
          event.stopPropagation()
          void this.run(command)
        }
      },
      true
    )
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
