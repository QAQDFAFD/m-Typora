import type { MenuCommand, MTyporaApi, OpenedFile } from '../../shared/api'

declare global {
  interface Window {
    mtypora?: MTyporaApi
  }
}

/** Picks a file with a plain <input type="file"> (browser fallback). */
function pickFile(): Promise<OpenedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,.markdown,.mdown,.txt,text/markdown,text/plain'
    input.onchange = async () => {
      const file = input.files?.[0]
      resolve(file ? { path: file.name, content: await file.text() } : null)
    }
    input.click()
  })
}

function download(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Browser fallback so the renderer also runs with `npm run dev:web`.
 * Files are opened through a file picker and "saved" as downloads.
 */
function createWebBridge(): MTyporaApi {
  return {
    platform: 'web',
    openFileDialog: pickFile,
    openFolderDialog: async () => {
      alert('浏览器模式不支持打开文件夹，请在桌面版中使用。')
      return null
    },
    readFile: async (path) => {
      throw new Error(`Cannot read ${path} in browser mode`)
    },
    readFolder: async () => [],
    searchFolder: async () => [],
    saveFile: async (path, content) => {
      const name = path?.split('/').pop() || '未命名.md'
      download(name, content, 'text/markdown')
      return name
    },
    renameFile: async (_path, newName) => newName,
    saveAsset: async () => {
      throw new Error('Assets are not supported in browser mode')
    },
    uploadImages: async () => {
      throw new Error('浏览器模式不支持上传图片，请在桌面版中使用。')
    },
    pathForFile: () => '',
    exportHtml: async (name, html) => {
      download(`${name}.html`, html, 'text/html')
      return `${name}.html`
    },
    exportPdf: async () => {
      window.print()
      return null
    },
    listThemes: async () => [],
    openThemeFolder: () => {},
    print: () => window.print(),
    revealInFinder: () => {},
    openExternal: (url) => window.open(url, '_blank', 'noopener'),
    confirmDiscard: async (name) => (confirm(`放弃对“${name}”的修改？`) ? 'discard' : 'cancel'),
    showContextMenu: () => {},
    showTitleMenu: () => {},
    syncMenu: () => {},
    setTitle: (title) => {
      document.title = title
    },
    setDirty: () => {},
    closeWindow: () => window.close(),
    onMenu: (handler: (command: MenuCommand) => void) => {
      window.addEventListener('mtypora-menu', (event) => handler((event as CustomEvent<MenuCommand>).detail))
    },
    onOpenPath: () => {}
  }
}

export const bridge: MTyporaApi = window.mtypora ?? createWebBridge()
export const isDesktop = Boolean(window.mtypora)
