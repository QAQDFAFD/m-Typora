import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// Runs the renderer alone in a normal browser (no Electron) for quick UI work.
// The renderer falls back to an in-browser bridge when window.mtypora is missing.
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  server: { port: 5199 }
})
