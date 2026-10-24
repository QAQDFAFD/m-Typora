import { THEMES, type ThemeId } from '../../shared/api'
import { escapeHtml } from './markdown-utils'
import type { Prefs } from './prefs'

type Section = 'general' | 'editor' | 'image' | 'export' | 'appearance'

const SECTIONS: Array<[Section, string]> = [
  ['general', '通用'],
  ['editor', '编辑器'],
  ['image', '图像'],
  ['export', '导出'],
  ['appearance', '外观']
]

export interface PreferencesHandlers {
  onChange(patch: Partial<Prefs>): void
  /** Uploads a sample image with the current settings; resolves to its URL. */
  onTestUpload(): Promise<string>
  onOpenThemeFolder(): void
  customThemes(): Array<{ id: ThemeId; label: string }>
  /** "访达" on macOS, "文件夹" elsewhere. */
  fileManager: string
}

const option = <T extends string | number>(value: T, label: string, current: T) =>
  `<option value="${escapeHtml(String(value))}" ${value === current ? 'selected' : ''}>${escapeHtml(label)}</option>`

const check = (key: keyof Prefs, label: string, prefs: Prefs) =>
  `<label class="prefs-row prefs-check"><input type="checkbox" data-pref="${key}" ${prefs[key] ? 'checked' : ''}/> ${label}</label>`

/** Typora-style preferences: categories on the left, settings on the right; drag the title to move it. */
export class PreferencesDialog {
  private section: Section = 'general'
  private offset = { x: 0, y: 0 }

  constructor(
    private el: HTMLElement,
    private handlers: PreferencesHandlers
  ) {
    el.addEventListener('mousedown', (event) => {
      if (event.target === el) this.close()
    })
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.close()
    })
  }

  isOpen(): boolean {
    return !this.el.hidden
  }

  open(prefs: Prefs): void {
    this.el.innerHTML = `
      <div class="prefs-panel" role="dialog" aria-label="偏好设置" tabindex="-1">
        <div class="prefs-header" title="拖动以移动">偏好设置<button class="prefs-close" title="关闭">✕</button></div>
        <div class="prefs-body">
          <nav class="prefs-nav">${SECTIONS.map(([id, label]) => `<button class="prefs-nav-item" data-section="${id}">${label}</button>`).join('')}</nav>
          <div class="prefs-content">${SECTIONS.map(([id]) => `<section class="prefs-section" data-section="${id}">${this.renderSection(id, prefs)}</section>`).join('')}</div>
        </div>
      </div>`
    this.el.hidden = false
    const panel = this.el.querySelector<HTMLElement>('.prefs-panel')!
    this.applyOffset(panel)
    this.showSection(this.section)
    panel.focus()
    this.bind(panel)
  }

  close(): void {
    this.el.hidden = true
  }

  /** Reflects changes made elsewhere (menus, shortcuts) while the dialog is open. */
  sync(prefs: Prefs): void {
    if (!this.isOpen()) return
    this.el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-pref]').forEach((control) => {
      const value = prefs[control.dataset.pref as keyof Prefs]
      if (control instanceof HTMLInputElement && control.type === 'checkbox') control.checked = Boolean(value)
      else if (document.activeElement !== control) control.value = String(value)
    })
    this.showService()
  }

  private renderSection(section: Section, prefs: Prefs): string {
    switch (section) {
      case 'general':
        return `
          <h3>保存</h3>
          ${check('autoSave', '自动保存', prefs)}
          <p class="prefs-hint">编辑后约 1 秒自动写入磁盘（仅对已保存过的文件）。</p>`
      case 'editor':
        return `
          <h3>输入</h3>
          ${check('autoPair', '自动配对括号和引号', prefs)}
          <h3>版面</h3>
          <label class="prefs-row">正文宽度
            <select data-pref="lineWidth">${option('default', '默认', prefs.lineWidth)}${option('wide', '较宽', prefs.lineWidth)}${option('full', '全宽', prefs.lineWidth)}</select>
          </label>`
      case 'image':
        return `
          <h3>插入图片时</h3>
          <label class="prefs-row">对本地图片
            <select data-pref="imageInsert">
              ${option('none', '无特殊操作', prefs.imageInsert)}
              ${option('assets', '复制到 ./assets 文件夹', prefs.imageInsert)}
              ${option('upload', '上传图片', prefs.imageInsert)}
            </select>
          </label>
          <p class="prefs-hint">拖入或粘贴图片时生效。也可以随时用「格式 › 上传全部本地图片」上传当前文档里的本地图片。</p>
          <h3>上传服务</h3>
          <label class="prefs-row">上传服务
            <select data-pref="uploadService">
              ${option('picgo-app', 'PicGo (app)', prefs.uploadService)}
              ${option('picgo-core', 'PicGo-Core (命令行)', prefs.uploadService)}
              ${option('custom', '自定义命令', prefs.uploadService)}
            </select>
          </label>
          <div class="prefs-service" data-service="picgo-app">
            <p class="prefs-hint">需要先运行 PicGo，并在 PicGo 的「设置 › 设置 Server」中开启 Server（默认端口 36677）。</p>
          </div>
          <div class="prefs-service" data-service="picgo-core">
            <label class="prefs-row">PicGo-Core 路径
              <input type="text" data-pref="picgoPath" value="${escapeHtml(prefs.picgoPath)}" placeholder="picgo" spellcheck="false" />
            </label>
            <p class="prefs-hint">留空则使用 PATH 中的 <code>picgo</code>（<code>npm install -g picgo</code>）；会执行 <code>picgo upload 图片路径</code>。</p>
          </div>
          <div class="prefs-service" data-service="custom">
            <label class="prefs-row">命令
              <input type="text" data-pref="uploadCommand" value="${escapeHtml(prefs.uploadCommand)}" placeholder="例如 /usr/local/bin/my-uploader" spellcheck="false" />
            </label>
            <p class="prefs-hint">图片路径会追加在命令后面；命令输出的最后几行（每张图片一行）应为图片地址。</p>
          </div>
          <div class="prefs-row">
            <button class="prefs-button" data-action="test-upload">验证图片上传选项</button>
          </div>
          <p class="prefs-status" data-status="upload" hidden></p>`
      case 'export':
        return `
          <h3>PDF</h3>
          <label class="prefs-row">纸张大小
            <select data-pref="pdfPageSize">${(['A4', 'A3', 'A5', 'Letter', 'Legal'] as const).map((size) => option(size, size, prefs.pdfPageSize)).join('')}</select>
          </label>
          <label class="prefs-row">页边距
            <select data-pref="pdfMargin">${option('default', '默认', prefs.pdfMargin)}${option('narrow', '窄', prefs.pdfMargin)}${option('wide', '宽', prefs.pdfMargin)}${option('none', '无', prefs.pdfMargin)}</select>
          </label>
          <h3>HTML</h3>
          ${check('htmlEmbedImages', '把本地图片嵌入 HTML 文件', prefs)}
          <p class="prefs-hint">不嵌入时，图片以相对 HTML 文件的路径引用。</p>
          <h3>导出之后</h3>
          <label class="prefs-row">导出完成后
            <select data-pref="afterExport">${option('none', '无操作', prefs.afterExport)}${option('open', '打开导出的文件', prefs.afterExport)}${option('reveal', `在${this.handlers.fileManager}中显示`, prefs.afterExport)}</select>
          </label>
          <p class="prefs-hint">导出 PDF / HTML 都在「文件 › 导出」中，导出的样式与当前主题一致。</p>`
      case 'appearance': {
        const custom = this.handlers.customThemes()
        return `
          <h3>主题</h3>
          <label class="prefs-row">主题
            <select data-pref="theme">
              ${THEMES.map((theme) => option<string>(theme.id, theme.label, prefs.theme)).join('')}
              ${custom.length > 0 ? `<optgroup label="自定义">${custom.map((theme) => option<string>(theme.id, theme.label, prefs.theme)).join('')}</optgroup>` : ''}
            </select>
          </label>
          <div class="prefs-row">
            <button class="prefs-button" data-action="theme-folder">打开主题文件夹</button>
          </div>
          <p class="prefs-hint">把自己写的 <code>.css</code> 放进主题文件夹并重启 m-typora，就能在这里和「主题」菜单中选择它；文件夹里的 README 有示例。</p>
          <h3>字体与界面</h3>
          <label class="prefs-row">字体大小
            <select data-pref="fontSize">${[14, 15, 16, 17, 18, 20].map((size) => option(size, `${size}px`, prefs.fontSize)).join('')}</select>
          </label>
          ${check('statusBar', '显示状态栏', prefs)}`
      }
    }
  }

  private showSection(section: Section): void {
    this.section = section
    this.el.querySelectorAll<HTMLElement>('[data-section]').forEach((el) => {
      if (el.classList.contains('prefs-nav-item')) el.classList.toggle('active', el.dataset.section === section)
      else el.hidden = el.dataset.section !== section
    })
    this.showService()
  }

  /** Only the settings of the chosen upload service are shown. */
  private showService(): void {
    const service = this.el.querySelector<HTMLSelectElement>('[data-pref="uploadService"]')?.value
    this.el.querySelectorAll<HTMLElement>('.prefs-service').forEach((el) => (el.hidden = el.dataset.service !== service))
  }

  private bind(panel: HTMLElement): void {
    panel.querySelector('.prefs-close')!.addEventListener('click', () => this.close())
    panel.querySelector('.prefs-nav')!.addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('[data-section]')
      if (item) this.showSection(item.dataset.section as Section)
    })
    panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-pref]').forEach((control) => {
      control.addEventListener('change', () => {
        const key = control.dataset.pref as keyof Prefs
        const value =
          control instanceof HTMLInputElement && control.type === 'checkbox'
            ? control.checked
            : key === 'fontSize'
              ? Number(control.value)
              : control.value
        this.handlers.onChange({ [key]: value } as Partial<Prefs>)
        if (key === 'uploadService') this.showService()
      })
    })
    panel.querySelector('[data-action="theme-folder"]')?.addEventListener('click', () => this.handlers.onOpenThemeFolder())
    panel.querySelector('[data-action="test-upload"]')?.addEventListener('click', () => void this.testUpload(panel))
    this.bindDrag(panel)
  }

  private async testUpload(panel: HTMLElement): Promise<void> {
    const status = panel.querySelector<HTMLElement>('[data-status="upload"]')!
    const button = panel.querySelector<HTMLButtonElement>('[data-action="test-upload"]')!
    // Text fields only commit on change; make sure what is typed is what gets tested.
    panel.querySelectorAll<HTMLInputElement>('input[type="text"][data-pref]').forEach((input) => input.dispatchEvent(new Event('change')))
    status.hidden = false
    status.className = 'prefs-status'
    status.textContent = '正在上传测试图片…'
    button.disabled = true
    try {
      const url = await this.handlers.onTestUpload()
      status.classList.add('ok')
      status.innerHTML = `上传成功：<a href="${escapeHtml(url)}" target="_blank">${escapeHtml(url)}</a>`
    } catch (error) {
      status.classList.add('error')
      status.textContent = `上传失败：${(error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`
    } finally {
      button.disabled = false
    }
  }

  /** Dragging the title moves the dialog; it stays where it was left until the app quits. */
  private bindDrag(panel: HTMLElement): void {
    const header = panel.querySelector<HTMLElement>('.prefs-header')!
    header.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
      event.preventDefault()
      const start = { x: event.clientX - this.offset.x, y: event.clientY - this.offset.y }
      const base = panel.getBoundingClientRect()
      const origin = { left: base.left - this.offset.x, top: base.top - this.offset.y }
      panel.classList.add('dragging')
      const onMove = (move: MouseEvent) => {
        // Keep the title bar reachable inside the window.
        const x = Math.min(window.innerWidth - origin.left - 80, Math.max(-origin.left - base.width + 80, move.clientX - start.x))
        const y = Math.min(window.innerHeight - origin.top - 40, Math.max(-origin.top, move.clientY - start.y))
        this.offset = { x, y }
        this.applyOffset(panel)
      }
      const onUp = () => {
        panel.classList.remove('dragging')
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    })
  }

  private applyOffset(panel: HTMLElement): void {
    panel.style.transform = `translate(${this.offset.x}px, ${this.offset.y}px)`
  }
}
