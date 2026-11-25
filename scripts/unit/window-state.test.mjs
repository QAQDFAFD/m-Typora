import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  fitWindowBounds,
  loadSessionState,
  MIN_HEIGHT,
  MIN_WIDTH,
  saveSessionState,
  saveSessionStateSync
} from '../../src/main/window-state.ts'

test('fitWindowBounds returns defaults, clamps minimums, and restores reachable positions', () => {
  const displays = [{ x: 0, y: 25, width: 1440, height: 875 }]
  assert.deepEqual(fitWindowBounds(undefined, displays), { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT })

  assert.deepEqual(fitWindowBounds({ x: 100, y: 80, width: 200, height: 150, maximized: true }, displays), {
    x: 100,
    y: 80,
    width: MIN_WIDTH,
    height: MIN_HEIGHT,
    maximized: true
  })

  assert.deepEqual(fitWindowBounds({ x: 120, y: 90, width: 2000, height: 1200 }, displays), {
    x: 120,
    y: 90,
    width: 1440,
    height: 875,
    maximized: false
  })
})

test('fitWindowBounds resets off-screen or disconnected monitor positions cleanly', () => {
  const displays = [{ x: 0, y: 25, width: 1440, height: 875 }]
  // Off-screen to the right (disconnected external display)
  assert.deepEqual(fitWindowBounds({ x: 2000, y: 100, width: 1000, height: 700 }, displays), {
    width: 1000,
    height: 700,
    maximized: false
  })
  // Titlebar above menu bar / top edge
  assert.deepEqual(fitWindowBounds({ x: 100, y: 10, width: 900, height: 700 }, displays), {
    width: 900,
    height: 700,
    maximized: false
  })
})

test('loadSessionState and saveSessionState round-trip and handle corrupt files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'm-typora-winstate-'))
  try {
    const file = join(dir, 'nested', 'window-state.json')
    assert.deepEqual(loadSessionState(file), {})

    const state = {
      bounds: { x: 40, y: 60, width: 980, height: 700, maximized: false },
      lastFile: '/tmp/note.md'
    }
    await saveSessionState(file, state)
    assert.deepEqual(loadSessionState(file), state)

    const updated = { ...state, lastFile: null }
    saveSessionStateSync(file, updated)
    assert.deepEqual(loadSessionState(file), updated)

    await writeFile(file, '{broken json', 'utf8')
    assert.deepEqual(loadSessionState(file), {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
