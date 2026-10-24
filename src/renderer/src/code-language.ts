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

/**
 * The language picker stores display names ("Python", "C++"); Typora writes the usual
 * lowercase fence identifiers (```python, ```cpp). Only picker changes are rewritten —
 * a language already written in the file is kept exactly as it is.
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
      }
    })
)
