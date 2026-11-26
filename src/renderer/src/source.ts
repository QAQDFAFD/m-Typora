import { defaultKeymap, deleteLine, history, historyKeymap, indentWithTab, redo, selectAll, undo } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { findNext, findPrevious, openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { EditorState, type ChangeSpec } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, keymap } from '@codemirror/view'
import type { MenuCommand } from '../../shared/api'
import { sourceHighlight } from './code-theme'

const WRAP: Partial<Record<MenuCommand, [string, string]>> = {
  strong: ['**', '**'],
  emphasis: ['*', '*'],
  'inline-code': ['`', '`'],
  strike: ['~~', '~~'],
  underline: ['<u>', '</u>']
}

const LINE_PREFIX: Partial<Record<MenuCommand, string>> = {
  quote: '> ',
  'bullet-list': '- ',
  'task-list': '- [ ] '
}

const SEARCH_PHRASES: Record<string, string> = {
  Find: '查找',
  Replace: '替换',
  next: '下一个',
  previous: '上一个',
  all: '全部选中',
  'match case': '区分大小写',
  regexp: '正则',
  'by word': '全词匹配',
  replace: '替换',
  'replace all': '全部替换',
  close: '关闭',
  'Go to line': '跳转到行',
  go: '跳转',
  'current match': '当前匹配',
  'on line': '第',
  'replaced match on line $': '已替换第 $ 行的匹配项',
  'replaced $ matches': '已替换 $ 处匹配项'
}

/** Toggles a line-start Markdown prefix (or numbered items for ordered lists) across selected lines. */
function toggleLinePrefix(view: EditorView, kind: 'ordered' | string): boolean {
  const { state } = view
  const { from, to } = state.selection.main
  const startLine = state.doc.lineAt(from).number
  const endLine = state.doc.lineAt(Math.max(from, to > from && state.doc.lineAt(to).from === to ? to - 1 : to)).number
  const lines = Array.from({ length: endLine - startLine + 1 }, (_, i) => state.doc.line(startLine + i))
  const orderedRe = /^\d+\.\s/
  const allMarked = lines.every((line) => (kind === 'ordered' ? orderedRe.test(line.text) : line.text.startsWith(kind)))
  const changes: ChangeSpec[] = lines.map((line, idx) => {
    if (allMarked) {
      const len = kind === 'ordered' ? orderedRe.exec(line.text)![0].length : kind.length
      return { from: line.from, to: line.from + len, insert: '' }
    }
    return { from: line.from, insert: kind === 'ordered' ? `${idx + 1}. ` : kind }
  })
  view.dispatch({ changes })
  return true
}

/** Inserts a fenced multi-line block (``` or $$) around the selection or at the caret. */
function insertFencedBlock(view: EditorView, openFence: string, closeFence: string, caretAtHeaderEnd = false): boolean {
  const { state } = view
  const { from, to } = state.selection.main
  const selected = state.sliceDoc(from, to)
  const line = state.doc.lineAt(from)
  const needsNewline = from > line.from && line.text.slice(0, from - line.from).trim().length > 0
  const prefix = needsNewline ? '\n' : ''
  const insert = `${prefix}${openFence}\n${selected}\n${closeFence}`
  const anchor = caretAtHeaderEnd ? from + prefix.length + openFence.length : from + prefix.length + openFence.length + 1
  view.dispatch({ changes: { from, to, insert }, selection: { anchor, head: anchor + (caretAtHeaderEnd ? 0 : selected.length) } })
  return true
}

/** Source-code mode: the raw markdown in CodeMirror 6, styled like Typora's source view. */
export class SourceEditor {
  private view: EditorView
  private silent = false

  constructor(root: HTMLElement, onChange: (markdown: string) => void) {
    this.view = new EditorView({
      parent: root,
      state: EditorState.create({
        doc: '',
        extensions: [
          history(),
          drawSelection(),
          highlightActiveLine(),
          search({ top: true }),
          EditorState.phrases.of(SEARCH_PHRASES),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          sourceHighlight,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ spellcheck: 'false' }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !this.silent) onChange(update.state.doc.toString())
          })
        ]
      })
    })
  }

  getMarkdown(): string {
    return this.view.state.doc.toString()
  }

  setMarkdown(text: string): void {
    this.silent = true
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } })
    this.silent = false
  }

  focus(): void {
    this.view.focus()
  }

  getCaret(): number {
    return this.view.state.selection.main.head
  }

  setCaret(pos: number): void {
    const anchor = Math.max(0, Math.min(pos, this.view.state.doc.length))
    this.view.dispatch({ selection: { anchor } })
  }

  hasSelection(): boolean {
    return !this.view.state.selection.main.empty
  }

  selectedText(): string {
    const { from, to } = this.view.state.selection.main
    return this.view.state.sliceDoc(from, to)
  }

  /** Moves the cursor to a 1-based line and scrolls it to the top. */
  revealLine(line: number): void {
    const target = this.view.state.doc.line(Math.min(Math.max(line, 1), this.view.state.doc.lines))
    this.view.dispatch({
      selection: { anchor: target.from },
      effects: EditorView.scrollIntoView(target.from, { y: 'start', yMargin: 24 })
    })
    this.view.focus()
  }

  /** Runs menu/shortcut commands in raw Markdown text. */
  exec(command: MenuCommand): boolean {
    const view = this.view
    if (command === 'undo') return undo(view)
    if (command === 'redo') return redo(view)
    if (command === 'select-all') return selectAll(view)
    if (command === 'find' || command === 'replace') return openSearchPanel(view)
    if (command === 'find-next') return findNext(view)
    if (command === 'find-prev') return findPrevious(view)
    if (command === 'delete-line') return deleteLine(view)

    const pair = WRAP[command]
    if (pair) {
      const [open, close] = pair
      const { from, to } = view.state.selection.main
      view.dispatch({
        changes: [
          { from, insert: open },
          { from: to, insert: close }
        ],
        selection: { anchor: from + open.length, head: to + open.length }
      })
      return true
    }

    const prefix = LINE_PREFIX[command]
    if (prefix) return toggleLinePrefix(view, prefix)
    if (command === 'ordered-list') return toggleLinePrefix(view, 'ordered')

    const heading = /^heading-(\d)$/.exec(command)
    if (heading || command === 'paragraph' || command === 'heading-up' || command === 'heading-down') {
      const line = view.state.doc.lineAt(view.state.selection.main.head)
      const match = /^(#{1,6})\s+/.exec(line.text)
      const current = match ? match[1].length : 0
      const oldLen = match ? match[0].length : 0
      let next = 0
      if (heading) {
        const target = Number(heading[1])
        next = current === target ? 0 : target
      } else if (command === 'heading-up') {
        if (current === 1) return false
        next = current === 0 ? 6 : current - 1
      } else if (command === 'heading-down') {
        if (current === 0) return false
        next = current === 6 ? 0 : current + 1
      }
      const insert = next > 0 ? `${'#'.repeat(next)} ` : ''
      view.dispatch({ changes: { from: line.from, to: line.from + oldLen, insert } })
      return true
    }

    const { from, to } = view.state.selection.main
    switch (command) {
      case 'select-line': {
        const line = view.state.doc.lineAt(view.state.selection.main.head)
        view.dispatch({ selection: { anchor: line.from, head: line.to } })
        return true
      }
      case 'select-word': {
        const word = view.state.wordAt(view.state.selection.main.head)
        if (!word) return false
        view.dispatch({ selection: { anchor: word.from, head: word.to } })
        return true
      }
      case 'link': {
        const selected = view.state.sliceDoc(from, to)
        const insert = `[${selected}]()`
        const caret = selected ? from + selected.length + 3 : from + 1
        view.dispatch({ changes: { from, to, insert }, selection: { anchor: caret } })
        return true
      }
      case 'image': {
        view.dispatch({ changes: { from, to, insert: '![]()' }, selection: { anchor: from + 4 } })
        return true
      }
      case 'code-fence':
        return insertFencedBlock(view, '```', '```', from === to)
      case 'math-block':
        return insertFencedBlock(view, '$$', '$$', false)
      case 'table': {
        const snippet = '| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n'
        view.dispatch({ changes: { from, to, insert: snippet }, selection: { anchor: from + 2, head: from + 5 } })
        return true
      }
      case 'hr': {
        const line = view.state.doc.lineAt(from)
        const insert = from > line.from ? '\n---\n' : '---\n'
        view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } })
        return true
      }
      case 'clear-format': {
        if (from === to) return false
        const cleaned = view.state.sliceDoc(from, to).replace(/(\*\*|\*|~~|`|<u>|<\/u>)/g, '')
        view.dispatch({ changes: { from, to, insert: cleaned }, selection: { anchor: from, head: from + cleaned.length } })
        return true
      }
      default:
        return false
    }
  }
}
