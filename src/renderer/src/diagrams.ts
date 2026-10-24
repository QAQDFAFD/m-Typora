type Mermaid = (typeof import('mermaid'))['default']

let mermaidPromise: Promise<Mermaid> | null = null
let configuredTheme = ''
let counter = 0

/** Mermaid is large, so it is loaded the first time a diagram is shown. */
function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import('mermaid').then((module) => module.default)
  return mermaidPromise
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
      const mermaid = await loadMermaid()
      const theme = dark() ? 'dark' : 'default'
      if (theme !== configuredTheme) {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme })
        configuredTheme = theme
      }
      const { svg } = await mermaid.render(`mtypora-mermaid-${++counter}`, content)
      const host = document.createElement('div')
      host.className = 'md-diagram'
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
