import { watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'
import { hashText } from './atomic'
import { IGNORED_DIRS, MARKDOWN_FILE } from './files'
import type { ExternalChange } from '../shared/api'

interface Notify {
  fileChanged(path: string, change: ExternalChange): void
  folderChanged(): void
}

/**
 * What one window knows about its document on disk: the path and the text it last read or
 * wrote there. Watches that file (and the sidebar's folder) and reports changes made by
 * anything else — sync clients, git, other editors.
 */
export class DocumentTracker {
  private path: string | null = null
  /** Hash of the text this window last read from or wrote to `path`. */
  private hash: string | null = null
  private missing = false
  /** The external version already reported, so one change is announced once. */
  private reported: string | null = null
  private fileWatcher: FSWatcher | null = null
  private folderWatcher: FSWatcher | null = null
  private fileTimer: NodeJS.Timeout | undefined
  private folderTimer: NodeJS.Timeout | undefined

  constructor(private notify: Notify) {}

  currentPath(): string | null {
    return this.path
  }

  /** True when the text on disk is not the one this window last read or wrote. */
  changedOnDisk(path: string, diskText: string): boolean {
    return path !== this.path || this.hash !== hashText(diskText)
  }

  /** Hash of the known disk text, recorded with drafts to detect later outside edits. */
  knownHash(): string | null {
    return this.hash
  }

  /** Records that `text` is what is on disk at `path` (just read or just written). */
  setKnown(path: string, text: string): void {
    this.hash = hashText(text)
    this.missing = false
    this.reported = null
    if (path !== this.path) {
      this.path = path
      this.watchFile()
    }
  }

  /** The file was renamed by this window: same text, new place. */
  moved(path: string): void {
    this.path = path
    this.watchFile()
  }

  /** The window shows an untitled document (or a different one it has not read yet). */
  forget(): void {
    this.path = null
    this.hash = null
    this.missing = false
    this.reported = null
    this.watchFile()
  }

  watchFolder(root: string | null): void {
    this.folderWatcher?.close()
    this.folderWatcher = null
    if (!root) return
    try {
      this.folderWatcher = watch(root, { recursive: true }, (_event, name) => {
        if (name && !affectsTree(name)) return
        clearTimeout(this.folderTimer)
        this.folderTimer = setTimeout(() => this.notify.folderChanged(), 500)
      })
      this.folderWatcher.on('error', () => this.watchFolder(null))
    } catch {
      // A folder that cannot be watched still works; the sidebar refreshes after saves.
    }
  }

  dispose(): void {
    this.forget()
    this.watchFolder(null)
    clearTimeout(this.fileTimer)
    clearTimeout(this.folderTimer)
  }

  /**
   * Watches the folder rather than the file: editors and sync clients often save by writing a
   * temporary file and renaming it over the original, which a watch on the file itself misses.
   */
  private watchFile(): void {
    this.fileWatcher?.close()
    this.fileWatcher = null
    clearTimeout(this.fileTimer)
    const path = this.path
    if (!path) return
    const name = basename(path)
    try {
      this.fileWatcher = watch(dirname(path), (_event, changed) => {
        if (changed && changed !== name) return
        clearTimeout(this.fileTimer)
        this.fileTimer = setTimeout(() => void this.check(path), 300)
      })
      this.fileWatcher.on('error', () => {
        this.fileWatcher?.close()
        this.fileWatcher = null
      })
    } catch {
      // Unwatchable (e.g. some network drives): the check before each save still guards it.
    }
  }

  private async check(path: string): Promise<void> {
    const text = await readFile(path, 'utf8').catch(() => null)
    if (path !== this.path) return
    if (text === null) {
      if (!this.missing) {
        this.missing = true
        this.notify.fileChanged(path, 'deleted')
      }
      return
    }
    const hash = hashText(text)
    if (this.missing) {
      this.missing = false
      if (hash === this.hash) return this.notify.fileChanged(path, 'restored')
    }
    if (hash === this.hash || hash === this.reported) return
    this.reported = hash
    this.notify.fileChanged(path, 'modified')
  }
}

/** Whether a changed path inside the sidebar's folder can change its tree (not .git churn). */
function affectsTree(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]/)
  if (parts.some((part) => part.startsWith('.') || IGNORED_DIRS.has(part))) return false
  const last = parts[parts.length - 1]
  return MARKDOWN_FILE.test(last) || extname(last) === ''
}
