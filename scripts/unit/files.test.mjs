import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { clearTreeCache, createUntitledFile, createUntitledFolder, readTree, searchFolder } from '../../src/main/files.ts'

test('readTree shows empty dirs, hides non-markdown/ignored dirs, skips broken symlinks, and sorts numerically', async () => {
  clearTreeCache()
  const dir = await mkdtemp(join(tmpdir(), 'm-typora-files-'))
  try {
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(dir, '.git'), { recursive: true })
    await mkdir(join(dir, 'empty-dir'), { recursive: true })
    await mkdir(join(dir, 'hidden-only'), { recursive: true })
    await writeFile(join(dir, 'hidden-only', '.DS_Store'), '')
    await mkdir(join(dir, 'assets-only'), { recursive: true })
    await writeFile(join(dir, 'assets-only', 'logo.png'), 'png')
    await mkdir(join(dir, 'notes'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'pkg', 'ignored.md'), '# Ignored\n')
    await writeFile(join(dir, '.git', 'hidden.md'), '# Hidden\n')
    await writeFile(join(dir, '2.md'), '# Two\n\nSecond line.\n')
    await writeFile(join(dir, '10.md'), '# Ten\n\nTenth line.\n')
    await writeFile(join(dir, 'notes', 'child.md'), '# Child\n')
    if (process.platform !== 'win32') await symlink(join(dir, 'does-not-exist.md'), join(dir, 'broken.md'))

    const tree = await readTree(dir)
    assert.deepEqual(
      tree.map((node) => node.name),
      ['empty-dir', 'hidden-only', 'notes', '2.md', '10.md']
    )
    assert.deepEqual(tree[0].children, [])
    assert.deepEqual(tree[1].children, [])
    assert.deepEqual(tree[3].excerpt, ['Two', 'Second line.'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readTree decodes UTF-8 cut across the 2048-byte boundary cleanly and updates on change', async () => {
  clearTreeCache()
  const dir = await mkdtemp(join(tmpdir(), 'm-typora-utf8-'))
  try {
    const file = join(dir, 'cjk.md')
    // 2047 ASCII bytes + 3-byte Chinese character ("中") -> splits mid-character at 2048 bytes.
    const prefix = 'a'.repeat(2047)
    await writeFile(file, `${prefix}中后续内容\n`)

    const first = await readTree(dir)
    assert.equal(first.length, 1)
    assert.equal(first[0].excerpt?.join('').includes('\uFFFD'), false)

    await writeFile(file, '# Updated Title\n\nFresh body.\n')
    const now = new Date(Date.now() + 5000)
    await utimes(file, now, now)
    const second = await readTree(dir)
    assert.deepEqual(second[0].excerpt, ['Updated Title', 'Fresh body.'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('searchFolder matches plain text, cross-line phrases, multi-word queries, and filenames', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'm-typora-search-'))
  try {
    await mkdir(join(dir, 'sub'), { recursive: true })
    await mkdir(join(dir, 'dist'), { recursive: true })
    await writeFile(join(dir, 'dist', 'skip.md'), 'brown fox\n')
    await writeFile(join(dir, 'bold.md'), '这里有**粗体**与 [链接文字](https://example.com)。\n')
    await writeFile(join(dir, 'sub', 'wrapped.md'), 'The quick brown\nfox jumps over.\n')
    await writeFile(join(dir, 'Project Notes.md'), 'Empty body.\n')

    const boldHits = await searchFolder(dir, '粗体与')
    assert.equal(boldHits.length, 1)
    assert.equal(boldHits[0].path, join(dir, 'bold.md'))

    const phraseHits = await searchFolder(dir, 'brown fox')
    assert.equal(phraseHits.length, 1)
    assert.equal(phraseHits[0].path, join(dir, 'sub', 'wrapped.md'))

    const multiHits = await searchFolder(dir, 'jumps quick')
    assert.equal(multiHits.length, 1)
    assert.equal(multiHits[0].path, join(dir, 'sub', 'wrapped.md'))

    const fileHits = await searchFolder(dir, 'project notes')
    assert.deepEqual(fileHits, [{ path: join(dir, 'Project Notes.md'), line: 0, text: '' }])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('createUntitledFile generates sequential and collision-free filenames', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'm-typora-newfile-'))
  try {
    const first = await createUntitledFile(dir)
    const second = await createUntitledFile(dir)
    const third = await createUntitledFile(dir)
    assert.equal(first, join(dir, '未命名.md'))
    assert.equal(second, join(dir, '未命名 2.md'))
    assert.equal(third, join(dir, '未命名 3.md'))

    const parallel = await Promise.all([createUntitledFile(dir), createUntitledFile(dir), createUntitledFile(dir)])
    assert.equal(new Set(parallel).size, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('createUntitledFolder generates sequential and collision-free folder names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'm-typora-newfolder-'))
  try {
    const first = await createUntitledFolder(dir)
    const second = await createUntitledFolder(dir)
    const third = await createUntitledFolder(dir)
    assert.equal(first, join(dir, '未命名文件夹'))
    assert.equal(second, join(dir, '未命名文件夹 2'))
    assert.equal(third, join(dir, '未命名文件夹 3'))

    const parallel = await Promise.all([createUntitledFolder(dir), createUntitledFolder(dir), createUntitledFolder(dir)])
    assert.equal(new Set(parallel).size, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
