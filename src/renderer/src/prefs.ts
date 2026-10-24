import { THEMES, type AfterExport, type PdfMargin, type PdfPageSize, type SidebarView, type ThemeId, type UploadService } from '../../shared/api'

const SIDEBAR_VIEWS: SidebarView[] = ['articles', 'tree', 'outline', 'search']

export type LineWidth = 'default' | 'wide' | 'full'

/** What happens to an image dropped or pasted into a document (Typora's "When Insert…"). */
export type ImageInsert = 'none' | 'assets' | 'upload'

/** Where an image that has a paragraph to itself sits on the line. */
export type ImageAlign = 'left' | 'center' | 'right'

const IMAGE_ALIGNS: ImageAlign[] = ['left', 'center', 'right']
export const DEFAULT_PICGO_PORT = 36677

/** A TCP port, or null for anything else. */
export function validPort(value: unknown): number | null {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

export interface Prefs {
  theme: ThemeId
  sidebar: boolean
  sidebarView: SidebarView
  sidebarWidth: number
  statusBar: boolean
  focus: boolean
  typewriter: boolean
  zoom: number
  fontSize: number
  lineWidth: LineWidth
  autoSave: boolean
  autoPair: boolean
  lastFolder: string | null
  recentFiles: string[]
  imageInsert: ImageInsert
  imageAlign: ImageAlign
  uploadService: UploadService
  picgoPort: number
  picgoPath: string
  uploadCommand: string
  pdfPageSize: PdfPageSize
  pdfMargin: PdfMargin
  htmlEmbedImages: boolean
  afterExport: AfterExport
}

const KEY = 'm-typora:prefs'

const DEFAULTS: Prefs = {
  theme: 'github',
  sidebar: false,
  sidebarView: 'outline',
  sidebarWidth: 270,
  statusBar: true,
  focus: false,
  typewriter: false,
  zoom: 1,
  fontSize: 16,
  lineWidth: 'default',
  autoSave: false,
  autoPair: true,
  lastFolder: null,
  recentFiles: [],
  imageInsert: 'assets',
  imageAlign: 'center',
  uploadService: 'picgo-app',
  picgoPort: DEFAULT_PICGO_PORT,
  picgoPath: '',
  uploadCommand: '',
  pdfPageSize: 'A4',
  pdfMargin: 'default',
  htmlEmbedImages: false,
  afterExport: 'none'
}

export function loadPrefs(): Prefs {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>
    const prefs = { ...DEFAULTS, ...stored }
    // Drop values written by older versions (e.g. removed theme names). Custom themes are
    // checked once the theme folder has been read (App.start).
    if (!prefs.theme.startsWith('custom:') && !THEMES.some((theme) => theme.id === prefs.theme)) prefs.theme = DEFAULTS.theme
    if (!SIDEBAR_VIEWS.includes(prefs.sidebarView)) prefs.sidebarView = DEFAULTS.sidebarView
    if (!Array.isArray(prefs.recentFiles)) prefs.recentFiles = []
    if (!IMAGE_ALIGNS.includes(prefs.imageAlign)) prefs.imageAlign = DEFAULTS.imageAlign
    prefs.picgoPort = validPort(prefs.picgoPort) ?? DEFAULT_PICGO_PORT
    return prefs
  } catch {
    return { ...DEFAULTS }
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    // Preferences are a convenience; ignore storage failures.
  }
}
