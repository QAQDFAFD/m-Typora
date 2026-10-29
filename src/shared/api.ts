// Contract between the Electron main process and the renderer.

export interface OpenedFile {
  path: string
  content: string
}

export interface TreeNode {
  name: string
  path: string
  children?: TreeNode[]
  /** Last modification time in ms (files only). */
  mtime?: number
  /** Up to two plain-text lines used by the article list (files only). */
  excerpt?: string[]
}

/** The result of a save: the path written, a refusal because the file changed on disk, or a cancelled dialog. */
export type SaveResult = { path: string } | { conflict: true } | null

export interface SaveOptions {
  /** Overwrite even though the file changed on disk since this window read it. */
  force?: boolean
  /** Where the save dialog starts when `path` is null. */
  suggestedPath?: string
}

/** What happened to the open document on disk, as seen by the main process. */
export type ExternalChange = 'modified' | 'deleted' | 'restored'

/** Unsaved text recovered after a crash. */
export interface DraftRestore {
  path: string | null
  content: string
  /** The file was changed by something else after these edits started. */
  diskChanged: boolean
}

export interface HistoryEntry {
  /** Snapshot time in ms; also its id. */
  id: string
  time: number
  size: number
}

export interface SearchHit {
  path: string
  line: number
  text: string
}

export const THEMES = [
  { id: 'github', label: 'Github' },
  { id: 'gothic', label: 'Gothic' },
  { id: 'newsprint', label: 'Newsprint' },
  { id: 'night', label: 'Night' },
  { id: 'pixyll', label: 'Pixyll' },
  { id: 'whitey', label: 'Whitey' }
] as const

export type BuiltinThemeId = (typeof THEMES)[number]['id']
/** A built-in theme, or `custom:<file name>` for a CSS file in the user's theme folder. */
export type ThemeId = BuiltinThemeId | `custom:${string}`

export interface CustomTheme {
  id: `custom:${string}`
  label: string
  /** The stylesheet, with relative url(...) references made absolute. */
  css: string
}

export type UploadService = 'picgo-app' | 'picgo-core' | 'custom'

export interface UploadConfig {
  service: UploadService
  /** Port of PicGo.app's upload server (PicGo › 设置 › 设置 Server). */
  picgoPort: number
  /** PicGo-Core executable; empty means `picgo` from the user's PATH. */
  picgoPath: string
  /** Custom command; the image paths are appended and the last lines of its output are the URLs. */
  command: string
}

/** An image to upload: a file on disk, or bytes (pasted screenshots) with a file name. */
export interface UploadFile {
  path?: string
  name: string
  data?: ArrayBuffer
}

export type AfterExport = 'none' | 'open' | 'reveal'

export interface ExportOptions {
  /** The document being exported; the save dialog starts in its folder. */
  docPath: string | null
  after: AfterExport
}

export interface HtmlExportOptions extends ExportOptions {
  /** Inline local images as data: URLs instead of linking them relative to the HTML file. */
  embedImages: boolean
}

export type PdfPageSize = 'A4' | 'A3' | 'A5' | 'Letter' | 'Legal'
export type PdfMargin = 'default' | 'none' | 'narrow' | 'wide'

export interface PdfExportOptions extends ExportOptions {
  pageSize: PdfPageSize
  margin: PdfMargin
}

export type SidebarView = 'articles' | 'tree' | 'outline' | 'search'

export type MenuCommand =
  // File
  | 'new'
  | 'open'
  | 'open-quickly'
  | 'open-folder'
  | 'save'
  | 'save-as'
  | 'save-and-close'
  | 'history'
  | 'rename'
  | 'reveal-in-finder'
  | 'copy-path'
  | 'export-pdf'
  | 'export-html'
  | 'export-html-plain'
  | 'print'
  | 'preferences'
  // Edit
  | 'undo'
  | 'redo'
  | 'find'
  | 'find-next'
  | 'find-prev'
  | 'replace'
  | 'copy-markdown'
  | 'copy-html'
  | 'select-line'
  | 'select-word'
  | 'select-styled'
  | 'delete-line'
  // Paragraph
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'heading-4'
  | 'heading-5'
  | 'heading-6'
  | 'paragraph'
  | 'heading-up'
  | 'heading-down'
  | 'table'
  | 'code-fence'
  | 'math-block'
  | 'quote'
  | 'ordered-list'
  | 'bullet-list'
  | 'task-list'
  | 'hr'
  | 'front-matter'
  // Paragraph › Table
  | 'table-row-above'
  | 'table-row-below'
  | 'table-col-left'
  | 'table-col-right'
  | 'table-row-up'
  | 'table-row-down'
  | 'table-col-move-left'
  | 'table-col-move-right'
  | 'table-delete-row'
  | 'table-delete-col'
  | 'table-delete'
  | 'table-align-left'
  | 'table-align-center'
  | 'table-align-right'
  // Format
  | 'strong'
  | 'emphasis'
  | 'inline-code'
  | 'strike'
  | 'underline'
  | 'link'
  | 'image'
  | 'upload-images'
  | 'clear-format'
  // View
  | 'toggle-source'
  | 'toggle-sidebar'
  | 'view-outline'
  | 'view-articles'
  | 'view-tree'
  | 'view-search'
  | 'toggle-focus'
  | 'toggle-typewriter'
  | 'toggle-statusbar'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  // Themes
  | `theme-${ThemeId}`
  | 'open-theme-folder'
  // Help
  | 'quick-start'

/** Renderer state mirrored into native menu checkmarks. */
export interface MenuState {
  source: boolean
  sidebar: boolean
  sidebarView: SidebarView
  focus: boolean
  typewriter: boolean
  statusBar: boolean
  theme: ThemeId
  hasFile: boolean
  /** The theme's page color, so the native window never flashes another color. */
  background: string
  /** A dark theme: native parts of the window (traffic lights, menus, dialogs) go dark too. */
  dark: boolean
}

export interface MTyporaApi {
  platform: string
  openFileDialog(): Promise<OpenedFile | null>
  openFolderDialog(): Promise<{ root: string; tree: TreeNode[] } | null>
  readFile(path: string): Promise<OpenedFile>
  readFolder(root: string): Promise<TreeNode[]>
  searchFolder(root: string, query: string): Promise<SearchHit[]>
  saveFile(path: string | null, content: string, options?: SaveOptions): Promise<SaveResult>
  renameFile(path: string, newName: string): Promise<string>
  /** Copies a pasted/dropped image next to the document and returns its relative path. */
  saveAsset(docPath: string, fileName: string, data: ArrayBuffer): Promise<string>
  /** Uploads images with PicGo or a custom command; resolves to one URL per image. */
  uploadImages(files: UploadFile[], config: UploadConfig): Promise<string[]>
  /** The path of a file dropped or pasted from the file manager ('' for in-memory data). */
  pathForFile(file: File): string
  exportHtml(suggestedName: string, html: string, options: HtmlExportOptions): Promise<string | null>
  /** Prints the standalone `html` page (see export.ts) to a PDF file. */
  exportPdf(suggestedName: string, html: string, options: PdfExportOptions): Promise<string | null>
  listThemes(): Promise<CustomTheme[]>
  openThemeFolder(): void
  print(): void
  revealInFinder(path: string): void
  openExternal(url: string): void
  setTitle(title: string, edited: boolean, path: string | null): void
  confirmDiscard(name: string): Promise<'save' | 'discard' | 'cancel'>
  showContextMenu(hasSelection: boolean, inTable: boolean): void
  showTitleMenu(hasFile: boolean): void
  syncMenu(state: MenuState): void
  onMenu(handler: (command: MenuCommand) => void): void
  onOpenPath(handler: (path: string) => void): void
  /** `autoSaveOnClose`: closing the window saves instead of asking. */
  setDirty(dirty: boolean, autoSaveOnClose: boolean): void
  closeWindow(): void
  /** Focuses another window that already shows `path`; false when there is none. */
  focusOpenWindow(path: string): Promise<boolean>
  onFileChanged(handler: (path: string, change: ExternalChange) => void): void
  watchFolder(root: string | null): void
  onFolderChanged(handler: () => void): void
  saveDraft(path: string | null, content: string): void
  clearDraft(): void
  onDraftRestore(handler: (draft: DraftRestore) => void): void
  listHistory(path: string): Promise<HistoryEntry[]>
  readHistory(path: string, id: string): Promise<string>
  revealHistory(path: string, id: string): void
}
