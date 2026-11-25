import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DocumentTracker } from '../../src/main/tracker.ts'

test('DocumentTracker detects external edits, ENOENT deletion/restore, and ignores transient permission errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'm-typora-tracker-'))
  const file = join(dir, 'doc.md')
  await writeFile(file, 'v1\n')

  const events = []
  const tracker = new DocumentTracker({
    fileChanged: (path, change) => events.push({ path, change }),
    folderChanged: () => {}
  })

  try {
    tracker.setKnown(file, 'v1\n')
    assert.equal(tracker.changedOnDisk(file, 'v1\n'), false)
    assert.equal(tracker.changedOnDisk(file, 'v2\n'), true)

    // Unchanged on disk: no event.
    await tracker.check(file)
    assert.deepEqual(events, [])

    // Modified on disk: emitted once per unique external version.
    await writeFile(file, 'v2\n')
    await tracker.check(file)
    await tracker.check(file)
    assert.deepEqual(events, [{ path: file, change: 'modified' }])

    // Non-ENOENT read error (e.g. EACCES when temporarily locked) must not emit 'deleted'.
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      await chmod(file, 0o000)
      await tracker.check(file)
      assert.deepEqual(events, [{ path: file, change: 'modified' }])
      await chmod(file, 0o644)
    }

    // Actual deletion (ENOENT) emits 'deleted', and restoring the known content emits 'restored'.
    await rm(file)
    await tracker.check(file)
    assert.deepEqual(events.at(-1), { path: file, change: 'deleted' })

    await writeFile(file, 'v1\n')
    await tracker.check(file)
    assert.deepEqual(events.at(-1), { path: file, change: 'restored' })
  } finally {
    await chmod(file, 0o644).catch(() => {})
    tracker.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
