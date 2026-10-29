import { escapeHtml } from './markdown-utils'

export interface NoticeAction {
  label: string
  primary?: boolean
  run: () => void
}

/** What a notice is about; a later notice of another kind replaces it. */
export type NoticeKind = 'restored' | 'conflict' | 'deleted'

/**
 * The bar above the document for things that need a decision: recovered text, a file changed
 * or removed by another program. It only appears when something happened.
 */
export class NoticeBar {
  private kind: NoticeKind | null = null
  private actions: NoticeAction[] = []

  constructor(private el: HTMLElement, private onChange: () => void) {
    el.setAttribute('role', 'alert')
    el.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')
      if (button) this.actions[Number(button.dataset.action)]?.run()
    })
  }

  current(): NoticeKind | null {
    return this.kind
  }

  show(kind: NoticeKind, message: string, actions: NoticeAction[]): void {
    this.kind = kind
    this.actions = actions
    this.el.dataset.kind = kind
    this.el.innerHTML = `
      <svg class="notice-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" /><path d="M8 4.5v4.2M8 10.8v.7" /></svg>
      <span class="notice-text">${escapeHtml(message)}</span>
      ${actions
        .map((action, index) => `<button class="notice-button${action.primary ? ' primary' : ''}" data-action="${index}">${escapeHtml(action.label)}</button>`)
        .join('')}`
    this.el.hidden = false
    this.onChange()
  }

  /** Hides the bar; with `kind`, only when it shows that kind of notice. */
  hide(kind?: NoticeKind): void {
    if (!this.kind || (kind && kind !== this.kind)) return
    this.kind = null
    this.actions = []
    this.el.hidden = true
    this.el.innerHTML = ''
    this.onChange()
  }
}
