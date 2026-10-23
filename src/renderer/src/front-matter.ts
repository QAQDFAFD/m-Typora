const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** Splits a leading YAML front matter block from the markdown body. */
export function splitFrontMatter(markdown: string): { yaml: string | null; body: string } {
  const match = FRONT_MATTER.exec(markdown)
  if (!match) return { yaml: null, body: markdown }
  return { yaml: match[1], body: markdown.slice(match[0].length).replace(/^\r?\n/, '') }
}

export function joinFrontMatter(yaml: string | null, body: string): string {
  if (yaml === null) return body
  return `---\n${yaml}\n---\n\n${body}`
}

/**
 * Typora renders YAML front matter as a grey monospace block above the document.
 * Milkdown has no front matter node, so it is kept out of the editor and edited here.
 */
export class FrontMatterBlock {
  private textarea: HTMLTextAreaElement

  constructor(private el: HTMLElement, onChange: () => void, onExit: () => void) {
    this.textarea = document.createElement('textarea')
    this.textarea.className = 'md-front-matter'
    this.textarea.spellcheck = false
    this.textarea.rows = 1
    el.append(this.textarea)
    this.textarea.addEventListener('input', () => {
      this.autosize()
      onChange()
    })
    this.textarea.addEventListener('keydown', (event) => {
      const atEnd = this.textarea.selectionStart === this.textarea.value.length
      if ((event.key === 'ArrowDown' && atEnd) || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
        event.preventDefault()
        onExit()
      }
      // Backspace in an empty block removes it, like deleting an empty code fence.
      if (event.key === 'Backspace' && this.textarea.value === '') {
        event.preventDefault()
        this.set(null)
        onChange()
        onExit()
      }
    })
    this.set(null)
  }

  get(): string | null {
    return this.el.hidden ? null : this.textarea.value
  }

  set(yaml: string | null): void {
    this.el.hidden = yaml === null
    this.textarea.value = yaml ?? ''
    requestAnimationFrame(() => this.autosize())
  }

  focus(): void {
    this.textarea.focus()
  }

  private autosize(): void {
    this.textarea.style.height = 'auto'
    this.textarea.style.height = `${this.textarea.scrollHeight}px`
  }
}
