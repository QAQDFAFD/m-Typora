import { history, redo, undo } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { openSearchPanel, findNext, findPrevious, search } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, keymap } from '@codemirror/view'
import { defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands'
import { searchKeymap } from '@codemirror/search'
import type { MenuCommand } from '../../shared/api'
import { sourceHighlight } from './code-theme'

const WRAP: Partial<Record<MenuCommand, string>> = {
  strong: '**',
  emphasis: '*',
  'inline-code': '`',
  strike: '~~'
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
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          sourceHighlight,
          EditorView.lineWrapping,
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

  /** The subset of menu commands that make sense on raw text. */
  exec(command: MenuCommand): boolean {
    const view = this.view
    if (command === 'undo') return undo(view)
    if (command === 'redo') return redo(view)
    if (command === 'find' || command === 'replace') return openSearchPanel(view)
    if (command === 'find-next') return findNext(view)
    if (command === 'find-prev') return findPrevious(view)

    const marker = WRAP[command]
    if (marker) {
      const { from, to } = view.state.selection.main
      view.dispatch({
        changes: [
          { from, insert: marker },
          { from: to, insert: marker }
        ],
        selection: { anchor: from + marker.length, head: to + marker.length }
      })
      return true
    }

    const heading = /^heading-(\d)$/.exec(command)
    if (heading || command === 'paragraph') {
      const line = view.state.doc.lineAt(view.state.selection.main.head)
      const prefix = /^#{1,6}\s+/.exec(line.text)?.[0] ?? ''
      const insert = heading ? `${'#'.repeat(Number(heading[1]))} ` : ''
      view.dispatch({ changes: { from: line.from, to: line.from + prefix.length, insert } })
      return true
    }
    return false
  }
}
