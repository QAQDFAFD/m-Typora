import type { EditorView } from '@milkdown/kit/prose/view'
import type { CustomTheme, MenuCommand, SearchHit, SidebarView, ThemeId, UploadConfig, UploadFile } from '../../shared/api'
import { bridge, isDesktop } from './bridge'
import { buildExportPage, buildPlainHtml } from './export'
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
  private customThemes: CustomTheme[] = []
  private customThemeStyle: HTMLStyleElement | null = null

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
  private toastTimer = 0
  private pinnedHeading: { index: number; until: number } | null = null

  constructor() {
    this.wysiwyg = new WysiwygEditor({
      root: $('#wysiwyg'),
      onChange: () => this.onContentChange(),
      onCursorMove: (view) => this.keepCursorCentered(view),
      resolveImage: (src) => this.resolveImage(src),
      uploadImage: (file) => this.storeImage(file),
      autoPair: () => this.prefs.autoPair,
      isDark: () => this.isDarkTheme()
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
    this.preferences = new PreferencesDialog($('#preferences'), {
      onChange: (patch) => this.updatePrefs(patch),
      onTestUpload: () => this.testUpload(),
      onOpenThemeFolder: () => bridge.openThemeFolder(),
      customThemes: () => this.customThemes.map(({ id, label }) => ({ id, label })),
      fileManager: bridge.platform === 'darwin' ? '访达' : '文件夹'
    })
  }

  async start(): Promise<void> {
    this.root.dataset.platform = bridge.platform
    if (!isMacLike()) localizeShortcutHints(document.body)
    this.sidebar.setView(this.prefs.sidebarView)
    // Custom themes live in a folder the main process reads; know them before the first paint.
    this.customThemes = await bridge.listThemes().catch(() => [])
    if (this.prefs.theme.startsWith('custom:') && !this.customThemes.some((theme) => theme.id === this.prefs.theme)) {
      this.prefs = { ...this.prefs, theme: 'github' }
    }
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
        return this.exportDocument('html')
      case 'export-html-plain':
        return this.exportDocument('html-plain')
      case 'export-pdf':
        return this.exportDocument('pdf')
      case 'print':
        return bridge.print()
      case 'preferences':
        return this.preferences.open(this.prefs)
      case 'open-theme-folder':
        return bridge.openThemeFolder()
      case 'upload-images':
        return this.uploadAllImages()
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
        // ⌘Enter / ⇧⌘⌫ are table accelerators; never let them act while typing in a field.
        if (command.startsWith('table-') && this.isTypingInField()) return
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
    // Line 0 is a match on the file name: opening the file is all there is to do.
    if (this.path !== hit.path || hit.line === 0) return
    if (this.mode === 'source') return this.source.revealLine(hit.line)
    // Words searched for separately are highlighted by the longest one.
    const phrase = query.trim()
    const needle = hit.text.toLowerCase().includes(phrase.toLowerCase())
      ? phrase
      : phrase.split(/\s+/).reduce((longest, word) => (word.length > longest.length ? word : longest), '')
    this.findBar.open(false, needle)
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
    // The clicked heading stays highlighted while the jump animates (and when the page
    // cannot scroll far enough to bring it to the top).
    this.pinnedHeading = { index, until: Date.now() + 1200 }
    this.sidebar.setActiveHeading(index)
  }

  private updateActiveHeading(): void {
    if (this.mode === 'source') return
    if (this.pinnedHeading && Date.now() < this.pinnedHeading.until) {
      this.sidebar.setActiveHeading(this.pinnedHeading.index)
      return
    }
    const box = this.scroller.getBoundingClientRect()
    const atBottom = this.scroller.scrollTop + this.scroller.clientHeight >= this.scroller.scrollHeight - 2
    if (this.pinnedHeading && atBottom) {
      this.sidebar.setActiveHeading(this.pinnedHeading.index)
      return
    }
    this.pinnedHeading = null
    const limit = box.top + 60
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
    root.dataset.imageAlign = prefs.imageAlign
    this.applyCustomTheme(prefs.theme.startsWith('custom:') ? (this.customThemes.find((theme) => theme.id === prefs.theme)?.css ?? '') : null)
    root.style.setProperty('--zoom', String(prefs.zoom))
    root.style.setProperty('--base-font-size', `${prefs.fontSize}px`)
    root.style.setProperty('--write-max-width', LINE_WIDTHS[prefs.lineWidth])
    root.style.setProperty('--sidebar-width', `${prefs.sidebarWidth}px`)
    root.classList.toggle('sidebar-open', prefs.sidebar)
    root.classList.toggle('focus-mode', prefs.focus)
    root.classList.toggle('typewriter-mode', prefs.typewriter)
    root.classList.toggle('statusbar-hidden', !prefs.statusBar)
    if (this.sidebar.getView() !== prefs.sidebarView) this.sidebar.setView(prefs.sidebarView)
    this.preferences.sync(prefs)
    this.syncMenu()
  }

  /**
   * A custom theme is the user's stylesheet layered over the default (Github) theme, so
   * it only has to set what it changes — the way Typora themes work.
   */
  private applyCustomTheme(css: string | null): void {
    if (css === null) {
      this.customThemeStyle?.remove()
      this.customThemeStyle = null
      return
    }
    this.customThemeStyle ??= Object.assign(document.createElement('style'), { id: 'custom-theme' })
    if (this.customThemeStyle.textContent !== css) this.customThemeStyle.textContent = css
    if (!this.customThemeStyle.isConnected) document.head.append(this.customThemeStyle)
  }

  /** Dark themes (Night, or a custom theme declaring `color-scheme: dark`). */
  private isDarkTheme(): boolean {
    return getComputedStyle(this.root).colorScheme.includes('dark')
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
      hasFile: this.path !== null,
      background: getComputedStyle(document.body).backgroundColor,
      dark: this.isDarkTheme()
    })
  }

  // ----------------------------------------------------------------- images

  private resolveImage(src: string): string {
    if (/^(https?:|data:|blob:|file:)/i.test(src) || !isDesktop || !this.path) return src
    const absolute = src.startsWith('/') ? src : `${dirName(this.path)}/${src}`
    return `file://${encodeURI(absolute)}`
  }

  /**
   * Where a dropped or pasted image goes (Preferences › 图像 › 插入图片时): uploaded with
   * PicGo / a command, copied into ./assets next to the document, or referenced in place.
   */
  private async storeImage(file: File): Promise<string> {
    const path = isDesktop ? bridge.pathForFile(file) : ''
    const name = file.name || 'image.png'
    if (isDesktop && this.prefs.imageInsert === 'upload') {
      this.toast('正在上传图片…', 'progress')
      try {
        const [url] = await bridge.uploadImages([path ? { path, name } : { name, data: await file.arrayBuffer() }], this.uploadConfig())
        this.toast('图片已上传', 'ok')
        return url
      } catch (error) {
        this.toast(`图片上传失败，已保存在本地：${errorMessage(error)}`, 'error')
      }
    }
    if (isDesktop && path && (this.prefs.imageInsert === 'none' || !this.path)) return this.linkToFile(path)
    if (isDesktop && this.path) return bridge.saveAsset(this.path, name, await file.arrayBuffer())
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
  }

  /** A path to an image on disk, relative to the document when it has been saved. */
  private linkToFile(path: string): string {
    const target = path.replace(/\\/g, '/')
    return this.path ? relativePath(dirName(this.path).replace(/\\/g, '/'), target) : target
  }

  /** The file an image src points at, or null when it cannot be known (unsaved document). */
  private imageFile(src: string): string | null {
    let path = src
    try {
      path = src.startsWith('file:') ? decodeURIComponent(new URL(src).pathname) : decodeURI(src)
    } catch {
      // Keep the src as written.
    }
    if (bridge.platform === 'win32' && /^\/[a-z]:/i.test(path)) path = path.slice(1)
    if (path.startsWith('/') || /^[a-z]:[\\/]/i.test(path)) return path
    return this.path ? `${dirName(this.path)}/${path}` : null
  }

  private uploadConfig(): UploadConfig {
    return { service: this.prefs.uploadService, picgoPort: this.prefs.picgoPort, picgoPath: this.prefs.picgoPath, command: this.prefs.uploadCommand }
  }

  /** Format › 上传全部本地图片: uploads every local image and points it at its new URL. */
  private async uploadAllImages(): Promise<void> {
    if (!isDesktop) return
    if (this.mode === 'source') this.setMode('wysiwyg')
    const images = this.wysiwyg.localImages()
    const files = images.map((image) => ({ ...image, file: this.imageFile(image.src) }))
    const uploadable = files.filter((image): image is typeof image & { file: string } => image.file !== null)
    if (uploadable.length === 0) {
      this.toast(images.length === 0 ? '当前文档没有本地图片' : '请先保存文档，相对路径的图片才能找到', 'error')
      return
    }
    this.toast(`正在上传 ${uploadable.length} 张图片…`, 'progress')
    try {
      const list: UploadFile[] = uploadable.map((image) => ({ path: image.file, name: fileName(image.file) }))
      const urls = await bridge.uploadImages(list, this.uploadConfig())
      this.wysiwyg.setImageSources(uploadable.map((image, i) => ({ pos: image.pos, src: urls[i] })))
      this.toast(`已上传 ${urls.length} 张图片`, 'ok')
    } catch (error) {
      this.toast(`图片上传失败：${errorMessage(error)}`, 'error')
    }
  }

  /** Preferences › 图像 › 验证: uploads a small generated picture. */
  private async testUpload(): Promise<string> {
    const canvas = Object.assign(document.createElement('canvas'), { width: 240, height: 80 })
    const context = canvas.getContext('2d')!
    context.fillStyle = '#4183c4'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#ffffff'
    context.font = '600 26px sans-serif'
    context.fillText('m-typora ✓', 32, 50)
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('无法生成测试图片'))), 'image/png')
    )
    const [url] = await bridge.uploadImages([{ name: 'm-typora-upload-test.png', data: await blob.arrayBuffer() }], this.uploadConfig())
    return url
  }

  // ----------------------------------------------------------------- export

  /** File › 导出: the document as the editor shows it, with the current theme. */
  private async exportDocument(kind: 'pdf' | 'html' | 'html-plain'): Promise<void> {
    const title = stripExtension(fileName(this.path))
    // Exports are built from the rendered document, so bring source edits over first.
    if (this.mode === 'source') this.wysiwyg.setMarkdown(splitFrontMatter(this.source.getMarkdown()).body, false)
    const common = { docPath: this.path, after: this.prefs.afterExport }
    try {
      if (kind === 'html-plain') {
        await bridge.exportHtml(title, buildPlainHtml(title, this.wysiwyg.toHtml()), { ...common, embedImages: this.prefs.htmlEmbedImages })
        return
      }
      const html = await this.wysiwyg.withRenderedDocument((editor) =>
        buildExportPage({ title, editor, codeBlocks: this.wysiwyg.codeBlocks(), dark: this.isDarkTheme(), target: kind })
      )
      if (kind === 'pdf') {
        this.toast('正在导出 PDF…', 'progress')
        const target = await bridge.exportPdf(title, html, { ...common, pageSize: this.prefs.pdfPageSize, margin: this.prefs.pdfMargin })
        this.toast(target ? `已导出 ${fileName(target)}` : '', 'ok')
      } else {
        await bridge.exportHtml(title, html, { ...common, embedImages: this.prefs.htmlEmbedImages })
      }
    } catch (error) {
      this.toast(`导出失败：${errorMessage(error)}`, 'error')
    }
  }

  /** A short message at the bottom of the window (upload and export progress). */
  private toast(text: string, kind: 'progress' | 'ok' | 'error'): void {
    let el = document.querySelector<HTMLElement>('#toast')
    if (!el) {
      el = Object.assign(document.createElement('div'), { id: 'toast', className: 'toast' })
      el.setAttribute('role', 'status')
      document.body.append(el)
    }
    window.clearTimeout(this.toastTimer)
    el.hidden = !text
    el.textContent = text
    el.dataset.kind = kind
    if (kind !== 'progress') this.toastTimer = window.setTimeout(() => (el!.hidden = true), kind === 'error' ? 6000 : 2500)
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
        bridge.showContextMenu(this.activeEditor().hasSelection(), this.mode === 'wysiwyg' && this.wysiwyg.inTable())
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
        // The document keeps at least 360px (see --sidebar-actual in base.css).
        const width = Math.round(Math.max(160, Math.min(560, move.clientX, window.innerWidth - 360)))
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

/** The message of an error thrown in the main process, without Electron's IPC prefix. */
function errorMessage(error: unknown): string {
  return String((error as Error)?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** `to` relative to the folder `from` (both with forward slashes). */
function relativePath(from: string, to: string): string {
  const a = from.split('/').filter(Boolean)
  const b = to.split('/').filter(Boolean)
  // Different Windows drives have no relative path.
  if (a[0] !== b[0]) return to
  let common = 0
  while (common < a.length && common < b.length && a[common] === b[common]) common++
  return [...a.slice(common).map(() => '..'), ...b.slice(common)].join('/')
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

function isMacLike(): boolean {
  return bridge.platform === 'darwin' || (bridge.platform === 'web' && /Mac|iPhone|iPad/i.test(navigator.platform))
}

/** Rewrites ⌘ ⇧ ⌥ ⌃ in tooltips to Ctrl / Shift / Alt on Windows and Linux. */
function localizeShortcutHints(root: HTMLElement): void {
  const symbols: Record<string, string> = { '⌃': 'Ctrl+', '⌥': 'Alt+', '⇧': 'Shift+', '⌘': 'Ctrl+' }
  root.querySelectorAll<HTMLElement>('[title]').forEach((el) => {
    el.title = el.title.replace(/[⌃⌥⇧⌘]+/g, (keys) => [...new Set([...keys].map((k) => symbols[k]))].join(''))
  })
}
