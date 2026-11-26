import { languages } from '@codemirror/language-data'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { AttrStep } from '@milkdown/kit/prose/transform'
import { $prose } from '@milkdown/kit/utils'

/** Fence identifier written to Markdown for a language picked by its display name. */
const FENCE_NAMES = new Map(
  languages.map((language) => {
    const lower = language.name.toLowerCase()
    return [language.name, /^[\w-]+$/.test(lower) ? lower : (language.alias.find((a) => /^[\w-]+$/.test(a)) ?? lower)]
  })
)

function focusCodeBody(block: Element | null): void {
  requestAnimationFrame(() => block?.querySelector<HTMLElement>('.cm-content')?.focus())
}

/**
 * The language picker stores display names ("Python", "C++"); Typora writes the usual
 * lowercase fence identifiers (```python, ```cpp). Also wires Enter/Escape keyboard control
 * for the language search box and "已复制" feedback on the copy button.
 */
export const codeLanguagePlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey('mtypora-code-language'),
      appendTransaction(transactions, _old, state) {
        const tr = state.tr
        transactions.forEach((transaction, t) => {
          transaction.steps.forEach((step, s) => {
            if (!(step instanceof AttrStep) || step.attr !== 'language') return
            const fence = FENCE_NAMES.get(step.value)
            if (!fence || fence === step.value) return
            let pos = transaction.mapping.slice(s + 1).map(step.pos)
            for (const later of transactions.slice(t + 1)) pos = later.mapping.map(pos)
            if (state.doc.nodeAt(pos)?.attrs.language === step.value) tr.setNodeAttribute(pos, 'language', fence)
          })
        })
        return tr.docChanged ? tr : null
      },
      view(view) {
        const timers = new WeakMap<HTMLButtonElement, number>()
        const pending = new Set<number>()

        const onKeyDown = (event: KeyboardEvent) => {
          if (event.isComposing || event.keyCode === 229) return
          const target = event.target as HTMLElement | null
          const search = target?.closest<HTMLInputElement>('.milkdown-code-block .list-wrapper .search-input')
          if (!search) return
          const block = search.closest('.milkdown-code-block')
          if (event.key === 'Enter') {
            event.preventDefault()
            event.stopPropagation()
            const first = search.closest('.list-wrapper')?.querySelector<HTMLElement>('.language-list-item')
            if (first) {
              first.click()
              focusCodeBody(block)
            }
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            block?.querySelector<HTMLElement>('.language-button[data-expanded="true"]')?.click()
            focusCodeBody(block)
          }
        }

        const onClick = (event: MouseEvent) => {
          const btn = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('.milkdown-code-block .copy-button')
          if (!btn) return
          const textNode = Array.from(btn.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
          if (!textNode) return
          btn.dataset.copyLabel ??= textNode.textContent ?? '复制'
          textNode.textContent = '已复制'
          btn.classList.add('copied')
          const prev = timers.get(btn)
          if (prev !== undefined) {
            window.clearTimeout(prev)
            pending.delete(prev)
          }
          const timer = window.setTimeout(() => {
            pending.delete(timer)
            if (btn.isConnected && btn.dataset.copyLabel !== undefined) {
              textNode.textContent = btn.dataset.copyLabel
              btn.classList.remove('copied')
            }
          }, 1500)
          timers.set(btn, timer)
          pending.add(timer)
        }

        view.dom.addEventListener('keydown', onKeyDown, true)
        view.dom.addEventListener('click', onClick)
        return {
          destroy() {
            view.dom.removeEventListener('keydown', onKeyDown, true)
            view.dom.removeEventListener('click', onClick)
            for (const timer of pending) window.clearTimeout(timer)
            pending.clear()
          }
        }
      }
    })
)
