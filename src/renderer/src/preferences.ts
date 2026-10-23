import { THEMES } from '../../shared/api'
import type { LineWidth, Prefs } from './prefs'

/** A compact version of Typora's preferences window, shown as a sheet. */
export class PreferencesDialog {
  constructor(private el: HTMLElement, private onChange: (patch: Partial<Prefs>) => void) {
    el.addEventListener('mousedown', (event) => {
      if (event.target === el) this.close()
    })
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.close()
    })
  }

  open(prefs: Prefs): void {
    this.el.innerHTML = `
      <div class="prefs-panel" role="dialog" aria-label="偏好设置" tabindex="-1">
        <div class="prefs-header">偏好设置<button class="prefs-close" title="关闭">✕</button></div>
        <section>
          <h3>通用</h3>
          <label class="prefs-row"><input type="checkbox" data-pref="autoSave" ${prefs.autoSave ? 'checked' : ''}/> 自动保存</label>
        </section>
        <section>
          <h3>外观</h3>
          <label class="prefs-row">主题
            <select data-pref="theme">${THEMES.map((t) => `<option value="${t.id}" ${t.id === prefs.theme ? 'selected' : ''}>${t.label}</option>`).join('')}</select>
          </label>
          <label class="prefs-row">字体大小
            <select data-pref="fontSize">${[14, 15, 16, 17, 18, 20].map((s) => `<option value="${s}" ${s === prefs.fontSize ? 'selected' : ''}>${s}px</option>`).join('')}</select>
          </label>
          <label class="prefs-row">正文宽度
            <select data-pref="lineWidth">${(
              [
                ['default', '默认'],
                ['wide', '较宽'],
                ['full', '全宽']
              ] as Array<[LineWidth, string]>
            )
              .map(([value, label]) => `<option value="${value}" ${value === prefs.lineWidth ? 'selected' : ''}>${label}</option>`)
              .join('')}</select>
          </label>
          <label class="prefs-row"><input type="checkbox" data-pref="statusBar" ${prefs.statusBar ? 'checked' : ''}/> 显示状态栏</label>
        </section>
        <section>
          <h3>编辑器</h3>
          <label class="prefs-row"><input type="checkbox" data-pref="autoPair" ${prefs.autoPair ? 'checked' : ''}/> 自动配对括号和引号</label>
        </section>
      </div>`
    this.el.hidden = false
    this.el.querySelector<HTMLElement>('.prefs-panel')!.focus()
    this.el.querySelector('.prefs-close')!.addEventListener('click', () => this.close())
    this.el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-pref]').forEach((control) => {
      control.addEventListener('change', () => {
        const key = control.dataset.pref as keyof Prefs
        const value =
          control instanceof HTMLInputElement && control.type === 'checkbox'
            ? control.checked
            : key === 'fontSize'
              ? Number(control.value)
              : control.value
        this.onChange({ [key]: value } as Partial<Prefs>)
      })
    })
  }

  close(): void {
    this.el.hidden = true
  }
}
