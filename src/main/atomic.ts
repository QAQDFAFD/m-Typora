import { createHash, randomUUID } from 'node:crypto'
import { open, realpath, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export const hashText = (text: string): string => createHash('sha1').update(text).digest('hex')

/** Follows symlinks, so a save replaces the file a link points to rather than the link itself. */
export const resolveTarget = (path: string): Promise<string> => realpath(path).catch(() => path)

const pathLocks = new Map<string, Promise<unknown>>()

/** Runs tasks targeting the same path sequentially so concurrent saves never race. */
export async function withPathLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const prev = pathLocks.get(path) ?? Promise.resolve()
  const current = prev.catch(() => {}).then(task)
  pathLocks.set(path, current)
  try {
    return await current
  } finally {
    if (pathLocks.get(path) === current) pathLocks.delete(path)
  }
}

/** Windows refuses to replace a file another program has open; those errors clear up quickly. */
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * Writes through a temporary file in the same folder and renames it over the target, so a crash,
 * power loss or full disk mid-write leaves the old file intact instead of a truncated one.
 */
export async function writeFileAtomic(path: string, content: string | Uint8Array): Promise<void> {
  const target = await resolveTarget(path)
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}-${randomUUID().slice(0, 8)}.m-typora-tmp`)
  const mode = await stat(target).then((info) => info.mode & 0o777).catch(() => undefined)

  const handle = await open(temp, 'w')
  try {
    if (typeof content === 'string') await handle.writeFile(content, 'utf8')
    else await handle.writeFile(content)
    if (mode !== undefined) await handle.chmod(mode)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(temp).catch(() => {})
    throw error
  }
  await handle.close()

  // A failed rename keeps the complete temporary file, so the text can still be recovered.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temp, target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (process.platform !== 'win32' || attempt >= 3 || !RETRYABLE.has(code)) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}
