import { createHash } from 'node:crypto'
import { open, realpath, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export const hashText = (text: string): string => createHash('sha1').update(text).digest('hex')

/** Follows symlinks, so a save replaces the file a link points to rather than the link itself. */
export const resolveTarget = (path: string): Promise<string> => realpath(path).catch(() => path)

/** Windows refuses to replace a file another program has open; those errors clear up quickly. */
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * Writes through a temporary file in the same folder and renames it over the target, so a crash,
 * power loss or full disk mid-write leaves the old file intact instead of a truncated one.
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const target = await resolveTarget(path)
  const temp = join(dirname(target), `.${basename(target)}.m-typora-tmp`)
  const mode = await stat(target).then((info) => info.mode & 0o777).catch(() => undefined)

  const handle = await open(temp, 'w')
  try {
    await handle.writeFile(content, 'utf8')
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
