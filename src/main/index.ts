import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { buildMenu, contextMenu, syncMenu, titleMenu } from './menu'
import { readTree, searchFolder } from './files'
import type { MenuCommand, MenuState } from '../shared/api'

const MARKDOWN_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'txt'] },
  { name: 'All Files', extensions: ['*'] }
]

// Smoke-test mode: render once, capture a screenshot, then quit.
const SMOKE_OUTPUT = process.env.M_TYPORA_SMOKE
const SMOKE_FILE = process.env.M_TYPORA_SMOKE_FILE
const SMOKE_FOLDER = process.env.M_TYPORA_SMOKE_FOLDER
/** e.g. "1411x923" — lets screenshots be compared pixel-for-pixel with a reference. */
const SMOKE_SIZE = /^(\d+)x(\d+)$/.exec(process.env.M_TYPORA_SMOKE_SIZE ?? '')

const dirtyWindows = new WeakSet<BrowserWindow>()
const menuStates = new WeakMap<BrowserWindow, MenuState>()
const pendingOpenPaths: string[] = []

function createWindow(initialPath?: string): BrowserWindow {
  const win = new BrowserWindow({
    width: SMOKE_SIZE ? Number(SMOKE_SIZE[1]) : 1180,
    height: SMOKE_SIZE ? Number(SMOKE_SIZE[2]) : 800,
    minWidth: 480,
    minHeight: 360,
    show: false,
    backgroundColor: '#ffffff',
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: { x: 10, y: 8 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => {
    if (!SMOKE_OUTPUT) win.show()
  })

  win.on('focus', () => {
    const state = menuStates.get(win)
    if (state) syncMenu(state)
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
  })

  win.webContents.on('did-finish-load', () => {
    const path = initialPath ?? SMOKE_FILE
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
    const result = await dialog.showOpenDialog(senderWindow(event), {
      properties: ['openFile'],
      filters: MARKDOWN_FILTERS
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const path = result.filePaths[0]
    app.addRecentDocument(path)
    return { path, content: await readFile(path, 'utf8') }
  })

  ipcMain.handle('dialog:open-folder', async (event) => {
    const result = await dialog.showOpenDialog(senderWindow(event), {
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const root = result.filePaths[0]
    return { root, tree: await readTree(root) }
  })

  ipcMain.handle('fs:read-file', async (_event, path: string) => {
    app.addRecentDocument(path)
    return { path, content: await readFile(path, 'utf8') }
  })

  ipcMain.handle('fs:read-folder', (_event, root: string) => readTree(root))

  ipcMain.handle('fs:search', (_event, root: string, query: string) => searchFolder(root, query))

  ipcMain.handle('fs:save-file', async (event, path: string | null, content: string) => {
    let target = path
    if (!target) {
      const result = await dialog.showSaveDialog(senderWindow(event), {
        defaultPath: '未命名.md',
        filters: MARKDOWN_FILTERS
      })
      if (result.canceled || !result.filePath) return null
      target = result.filePath
    }
    await writeFile(target, content, 'utf8')
    app.addRecentDocument(target)
    return target
  })

  ipcMain.handle('fs:rename', async (_event, path: string, newName: string) => {
    const name = basename(newName.trim())
    if (!name) throw new Error('文件名不能为空')
    const target = join(dirname(path), extname(name) ? name : `${name}${extname(path) || '.md'}`)
    if (target === path) return path
    if (existsSync(target)) throw new Error(`“${basename(target)}”已存在`)
    await rename(path, target)
    return target
  })

  ipcMain.handle('fs:save-asset', async (_event, docPath: string, fileName: string, data: ArrayBuffer) => {
    const assetsDir = join(dirname(docPath), 'assets')
    await mkdir(assetsDir, { recursive: true })
    const safeName = `${Date.now()}-${basename(fileName).replace(/[^\w.-]+/g, '_')}`
    await writeFile(join(assetsDir, safeName), Buffer.from(data))
    return `assets/${safeName}`
  })

  ipcMain.handle('export:html', async (event, suggestedName: string, html: string) => {
    const result = await dialog.showSaveDialog(senderWindow(event), {
      defaultPath: `${suggestedName}.html`,
      filters: [{ name: 'HTML', extensions: ['html'] }]
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, html, 'utf8')
    return result.filePath
  })

  ipcMain.handle('export:pdf', async (event, suggestedName: string) => {
    const win = senderWindow(event)
    const result = await dialog.showSaveDialog(win, {
      defaultPath: `${suggestedName}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (result.canceled || !result.filePath) return null
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.7, bottom: 0.7, left: 0.7, right: 0.7 }
    })
    await writeFile(result.filePath, pdf)
    return result.filePath
  })

  ipcMain.on('print', (event) => senderWindow(event).webContents.print({ printBackground: true }))

  ipcMain.on('shell:reveal', (_event, path: string) => shell.showItemInFolder(path))

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

  ipcMain.on('menu:context', (event, hasSelection: boolean) => {
    const win = senderWindow(event)
    contextMenu((command) => sendMenu(command, win), hasSelection).popup({ window: win })
  })

  ipcMain.on('menu:title', (event, hasFile: boolean) => {
    const win = senderWindow(event)
    titleMenu((command) => sendMenu(command, win), hasFile).popup({ window: win })
  })

  ipcMain.on('menu:sync', (event, state: MenuState) => {
    const win = senderWindow(event)
    menuStates.set(win, state)
    if (BrowserWindow.getFocusedWindow() === win || BrowserWindow.getAllWindows().length === 1) syncMenu(state)
  })

  ipcMain.on('window:set-title', (event, title: string, edited: boolean, path: string | null) => {
    const win = senderWindow(event)
    win.setTitle(title)
    if (process.platform === 'darwin') {
      win.setDocumentEdited(edited)
      win.setRepresentedFilename(path ?? '')
    }
  })

  ipcMain.on('window:set-dirty', (event, dirty: boolean) => {
    const win = senderWindow(event)
    if (dirty) dirtyWindows.add(win)
    else dirtyWindows.delete(win)
  })

  ipcMain.on('window:close', (event) => {
    const win = senderWindow(event)
    dirtyWindows.delete(win)
    win.close()
  })
}

// macOS delivers files opened from Finder through this event, possibly before ready.
app.on('open-file', (event, path) => {
  event.preventDefault()
  if (app.isReady()) createWindow(path)
  else pendingOpenPaths.push(path)
})

app.whenReady().then(() => {
  app.setName('m-typora')
  app.setAboutPanelOptions({ applicationName: 'm-typora', applicationVersion: app.getVersion() })
  registerIpc()
  buildMenu({ newWindow: () => createWindow(), send: sendMenu })

  const argvPath = process.argv.slice(app.isPackaged ? 1 : 2).find((arg) => /\.(md|markdown|txt)$/i.test(arg))
  const initial = pendingOpenPaths.length > 0 ? pendingOpenPaths : argvPath ? [argvPath] : [undefined]
  for (const path of initial) createWindow(path)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || SMOKE_OUTPUT) app.quit()
})
