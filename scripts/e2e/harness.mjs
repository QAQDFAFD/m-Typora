// End-to-end harness: launches the built app with its own profile and drives it with real
// Chromium input events (webContents.sendInputEvent) through the main-process inspector.
// Native dialogs, context menus and shell calls are stubbed so tests never block or leave the app.
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const APP = resolve(new URL('../..', import.meta.url).pathname)
const ELECTRON = join(APP, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * `profile` reuses a profile directory (to relaunch after a crash); `prefs` are merged into the
 * stored preferences before the page loads them (the window reloads once).
 */
export async function launch({ port = 9240, size = '1180x800', scale, profile, prefs } = {}) {
  profile ??= await mkdtemp(join(tmpdir(), 'm-typora-e2e-profile-'))
  const args = [`--inspect=${port}`]
  if (scale) args.push(`--force-device-scale-factor=${scale}`)
  args.push(APP)
  // ELECTRON_ENABLE_LOGGING forwards renderer console output, so tests can fail on page errors.
  const env = { ...process.env, M_TYPORA_E2E: '1', M_TYPORA_USER_DATA: profile, M_TYPORA_SMOKE_SIZE: size, ELECTRON_ENABLE_LOGGING: '1' }
  const child = spawn(ELECTRON, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const logs = []
  child.stdout.on('data', (d) => logs.push(String(d)))
  child.stderr.on('data', (d) => logs.push(String(d)))

  let target
  for (let i = 0; i < 120 && !target; i++) {
    await sleep(150)
    target = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).then((l) => l[0]).catch(() => null)
  }
  if (!target) throw new Error('inspector not reachable:\n' + logs.join(''))
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)))
  let id = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg), pending.delete(msg.id)
  }
  const send = (method, params) =>
    new Promise((res) => {
      const n = ++id
      pending.set(n, res)
      ws.send(JSON.stringify({ id: n, method, params }))
    })
  await send('Runtime.enable')

  async function main(body) {
    const expression = `(async () => { const electron = process.mainModule.require('electron'); const all = electron.BrowserWindow.getAllWindows(); const win = all.find((w) => w.webContents.getURL().includes('renderer/index.html')) ?? all[0]; ${body} })()`
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description?.slice(0, 500) ?? 'main eval failed')
    return res.result?.result?.value
  }
  const page = (code) => main(`return win.webContents.executeJavaScript(${JSON.stringify(`(async () => { ${code} })()`)})`)

  const waitForEditor = async () => {
    for (let i = 0; i < 120; i++) {
      if (await page(`return !!document.querySelector('#write .ProseMirror')`).catch(() => false)) break
      await sleep(150)
    }
  }
  await waitForEditor()
  if (prefs) {
    await page(`const key = 'm-typora:prefs'; localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? '{}'), ...${JSON.stringify(prefs)} })); return true`)
    await main('win.webContents.reload(); return true')
    await sleep(300)
    await waitForEditor()
  }

  // Stub native UI so a test can never hang on a modal, and record what would have been shown.
  await main(`
    globalThis.__e2e = { dialogs: [], menus: [], shell: [], answers: { save: null, open: null, message: 1 } }
    const e2e = globalThis.__e2e
    electron.dialog.showSaveDialog = async (_w, o) => (e2e.dialogs.push(['save', o.defaultPath]), e2e.answers.save ? { canceled: false, filePath: e2e.answers.save } : { canceled: true })
    electron.dialog.showOpenDialog = async (_w, o) => (e2e.dialogs.push(['open', o.properties]), e2e.answers.open ? { canceled: false, filePaths: [e2e.answers.open] } : { canceled: true, filePaths: [] })
    electron.dialog.showMessageBox = async (_w, o) => (e2e.dialogs.push(['message', o.message]), { response: e2e.answers.message })
    electron.dialog.showMessageBoxSync = (_w, o) => (e2e.dialogs.push(['messageSync', o.message]), e2e.answers.message)
    electron.shell.openExternal = async (url) => { e2e.shell.push(['openExternal', url]) }
    electron.shell.showItemInFolder = (p) => { e2e.shell.push(['showItemInFolder', p]) }
    electron.Menu.prototype.popup = function () { e2e.menus.push(this) }
    // The window is shown without activating the app; act as focused even when the user
    // switches to another app mid-run (focus events, :focus, clipboard access).
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    win.webContents.focus()
    return true`)

  const input = (event) => main(`win.webContents.sendInputEvent(${JSON.stringify(event)}); return true`)

  const api = {
    logs,
    profile,
    main,
    page,
    /** Clicks at window coordinates (CSS px) with a real mouse down/up. */
    async clickAt(x, y, { button = 'left', clickCount = 1, modifiers = [] } = {}) {
      await input({ type: 'mouseMove', x, y, modifiers })
      await input({ type: 'mouseDown', x, y, button, clickCount, modifiers })
      await input({ type: 'mouseUp', x, y, button, clickCount, modifiers })
      await sleep(120)
    },
    /** Center of the first element matching `selector` (optionally containing `text`). */
    async rect(selector, text) {
      return page(`
        const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
        const el = ${text === undefined ? 'els[0]' : `els.find((e) => e.textContent.includes(${JSON.stringify(text)}))`}
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }`)
    },
    async click(selector, text, options) {
      const r = await api.rect(selector, text)
      if (!r) throw new Error(`click: no element ${selector} ${text ?? ''}`)
      await api.clickAt(r.x, r.y, options)
      return r
    },
    /** Clicks right after `offset` characters into the first text that contains `needle`. */
    async clickText(needle, offset = 0, scope = '#write') {
      const p = await page(`
        const walker = document.createTreeWalker(document.querySelector(${JSON.stringify(scope)}), NodeFilter.SHOW_TEXT)
        let node
        while ((node = walker.nextNode()) && !node.textContent.includes(${JSON.stringify(needle)})) {}
        if (!node) return null
        const i = node.textContent.indexOf(${JSON.stringify(needle)}) + ${offset}
        const range = document.createRange(); range.setStart(node, i); range.setEnd(node, Math.min(i + 1, node.textContent.length))
        const r = range.getBoundingClientRect()
        node.parentElement.scrollIntoView({ block: 'center' })
        const r2 = range.getBoundingClientRect()
        return { x: r2.left + 0.5, y: r2.top + r2.height / 2 }`)
      if (!p) throw new Error(`clickText: no text ${needle}`)
      await api.clickAt(p.x, p.y)
    },
    /** Types text with real key events at ~40 characters per second (newlines press Enter). */
    async type(text, delay = 25) {
      for (const ch of text) {
        if (ch === '\n') await api.key('Enter')
        else await input({ type: 'char', keyCode: ch })
        await sleep(delay)
      }
      await sleep(60)
    },
    /** Presses a key, e.g. key('Enter'), key('B', ['meta']), key('Backspace', ['meta', 'shift']). */
    async key(keyCode, modifiers = []) {
      // On macOS ⌘A / ⌘C / ⌘V / ⌘X come from the Edit menu, which sendInputEvent bypasses.
      const editRole = modifiers.length === 1 && modifiers[0] === 'meta' && { A: 'selectAll', C: 'copy', V: 'paste', X: 'cut' }[keyCode]
      if (editRole) {
        await main(`win.webContents.${editRole}(); return true`)
        await sleep(80)
        return
      }
      await input({ type: 'keyDown', keyCode, modifiers })
      if (keyCode.length === 1 && modifiers.every((m) => m === 'shift')) await input({ type: 'char', keyCode, modifiers })
      // Text areas insert their newline from the character event that follows Enter.
      if (keyCode === 'Enter' && modifiers.length === 0 && (await page(`return document.activeElement?.tagName === 'TEXTAREA'`))) {
        await input({ type: 'char', keyCode: '\r' })
      }
      await input({ type: 'keyUp', keyCode, modifiers })
      await sleep(60)
    },
    /** Input-method composition (e.g. pinyin "zhong" → "中") through the DevTools protocol. */
    async ime(composing, commit) {
      await main(`
        const dbg = win.webContents.debugger
        if (!dbg.isAttached()) dbg.attach('1.3')
        for (let i = 1; i <= ${JSON.stringify(composing)}.length; i++) {
          const t = ${JSON.stringify(composing)}.slice(0, i)
          await dbg.sendCommand('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length })
        }
        await dbg.sendCommand('Input.insertText', { text: ${JSON.stringify(commit)} })
        return true`).catch((e) => { throw new Error('ime: ' + e.message) })
      await sleep(150)
    },
    /** Presses at one point, moves, and releases at another (drag). */
    async drag(from, to) {
      await input({ type: 'mouseMove', x: from.x, y: from.y })
      await input({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 })
      for (let i = 1; i <= 5; i++) {
        // The held button must be in the modifiers, or Chromium treats it as a hover (no text selection).
        await input({ type: 'mouseMove', x: from.x + ((to.x - from.x) * i) / 5, y: from.y + ((to.y - from.y) * i) / 5, button: 'left', modifiers: ['leftButtonDown'] })
        await sleep(20)
      }
      await input({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 })
      await sleep(150)
    },
    /** Sends a menu command exactly as the native menu does. */
    async menu(command) {
      await main(`win.webContents.send('menu', ${JSON.stringify(command)}); return true`)
      await sleep(250)
    },
    async clickMenuItem(id) {
      await main(`const item = electron.Menu.getApplicationMenu().getMenuItemById(${JSON.stringify(id)}); if (item.type === 'radio' || item.type === 'checkbox') item.checked = item.type === 'radio' ? true : !item.checked; item.click(undefined, win); return true`)
      await sleep(250)
    },
    menuChecked: (id) => main(`return electron.Menu.getApplicationMenu().getMenuItemById(${JSON.stringify(id)})?.checked ?? null`),
    /** Labels of the last popped-up native (context / title) menu. */
    lastPopupLabels: () =>
      main(`const m = globalThis.__e2e.menus.at(-1); if (!m) return null; const walk = (menu) => menu.items.map((i) => i.type === 'separator' ? '-' : i.submenu ? { [i.label]: walk(i.submenu) } : i.label); return walk(m)`),
    async clickPopupItem(path) {
      await main(`let menu = globalThis.__e2e.menus.at(-1); const path = ${JSON.stringify(path)}; let item
        for (const label of path) { item = menu.items.find((i) => i.label === label); menu = item?.submenu }
        if (!item) throw new Error('no popup item ' + path.join(' > ')); item.click(undefined, win); return true`)
      await sleep(250)
    },
    e2e: () => main(`return { dialogs: globalThis.__e2e.dialogs, shell: globalThis.__e2e.shell }`),
    answer: (kind, value) => main(`globalThis.__e2e.answers[${JSON.stringify(kind)}] = ${JSON.stringify(value)}; return true`),
    /** Opens a file the way Finder does. */
    async open(path) {
      await main(`win.webContents.send('open-path', ${JSON.stringify(path)}); return true`)
      await sleep(500)
    },
    readFile: (path) => main(`return process.mainModule.require('node:fs').readFileSync(${JSON.stringify(path)}, 'utf8')`),
    screenshot: async (path) => {
      const b64 = await main(`const img = await win.webContents.capturePage(); return img.toPNG().toString('base64')`)
      await writeFile(path, Buffer.from(b64, 'base64'))
      return path
    },
    close: async () => {
      await main('electron.app.exit(0)').catch(() => {})
      ws.close()
      child.kill()
    },
    /** Ends the process without any of the app's own shutdown work, like a crash or power loss. */
    kill: async () => {
      ws.close()
      child.kill('SIGKILL')
      await new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve)))
    }
  }
  return api
}
