import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { THEMES, type CustomTheme, type MenuCommand, type MenuState } from '../shared/api'

type Send = (command: MenuCommand, win?: BrowserWindow) => void

interface MenuActions {
  newWindow(): void
  send: Send
}

const isMac = process.platform === 'darwin'

let actions: MenuActions | null = null
let customThemes: Array<Pick<CustomTheme, 'id' | 'label'>> = []
let lastState: MenuState | null = null
/** ⌃⌘ on macOS, Ctrl+Shift elsewhere — Typora's binding for view switches and images. */
const ctrlCmd = (key: string) => (isMac ? `Ctrl+Cmd+${key}` : `Ctrl+Shift+${key}`)

function commandItem(send: Send, label: string, command: MenuCommand, accelerator?: string, extra: Partial<MenuItemConstructorOptions> = {}): MenuItemConstructorOptions {
  return { label, accelerator, id: command, click: (_item, win) => send(command, win as BrowserWindow | undefined), ...extra }
}

function checkItem(send: Send, label: string, command: MenuCommand, accelerator?: string): MenuItemConstructorOptions {
  return commandItem(send, label, command, accelerator, { type: 'checkbox' })
}

/** Paragraph items, shared by the menu bar and the editor's context menu. */
function paragraphItems(send: Send): MenuItemConstructorOptions[] {
  const c = (label: string, command: MenuCommand, accelerator?: string) => commandItem(send, label, command, accelerator, { id: undefined })
  return [
    ...([1, 2, 3, 4, 5, 6] as const).map((level) => c(`${level} 级标题`, `heading-${level}`, `CmdOrCtrl+${level}`)),
    { type: 'separator' },
    c('段落', 'paragraph', 'CmdOrCtrl+0'),
    { type: 'separator' },
    c('提升标题级别', 'heading-up', 'CmdOrCtrl+='),
    c('降低标题级别', 'heading-down', 'CmdOrCtrl+-'),
    { type: 'separator' },
    { label: '表格', submenu: [c('插入表格', 'table', 'Alt+CmdOrCtrl+T'), { type: 'separator' }, ...tableItems(send)] },
    c('代码块', 'code-fence', 'Alt+CmdOrCtrl+C'),
    c('公式块', 'math-block', 'Alt+CmdOrCtrl+B'),
    { type: 'separator' },
    c('引用', 'quote', 'Alt+CmdOrCtrl+Q'),
    { type: 'separator' },
    c('有序列表', 'ordered-list', 'Alt+CmdOrCtrl+O'),
    c('无序列表', 'bullet-list', 'Alt+CmdOrCtrl+U'),
    c('任务列表', 'task-list', 'Alt+CmdOrCtrl+X'),
    { type: 'separator' },
    c('水平分割线', 'hr', 'Alt+CmdOrCtrl+-'),
    c('YAML Front Matter', 'front-matter')
  ]
}

/** Row / column operations (Paragraph › Table and the table context menu). */
function tableItems(send: Send): MenuItemConstructorOptions[] {
  const c = (label: string, command: MenuCommand, accelerator?: string) => commandItem(send, label, command, accelerator, { id: undefined })
  return [
    c('上方插入行', 'table-row-above'),
    c('下方插入行', 'table-row-below', 'CmdOrCtrl+Enter'),
    c('左侧插入列', 'table-col-left'),
    c('右侧插入列', 'table-col-right'),
    { type: 'separator' },
    c('上移该行', 'table-row-up'),
    c('下移该行', 'table-row-down'),
    c('左移该列', 'table-col-move-left'),
    c('右移该列', 'table-col-move-right'),
    { type: 'separator' },
    c('左对齐', 'table-align-left'),
    c('居中对齐', 'table-align-center'),
    c('右对齐', 'table-align-right'),
    { type: 'separator' },
    c('删除行', 'table-delete-row', 'CmdOrCtrl+Shift+Backspace'),
    c('删除列', 'table-delete-col'),
    c('删除表格', 'table-delete')
  ]
}

function formatItems(send: Send): MenuItemConstructorOptions[] {
  const c = (label: string, command: MenuCommand, accelerator?: string) => commandItem(send, label, command, accelerator, { id: undefined })
  return [
    c('加粗', 'strong', 'CmdOrCtrl+B'),
    c('斜体', 'emphasis', 'CmdOrCtrl+I'),
    c('代码', 'inline-code', 'Ctrl+`'),
    c('删除线', 'strike', 'Ctrl+Shift+`'),
    c('下划线', 'underline', 'CmdOrCtrl+U'),
    { type: 'separator' },
    c('超链接', 'link', 'CmdOrCtrl+K'),
    c('图像', 'image', ctrlCmd('I')),
    c('上传全部本地图片', 'upload-images'),
    { type: 'separator' },
    c('清除样式', 'clear-format', 'CmdOrCtrl+\\')
  ]
}

export function buildMenu(menuActions: MenuActions, themes: Array<Pick<CustomTheme, 'id' | 'label'>> = customThemes): void {
  actions = menuActions
  customThemes = themes.map(({ id, label }) => ({ id, label }))
  const { newWindow, send } = menuActions
  const c = (label: string, command: MenuCommand, accelerator?: string) => commandItem(send, label, command, accelerator)
  const themeItem = (id: CustomTheme['id'] | (typeof THEMES)[number]['id'], label: string) =>
    commandItem(send, label, `theme-${id}`, undefined, { type: 'radio' })

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.getName(),
            submenu: [
              { role: 'about' as const, label: `关于 ${app.getName()}` },
              { type: 'separator' as const },
              c('偏好设置…', 'preferences', 'CmdOrCtrl+,'),
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: '文件',
      submenu: [
        c('新建', 'new', 'CmdOrCtrl+N'),
        { label: '新建窗口', accelerator: 'CmdOrCtrl+Shift+N', click: newWindow },
        { type: 'separator' },
        c('打开…', 'open', 'CmdOrCtrl+O'),
        c('快速打开…', 'open-quickly', 'CmdOrCtrl+Shift+O'),
        c('打开文件夹…', 'open-folder'),
        { role: 'recentDocuments', label: '打开最近文件', submenu: [{ role: 'clearRecentDocuments', label: '清除最近文件' }] },
        { type: 'separator' },
        c('保存', 'save', 'CmdOrCtrl+S'),
        c('另存为…', 'save-as', 'CmdOrCtrl+Shift+S'),
        c('重命名…', 'rename'),
        { type: 'separator' },
        c('在访达中显示', 'reveal-in-finder'),
        c('复制文件路径', 'copy-path'),
        { type: 'separator' },
        {
          label: '导出',
          submenu: [c('PDF', 'export-pdf'), c('HTML', 'export-html'), c('HTML (without styles)', 'export-html-plain')]
        },
        c('打印…', 'print', 'Alt+CmdOrCtrl+P'),
        ...(isMac ? [] : [{ type: 'separator' as const }, c('偏好设置…', 'preferences', 'CmdOrCtrl+,')]),
        { type: 'separator' },
        { role: 'close', label: '关闭' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        c('撤销', 'undo', 'CmdOrCtrl+Z'),
        c('重做', 'redo', isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y'),
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { type: 'separator' },
        c('拷贝为 Markdown', 'copy-markdown', 'CmdOrCtrl+Shift+C'),
        c('拷贝为 HTML 代码', 'copy-html'),
        { role: 'pasteAndMatchStyle', label: '粘贴为纯文本', accelerator: 'CmdOrCtrl+Shift+V' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' },
        c('选中当前行/句', 'select-line', 'CmdOrCtrl+L'),
        c('选中当前格式文本', 'select-styled', 'CmdOrCtrl+E'),
        c('选中当前词', 'select-word', 'CmdOrCtrl+D'),
        c('删除当前行', 'delete-line', 'CmdOrCtrl+Shift+D'),
        { type: 'separator' },
        {
          label: '查找和替换',
          submenu: [
            c('查找', 'find', 'CmdOrCtrl+F'),
            c('查找下一个', 'find-next', 'CmdOrCtrl+G'),
            c('查找上一个', 'find-prev', 'CmdOrCtrl+Shift+G'),
            c('替换', 'replace', 'Alt+CmdOrCtrl+F')
          ]
        },
        ...(isMac ? [{ type: 'separator' as const }, { role: 'startSpeaking' as const, label: '开始朗读' }] : [])
      ]
    },
    { label: '段落', submenu: paragraphItems(send) },
    { label: '格式', submenu: formatItems(send) },
    {
      label: '视图',
      submenu: [
        checkItem(send, '源代码模式', 'toggle-source', 'CmdOrCtrl+/'),
        { type: 'separator' },
        checkItem(send, '显示 / 隐藏侧边栏', 'toggle-sidebar', 'CmdOrCtrl+Shift+L'),
        checkItem(send, '大纲', 'view-outline', ctrlCmd('1')),
        checkItem(send, '文档列表', 'view-articles', ctrlCmd('2')),
        checkItem(send, '文件树', 'view-tree', ctrlCmd('3')),
        checkItem(send, '搜索', 'view-search', 'CmdOrCtrl+Shift+F'),
        { type: 'separator' },
        checkItem(send, '专注模式', 'toggle-focus', 'F8'),
        checkItem(send, '打字机模式', 'toggle-typewriter', 'F9'),
        { type: 'separator' },
        checkItem(send, '显示状态栏', 'toggle-statusbar'),
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏', accelerator: isMac ? 'Ctrl+Cmd+F' : 'F11' },
        {
          label: '保持窗口在最前端',
          type: 'checkbox',
          id: 'always-on-top',
          click: (item, win) => (win as BrowserWindow | undefined)?.setAlwaysOnTop(item.checked)
        },
        { type: 'separator' },
        c('实际大小', 'zoom-reset', 'CmdOrCtrl+Shift+0'),
        c('放大', 'zoom-in', 'CmdOrCtrl+Shift+='),
        c('缩小', 'zoom-out', 'CmdOrCtrl+Shift+-'),
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' }
      ]
    },
    {
      label: '主题',
      submenu: [
        ...THEMES.map((theme) => themeItem(theme.id, theme.label)),
        ...(customThemes.length > 0 ? [{ type: 'separator' as const }, ...customThemes.map((theme) => themeItem(theme.id, theme.label))] : []),
        { type: 'separator' },
        c('打开主题文件夹', 'open-theme-folder')
      ]
    },
    { role: 'windowMenu', label: '窗口' },
    {
      role: 'help',
      label: '帮助',
      submenu: [
        c('快速上手', 'quick-start'),
        { label: 'Markdown 语法参考', click: () => shell.openExternal('https://commonmark.org/help/') },
        { label: 'GitHub Flavored Markdown 规范', click: () => shell.openExternal('https://github.github.com/gfm/') }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  if (lastState) syncMenu(lastState)
}

/** Rebuilds the Theme menu when the theme folder's contents changed. */
export function setCustomThemes(themes: CustomTheme[]): void {
  const same = themes.length === customThemes.length && themes.every((theme, i) => theme.id === customThemes[i].id && theme.label === customThemes[i].label)
  if (!same && actions) buildMenu(actions, themes)
}

/** Mirrors renderer state into the native menu's checkmarks. */
export function syncMenu(state: MenuState): void {
  lastState = state
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  const check = (id: string, value: boolean) => {
    const item = menu.getMenuItemById(id)
    if (item) item.checked = value
  }
  const enable = (id: string, value: boolean) => {
    const item = menu.getMenuItemById(id)
    if (item) item.enabled = value
  }
  check('toggle-source', state.source)
  check('toggle-sidebar', state.sidebar)
  check('view-outline', state.sidebar && state.sidebarView === 'outline')
  check('view-articles', state.sidebar && state.sidebarView === 'articles')
  check('view-tree', state.sidebar && state.sidebarView === 'tree')
  check('view-search', state.sidebar && state.sidebarView === 'search')
  check('toggle-focus', state.focus)
  check('toggle-typewriter', state.typewriter)
  check('toggle-statusbar', state.statusBar)
  // Assigning `checked` on a radio item always selects it (Electron ignores the value),
  // so only the active theme may be assigned.
  const themeItem = menu.getMenuItemById(`theme-${state.theme}`)
  if (themeItem && !themeItem.checked) themeItem.checked = true
  for (const id of ['rename', 'reveal-in-finder', 'copy-path']) enable(id, state.hasFile)
}

export function contextMenu(send: Send, hasSelection: boolean, inTable: boolean): Menu {
  const c = (label: string, command: MenuCommand) => commandItem(send, label, command, undefined, { id: undefined })
  return Menu.buildFromTemplate([
    { role: 'cut', label: '剪切', enabled: hasSelection },
    { role: 'copy', label: '拷贝', enabled: hasSelection },
    { role: 'paste', label: '粘贴' },
    { type: 'separator' },
    c('拷贝为 Markdown', 'copy-markdown'),
    { role: 'pasteAndMatchStyle', label: '粘贴为纯文本' },
    { type: 'separator' },
    ...(inTable ? [{ label: '表格', submenu: tableItems(send).map(stripAccelerator) }, { type: 'separator' as const }] : []),
    { label: '段落', submenu: paragraphItems(send).map(stripAccelerator) },
    { label: '格式', submenu: formatItems(send).map(stripAccelerator) },
    { type: 'separator' },
    {
      label: '插入',
      submenu: [c('表格', 'table'), c('代码块', 'code-fence'), c('公式块', 'math-block'), c('水平分割线', 'hr'), c('图像', 'image'), c('超链接', 'link')]
    }
  ])
}

export function titleMenu(send: Send, hasFile: boolean): Menu {
  const c = (label: string, command: MenuCommand, enabled = true) => commandItem(send, label, command, undefined, { id: undefined, enabled })
  return Menu.buildFromTemplate([
    c(hasFile ? '重命名…' : '保存…', hasFile ? 'rename' : 'save'),
    c('另存为…', 'save-as'),
    { type: 'separator' },
    c('在访达中显示', 'reveal-in-finder', hasFile),
    c('复制文件路径', 'copy-path', hasFile)
  ])
}

function stripAccelerator(item: MenuItemConstructorOptions): MenuItemConstructorOptions {
  return { ...item, accelerator: undefined }
}
