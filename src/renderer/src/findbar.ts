import type { SearchQuery } from './search-plugin'

interface FindBarHandlers {
  onQuery(query: SearchQuery): void
  onStep(dir: 1 | -1): void
  onReplace(replacement: string): void
  onReplaceAll(replacement: string): void
  onClose(): void
}

/** The find / replace bar that slides in at the top of the document. */
export class FindBar {
  private input: HTMLInputElement
  private replaceInput: HTMLInputElement
  private countEl: HTMLElement
  private caseButton: HTMLButtonElement
  private wordButton: HTMLButtonElement
  private query: SearchQuery = { text: '', caseSensitive: false, wholeWord: false }

  constructor(private el: HTMLElement, private handlers: FindBarHandlers) {
    el.innerHTML = `
      <div class="find-row">
        <svg class="find-icon" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2l3.3 3.3"/></svg>
        <input class="find-input" type="text" placeholder="查找" spellcheck="false" />
        <span class="find-count"></span>
        <button class="find-toggle" data-toggle="case" title="区分大小写">Aa</button>
        <button class="find-toggle" data-toggle="word" title="全词匹配"><u>ab</u></button>
        <button class="find-nav" data-step="-1" title="上一个 (⇧⌘G)">‹</button>
        <button class="find-nav" data-step="1" title="下一个 (⌘G)">›</button>
        <button class="find-nav" data-action="close" title="关闭 (Esc)">✕</button>
      </div>
      <div class="replace-row">
        <span class="find-icon-spacer"></span>
        <input class="replace-input" type="text" placeholder="替换为" spellcheck="false" />
        <button class="find-text-button" data-action="replace">替换</button>
        <button class="find-text-button" data-action="replace-all">全部替换</button>
      </div>`
    this.input = el.querySelector('.find-input')!
    this.replaceInput = el.querySelector('.replace-input')!
    this.countEl = el.querySelector('.find-count')!
    this.caseButton = el.querySelector('[data-toggle="case"]')!
    this.wordButton = el.querySelector('[data-toggle="word"]')!

    this.input.addEventListener('input', () => this.emitQuery())
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        this.handlers.onStep(event.shiftKey ? -1 : 1)
      }
    })
    this.replaceInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        this.handlers.onReplace(this.replaceInput.value)
      }
    })
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        this.handlers.onClose()
      }
    })
    el.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button')
      if (!button) return
      if (button.dataset.step) this.handlers.onStep(Number(button.dataset.step) as 1 | -1)
      if (button.dataset.action === 'close') this.handlers.onClose()
      if (button.dataset.action === 'replace') this.handlers.onReplace(this.replaceInput.value)
      if (button.dataset.action === 'replace-all') this.handlers.onReplaceAll(this.replaceInput.value)
      if (button.dataset.toggle === 'case') {
        this.query.caseSensitive = !this.query.caseSensitive
        this.emitQuery()
      }
      if (button.dataset.toggle === 'word') {
        this.query.wholeWord = !this.query.wholeWord
        this.emitQuery()
      }
    })
  }

  isOpen(): boolean {
    return !this.el.hidden
  }

  open(replace: boolean, initial?: string): void {
    this.el.hidden = false
    this.el.classList.toggle('with-replace', replace)
    if (initial) this.input.value = initial
    this.input.focus()
    this.input.select()
    this.emitQuery()
  }

  close(): void {
    this.el.hidden = true
  }

  setCount(current: number, total: number): void {
    this.countEl.textContent = this.input.value ? (total === 0 ? '无结果' : `${current + 1} / ${total}`) : ''
  }

  private emitQuery(): void {
    this.query = { ...this.query, text: this.input.value }
    this.caseButton.classList.toggle('active', this.query.caseSensitive)
    this.wordButton.classList.toggle('active', this.query.wholeWord)
    this.handlers.onQuery(this.query)
  }
}
