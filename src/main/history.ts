import { app } from 'electron'
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hashText, resolveTarget, writeFileAtomic } from './atomic'
import type { HistoryEntry } from '../shared/api'

/**
 * Local version history (docs/optimization-plan.md 5.5): before a save replaces a file, the
 * version on disk is copied to userData/history/<hash of the path>/<time>.md.
 */

/** Saves closer together than this keep only the first snapshot (auto-save writes every second). */
const MIN_INTERVAL = 10 * 60 * 1000
const MAX_PER_FILE = 50
const MAX_AGE = 30 * 24 * 60 * 60 * 1000
const MAX_TOTAL_BYTES = 200 * 1024 * 1024
const SNAPSHOT = /^(\d+)\.md$/

const historyRoot = (): string => join(app.getPath('userData'), 'history')
const folderFor = (realPath: string): string => join(historyRoot(), hashText(realPath).slice(0, 20))

async function entriesIn(folder: string): Promise<HistoryEntry[]> {
  const names = await readdir(folder).catch(() => [] as string[])
  const entries: HistoryEntry[] = []
  for (const name of names) {
    const match = SNAPSHOT.exec(name)
    if (!match) continue
    const info = await stat(join(folder, name)).catch(() => null)
    if (info) entries.push({ id: match[1], time: Number(match[1]), size: info.size })
  }
  return entries.sort((a, b) => b.time - a.time)
}

/**
 * Keeps `previous` (the text about to be overwritten at `path`). `force` keeps it even right
 * after another snapshot — used when the text came from outside this window and exists nowhere else.
 */
export async function snapshot(path: string, previous: string, force: boolean): Promise<void> {
  const realPath = await resolveTarget(path)
  const folder = folderFor(realPath)
  const entries = await entriesIn(folder)
  if (!force && entries[0] && Date.now() - entries[0].time < MIN_INTERVAL) return
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'path.txt'), realPath, 'utf8')
  // Two snapshots in the same millisecond would share a name.
  const time = Math.max(Date.now(), (entries[0]?.time ?? 0) + 1)
  await writeFileAtomic(join(folder, `${time}.md`), previous)
  await pruneFolder(folder)
}

export async function listHistory(path: string): Promise<HistoryEntry[]> {
  return entriesIn(folderFor(await resolveTarget(path)))
}

export async function historyFile(path: string, id: string): Promise<string> {
  if (!/^\d+$/.test(id)) throw new Error(`Bad history id ${id}`)
  return join(folderFor(await resolveTarget(path)), `${id}.md`)
}

export async function readHistory(path: string, id: string): Promise<string> {
  return readFile(await historyFile(path, id), 'utf8')
}

/** A renamed file keeps its history. */
export async function moveHistory(from: string, to: string): Promise<void> {
  const source = folderFor(from)
  const target = folderFor(await resolveTarget(to))
  if (source === target || !(await stat(source).catch(() => null))) return
  await mkdir(target, { recursive: true })
  for (const name of await readdir(source)) {
    if (SNAPSHOT.test(name)) await rename(join(source, name), join(target, name))
  }
  await writeFile(join(target, 'path.txt'), await resolveTarget(to), 'utf8')
  await rm(source, { recursive: true, force: true })
  await pruneFolder(target)
}

async function pruneFolder(folder: string): Promise<void> {
  const entries = await entriesIn(folder)
  const now = Date.now()
  for (const [index, entry] of entries.entries()) {
    if (index >= MAX_PER_FILE || now - entry.time > MAX_AGE) await unlink(join(folder, `${entry.id}.md`)).catch(() => {})
  }
}

/** Run once at startup: applies the age and count limits everywhere, then the total size limit. */
export async function pruneHistory(): Promise<void> {
  const root = historyRoot()
  const folders = await readdir(root).catch(() => [] as string[])
  const all: Array<HistoryEntry & { file: string }> = []
  for (const name of folders) {
    const folder = join(root, name)
    await pruneFolder(folder)
    const entries = await entriesIn(folder)
    if (entries.length === 0) {
      await rm(folder, { recursive: true, force: true })
      continue
    }
    for (const entry of entries) all.push({ ...entry, file: join(folder, `${entry.id}.md`) })
  }
  let total = all.reduce((sum, entry) => sum + entry.size, 0)
  for (const entry of all.sort((a, b) => a.time - b.time)) {
    if (total <= MAX_TOTAL_BYTES) break
    await unlink(entry.file).catch(() => {})
    total -= entry.size
  }
}
