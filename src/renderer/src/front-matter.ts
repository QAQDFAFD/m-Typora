const FRONT_MATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/

/** Splits a leading YAML front matter block from the markdown body (including empty `---\n---`). */
export function splitFrontMatter(markdown: string): { yaml: string | null; body: string } {
  const match = FRONT_MATTER.exec(markdown)
  if (!match) return { yaml: null, body: markdown }
  return { yaml: match[1] ?? '', body: markdown.slice(match[0].length).replace(/^\r?\n/, '') }
}

export function joinFrontMatter(yaml: string | null, body: string): string {
  if (yaml === null) return body
  return yaml === '' ? `---\n---\n\n${body}` : `---\n${yaml}\n---\n\n${body}`
}

/**
 * Typora renders YAML front matter as a grey monospace block above the document.
 * Milkdown has no front matter node, so it is kept out of the editor and edited here.
 */
export class FrontMatterBlock {
  private el: HTMLElement
  private onChange: () => void
  private textarea: HTMLTextAreaElement
  private undoStack: Array<string | null> = []
  private redoStack: Array<string | null> = []
  private lastRecorded: string | null = null

  constructor(el: HTMLElement, onChange: () => void, onExit: () => void) {
    this.el = el
    this.onChange = onChange
    this.textarea = document.createElement('textarea')
    this.textarea.className = 'md-front-matter'
    this.textarea.spellcheck = false
    this.textarea.rows = 1
    el.append(this.textarea)
    this.textarea.addEventListener('input', () => {
      if (this.textarea.value !== this.lastRecorded) {
        this.undoStack.push(this.lastRecorded)
        this.redoStack.length = 0
        this.lastRecorded = this.textarea.value
      }
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
        this.set(null, false)
        onChange()
        onExit()
      }
    })
    this.set(null, true)
  }

  get(): string | null {
    return this.el.hidden ? null : this.textarea.value
  }

  set(yaml: string | null, resetHistory = true): void {
    if (resetHistory) {
      this.undoStack.length = 0
      this.redoStack.length = 0
    } else if (yaml !== this.lastRecorded) {
      this.undoStack.push(this.lastRecorded)
      this.redoStack.length = 0
    }
    this.applyValue(yaml)
  }

  undo(): boolean {
    if (this.undoStack.length === 0) return false
    const prev = this.undoStack.pop()!
    this.redoStack.push(this.get())
    this.applyValue(prev)
    this.onChange()
    return true
  }

  redo(): boolean {
    if (this.redoStack.length === 0) return false
    const next = this.redoStack.pop()!
    this.undoStack.push(this.get())
    this.applyValue(next)
    this.onChange()
    return true
  }

  focus(): void {
    this.textarea.focus()
  }

  private applyValue(yaml: string | null): void {
    this.el.hidden = yaml === null
    this.textarea.value = yaml ?? ''
    this.lastRecorded = yaml
    requestAnimationFrame(() => this.autosize())
  }

  private autosize(): void {
    this.textarea.style.height = 'auto'
    this.textarea.style.height = `${this.textarea.scrollHeight}px`
  }
}
