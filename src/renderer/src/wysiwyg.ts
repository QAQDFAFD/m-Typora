import { Crepe } from '@milkdown/crepe'
import { editorViewCtx, remarkStringifyOptionsCtx, schemaCtx, serializerCtx, type CmdKey } from '@milkdown/kit/core'
import { redo, undo } from '@milkdown/kit/prose/history'
import { DOMSerializer, type Node as ProseNode } from '@milkdown/kit/prose/model'
import { Selection, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import {
  createCodeBlockCommand,
  insertHrCommand,
  insertImageCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand
} from '@milkdown/kit/preset/commonmark'
import { insertTableCommand, toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm'
import { callCommand, replaceAll } from '@milkdown/kit/utils'
import type { MenuCommand } from '../../shared/api'
import { createAutoPairPlugin } from './auto-pair'
import { codeFenceTheme } from './code-theme'
import { createFocusPlugin } from './focus-plugin'
import { searchPlugin } from './search-plugin'
import { syntaxRevealPlugin } from './syntax-reveal'

export interface WysiwygOptions {
  root: HTMLElement
  onChange(markdown: string): void
  onCursorMove(view: EditorView): void
  /** Turns a markdown image src into something the webview can load. */
  resolveImage(src: string): string
  /** Persists a pasted/dropped image and returns the src to write into markdown. */
  uploadImage(file: File): Promise<string>
  autoPair(): boolean
}

const BULLET_ICON = '<span class="md-bullet"></span>'
const CHECKED_ICON = '<span class="md-task-box checked"></span>'
const UNCHECKED_ICON = '<span class="md-task-box"></span>'

/** Typora-style seamless editor built on Milkdown Crepe (ProseMirror + remark). */
export class WysiwygEditor {
  private crepe: Crepe
  private ready: Promise<unknown>

  constructor(private options: WysiwygOptions) {
    this.crepe = new Crepe({
      root: options.root,
      defaultValue: '',
      features: {
        // Typora has no floating block handles, slash menu, selection toolbar or placeholder.
        [Crepe.Feature.BlockEdit]: false,
        [Crepe.Feature.Toolbar]: false,
        [Crepe.Feature.Placeholder]: false,
        [Crepe.Feature.TopBar]: false,
        [Crepe.Feature.AI]: false
      },
      featureConfigs: {
        // Native caret like Typora; keep only the drop / gap cursors.
        [Crepe.Feature.Cursor]: { virtual: false, color: '#9fb8e8', width: 2 },
        [Crepe.Feature.CodeMirror]: { theme: codeFenceTheme, searchPlaceholder: '搜索语言', noResultText: '无匹配', copyText: '复制', previewLabel: '预览' },
        [Crepe.Feature.ListItem]: { bulletIcon: BULLET_ICON, checkBoxCheckedIcon: CHECKED_ICON, checkBoxUncheckedIcon: UNCHECKED_ICON },
        [Crepe.Feature.ImageBlock]: {
          onUpload: options.uploadImage,
          blockOnUpload: options.uploadImage,
          inlineOnUpload: options.uploadImage,
          proxyDomURL: options.resolveImage,
          blockUploadPlaceholderText: '粘贴图片链接，或',
          blockUploadButton: '选择文件',
          blockConfirmButton: '确定',
          blockCaptionPlaceholderText: '图片描述',
          inlineUploadPlaceholderText: '粘贴图片链接，或',
          inlineUploadButton: '选择文件',
          inlineConfirmButton: '确定'
        }
      }
    })
    // Write Markdown the way Typora does: "-" bullets, "---" rules, "*" emphasis.
    this.crepe.editor.config((ctx) => {
      ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, bullet: '-' as const, rule: '-' as const, emphasis: '*' as const, strong: '*' as const }))
    })
    this.crepe.editor
      .use(syntaxRevealPlugin)
      .use(searchPlugin)
      .use(createAutoPairPlugin(options.autoPair))
      .use(createFocusPlugin(options.onCursorMove))
    this.crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => options.onChange(markdown))
    })
    this.ready = this.crepe.create()
  }

  whenReady(): Promise<unknown> {
    return this.ready
  }

  getMarkdown(): string {
    return this.crepe.getMarkdown()
  }

  /** Replaces the whole document. `resetHistory` is used when opening another file. */
  setMarkdown(markdown: string, resetHistory: boolean): void {
    this.crepe.editor.action(replaceAll(markdown, resetHistory))
  }

  view(): EditorView {
    return this.crepe.editor.action((ctx) => ctx.get(editorViewCtx))
  }

  focus(): void {
    this.view().focus()
  }

  focusEnd(): void {
    const view = this.view()
    view.dispatch(view.state.tr.setSelection(Selection.atEnd(view.state.doc)).scrollIntoView())
    view.focus()
  }

  focusStart(): void {
    const view = this.view()
    view.dispatch(view.state.tr.setSelection(Selection.atStart(view.state.doc)))
    view.focus()
  }

  headingElements(): HTMLElement[] {
    return Array.from(this.options.root.querySelectorAll<HTMLElement>('.ProseMirror > :is(h1, h2, h3, h4, h5, h6)'))
  }

  hasSelection(): boolean {
    return !this.view().state.selection.empty
  }

  /** Serializes the document to clean, semantic HTML (no editor chrome). */
  toHtml(): string {
    return this.crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      return this.fragmentHtml(ctx.get(schemaCtx), view.state.doc)
    })
  }

  /** Markdown and HTML for the current selection (used by "Copy as Markdown / HTML"). */
  selectionAs(): { markdown: string; html: string } {
    return this.crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const schema = ctx.get(schemaCtx)
      const slice = view.state.selection.content()
      const doc = schema.topNodeType.createAndFill(undefined, slice.content) ?? view.state.doc
      return { markdown: ctx.get(serializerCtx)(doc), html: this.fragmentHtml(schema, doc) }
    })
  }

  private fragmentHtml(schema: Parameters<typeof DOMSerializer.fromSchema>[0], doc: ProseNode): string {
    const container = document.createElement('div')
    container.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(doc.content))
    return container.innerHTML
  }

  /** Runs a Paragraph / Format / Edit menu command. Returns false when not applicable. */
  exec(command: MenuCommand): boolean {
    const view = this.view()
    const call = <T>(key: CmdKey<T>, payload?: T) => this.crepe.editor.action(callCommand(key, payload))
    const heading = /^heading-(\d)$/.exec(command)
    if (heading) {
      const level = Number(heading[1])
      return this.currentHeadingLevel() === level ? call(turnIntoTextCommand.key) : call(wrapInHeadingCommand.key, level)
    }
    switch (command) {
      case 'undo':
        return undo(view.state, view.dispatch)
      case 'redo':
        return redo(view.state, view.dispatch)
      case 'paragraph':
        return call(turnIntoTextCommand.key)
      case 'heading-up': {
        const level = this.currentHeadingLevel()
        if (level === 1) return false
        return call(wrapInHeadingCommand.key, level === 0 ? 6 : level - 1)
      }
      case 'heading-down': {
        const level = this.currentHeadingLevel()
        if (level === 0) return false
        return level === 6 ? call(turnIntoTextCommand.key) : call(wrapInHeadingCommand.key, level + 1)
      }
      case 'quote':
        return call(wrapInBlockquoteCommand.key)
      case 'ordered-list':
        return call(wrapInOrderedListCommand.key)
      case 'bullet-list':
        return call(wrapInBulletListCommand.key)
      case 'task-list':
        if (!this.insideListItem()) call(wrapInBulletListCommand.key)
        return this.markTaskItem()
      case 'code-fence':
        return call(createCodeBlockCommand.key, '')
      case 'math-block':
        return call(createCodeBlockCommand.key, 'latex')
      case 'table':
        return call(insertTableCommand.key, { row: 3, col: 3 })
      case 'hr':
        return call(insertHrCommand.key)
      case 'strong':
        return call(toggleStrongCommand.key)
      case 'emphasis':
        return call(toggleEmphasisCommand.key)
      case 'inline-code':
        return call(toggleInlineCodeCommand.key)
      case 'strike':
        return call(toggleStrikethroughCommand.key)
      case 'link':
        return call(toggleLinkCommand.key, { href: '' })
      case 'image':
        return call(insertImageCommand.key, { src: '', alt: '' })
      case 'clear-format': {
        const { from, to } = view.state.selection
        view.dispatch(view.state.tr.removeMark(from, to))
        return true
      }
      case 'select-line': {
        const { $from } = view.state.selection
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, $from.start(), $from.end())))
        return true
      }
      case 'select-word':
        return this.selectWord()
      case 'select-styled':
        return this.selectStyledRun()
      case 'delete-line': {
        const { $from } = view.state.selection
        if ($from.depth === 0) return false
        view.dispatch(view.state.tr.delete($from.before(1), $from.after(1)))
        return true
      }
      default:
        return false
    }
  }

  private currentHeadingLevel(): number {
    const { $from } = this.view().state.selection
    return $from.parent.type.name === 'heading' ? Number($from.parent.attrs.level) : 0
  }

  private insideListItem(): boolean {
    const { $from } = this.view().state.selection
    for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type.name === 'list_item') return true
    return false
  }

  private markTaskItem(): boolean {
    const view = this.view()
    const { $from } = view.state.selection
    for (let depth = $from.depth; depth > 0; depth--) {
      const node = $from.node(depth)
      if (node.type.name === 'list_item') {
        view.dispatch(view.state.tr.setNodeMarkup($from.before(depth), undefined, { ...node.attrs, checked: false }))
        return true
      }
    }
    return false
  }

  private selectWord(): boolean {
    const view = this.view()
    const { $from } = view.state.selection
    const text = $from.parent.textContent
    const offset = $from.parentOffset
    const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch)
    let start = offset
    let end = offset
    while (isWord(text[start - 1])) start--
    while (isWord(text[end])) end++
    if (start === end) return false
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, $from.start() + start, $from.start() + end)))
    return true
  }

  private selectStyledRun(): boolean {
    const view = this.view()
    const { $from } = view.state.selection
    const marks = $from.marks()
    if (marks.length === 0) return false
    const mark = marks[0]
    // Collect contiguous runs of this mark, then select the run around the caret.
    const runs: Array<{ from: number; to: number }> = []
    const start = $from.start()
    $from.parent.forEach((child, offset) => {
      if (!mark.isInSet(child.marks)) return
      const from = start + offset
      const last = runs[runs.length - 1]
      if (last && last.to === from) last.to = from + child.nodeSize
      else runs.push({ from, to: from + child.nodeSize })
    })
    const run = runs.find((r) => r.from <= $from.pos && $from.pos <= r.to)
    if (!run) return false
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, run.from, run.to)))
    return true
  }
}
