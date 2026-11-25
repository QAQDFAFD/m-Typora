import assert from 'node:assert/strict'
import test from 'node:test'
import { getViewState, loadViewStates, moveViewState, saveViewState, VIEW_STATE_KEY } from '../../src/renderer/src/view-state.ts'

function memoryStorage() {
  const data = new Map()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value))
  }
}

test('view-state saves, restores, clamps, moves, and handles corrupt storage', () => {
  const storage = memoryStorage()
  assert.equal(getViewState('/a.md', storage), null)

  saveViewState('/a.md', { scrollTop: 245.7, caret: 42 }, storage)
  const saved = getViewState('/a.md', storage)
  assert.equal(saved?.scrollTop, 246)
  assert.equal(saved?.caret, 42)

  saveViewState('/neg.md', { scrollTop: -10, caret: -5 }, storage)
  assert.equal(getViewState('/neg.md', storage)?.scrollTop, 0)
  assert.equal(getViewState('/neg.md', storage)?.caret, 0)

  moveViewState('/a.md', '/b.md', storage)
  assert.equal(getViewState('/a.md', storage), null)
  assert.equal(getViewState('/b.md', storage)?.scrollTop, 246)

  storage.setItem(VIEW_STATE_KEY, '{invalid')
  assert.deepEqual(loadViewStates(storage), {})
})

test('view-state keeps at most 50 recent files', () => {
  const storage = memoryStorage()
  const now = Date.now() - 1000
  const seed = {}
  for (let i = 0; i < 50; i++) {
    seed[`/file-${i}.md`] = { scrollTop: i * 10, caret: i, updatedAt: now + i }
  }
  storage.setItem(VIEW_STATE_KEY, JSON.stringify(seed))

  saveViewState('/file-50.md', { scrollTop: 999, caret: 12 }, storage)
  const loaded = loadViewStates(storage)
  assert.equal(Object.keys(loaded).length, 50)
  assert.equal(loaded['/file-0.md'], undefined)
  assert.equal(loaded['/file-50.md']?.scrollTop, 999)
})
