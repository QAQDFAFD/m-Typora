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

export interface SearchHit {
  path: string
  line: number
  text: string
}

export const THEMES = [
  { id: 'github', label: 'Github' },
  { id: 'newsprint', label: 'Newsprint' },
  { id: 'night', label: 'Night' },
  { id: 'pixyll', label: 'Pixyll' },
  { id: 'whitey', label: 'Whitey' }
] as const

export type ThemeId = (typeof THEMES)[number]['id']

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
  // Format
  | 'strong'
  | 'emphasis'
  | 'inline-code'
  | 'strike'
  | 'link'
  | 'image'
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
}

export interface MTyporaApi {
  platform: string
  openFileDialog(): Promise<OpenedFile | null>
  openFolderDialog(): Promise<{ root: string; tree: TreeNode[] } | null>
  readFile(path: string): Promise<OpenedFile>
  readFolder(root: string): Promise<TreeNode[]>
  searchFolder(root: string, query: string): Promise<SearchHit[]>
  saveFile(path: string | null, content: string): Promise<string | null>
  renameFile(path: string, newName: string): Promise<string>
  /** Copies a pasted/dropped image next to the document and returns its relative path. */
  saveAsset(docPath: string, fileName: string, data: ArrayBuffer): Promise<string>
  exportHtml(suggestedName: string, html: string): Promise<string | null>
  exportPdf(suggestedName: string): Promise<string | null>
  print(): void
  revealInFinder(path: string): void
  openExternal(url: string): void
  setTitle(title: string, edited: boolean, path: string | null): void
  confirmDiscard(name: string): Promise<'save' | 'discard' | 'cancel'>
  showContextMenu(hasSelection: boolean): void
  showTitleMenu(hasFile: boolean): void
  syncMenu(state: MenuState): void
  onMenu(handler: (command: MenuCommand) => void): void
  onOpenPath(handler: (path: string) => void): void
  setDirty(dirty: boolean): void
  closeWindow(): void
}
