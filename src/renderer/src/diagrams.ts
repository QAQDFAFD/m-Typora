import { EditorView as CmEditorView } from '@codemirror/view'

type Mermaid = (typeof import('mermaid'))['default']

let mermaidPromise: Promise<Mermaid> | null = null
let configuredTheme = ''
let counter = 0
let refreshSeq = 0

/** Mermaid is large, so it is loaded the first time a diagram is shown. */
function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import('mermaid').then((module) => module.default)
  return mermaidPromise
}

async function configured(dark: boolean): Promise<Mermaid> {
  const mermaid = await loadMermaid()
  const theme = dark ? 'dark' : 'default'
  if (theme !== configuredTheme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme })
    configuredTheme = theme
  }
  return mermaid
}

/** The diagram as SVG markup (used by export). Throws on syntax errors. */
export async function renderDiagramSvg(content: string, dark: boolean): Promise<string> {
  const mermaid = await configured(dark)
  return (await mermaid.render(`mtypora-mermaid-${++counter}`, content)).svg
}

/**
 * Preview for ```mermaid fences, as Typora draws diagrams from code blocks.
 * Returns `undefined` so the code block waits for `apply`; other languages get no preview.
 */
export function renderDiagramPreview(
  language: string,
  content: string,
  apply: (value: null | string | HTMLElement) => void,
  dark: () => boolean
): undefined | null {
  if (language.toLowerCase() !== 'mermaid' || !content.trim()) return null
  void (async () => {
    try {
      const isDark = dark()
      const svg = await renderDiagramSvg(content, isDark)
      const host = document.createElement('div')
      host.className = 'md-diagram'
      host.dataset.themeMode = isDark ? 'dark' : 'light'
      host.innerHTML = svg
      apply(host)
    } catch (error) {
      const message = document.createElement('div')
      message.className = 'md-diagram-error'
      message.textContent = `图表语法错误：${(error as Error).message.split('\n')[0]}`
      apply(message)
    }
  })()
  return undefined
}

/** Re-renders already mounted Mermaid diagrams when switching between light and dark themes. */
export async function refreshDiagrams(root: ParentNode, dark: boolean): Promise<void> {
  const seq = ++refreshSeq
  const mode = dark ? 'dark' : 'light'
  const hosts = Array.from(root.querySelectorAll<HTMLElement>('.md-diagram'))
  for (const host of hosts) {
    if (host.dataset.themeMode === mode) continue
    const cmDom = host.closest('.milkdown-code-block')?.querySelector<HTMLElement>('.cm-editor')
    const source = cmDom ? CmEditorView.findFromDOM(cmDom)?.state.doc.toString() : undefined
    if (!source?.trim()) continue
    const svg = await renderDiagramSvg(source, dark).catch(() => null)
    if (seq !== refreshSeq) return
    if (svg && host.isConnected) {
      host.innerHTML = svg
      host.dataset.themeMode = mode
    }
  }
}
