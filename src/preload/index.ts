import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DraftRestore, ExternalChange, MenuCommand, MTyporaApi } from '../shared/api'

const api: MTyporaApi = {
  platform: process.platform,
  openFileDialog: () => ipcRenderer.invoke('dialog:open-file'),
  openFolderDialog: () => ipcRenderer.invoke('dialog:open-folder'),
  readFile: (path) => ipcRenderer.invoke('fs:read-file', path),
  readFolder: (root) => ipcRenderer.invoke('fs:read-folder', root),
  searchFolder: (root, query) => ipcRenderer.invoke('fs:search', root, query),
  saveFile: (path, content, options) => ipcRenderer.invoke('fs:save-file', path, content, options ?? {}),
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
  setDirty: (dirty, autoSaveOnClose) => ipcRenderer.send('window:set-dirty', dirty, autoSaveOnClose),
  closeWindow: () => ipcRenderer.send('window:close'),
  focusOpenWindow: (path) => ipcRenderer.invoke('window:focus-open', path),
  onFileChanged: (handler) => {
    ipcRenderer.on('doc:changed', (_event, path: string, change: ExternalChange) => handler(path, change))
  },
  watchFolder: (root) => ipcRenderer.send('folder:watch', root),
  onFolderChanged: (handler) => {
    ipcRenderer.on('folder:changed', () => handler())
  },
  saveDraft: (path, content) => ipcRenderer.send('draft:save', path, content),
  clearDraft: () => ipcRenderer.send('draft:clear'),
  onDraftRestore: (handler) => {
    ipcRenderer.on('draft:restore', (_event, draft: DraftRestore) => handler(draft))
  },
  listHistory: (path) => ipcRenderer.invoke('history:list', path),
  readHistory: (path, id) => ipcRenderer.invoke('history:read', path, id),
  revealHistory: (path, id) => ipcRenderer.send('history:reveal', path, id),
  onMenu: (handler) => {
    ipcRenderer.on('menu', (_event, command: MenuCommand) => handler(command))
  },
  onOpenPath: (handler) => {
    ipcRenderer.on('open-path', (_event, path: string) => handler(path))
  }
}

contextBridge.exposeInMainWorld('mtypora', api)
