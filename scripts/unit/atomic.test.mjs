import assert from 'node:assert/strict'
import { chmod, lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { withPathLock, writeFileAtomic } from '../../src/main/atomic.ts'

test('writeFileAtomic writes strings and buffers without leaving temp files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'm-typora-atomic-'))
  try {
    const file = join(dir, 'note.md')
    await writeFileAtomic(file, 'Hello atomic\n')
    assert.equal(await readFile(file, 'utf8'), 'Hello atomic\n')

    const bin = join(dir, 'data.bin')
    await writeFileAtomic(bin, Uint8Array.from([1, 2, 3, 4]))
    assert.deepEqual(await readFile(bin), Buffer.from([1, 2, 3, 4]))

    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.m-typora-tmp'))
    assert.deepEqual(leftovers, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeFileAtomic preserves symlinks and file permissions', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'm-typora-atomic-link-'))
  try {
    const real = join(dir, 'real.md')
    const link = join(dir, 'link.md')
    await writeFile(real, 'old\n', { mode: 0o640 })
    await chmod(real, 0o640)
    await symlink(real, link)

    await writeFileAtomic(link, 'new\n')
    assert.equal((await lstat(link)).isSymbolicLink(), true)
    assert.equal(await readFile(real, 'utf8'), 'new\n')
    assert.equal((await stat(real)).mode & 0o777, 0o640)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('withPathLock serializes concurrent writes to the same file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'm-typora-lock-'))
  try {
    const file = join(dir, 'race.md')
    const order = []
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        withPathLock(file, async () => {
          order.push(`start-${i}`)
          await writeFileAtomic(file, `content-${i}\n`)
          order.push(`end-${i}`)
        })
      )
    )
    assert.equal(await readFile(file, 'utf8'), 'content-7\n')
    for (let i = 0; i < 8; i++) {
      assert.equal(order[i * 2], `start-${i}`)
      assert.equal(order[i * 2 + 1], `end-${i}`)
    }
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.m-typora-tmp'))
    assert.deepEqual(leftovers, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
