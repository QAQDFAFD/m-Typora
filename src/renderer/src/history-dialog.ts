import type { HistoryEntry } from '../../shared/api'
import { bridge } from './bridge'
import { escapeHtml, fileName } from './markdown-utils'

const pad = (n: number) => String(n).padStart(2, '0')

function formatTime(time: number): string {
  const date = new Date(time)
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function ago(time: number): string {
  const minutes = Math.round((Date.now() - time) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

const formatSize = (size: number) => (size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`)

interface HistoryOptions {
  onRestore: (content: string) => void
  fileManager: string
}

/** File › 历史版本…: the versions kept before each save, with a preview and restore. */
export class HistoryDialog {
  private list: HTMLElement
  private preview: HTMLElement
  private heading: HTMLElement
  private restoreButton: HTMLButtonElement
  private revealButton: HTMLButtonElement
  private path = ''
  private entries: HistoryEntry[] = []
  private selected = 0
  private content = ''

  constructor(private el: HTMLElement, private options: HistoryOptions) {
    el.innerHTML = `
      <div class="history-panel" role="dialog" aria-label="历史版本" tabindex="-1">
        <div class="history-heading"></div>
        <div class="history-body">
          <ul class="history-list"></ul>
          <pre class="history-preview"></pre>
        </div>
        <div class="history-footer">
          <button class="dialog-button" data-role="reveal">在${escapeHtml(options.fileManager)}中显示</button>
          <span class="spacer"></span>
          <button class="dialog-button" data-role="cancel">取消</button>
          <button class="dialog-button primary" data-role="restore">恢复此版本</button>
        </div>
      </div>`
    this.list = el.querySelector('.history-list')!
    this.preview = el.querySelector('.history-preview')!
    this.heading = el.querySelector('.history-heading')!
    this.restoreButton = el.querySelector('[data-role="restore"]')!
    this.revealButton = el.querySelector('[data-role="reveal"]')!

    el.addEventListener('mousedown', (event) => {
      if (event.target === el) this.close()
    })
    el.addEventListener('keydown', (event) => this.onKey(event))
    this.list.addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('[data-index]')
      if (item) void this.select(Number(item.dataset.index))
    })
    el.querySelector('[data-role="cancel"]')!.addEventListener('click', () => this.close())
    this.restoreButton.addEventListener('click', () => this.restore())
    this.revealButton.addEventListener('click', () => {
      const entry = this.entries[this.selected]
      if (entry) bridge.revealHistory(this.path, entry.id)
    })
  }

  isOpen(): boolean {
    return !this.el.hidden
  }

  async open(path: string): Promise<void> {
    this.path = path
    this.entries = await bridge.listHistory(path).catch(() => [])
    this.heading.textContent = `历史版本 — ${fileName(path)}`
    this.el.hidden = false
    this.el.querySelector<HTMLElement>('.history-panel')!.focus()
    if (this.entries.length === 0) {
      this.list.innerHTML = ''
      this.preview.textContent = '还没有历史版本。保存文件时，会自动保留被覆盖之前的版本。'
      this.preview.classList.add('empty')
      this.restoreButton.disabled = true
      this.revealButton.disabled = true
      return
    }
    this.preview.classList.remove('empty')
    this.restoreButton.disabled = false
    this.revealButton.disabled = false
    await this.select(0)
  }

  close(): void {
    this.el.hidden = true
  }

  private async select(index: number): Promise<void> {
    const entry = this.entries[index]
    if (!entry) return
    this.selected = index
    this.list.innerHTML = this.entries
      .map(
        (item, i) => `
        <li class="history-item${i === index ? ' selected' : ''}" data-index="${i}">
          <span class="history-time">${formatTime(item.time)}</span>
          <span class="history-meta">${ago(item.time)} · ${formatSize(item.size)}</span>
        </li>`
      )
      .join('')
    this.list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' })
    this.content = await bridge.readHistory(this.path, entry.id).catch(() => '')
    if (this.selected !== index) return
    this.preview.textContent = this.content
    this.preview.scrollTop = 0
  }

  private restore(): void {
    if (this.entries.length === 0) return
    this.close()
    this.options.onRestore(this.content)
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      this.close()
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && this.entries.length > 0) {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      void this.select(Math.min(this.entries.length - 1, Math.max(0, this.selected + step)))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      this.restore()
    }
  }
}
