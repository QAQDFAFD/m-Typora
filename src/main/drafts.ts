import { app } from 'electron'
import { mkdir, readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic'

/** Unsaved text of one window, kept so it survives a crash (see docs/optimization-plan.md 5.2). */
export interface Draft {
  path: string | null
  content: string
  /** Hash of the file's text the edits started from, to tell whether it changed since. */
  baseHash: string | null
  savedAt: number
}

const MAX_AGE = 30 * 24 * 60 * 60 * 1000
const ID = /^[\w-]+$/

const draftsDir = (): string => join(app.getPath('userData'), 'drafts')
const draftFile = (id: string): string => {
  if (!ID.test(id)) throw new Error(`Bad draft id ${id}`)
  return join(draftsDir(), `${id}.json`)
}

export async function writeDraft(id: string, draft: Draft): Promise<void> {
  await mkdir(draftsDir(), { recursive: true })
  await writeFileAtomic(draftFile(id), JSON.stringify(draft))
}

export async function deleteDraft(id: string): Promise<void> {
  await unlink(draftFile(id)).catch(() => {})
}

export async function readDraft(id: string): Promise<Draft | null> {
  try {
    const draft = JSON.parse(await readFile(draftFile(id), 'utf8')) as Draft
    return typeof draft.content === 'string' ? draft : null
  } catch {
    return null
  }
}

/** Drafts left behind by windows that did not close normally; expired or unreadable ones are removed. */
export async function leftoverDrafts(): Promise<Array<{ id: string; draft: Draft }>> {
  const names = await readdir(draftsDir()).catch(() => [] as string[])
  const found: Array<{ id: string; draft: Draft }> = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -5)
    if (!ID.test(id)) continue
    const draft = await readDraft(id)
    if (!draft || Date.now() - draft.savedAt > MAX_AGE) await deleteDraft(id)
    else found.push({ id, draft })
  }
  return found.sort((a, b) => a.draft.savedAt - b.draft.savedAt)
}
