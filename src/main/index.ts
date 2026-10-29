import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { hashText, resolveTarget, writeFileAtomic } from './atomic'
import { deleteDraft, leftoverDrafts, readDraft, writeDraft, type Draft } from './drafts'
import { buildMenu, contextMenu, setCustomThemes, syncMenu, titleMenu } from './menu'
import { readTree, searchFolder } from './files'
import { exportHtml, exportPdf } from './export'
import { historyFile, listHistory, moveHistory, pruneHistory, readHistory, snapshot } from './history'
import { uploadImages } from './images'
import { ensureThemesDir, listCustomThemes } from './themes'
import { DocumentTracker } from './tracker'
import type { HtmlExportOptions, MenuCommand, MenuState, PdfExportOptions, SaveOptions, SaveResult, UploadConfig, UploadFile } from '../shared/api'

const MARKDOWN_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'txt'] },
  { name: 'All Files', extensions: ['*'] }
]

// Smoke-test mode: render once, capture a screenshot, then quit.
const SMOKE_OUTPUT = process.env.M_TYPORA_SMOKE
const SMOKE_FILE = process.env.M_TYPORA_SMOKE_FILE
const SMOKE_FOLDER = process.env.M_TYPORA_SMOKE_FOLDER
/** Automated tests drive the app over the inspector without showing a window. */
const HEADLESS = Boolean(SMOKE_OUTPUT || process.env.M_TYPORA_HEADLESS)
/** End-to-end tests: show the window without taking focus from the user's other apps. */
const E2E = Boolean(process.env.M_TYPORA_E2E)

// Tests run with their own profile so they never touch the user's preferences.
if (process.env.M_TYPORA_USER_DATA) app.setPath('userData', process.env.M_TYPORA_USER_DATA)
/** e.g. "1411x923" — lets screenshots be compared pixel-for-pixel with a reference. */
const SMOKE_SIZE = /^(\d+)x(\d+)$/.exec(process.env.M_TYPORA_SMOKE_SIZE ?? '')

const dirtyWindows = new WeakSet<BrowserWindow>()
/** Dirty windows with auto-save on: closing them saves instead of asking. */
const autoSaveWindows = new WeakSet<BrowserWindow>()
const menuStates = new WeakMap<BrowserWindow, MenuState>()
const pendingOpenPaths: string[] = []
/** Set while the app quits, so a window that saves before closing lets the quit continue. */
let quitting = false

interface WindowState {
  tracker: DocumentTracker
  /** Names this window's crash-recovery draft in userData/drafts. */
  draftId: string
  /** Draft writes and deletes run in order, so a late write never resurrects a cleared draft. */
  draftQueue: Promise<unknown>
  /** A draft to hand to the page once it has loaded (after a crash). */
  restore: Draft | null
  /** A file to open once the page has loaded. */
  path?: string
}

const windowStates = new WeakMap<BrowserWindow, WindowState>()

function stateOf(win: BrowserWindow): WindowState {
  const state = windowStates.get(win)
  if (!state) throw new Error('No state for window')
  return state
}

/** The window (other than `except`) whose document is `path`. */
function windowShowing(path: string, except?: BrowserWindow): BrowserWindow | undefined {
  const wanted = resolve(path)
  return BrowserWindow.getAllWindows().find((win) => {
    const current = win !== except && windowStates.get(win)?.tracker.currentPath()
    return current ? resolve(current) === wanted : false
  })
}

function focusWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** Opens a file from Finder / Explorer / the command line, reusing a window that already shows it. */
function openInWindow(path: string): void {
  const existing = windowShowing(path)
  if (existing) focusWindow(existing)
  else createWindow({ path })
}

/**
 * The window's native parts follow the theme rather than the system appearance. With the
 * system in dark mode, macOS draws the traffic lights for a dark title bar (no outline, a
 * bright rim) and on a light theme they look squashed; menus and dialogs would not match either.
 */
function applyAppState(state: MenuState): void {
  syncMenu(state)
  const appearance = state.dark ? 'dark' : 'light'
  if (nativeTheme.themeSource !== appearance) nativeTheme.themeSource = appearance
}

function createWindow(options: { path?: string; draftId?: string; draft?: Draft } = {}): BrowserWindow {
  const win = new BrowserWindow({
    width: SMOKE_SIZE ? Number(SMOKE_SIZE[1]) : 1180,
    height: SMOKE_SIZE ? Number(SMOKE_SIZE[2]) : 800,
    minWidth: 480,
    minHeight: 360,
    show: false,
    backgroundColor: '#ffffff',
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // Tests keep running at full speed while the user works in other windows.
      backgroundThrottling: !E2E
    }
  })

  const send = (channel: string, ...args: unknown[]) => {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
  const state: WindowState = {
    tracker: new DocumentTracker({
      fileChanged: (path, change) => send('doc:changed', path, change),
      folderChanged: () => send('folder:changed')
    }),
    draftId: options.draftId ?? randomUUID(),
    draftQueue: Promise.resolve(),
    restore: options.draft ?? null,
    path: options.path
  }
  windowStates.set(win, state)

  win.once('ready-to-show', () => {
    if (E2E) win.showInactive()
    else if (!HEADLESS) win.show()
  })

  win.on('focus', () => {
    const state = menuStates.get(win)
    if (state) applyAppState(state)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Links clicked inside the document must never navigate the editor away.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault()
      if (/^https?:/i.test(url)) shell.openExternal(url)
    }
  })

  win.on('close', (event) => {
    if (!dirtyWindows.has(win)) return
    event.preventDefault()
    if (autoSaveWindows.has(win)) return sendMenu('save-and-close', win)
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['保存', '不保存', '取消'],
      defaultId: 0,
      cancelId: 2,
      message: '是否保存对当前文档的修改？',
      detail: '如果不保存，你的修改将会丢失。'
    })
    if (choice === 0) sendMenu('save-and-close', win)
    if (choice === 1) {
      dirtyWindows.delete(win)
      win.destroy()
    }
    if (choice === 2) quitting = false
  })

  // A window that closes normally has nothing left to recover.
  win.on('closed', () => {
    state.tracker.dispose()
    state.draftQueue = state.draftQueue.then(() => deleteDraft(state.draftId))
  })

  // The page crashed: reload it and hand it back its unsaved text.
  win.webContents.on('render-process-gone', async (_event, details) => {
    if (details.reason === 'clean-exit' || win.isDestroyed()) return
    await state.draftQueue
    state.restore = await readDraft(state.draftId)
    state.path = state.restore ? undefined : (state.tracker.currentPath() ?? undefined)
    state.tracker.forget()
    dirtyWindows.delete(win)
    if (!win.isDestroyed()) win.reload()
  })

  win.webContents.on('did-finish-load', () => {
    if (state.restore) void restoreDraft(win, state)
    const path = state.path ?? SMOKE_FILE
    state.path = undefined
    if (path) win.webContents.send('open-path', path)
    if (SMOKE_FOLDER) win.webContents.send('open-path', SMOKE_FOLDER)
    if (SMOKE_OUTPUT) captureAndQuit(win, SMOKE_OUTPUT)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

async function restoreDraft(win: BrowserWindow, state: WindowState): Promise<void> {
  const draft = state.restore
  state.restore = null
  if (!draft) return
  let diskChanged = false
  if (draft.path && draft.baseHash) {
    const disk = await readFile(draft.path, 'utf8').catch(() => null)
    diskChanged = disk !== null && hashText(disk) !== draft.baseHash
  }
  if (!win.isDestroyed()) win.webContents.send('draft:restore', { path: draft.path, content: draft.content, diskChanged })
}

function captureAndQuit(win: BrowserWindow, output: string): void {
  setTimeout(async () => {
    const image = await win.webContents.capturePage()
    await writeFile(output, image.toPNG())
    console.log(`[smoke] screenshot written to ${output}`)
    app.exit(0)
  }, 3500)
}

function sendMenu(command: MenuCommand, win?: BrowserWindow | null): void {
  ;(win ?? BrowserWindow.getFocusedWindow())?.webContents.send('menu', command)
}

function senderWindow(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) throw new Error('No window for IPC sender')
  return win
}

function registerIpc(): void {
  ipcMain.handle('dialog:open-file', async (event) => {
    const win = senderWindow(event)
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: MARKDOWN_FILTERS
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const path = result.filePaths[0]
    const existing = windowShowing(path, win)
    if (existing) {
      focusWindow(existing)
      return null
    }
    app.addRecentDocument(path)
    const content = await readFile(path, 'utf8')
    stateOf(win).tracker.setKnown(path, content)
    return { path, content }
  })

  ipcMain.handle('dialog:open-folder', async (event) => {
    const result = await dialog.showOpenDialog(senderWindow(event), {
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const root = result.filePaths[0]
    return { root, tree: await readTree(root) }
  })

  // Reading a file makes it the window's document: its text is what later saves compare against.
  ipcMain.handle('fs:read-file', async (event, path: string) => {
    const content = await readFile(path, 'utf8')
    stateOf(senderWindow(event)).tracker.setKnown(path, content)
    app.addRecentDocument(path)
    return { path, content }
  })

  ipcMain.handle('fs:read-folder', (_event, root: string) => readTree(root))

  ipcMain.handle('fs:search', (_event, root: string, query: string) => searchFolder(root, query))

  ipcMain.handle('fs:save-file', async (event, path: string | null, content: string, options: SaveOptions = {}): Promise<SaveResult> => {
    const win = senderWindow(event)
    const { tracker } = stateOf(win)
    let target = path
    if (!target) {
      const result = await dialog.showSaveDialog(win, {
        defaultPath: options.suggestedPath ?? '未命名.md',
        filters: MARKDOWN_FILTERS
      })
      if (result.canceled || !result.filePath) return null
      target = result.filePath
    }
    const disk = await readFile(target, 'utf8').catch(() => null)
    if (disk !== null) {
      // Text this window never saw came from somewhere else (a sync client, git, another editor):
      // never overwrite it unless the user chose to. A save dialog has already asked.
      const fromOutside = tracker.changedOnDisk(target, disk)
      if (fromOutside && path && !options.force) return { conflict: true }
      if (disk !== content) await snapshot(target, disk, fromOutside).catch((error) => console.error('history snapshot failed', error))
    }
    await writeFileAtomic(target, content)
    tracker.setKnown(target, content)
    app.addRecentDocument(target)
    return { path: target }
  })

  ipcMain.handle('fs:rename', async (event, path: string, newName: string) => {
    const name = basename(newName.trim())
    if (!name) throw new Error('文件名不能为空')
    const target = join(dirname(path), extname(name) ? name : `${name}${extname(path) || '.md'}`)
    if (target === path) return path
    if (existsSync(target)) throw new Error(`“${basename(target)}”已存在`)
    const realPath = await resolveTarget(path)
    await rename(path, target)
    const { tracker } = stateOf(senderWindow(event))
    if (tracker.currentPath() === path) tracker.moved(target)
    await moveHistory(realPath, target).catch((error) => console.error('moving history failed', error))
    return target
  })

  ipcMain.handle('fs:save-asset', async (_event, docPath: string, fileName: string, data: ArrayBuffer) => {
    const assetsDir = join(dirname(docPath), 'assets')
    await mkdir(assetsDir, { recursive: true })
    const safeName = `${Date.now()}-${basename(fileName).replace(/[^\w.-]+/g, '_')}`
    await writeFile(join(assetsDir, safeName), Buffer.from(data))
    return `assets/${safeName}`
  })

  ipcMain.handle('image:upload', (_event, files: UploadFile[], config: UploadConfig) => uploadImages(files, config))

  ipcMain.handle('export:html', (event, name: string, html: string, options: HtmlExportOptions) =>
    exportHtml(senderWindow(event), name, html, options)
  )

  ipcMain.handle('export:pdf', (event, name: string, html: string, options: PdfExportOptions) =>
    exportPdf(senderWindow(event), name, html, options)
  )

  ipcMain.handle('themes:list', async () => {
    const themes = await listCustomThemes()
    setCustomThemes(themes)
    return themes
  })

  ipcMain.on('themes:open-folder', async () => {
    void shell.openPath(await ensureThemesDir())
  })

  ipcMain.on('print', (event) => senderWindow(event).webContents.print({ printBackground: true }))

  ipcMain.on('shell:reveal', (_event, path: string) => shell.showItemInFolder(path))

  ipcMain.handle('history:list', (_event, path: string) => listHistory(path))
  ipcMain.handle('history:read', (_event, path: string, id: string) => readHistory(path, id))
  ipcMain.on('history:reveal', async (_event, path: string, id: string) => shell.showItemInFolder(await historyFile(path, id)))

  ipcMain.on('folder:watch', (event, root: string | null) => stateOf(senderWindow(event)).tracker.watchFolder(root))

  ipcMain.on('draft:save', (event, path: string | null, content: string) => {
    const state = stateOf(senderWindow(event))
    const baseHash = path && state.tracker.currentPath() === path ? state.tracker.knownHash() : null
    const draft: Draft = { path, content, baseHash, savedAt: Date.now() }
    state.draftQueue = state.draftQueue.then(() => writeDraft(state.draftId, draft)).catch((error) => console.error('draft write failed', error))
  })

  ipcMain.on('draft:clear', (event) => {
    const state = stateOf(senderWindow(event))
    state.draftQueue = state.draftQueue.then(() => deleteDraft(state.draftId))
  })

  ipcMain.handle('window:focus-open', (event, path: string) => {
    const existing = windowShowing(path, senderWindow(event))
    if (existing) focusWindow(existing)
    return Boolean(existing)
  })

  ipcMain.on('shell:open-external', (_event, url: string) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url)
  })

  ipcMain.handle('dialog:confirm-discard', async (event, name: string) => {
    const { response } = await dialog.showMessageBox(senderWindow(event), {
      type: 'warning',
      buttons: ['保存', '不保存', '取消'],
      defaultId: 0,
      cancelId: 2,
      message: `是否保存对“${name}”的修改？`
    })
    return (['save', 'discard', 'cancel'] as const)[response]
  })

  ipcMain.on('menu:context', (event, hasSelection: boolean, inTable: boolean) => {
    const win = senderWindow(event)
    contextMenu((command) => sendMenu(command, win), hasSelection, inTable).popup({ window: win })
  })

  ipcMain.on('menu:title', (event, hasFile: boolean) => {
    const win = senderWindow(event)
    titleMenu((command) => sendMenu(command, win), hasFile).popup({ window: win })
  })

  ipcMain.on('menu:sync', (event, state: MenuState) => {
    const win = senderWindow(event)
    menuStates.set(win, state)
    // Match the window background to the theme so resizing never flashes white.
    if (state.background) win.setBackgroundColor(state.background)
    if (BrowserWindow.getFocusedWindow() === win || BrowserWindow.getAllWindows().length === 1) applyAppState(state)
  })

  ipcMain.on('window:set-title', (event, title: string, edited: boolean, path: string | null) => {
    const win = senderWindow(event)
    // An untitled document: stop watching the file shown before.
    if (!path) stateOf(win).tracker.forget()
    if (process.platform === 'darwin') {
      win.setTitle(title)
      win.setDocumentEdited(edited)
      win.setRepresentedFilename(path ?? '')
    } else {
      // The native title bar is the only title on Windows / Linux, so it carries the edited mark.
      win.setTitle(`${edited ? '• ' : ''}${title} - m-typora`)
    }
  })

  ipcMain.on('window:set-dirty', (event, dirty: boolean, autoSaveOnClose: boolean) => {
    const win = senderWindow(event)
    if (dirty) dirtyWindows.add(win)
    else dirtyWindows.delete(win)
    if (autoSaveOnClose) autoSaveWindows.add(win)
    else autoSaveWindows.delete(win)
  })

  ipcMain.on('window:close', (event) => {
    const win = senderWindow(event)
    dirtyWindows.delete(win)
    win.close()
    // The window saved before closing as part of quitting: carry on with the quit.
    if (quitting) setImmediate(() => app.quit())
  })
}

const MARKDOWN_ARG = /\.(md|markdown|mdown|txt)$/i

// One instance per profile: on Windows / Linux, opening a file from the file manager starts a
// new process, which hands its files to the running one and exits. The dev server is exempt so
// a development build can run beside the installed app.
const singleInstance = Boolean(process.env.ELECTRON_RENDERER_URL) || app.requestSingleInstanceLock()
if (!singleInstance) app.quit()

app.on('second-instance', (_event, argv, cwd) => {
  const paths = argv.slice(1).filter((arg) => MARKDOWN_ARG.test(arg)).map((arg) => resolve(cwd, arg))
  for (const path of paths) openInWindow(path)
  if (paths.length > 0) return
  const win = BrowserWindow.getAllWindows()[0]
  if (win) focusWindow(win)
  else createWindow()
})

app.on('before-quit', () => {
  quitting = true
})

// macOS delivers files opened from Finder through this event, possibly before ready.
app.on('open-file', (event, path) => {
  event.preventDefault()
  if (app.isReady()) openInWindow(path)
  else pendingOpenPaths.push(path)
})

app.whenReady().then(async () => {
  if (!singleInstance) return
  app.setName('m-typora')
  app.setAboutPanelOptions({ applicationName: 'm-typora', applicationVersion: app.getVersion() })
  registerIpc()
  buildMenu({ newWindow: () => createWindow(), send: sendMenu }, await listCustomThemes().catch(() => []))

  // Windows that did not close normally last time come back with their unsaved text.
  const drafts = SMOKE_OUTPUT ? [] : await leftoverDrafts()
  for (const { id, draft } of drafts) createWindow({ draftId: id, draft })

  const argvPath = process.argv.slice(app.isPackaged ? 1 : 2).find((arg) => MARKDOWN_ARG.test(arg))
  const recovered = new Set(drafts.map(({ draft }) => draft.path && resolve(draft.path)))
  const paths = (pendingOpenPaths.length > 0 ? pendingOpenPaths : argvPath ? [argvPath] : []).filter((path) => !recovered.has(resolve(path)))
  for (const path of paths) createWindow({ path })
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
  void pruneHistory().catch((error) => console.error('pruning history failed', error))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || SMOKE_OUTPUT) app.quit()
})
