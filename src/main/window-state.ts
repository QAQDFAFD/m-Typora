import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withPathLock, writeFileAtomic } from './atomic'

export const MIN_WIDTH = 480
export const MIN_HEIGHT = 360
export const DEFAULT_WIDTH = 1180
export const DEFAULT_HEIGHT = 800

export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

export interface DisplayRect {
  x: number
  y: number
  width: number
  height: number
}

export interface SessionState {
  bounds?: WindowBounds
  lastFile?: string | null
}

/** Ensures restored bounds have sensible dimensions and remain reachable on an active display. */
export function fitWindowBounds(saved: WindowBounds | undefined, displays: DisplayRect[]): WindowBounds {
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) {
    return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
  }
  const width = Math.max(MIN_WIDTH, Math.round(saved.width))
  const height = Math.max(MIN_HEIGHT, Math.round(saved.height))
  const maximized = Boolean(saved.maximized)
  if (displays.length === 0) return { width, height, maximized }

  if (typeof saved.x === 'number' && Number.isFinite(saved.x) && typeof saved.y === 'number' && Number.isFinite(saved.y)) {
    for (const display of displays) {
      const overlapX = Math.min(saved.x + width, display.x + display.width) - Math.max(saved.x, display.x)
      const overlapY = Math.min(saved.y + height, display.y + display.height) - Math.max(saved.y, display.y)
      if (overlapX >= 100 && overlapY >= 60 && saved.y >= display.y) {
        return {
          x: Math.round(saved.x),
          y: Math.round(saved.y),
          width: Math.min(width, display.width),
          height: Math.min(height, display.height),
          maximized
        }
      }
    }
  }

  return {
    width: Math.min(width, displays[0].width),
    height: Math.min(height, displays[0].height),
    maximized
  }
}

export function loadSessionState(file: string): SessionState {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const parsed = raw as Record<string, unknown>
    const state: SessionState = {}
    if (parsed.bounds && typeof parsed.bounds === 'object' && !Array.isArray(parsed.bounds)) {
      const b = parsed.bounds as Record<string, unknown>
      if (typeof b.width === 'number' && typeof b.height === 'number') {
        state.bounds = {
          width: b.width,
          height: b.height,
          ...(typeof b.x === 'number' ? { x: b.x } : {}),
          ...(typeof b.y === 'number' ? { y: b.y } : {}),
          ...(typeof b.maximized === 'boolean' ? { maximized: b.maximized } : {})
        }
      }
    }
    if (typeof parsed.lastFile === 'string' || parsed.lastFile === null) {
      state.lastFile = parsed.lastFile
    }
    return state
  } catch {
    return {}
  }
}

export function saveSessionState(file: string, state: SessionState): Promise<void> {
  return withPathLock(file, async () => {
    await mkdir(dirname(file), { recursive: true })
    await writeFileAtomic(file, JSON.stringify(state))
  })
}

export function saveSessionStateSync(file: string, state: SessionState): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(state), 'utf8')
  } catch {
    // Window geometry is a convenience; ignore storage errors on exit.
  }
}
