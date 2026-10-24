import { commandsCtx, editorViewCtx, type CmdKey } from '@milkdown/kit/core'
import type { Node as ProseNode, Schema } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, TextSelection, type EditorState, type PluginView } from '@milkdown/kit/prose/state'
import { deleteTable, isInTable, selectedRect, TableMap } from '@milkdown/kit/prose/tables'
import type { EditorView } from '@milkdown/kit/prose/view'
import {
  addColAfterCommand,
  addColBeforeCommand,
  addRowAfterCommand,
  addRowBeforeCommand,
  deleteSelectedCellsCommand,
  moveColCommand,
  moveRowCommand,
  selectColCommand,
  selectRowCommand,
  setAlignCommand
} from '@milkdown/kit/preset/gfm'
import { $prose, $useKeymap } from '@milkdown/kit/utils'
import type { MenuCommand } from '../../shared/api'

export type TableCommand = Extract<MenuCommand, `table-${string}`>
type Call = <T>(key: CmdKey<T>, payload?: T) => boolean
type Alignment = 'left' | 'center' | 'right'

interface TableInfo {
  table: ProseNode
  tablePos: number
  map: TableMap
  row: number
  col: number
}

export function tableInfo(state: EditorState): TableInfo | null {
  if (!isInTable(state)) return null
  const rect = selectedRect(state)
  return { table: rect.table, tablePos: rect.tableStart - 1, map: rect.map, row: rect.top, col: rect.left }
}

/** Puts the caret at the start of a cell (clamped to the table's size). */
function focusCell(view: EditorView, tablePos: number, row: number, col: number): void {
  const table = view.state.doc.nodeAt(tablePos)
  if (!table || table.type.name !== 'table') return
  const map = TableMap.get(table)
  const r = Math.max(0, Math.min(row, map.height - 1))
  const c = Math.max(0, Math.min(col, map.width - 1))
  const cellPos = tablePos + 1 + map.map[r * map.width + c]
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(cellPos + 1))).scrollIntoView())
}

function cellAlignment(info: TableInfo): Alignment {
  const header = info.table.child(0)
  return (header.maybeChild(info.col)?.attrs.alignment as Alignment) ?? 'left'
}

/** A copy of `table` with `rows` × `cols` cells, keeping existing content and column alignment. */
export function resizedTable(schema: Schema, table: ProseNode, rows: number, cols: number): ProseNode {
  const { table: tableType, table_header_row, table_row, table_header, table_cell } = schema.nodes
  const header = table.child(0)
  const alignment = (c: number) => (header.maybeChild(c)?.attrs.alignment as string) ?? 'left'
  const newRows: ProseNode[] = []
  for (let r = 0; r < rows; r++) {
    const isHeader = r === 0
    const cellType = isHeader ? table_header : table_cell
    const old = r < table.childCount ? table.child(r) : null
    const cells: ProseNode[] = []
    for (let c = 0; c < cols; c++) {
      const existing = old?.maybeChild(c)
      const attrs = { ...(existing?.attrs ?? {}), alignment: alignment(c) }
      cells.push(cellType.createAndFill(attrs, existing?.content)!)
    }
    newRows.push((isHeader ? table_header_row : table_row).create(null, cells))
  }
  return tableType.create(table.attrs, newRows)
}

/** `| a | b |` + Enter turns into a table with that header and one empty row, as in Typora. */
function tableFromPipeRow(schema: Schema, text: string): ProseNode | null {
  const match = /^\s*\|(.*\|)\s*$/.exec(text)
  if (!match) return null
  const titles = match[1].slice(0, -1).split('|').map((cell) => cell.trim())
  if (titles.length === 0) return null
  const { table, table_header_row, table_row, table_header, table_cell, paragraph } = schema.nodes
  const header = table_header_row.create(
    null,
    titles.map((title) => table_header.create({ alignment: 'left' }, paragraph.create(null, title ? schema.text(title) : undefined)))
  )
  const body = table_row.create(
    null,
    titles.map(() => table_cell.createAndFill({ alignment: 'left' })!)
  )
  return table.create(null, [header, body])
}

/** Runs one Paragraph › Table command. Returns false when the caret is not in a table. */
export function runTableCommand(command: TableCommand, view: EditorView, call: Call): boolean {
  const info = tableInfo(view.state)
  if (!info) return false
  const { tablePos, map, row, col } = info
  const inside = tablePos + 1
  switch (command) {
    case 'table-row-above':
      if (row === 0) return false
      call(addRowBeforeCommand.key)
      focusCell(view, tablePos, row, col)
      return true
    case 'table-row-below':
      call(addRowAfterCommand.key)
      focusCell(view, tablePos, row + 1, col)
      return true
    case 'table-col-left':
      call(addColBeforeCommand.key)
      focusCell(view, tablePos, row, col)
      return true
    case 'table-col-right':
      call(addColAfterCommand.key)
      focusCell(view, tablePos, row, col + 1)
      return true
    case 'table-row-up':
      if (row <= 1) return false
      call(moveRowCommand.key, { from: row, to: row - 1, pos: inside })
      focusCell(view, tablePos, row - 1, col)
      return true
    case 'table-row-down':
      if (row === 0 || row >= map.height - 1) return false
      call(moveRowCommand.key, { from: row, to: row + 1, pos: inside })
      focusCell(view, tablePos, row + 1, col)
      return true
    case 'table-col-move-left':
      if (col === 0) return false
      call(moveColCommand.key, { from: col, to: col - 1, pos: inside })
      focusCell(view, tablePos, row, col - 1)
      return true
    case 'table-col-move-right':
      if (col >= map.width - 1) return false
      call(moveColCommand.key, { from: col, to: col + 1, pos: inside })
      focusCell(view, tablePos, row, col + 1)
      return true
    case 'table-delete-row':
      // The header row cannot be removed, and a table keeps at least one body row.
      if (row === 0 || map.height <= 2) return false
      call(selectRowCommand.key, { index: row, pos: inside })
      call(deleteSelectedCellsCommand.key)
      focusCell(view, tablePos, row - 1, col)
      return true
    case 'table-delete-col':
      if (map.width <= 1) return deleteTable(view.state, view.dispatch)
      call(selectColCommand.key, { index: col, pos: inside })
      call(deleteSelectedCellsCommand.key)
      focusCell(view, tablePos, row, col - 1)
      return true
    case 'table-delete':
      return deleteTable(view.state, view.dispatch)
    case 'table-align-left':
    case 'table-align-center':
    case 'table-align-right': {
      const alignment = command.slice('table-align-'.length) as Alignment
      call(selectColCommand.key, { index: col, pos: inside })
      call(setAlignCommand.key, alignment)
      focusCell(view, tablePos, row, col)
      return true
    }
  }
}

export function resizeCurrentTable(view: EditorView, rows: number, cols: number): void {
  const info = tableInfo(view.state)
  if (!info) return
  const next = resizedTable(view.state.schema, info.table, Math.max(2, rows), Math.max(1, cols))
  view.dispatch(view.state.tr.replaceWith(info.tablePos, info.tablePos + info.table.nodeSize, next))
  focusCell(view, info.tablePos, Math.min(info.row, rows - 1), Math.min(info.col, cols - 1))
  view.focus()
}

// ------------------------------------------------------------------ keymap

/**
 * Typora's table keys: `| a | b |` + Enter creates a table, Enter moves to the cell below,
 * ⌘Enter adds a row below, ⇧⌘⌫ deletes the row. Higher priority than the GFM defaults.
 */
export const tableKeymap = $useKeymap('mtyporaTableKeymap', {
  EnterInTable: {
    shortcuts: 'Enter',
    priority: 300,
    command: (ctx) => () => {
      const view = ctx.get(editorViewCtx)
      const { state } = view
      const { $from, empty } = state.selection
      if (empty && $from.parent.type.name === 'paragraph' && $from.depth === 1 && $from.parentOffset === $from.parent.content.size) {
        const table = tableFromPipeRow(state.schema, $from.parent.textContent)
        if (table) {
          const start = $from.before()
          view.dispatch(state.tr.replaceWith(start, $from.after(), table))
          focusCell(view, start, 1, 0)
          return true
        }
      }
      const info = tableInfo(state)
      if (!info || info.row >= info.map.height - 1) return false
      focusCell(view, info.tablePos, info.row + 1, info.col)
      return true
    }
  },
  AddRowBelow: {
    shortcuts: 'Mod-Enter',
    priority: 300,
    command: (ctx) => () => runTableCommand('table-row-below', ctx.get(editorViewCtx), (key, payload) => ctx.get(commandsCtx).call(key, payload))
  },
  DeleteRow: {
    shortcuts: 'Mod-Shift-Backspace',
    priority: 300,
    command: (ctx) => () => runTableCommand('table-delete-row', ctx.get(editorViewCtx), (key, payload) => ctx.get(commandsCtx).call(key, payload))
  }
})

// ----------------------------------------------------------------- toolbar

const ICONS = {
  grid: '<svg viewBox="0 0 16 16"><rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M2 6.2h12M2 9.8h12M6 2.5v11M10 2.5v11"/></svg>',
  left: '<svg viewBox="0 0 16 16"><path d="M2.5 3.5h11M2.5 6.5h7M2.5 9.5h11M2.5 12.5h7"/></svg>',
  center: '<svg viewBox="0 0 16 16"><path d="M2.5 3.5h11M4.5 6.5h7M2.5 9.5h11M4.5 12.5h7"/></svg>',
  right: '<svg viewBox="0 0 16 16"><path d="M2.5 3.5h11M6.5 6.5h7M2.5 9.5h11M6.5 12.5h7"/></svg>',
  more: '<svg viewBox="0 0 16 16"><circle cx="3.5" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12.5" cy="8" r=".9"/></svg>',
  trash: '<svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>'
}

const MORE_ITEMS: Array<[TableCommand, string] | null> = [
  ['table-row-above', '上方插入行'],
  ['table-row-below', '下方插入行'],
  ['table-col-left', '左侧插入列'],
  ['table-col-right', '右侧插入列'],
  null,
  ['table-row-up', '上移该行'],
  ['table-row-down', '下移该行'],
  ['table-col-move-left', '左移该列'],
  ['table-col-move-right', '右移该列'],
  null,
  ['table-delete-row', '删除行'],
  ['table-delete-col', '删除列']
]

/** The bar Typora shows above a table while the caret is in it: size, alignment, more, delete. */
class TableToolbar implements PluginView {
  private el: HTMLElement
  private sizeLabel: HTMLElement
  private panel: HTMLElement
  private info: TableInfo | null = null

  constructor(
    private view: EditorView,
    private run: (command: TableCommand) => void
  ) {
    this.el = document.createElement('div')
    this.el.className = 'md-table-toolbar'
    this.el.contentEditable = 'false'
    this.el.innerHTML = `
      <button data-action="resize" title="调整表格大小">${ICONS.grid}<span class="md-table-size"></span></button>
      <span class="md-table-sep"></span>
      <button data-cmd="table-align-left" title="左对齐">${ICONS.left}</button>
      <button data-cmd="table-align-center" title="居中">${ICONS.center}</button>
      <button data-cmd="table-align-right" title="右对齐">${ICONS.right}</button>
      <span class="spacer"></span>
      <button data-action="more" title="更多">${ICONS.more}</button>
      <button data-cmd="table-delete" title="删除表格">${ICONS.trash}</button>
      <div class="md-table-panel" hidden></div>`
    this.sizeLabel = this.el.querySelector('.md-table-size')!
    this.panel = this.el.querySelector('.md-table-panel')!
    this.el.hidden = true
    view.dom.parentElement?.append(this.el)

    // Keep the caret in the table while the toolbar is used.
    this.el.addEventListener('mousedown', (event) => {
      if (!(event.target as HTMLElement).closest('input')) event.preventDefault()
    })
    this.el.addEventListener('click', (event) => this.onClick(event))
  }

  update(view: EditorView): void {
    this.view = view
    const info = tableInfo(view.state)
    const active = info && (view.hasFocus() || this.el.contains(document.activeElement))
    if (!active) {
      this.hide()
      return
    }
    if (this.info?.tablePos !== info.tablePos) this.panel.hidden = true
    this.info = info
    this.el.hidden = false
    this.sizeLabel.textContent = `${info.map.height} × ${info.map.width}`
    const alignment = cellAlignment(info)
    this.el.querySelectorAll<HTMLElement>('[data-cmd^="table-align-"]').forEach((button) => {
      button.classList.toggle('active', button.dataset.cmd === `table-align-${alignment}`)
    })
    this.position(info)
  }

  destroy(): void {
    this.el.remove()
  }

  private hide(): void {
    this.el.hidden = true
    this.panel.hidden = true
    this.info = null
  }

  private position(info: TableInfo): void {
    const tableDom = this.view.nodeDOM(info.tablePos) as HTMLElement | null
    const host = this.el.parentElement
    if (!tableDom || !host) return
    const zoom = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--zoom')) || 1
    const tableRect = tableDom.getBoundingClientRect()
    const hostRect = host.getBoundingClientRect()
    this.el.style.left = `${(tableRect.left - hostRect.left) / zoom}px`
    this.el.style.width = `${tableRect.width / zoom}px`
    this.el.style.top = `${(tableRect.top - hostRect.top) / zoom - this.el.offsetHeight}px`
  }

  private onClick(event: MouseEvent): void {
    const target = event.target as HTMLElement
    const button = target.closest<HTMLElement>('button')
    if (!button) return
    if (button.dataset.cmd) {
      this.panel.hidden = true
      this.run(button.dataset.cmd as TableCommand)
    } else if (button.dataset.action === 'more') {
      this.togglePanel('more')
    } else if (button.dataset.action === 'resize') {
      this.togglePanel('resize')
    } else if (button.dataset.action === 'apply-size') {
      const rows = Number(this.panel.querySelector<HTMLInputElement>('[name="rows"]')!.value)
      const cols = Number(this.panel.querySelector<HTMLInputElement>('[name="cols"]')!.value)
      this.panel.hidden = true
      if (rows > 0 && cols > 0) resizeCurrentTable(this.view, rows, cols)
    }
  }

  private togglePanel(kind: 'more' | 'resize'): void {
    if (!this.panel.hidden && this.panel.dataset.kind === kind) {
      this.panel.hidden = true
      return
    }
    this.panel.dataset.kind = kind
    if (kind === 'more') {
      this.panel.innerHTML = MORE_ITEMS.map((item) =>
        item ? `<button data-cmd="${item[0]}">${item[1]}</button>` : '<span class="md-table-panel-sep"></span>'
      ).join('')
    } else {
      const { height, width } = this.info!.map
      this.panel.innerHTML = `
        <label>行 <input name="rows" type="number" min="2" max="100" value="${height}"></label>
        <label>列 <input name="cols" type="number" min="1" max="30" value="${width}"></label>
        <button data-action="apply-size" class="md-table-apply">确定</button>`
      this.panel.querySelectorAll('input').forEach((input) =>
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') this.panel.querySelector<HTMLElement>('[data-action="apply-size"]')!.click()
          if (event.key === 'Escape') {
            this.panel.hidden = true
            this.view.focus()
          }
        })
      )
    }
    this.panel.hidden = false
  }
}

export function createTableToolbar(run: (command: TableCommand) => void) {
  return $prose(
    () =>
      new Plugin({
        key: new PluginKey('mtypora-table-toolbar'),
        view: (view) => new TableToolbar(view, run),
        props: {
          handleDOMEvents: {
            // Re-evaluate visibility when focus leaves the editor.
            blur: (view) => {
              setTimeout(() => {
                if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta('mtypora-table-blur', true))
              }, 0)
              return false
            }
          }
        }
      })
  )
}
