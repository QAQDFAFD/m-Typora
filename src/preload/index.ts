import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { MenuCommand, MTyporaApi } from '../shared/api'

const api: MTyporaApi = {
  platform: process.platform,
  openFileDialog: () => ipcRenderer.invoke('dialog:open-file'),
  openFolderDialog: () => ipcRenderer.invoke('dialog:open-folder'),
  readFile: (path) => ipcRenderer.invoke('fs:read-file', path),
  readFolder: (root) => ipcRenderer.invoke('fs:read-folder', root),
  searchFolder: (root, query) => ipcRenderer.invoke('fs:search', root, query),
  saveFile: (path, content) => ipcRenderer.invoke('fs:save-file', path, content),
  renameFile: (path, newName) => ipcRenderer.invoke('fs:rename', path, newName),
  saveAsset: (docPath, fileName, data) => ipcRenderer.invoke('fs:save-asset', docPath, fileName, data),
  uploadImages: (files, config) => ipcRenderer.invoke('image:upload', files, config),
  pathForFile: (file) => webUtils.getPathForFile(file),
  exportHtml: (name, html, options) => ipcRenderer.invoke('export:html', name, html, options),
  exportPdf: (name, html, options) => ipcRenderer.invoke('export:pdf', name, html, options),
  listThemes: () => ipcRenderer.invoke('themes:list'),
  openThemeFolder: () => ipcRenderer.send('themes:open-folder'),
  print: () => ipcRenderer.send('print'),
  revealInFinder: (path) => ipcRenderer.send('shell:reveal', path),
  openExternal: (url) => ipcRenderer.send('shell:open-external', url),
  confirmDiscard: (name) => ipcRenderer.invoke('dialog:confirm-discard', name),
  showContextMenu: (hasSelection, inTable) => ipcRenderer.send('menu:context', hasSelection, inTable),
  showTitleMenu: (hasFile) => ipcRenderer.send('menu:title', hasFile),
  syncMenu: (state) => ipcRenderer.send('menu:sync', state),
  setTitle: (title, edited, path) => ipcRenderer.send('window:set-title', title, edited, path),
  setDirty: (dirty) => ipcRenderer.send('window:set-dirty', dirty),
  closeWindow: () => ipcRenderer.send('window:close'),
  onMenu: (handler) => {
    ipcRenderer.on('menu', (_event, command: MenuCommand) => handler(command))
  },
  onOpenPath: (handler) => {
    ipcRenderer.on('open-path', (_event, path: string) => handler(path))
  }
}

contextBridge.exposeInMainWorld('mtypora', api)
