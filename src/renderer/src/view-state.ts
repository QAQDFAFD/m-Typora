export const VIEW_STATE_KEY = 'm-typora:view-states'
const MAX_ENTRIES = 50

export interface FileViewState {
  scrollTop: number
  caret: number
  updatedAt: number
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): StorageLike | undefined {
  return typeof globalThis !== 'undefined' && 'localStorage' in globalThis ? globalThis.localStorage : undefined
}

export function loadViewStates(storage: StorageLike | undefined = defaultStorage()): Record<string, FileViewState> {
  try {
    const raw = JSON.parse(storage?.getItem(VIEW_STATE_KEY) ?? '{}') as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, FileViewState> = {}
    for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const item = value as Record<string, unknown>
      if (typeof item.scrollTop === 'number' && typeof item.caret === 'number') {
        out[path] = {
          scrollTop: Math.max(0, Math.round(item.scrollTop)),
          caret: Math.max(0, Math.round(item.caret)),
          updatedAt: typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : 0
        }
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeViewStates(states: Record<string, FileViewState>, storage: StorageLike | undefined): void {
  try {
    const entries = Object.entries(states)
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      entries.length = MAX_ENTRIES
    }
    storage?.setItem(VIEW_STATE_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // View state is a convenience; ignore storage quota/access errors.
  }
}

export function getViewState(path: string, storage: StorageLike | undefined = defaultStorage()): FileViewState | null {
  return loadViewStates(storage)[path] ?? null
}

export function saveViewState(
  path: string,
  state: { scrollTop: number; caret: number },
  storage: StorageLike | undefined = defaultStorage()
): void {
  const states = loadViewStates(storage)
  states[path] = {
    scrollTop: Math.max(0, Math.round(state.scrollTop)),
    caret: Math.max(0, Math.round(state.caret)),
    updatedAt: Date.now()
  }
  writeViewStates(states, storage)
}

export function moveViewState(fromPath: string, toPath: string, storage: StorageLike | undefined = defaultStorage()): void {
  if (fromPath === toPath) return
  const states = loadViewStates(storage)
  const existing = states[fromPath]
  if (!existing) return
  delete states[fromPath]
  states[toPath] = { ...existing, updatedAt: Date.now() }
  writeViewStates(states, storage)
}
