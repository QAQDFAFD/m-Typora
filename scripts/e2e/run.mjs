// m-typora end-to-end suite (see docs/test-plan.md). Run with `npm run test:e2e`.
// Every interaction uses real mouse / keyboard events; setup opens files the way Finder does.
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { launch, sleep } from './harness.mjs'

const ROOT = resolve(new URL('../..', import.meta.url).pathname)
const only = process.argv.slice(2)
const docs = await mkdtemp(join(tmpdir(), 'm-typora-e2e-docs-'))
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=', 'base64')
await writeFile(join(docs, 'pixel.png'), PIXEL)

let counter = 0
/** Writes a fresh document and returns its path. */
async function fixture(content, name) {
  const path = join(docs, name ?? `doc-${++counter}.md`)
  await writeFile(path, content)
  return path
}

const TABLE = '# T\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\nAfter.\n'
const results = []
let app

class Fail extends Error {}
function expect(condition, message) {
  if (!condition) throw new Fail(message)
}
async function test(id, name, fn) {
  if (only.length && !only.some((prefix) => id.startsWith(prefix))) return
  const started = Date.now()
  try {
    await fn()
    results.push({ id, name, ok: true })
    console.log(`  ✓ ${id} ${name}`)
  } catch (error) {
    results.push({ id, name, ok: false, error: error.message })
    console.log(`  ✗ ${id} ${name}\n      ${error.message}`)
    await app.screenshot(join(ROOT, 'out', `e2e-fail-${id}.png`)).catch(() => {})
  }
  if (Date.now() - started > 20000) console.log(`    (slow: ${Date.now() - started}ms)`)
}

// ----------------------------------------------------------------- helpers
const q = (code) => app.page(`return ${code}`)
const title = () => q(`document.querySelector('#title').textContent`)
const edited = () => q(`document.documentElement.classList.contains('doc-edited')`)
const html = (selector) => q(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent.trim())`)
const count = (selector) => q(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
const visible = (selector) => q(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return !!e && !e.hidden && !e.closest('[hidden]') && getComputedStyle(e).display !== 'none' })()`)
const active = () => q(`(() => { const e = document.activeElement; return e.tagName + (e.className ? '.' + String(e.className).split(' ')[0] : '') })()`)
const caretText = () => q(`getSelection().anchorNode?.parentElement?.closest('td, th, p, li, h1, h2, h3')?.textContent.trim() ?? null`)
const inTable = () => q(`!!getSelection().anchorNode?.parentElement?.closest('table')`)
const rows = () => q(`[...document.querySelectorAll('#write table tr')].map((tr) => [...tr.children].map((c) => c.textContent.trim()).join('|'))`)
const tableState = () =>
  q(`(() => { const tb = document.querySelector('.md-table-toolbar'), p = tb?.querySelector('.md-table-panel')
    return { toolbar: !!tb && !tb.hidden, panel: p && !p.hidden ? p.dataset.kind : null, size: tb?.querySelector('.md-table-size')?.textContent } })()`)
async function save(path) {
  await app.menu('save')
  await sleep(200)
  return readFile(path, 'utf8')
}
/** Puts the caret at the end of the document by clicking below the last line. */
async function clickEnd() {
  const r = await app.rect('#write .ProseMirror')
  await app.clickAt(r.left + 40, r.bottom - 4)
  await app.key('End', ['meta'])
}
async function openFresh(content = '') {
  const path = await fixture(content)
  await app.answer('message', 1)
  await app.open(path)
  return path
}
async function hoverFooter() {
  const r = await app.rect('#footer')
  await app.main(`win.webContents.sendInputEvent({ type: 'mouseMove', x: ${Math.round(r.left + 40)}, y: ${Math.round(r.top + 10)} }); return true`)
  await sleep(150)
}

// ------------------------------------------------------------------- suite
// The suite was written with auto-save off (it is on by default); section S checks the default.
app = await launch({ prefs: { autoSave: false } })
try {
  console.log('A. 文件与窗口')
  await test('A1', '启动为空白未命名文档', async () => {
    expect((await title()) === '未命名', `title ${await title()}`)
    expect((await q(`document.querySelector('#write .ProseMirror').textContent`)) === '', 'editor not empty')
  })
  const basic = await fixture('# Basic\n\nHello world paragraph.\n\nSecond line here.\n', 'basic.md')
  await test('A2', '从访达打开文件', async () => {
    await app.open(basic)
    expect((await title()) === 'basic.md', `title ${await title()}`)
    expect((await html('#write h1'))[0] === 'Basic', 'h1 not rendered')
    expect(!(await edited()), 'marked edited after open')
  })
  await test('A3', '文件 › 打开…', async () => {
    const other = await fixture('Opened via dialog.\n', 'dialog.md')
    await app.answer('open', other)
    await app.menu('open')
    expect((await title()) === 'dialog.md', `title ${await title()}`)
    await app.answer('open', null)
  })
  await test('A4', '文件 › 新建', async () => {
    await app.menu('new')
    expect((await title()) === '未命名', `title ${await title()}`)
  })
  await test('A5', '有未保存修改时打开其他文件会确认', async () => {
    await app.open(basic)
    await app.clickText('Hello', 2)
    await app.type('X')
    await sleep(400)
    expect(await edited(), 'not edited after typing')
    const before = (await app.e2e()).dialogs.length
    await app.answer('message', 1)
    await app.open(await fixture('Other.\n', 'other.md'))
    const dialogs = (await app.e2e()).dialogs
    expect(dialogs.length > before && dialogs.at(-1)[0] === 'message', 'no confirm dialog')
    expect((await title()) === 'other.md', `title ${await title()}`)
  })
  await test('A6', '修改后保存', async () => {
    const path = await openFresh('Start.\n')
    await app.clickText('Start', 5)
    await app.type(' more')
    const text = await save(path)
    expect(text.includes('Start more.'), `saved ${JSON.stringify(text)}`)
    expect(!(await edited()), 'still marked edited')
  })
  await test('A7', '未命名文档另存为', async () => {
    await app.menu('new')
    await app.click('#write .ProseMirror')
    await app.type('Brand new')
    const target = join(docs, 'saved-as.md')
    await app.answer('save', target)
    await app.menu('save')
    await sleep(200)
    expect(existsSync(target) && (await readFile(target, 'utf8')).includes('Brand new'), 'file not written')
    expect((await title()) === 'saved-as.md', `title ${await title()}`)
    await app.answer('save', null)
  })
  await test('A8', '重命名', async () => {
    const path = await openFresh('Rename me.\n')
    await app.menu('rename')
    expect((await q(`document.querySelector('#title').isContentEditable`)) === true, 'title not editable')
    await app.key('A', ['meta'])
    await app.type('renamed-doc')
    await app.key('Enter')
    await sleep(300)
    expect(existsSync(join(docs, 'renamed-doc.md')) && !existsSync(path), 'file not renamed on disk')
    expect((await title()) === 'renamed-doc.md', `title ${await title()}`)
  })
  await test('A9', '在访达中显示', async () => {
    await app.open(basic)
    await app.menu('reveal-in-finder')
    const shell = (await app.e2e()).shell
    expect(shell.some(([kind, arg]) => kind === 'showItemInFolder' && arg === basic), 'not revealed')
  })
  await test('A10', '复制文件路径', async () => {
    await app.main(`await electron.clipboard.writeText(''); return true`)
    await app.menu('copy-path')
    await sleep(200)
    const clip = await app.main(`return electron.clipboard.readText()`)
    expect(clip === basic, `clipboard ${JSON.stringify(clip)}`)
  })
  await test('A11', '导出 HTML', async () => {
    const target = join(docs, 'export.html')
    await app.answer('save', target)
    await app.menu('export-html')
    await sleep(300)
    const out = existsSync(target) ? await readFile(target, 'utf8') : ''
    expect(out.includes('<h1') && out.includes('<style>'), 'html not exported')
    await app.answer('save', null)
  })
  await test('A12', '导出 PDF', async () => {
    const target = join(docs, 'export.pdf')
    await app.answer('save', target)
    await app.menu('export-pdf')
    await sleep(1500)
    expect(existsSync(target) && statSync(target).size > 1000, 'pdf not exported')
    await app.answer('save', null)
  })
  await test('A13', '自动保存', async () => {
    await app.menu('preferences')
    await app.click('[data-pref="autoSave"]')
    await app.key('Escape')
    const path = await openFresh('Auto.\n')
    await app.clickText('Auto', 4)
    await app.type(' saved')
    await sleep(1800)
    const text = await readFile(path, 'utf8')
    await app.menu('preferences')
    await app.click('[data-pref="autoSave"]')
    await app.key('Escape')
    expect(text.includes('Auto saved.'), `disk ${JSON.stringify(text)}`)
  })
  await test('A15', '重命名时 Esc 取消', async () => {
    const path = await openFresh('Keep name.\n')
    const before = await title()
    await app.menu('rename')
    await app.type('zzz')
    await app.key('Escape')
    await sleep(200)
    expect((await title()) === before && existsSync(path), `title ${await title()}`)
    expect((await q(`document.querySelector('#title').isContentEditable`)) === false, 'title still editable')
  })
  await test('A14', '标题栏下拉菜单', async () => {
    await app.open(basic)
    await app.click('#title-menu')
    const labels = JSON.stringify(await app.lastPopupLabels())
    expect(labels.includes('重命名') && labels.includes('复制文件路径') && labels.includes('在访达中显示'), labels)
  })

  console.log('B. 编辑')
  await test('B1', '输入 # 生成 1–6 级标题', async () => {
    await openFresh()
    await app.click('#write .ProseMirror')
    for (let n = 1; n <= 6; n++) await app.type(`${'#'.repeat(n)} H${n}\n`)
    for (let n = 1; n <= 6; n++) expect((await html(`#write h${n}`))[0] === `H${n}`, `h${n} missing`)
  })
  const blockCases = [
    ['引用', '> quote', '#write blockquote'],
    ['无序列表', '- item', '#write ul li'],
    ['有序列表', '1. item', '#write ol li'],
    ['任务列表', '- [ ] task', '#write .md-task-box'],
    ['代码块', '```js\n', '#write .milkdown-code-block'],
    ['分割线', '---\n', '#write hr'],
    ['公式块', '$$\n', '#write .milkdown-code-block']
  ]
  for (const [label, input, selector] of blockCases) {
    await test('B2', `输入生成${label}`, async () => {
      await openFresh()
      await app.click('#write .ProseMirror')
      await app.type(input)
      expect((await count(selector)) > 0, `${selector} missing`)
    })
  }
  const inlineCases = [
    ['粗体', '**bold** ', '#write strong', 'bold'],
    ['斜体', '*em* ', '#write em', 'em'],
    ['行内代码', '`code` ', '#write p code', 'code'],
    ['删除线', '~~del~~ ', '#write del', 'del'],
    ['链接', '[site](https://x.y) ', '#write a', 'site']
  ]
  for (const [label, input, selector, text] of inlineCases) {
    await test('B3', `输入即渲染${label}`, async () => {
      await openFresh()
      await app.click('#write .ProseMirror')
      await app.type(input)
      expect((await html(selector))[0] === text, `${selector}: ${JSON.stringify(await html('#write p'))}`)
    })
  }
  await test('B4', '光标进入 / 离开粗体显示 / 隐藏标记', async () => {
    await openFresh('A **strong** word.\n\nOther.\n')
    await app.clickText('strong', 3)
    expect((await count('#write .md-meta')) === 2, 'markers not shown')
    await app.clickText('Other', 2)
    expect((await count('#write .md-meta')) === 0, 'markers not hidden')
  })
  await test('B5', '选中文字后加粗 / 斜体 / 下划线', async () => {
    await openFresh('one two three\n')
    const word = await app.page(`
      const t = document.querySelector('#write p').firstChild; const r = document.createRange(); r.setStart(t, 4); r.setEnd(t, 7)
      const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }`)
    await app.clickAt(word.x, word.y, { clickCount: 2 })
    await app.menu('strong')
    expect((await html('#write strong'))[0] === 'two', 'not bold')
    await app.menu('emphasis')
    expect((await count('#write em')) === 1, 'not italic')
    await app.menu('underline')
    expect((await count('#write u')) === 1, 'not underlined')
  })
  await test('B6', '标题快捷命令', async () => {
    await openFresh('Para\n')
    await app.clickText('Para', 2)
    await app.menu('heading-2')
    expect((await html('#write h2'))[0] === 'Para', 'not h2')
    await app.menu('heading-up')
    expect((await html('#write h1'))[0] === 'Para', 'not h1 after ⌘=')
    await app.menu('heading-down')
    expect((await html('#write h2'))[0] === 'Para', 'not h2 after ⌘-')
    await app.menu('paragraph')
    expect((await count('#write h1, #write h2')) === 0, 'not paragraph')
  })
  await test('B7', '撤销 / 重做', async () => {
    await openFresh('Base\n')
    await app.clickText('Base', 4)
    await app.type(' typed')
    await app.menu('undo')
    expect(!(await q(`document.querySelector('#write p').textContent`)).includes('typed'), 'undo failed')
    await app.menu('redo')
    expect((await q(`document.querySelector('#write p').textContent`)).includes('typed'), 'redo failed')
  })
  await test('B8', '括号自动配对', async () => {
    await openFresh()
    await app.click('#write .ProseMirror')
    await app.type('f(x')
    expect((await q(`document.querySelector('#write p').textContent`)) === 'f(x)', 'no auto pair')
    await app.type(')')
    expect((await q(`document.querySelector('#write p').textContent`)) === 'f(x)', 'closer duplicated')
    await app.type(' [')
    await app.key('Backspace')
    expect((await q(`document.querySelector('#write p').textContent`)) === 'f(x) ', 'pair not deleted together')
  })
  await test('B9', '列表回车续项、空项退出、Tab 缩进', async () => {
    await openFresh()
    await app.click('#write .ProseMirror')
    await app.type('- a\nb\n')
    await app.key('Tab')
    await app.type('nested\n\n\n')
    await app.type('after')
    expect((await count('#write ul ul li')) >= 1, 'Tab did not indent')
    expect((await html('#write .ProseMirror > p')).includes('after'), 'empty item did not exit list')
  })
  await test('B10', '点击任务复选框切换', async () => {
    await openFresh('- [ ] task\n')
    await app.click('#write .md-task-box')
    expect((await count('#write .md-task-box.checked')) === 1, 'not checked')
  })
  await test('B11', '输入中文', async () => {
    await openFresh()
    await app.click('#write .ProseMirror')
    await app.type('中文输入测试')
    expect((await q(`document.querySelector('#write p').textContent`)) === '中文输入测试', 'chinese missing')
  })
  await test('B12', '输入法组字（段落、列表、表格）', async () => {
    const path = await openFresh('Para\n\n- item\n\n| a | b |\n| --- | --- |\n| c | d |\n')
    await app.clickText('Para', 1)
    await app.key('End')
    await app.ime('zhong', '中')
    await app.clickText('item', 1)
    await app.key('End')
    await app.ime('wen', '文')
    await app.clickText('c', 0, '#write table')
    await app.key('End')
    await app.ime('biao', '表')
    const text = await save(path)
    expect(text.includes('Para中') && text.includes('- item文') && text.includes('c表'), `saved ${JSON.stringify(text)}`)
    expect(!/zhong|wen|biao/.test(text), 'composition text left behind')
  })
  await test('B13', '代码块选择语言', async () => {
    const path = await openFresh('```js\nlet x = 1\n```\n')
    await sleep(300)
    await app.click('#write .milkdown-code-block .cm-line')
    await app.click('#write .milkdown-code-block .language-button')
    expect(await visible('#write .milkdown-code-block .list-wrapper'), 'language list not shown')
    await app.click('#write .milkdown-code-block .list-wrapper .search-input')
    expect(await visible('#write .milkdown-code-block .list-wrapper'), 'list vanished after clicking its search box')
    await app.type('pyth')
    await app.click('#write .milkdown-code-block .language-list-item', 'Python')
    const text = await save(path)
    expect(text.startsWith('```python'), `saved ${JSON.stringify(text)}`)
  })

  console.log('C. 表格')
  await test('B15', '粘贴 Markdown 纯文本', async () => {
    const path = await openFresh()
    await app.click('#write .ProseMirror')
    await app.main(`await electron.clipboard.writeText('**bold** and [link](https://x.y)\\n\\n- one\\n- two'); return true`)
    await app.key('V', ['meta'])
    expect((await html('#write strong'))[0] === 'bold', 'bold not parsed')
    expect((await q(`document.querySelector('#write a')?.getAttribute('href')`)) === 'https://x.y', 'link not parsed')
    expect((await html('#write ul li')).length === 2, 'list not parsed')
    const text = await save(path)
    expect(text.includes('**bold** and [link](https://x.y)') && text.includes('- two'), `saved ${JSON.stringify(text)}`)
  })
  await test('B16', '粘贴网页富文本', async () => {
    const path = await openFresh()
    await app.click('#write .ProseMirror')
    await app.main(`await electron.clipboard.write([new electron.ClipboardItem({ 'text/html': '<p><b>Hi</b> <i>there</i> <a href="https://a.b">site</a></p>', 'text/plain': 'Hi there site' })]); return true`)
    await app.key('V', ['meta'])
    const text = await save(path)
    expect(text.trim() === '**Hi** *there* [site](https://a.b)', `saved ${JSON.stringify(text)}`)
  })
  await test('B17', '代码块内粘贴保持原样', async () => {
    const path = await openFresh('```\nx\n```\n')
    await sleep(300)
    await app.click('#write .milkdown-code-block .cm-line')
    await app.key('End')
    await app.main(`await electron.clipboard.writeText('**not bold**\\n- not list'); return true`)
    await app.key('V', ['meta'])
    const text = await save(path)
    expect(text === '```\nx**not bold**\n- not list\n```\n', `saved ${JSON.stringify(text)}`)
  })
  await test('B18', '文档内复制粘贴保留格式', async () => {
    const path = await openFresh('Some **strong** word.\n\nTarget: \n')
    await app.clickText('strong', 2)
    await app.clickAt(...Object.values(await app.page(`
      const t = [...document.querySelectorAll('#write strong')].pop().firstChild; const r = document.createRange(); r.setStart(t, 2); r.setEnd(t, 3)
      const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 }`)), { clickCount: 2 })
    await app.key('C', ['meta'])
    await app.clickText('Target', 1)
    await app.key('End')
    await app.key('V', ['meta'])
    const text = await save(path)
    expect(text.includes('Target: **strong**') || text.includes('Target:**strong**'), `saved ${JSON.stringify(text)}`)
  })
  await test('C1', '插入表格', async () => {
    await openFresh('x\n')
    await app.clickText('x', 1)
    await app.menu('table')
    expect((await count('#write table')) === 1, 'no table')
    expect((await tableState()).toolbar, 'toolbar not shown')
  })
  await test('C2', '输入 | a | b | 回车建表', async () => {
    await openFresh()
    await app.click('#write .ProseMirror')
    await app.type('| a | b |\n')
    expect((await html('#write th')).join(',') === 'a,b', `headers ${await html('#write th')}`)
    expect(await inTable(), 'caret not in table')
  })
  await test('C3', '工具栏随光标出现 / 消失', async () => {
    await openFresh(TABLE)
    await app.clickText('1', 0, '#write table')
    expect((await tableState()).toolbar, 'not shown')
    await app.clickText('After', 2)
    expect(!(await tableState()).toolbar, 'not hidden')
  })
  await test('C4', '调整行列：点击输入框时面板不消失', async () => {
    await openFresh(TABLE)
    await app.clickText('1', 0, '#write table')
    await app.click('.md-table-toolbar [data-action="resize"]')
    expect((await tableState()).panel === 'resize', 'panel not opened')
    await app.click('.md-table-panel input[name="rows"]')
    expect((await tableState()).panel === 'resize', 'panel vanished after clicking input')
    expect((await active()).startsWith('INPUT'), `focus on ${await active()}`)
    await app.key('A', ['meta'])
    await app.type('5')
    await app.click('.md-table-panel input[name="cols"]')
    expect((await tableState()).panel === 'resize', 'panel vanished after clicking cols')
    await app.key('A', ['meta'])
    await app.type('3')
    await app.key('Enter')
    const st = await tableState()
    expect(st.size === '5 × 3', `size ${st.size}`)
    expect(st.panel === null, 'panel still open')
    expect(await inTable(), 'caret not back in table')
  })
  await test('B14', '语言列表：点代码内容或别处时关闭', async () => {
    await openFresh('```js\nlet x = 1\n```\n\nAfter.\n')
    await sleep(300)
    await app.click('#write .milkdown-code-block .cm-line')
    await app.click('#write .milkdown-code-block .language-button')
    expect(await visible('#write .milkdown-code-block .list-wrapper'), 'language list not shown')
    await app.click('#write .milkdown-code-block .cm-line')
    expect(!(await visible('#write .milkdown-code-block .list-wrapper')), 'list stays open after clicking the code')
    await app.click('#write .milkdown-code-block .language-button')
    await app.clickText('After', 2)
    expect(!(await visible('#write .milkdown-code-block .list-wrapper')), 'list stays open after clicking outside')
  })
  await test('C4b', '调整行列：点“确定”按钮', async () => {
    await openFresh(TABLE)
    await app.clickText('1', 0, '#write table')
    await app.click('.md-table-toolbar [data-action="resize"]')
    await app.click('.md-table-panel input[name="cols"]')
    await app.key('A', ['meta'])
    await app.type('4')
    await app.click('.md-table-panel .md-table-apply')
    expect((await tableState()).size === '3 × 4', `size ${(await tableState()).size}`)
    expect(await inTable(), 'caret not back in table')
  })
  await test('C5', '尺寸面板 Esc 关闭', async () => {
    await openFresh(TABLE)
    await app.clickText('1', 0, '#write table')
    await app.click('.md-table-toolbar [data-action="resize"]')
    await app.click('.md-table-panel input[name="rows"]')
    await app.key('Escape')
    expect((await tableState()).panel === null, 'panel open')
    expect((await active()).startsWith('DIV.ProseMirror'), `focus ${await active()}`)
  })
  await test('C6', '列居中', async () => {
    const path = await openFresh(TABLE)
    await app.clickText('2', 0, '#write table')
    await app.click('.md-table-toolbar [data-cmd="table-align-center"]')
    expect(await q(`document.querySelector('.md-table-toolbar [data-cmd="table-align-center"]').classList.contains('active')`), 'button not active')
    const text = await save(path)
    expect(/\|\s*-+\s*\|\s*:-+:\s*\|/.test(text), `saved ${JSON.stringify(text)}`)
  })
  await test('C7', '“⋯”下拉在点击别处后关闭', async () => {
    await openFresh(TABLE)
    await app.clickText('1', 0, '#write table')
    await app.click('.md-table-toolbar [data-action="more"]')
    expect((await tableState()).panel === 'more', 'not opened')
    await app.clickText('4', 0, '#write table')
    expect((await tableState()).panel === null, 'still open after clicking another cell')
    await app.click('.md-table-toolbar [data-action="more"]')
    await app.clickText('After', 2)
    expect((await tableState()).panel === null, 'still open after clicking outside')
    await app.clickText('1', 0, '#write table')
    await app.click('.md-table-toolbar [data-action="more"]')
    await app.click('.md-table-toolbar [data-action="more"]')
    expect((await tableState()).panel === null, 'not toggled closed')
  })
  const moreCases = [
    ['下方插入行', '1', 'table-row-below', ['a|b', '1|2', '|', '3|4']],
    ['上方插入行', '3', 'table-row-above', ['a|b', '1|2', '|', '3|4']],
    ['左侧插入列', '1', 'table-col-left', ['|a|b', '|1|2', '|3|4']],
    ['右侧插入列', '1', 'table-col-right', ['a||b', '1||2', '3||4']],
    ['下移该行', '1', 'table-row-down', ['a|b', '3|4', '1|2']],
    ['上移该行', '3', 'table-row-up', ['a|b', '3|4', '1|2']],
    ['右移该列', '1', 'table-col-move-right', ['b|a', '2|1', '4|3']],
    ['左移该列', '2', 'table-col-move-left', ['b|a', '2|1', '4|3']],
    ['删除行', '1', 'table-delete-row', ['a|b', '3|4']],
    ['删除列', '1', 'table-delete-col', ['b', '2', '4']]
  ]
  for (const [label, cell, cmd, expected] of moreCases) {
    await test('C8', `更多 › ${label}`, async () => {
      await openFresh(TABLE)
      await app.clickText(cell, 0, '#write table')
      await app.click('.md-table-toolbar [data-action="more"]')
      await app.click(`.md-table-panel [data-cmd="${cmd}"]`)
      const got = await rows()
      expect(JSON.stringify(got) === JSON.stringify(expected), `rows ${JSON.stringify(got)}`)
      expect((await tableState()).panel === null, 'panel still open')
    })
  }
  await test('C9', '删除表格', async () => {
    await openFresh(TABLE)
    await app.clickText('1', 0, '#write table')
    await app.click('.md-table-toolbar [data-cmd="table-delete"]')
    expect((await count('#write table')) === 0, 'table remains')
  })
  await test('C10', '单元格回车跳到下一行，末行离开表格', async () => {
    await openFresh(TABLE)
    await app.clickText('1', 1, '#write table')
    await app.key('Enter')
    expect((await caretText()) === '3', `caret in ${await caretText()}`)
    await app.key('Enter')
    expect(!(await inTable()), 'still in table')
  })
  await test('C11', 'Tab / ⇧Tab 移动单元格', async () => {
    await openFresh(TABLE)
    await app.clickText('1', 1, '#write table')
    await app.key('Tab')
    expect((await caretText()) === '2', `caret in ${await caretText()}`)
    await app.key('Tab', ['shift'])
    expect((await caretText()) === '1', `caret in ${await caretText()}`)
  })
  await test('C12', '⌘↩ 插入行、⇧⌘⌫ 删除行、表头不可删', async () => {
    await openFresh(TABLE)
    await app.clickText('1', 1, '#write table')
    await app.key('Enter', ['meta'])
    expect((await rows()).length === 4, `rows ${JSON.stringify(await rows())}`)
    await app.key('Backspace', ['meta', 'shift'])
    expect((await rows()).length === 3, `rows ${JSON.stringify(await rows())}`)
    await app.menu('table-row-below')
    expect((await rows()).length === 4, 'menu ⌘↩ path failed')
    await app.clickText('a', 1, '#write table')
    await app.key('Backspace', ['meta', 'shift'])
    expect((await rows())[0] === 'a|b', 'header deleted')
  })
  await test('C13', '单元格内输入中文与粗体并保存', async () => {
    const path = await openFresh(TABLE)
    await app.clickText('1', 1, '#write table')
    await app.type(' 中文 **粗** ')
    const text = await save(path)
    expect(/\| 1 中文 \*\*粗\*\* *\|/.test(text), `saved ${JSON.stringify(text)}`)
  })
  await test('C14', '右键 › 表格 › 下方插入行', async () => {
    await openFresh(TABLE)
    await app.clickText('1', 0, '#write table')
    const r = await app.rect('#write td', '1')
    await app.clickAt(r.x, r.y, { button: 'right' })
    const labels = JSON.stringify(await app.lastPopupLabels())
    expect(labels.includes('"表格"'), `no 表格 submenu: ${labels}`)
    await app.clickPopupItem(['表格', '下方插入行'])
    expect((await rows()).length === 4, `rows ${JSON.stringify(await rows())}`)
  })
  await test('C15', '工具栏不遮挡上方文字', async () => {
    await openFresh('# Heading above\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n')
    await app.clickText('1', 0, '#write table')
    const tb = await app.rect('.md-table-toolbar')
    const h = await app.rect('#write h1')
    const table = await app.rect('#write table')
    expect(tb.bottom <= table.top + 1, 'toolbar overlaps table')
    expect(tb.top >= h.bottom - 2, `toolbar covers heading (${tb.top} < ${h.bottom})`)
  })

  console.log('D. 链接与图片')
  await test('D1', '选中文字 ⌘K 生成链接', async () => {
    await openFresh('Plain words to link.\n')
    const word = await app.page(`
      const t = document.querySelector('#write p').firstChild; const r = document.createRange(); r.setStart(t, 6); r.setEnd(t, 11)
      const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }`)
    await app.clickAt(word.x, word.y, { clickCount: 2 })
    await app.menu('link')
    expect(await visible('.md-link-editor'), 'editor not shown')
    expect((await active()).startsWith('INPUT'), `focus ${await active()}`)
    await app.type('https://ex.com')
    await app.key('Enter')
    expect((await q(`document.querySelector('#write a')?.getAttribute('href')`)) === 'https://ex.com', 'no link')
    expect(!(await visible('.md-link-editor')), 'editor still open')
  })
  await test('D2', '修改并清空链接', async () => {
    await openFresh('A [site](https://old.com) link.\n')
    await app.clickText('site', 2)
    await app.menu('link')
    expect((await q(`document.querySelector('.md-link-editor input').value`)) === 'https://old.com', 'href not prefilled')
    await app.key('A', ['meta'])
    await app.key('Backspace')
    await app.key('Enter')
    expect((await count('#write a')) === 0, 'link not removed')
  })
  await test('D3', '链接编辑框 Esc 关闭', async () => {
    await openFresh('A [site](https://old.com) link.\n')
    await app.clickText('site', 2)
    await app.menu('link')
    await app.type('zzz')
    await app.key('Escape')
    expect(!(await visible('.md-link-editor')), 'not closed')
    expect((await q(`document.querySelector('#write a').getAttribute('href')`)) === 'https://old.com', 'href changed')
  })
  await test('D4', '⌘ + 单击打开链接', async () => {
    await openFresh('A [site](https://open.me) link.\n')
    const r = await app.rect('#write a')
    await app.clickAt(r.x, r.y, { modifiers: ['meta'] })
    const shell = (await app.e2e()).shell
    expect(shell.some(([k, url]) => k === 'openExternal' && url === 'https://open.me'), 'not opened')
  })
  await test('D5', '悬停链接显示提示', async () => {
    await openFresh('A [site](https://hover.me) link.\n')
    const r = await app.rect('#write a')
    // Move off the link first so entering it fires mouseover, as a real pointer would.
    await app.main(`win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 300 }); return true`)
    await sleep(80)
    await app.main(`win.webContents.sendInputEvent({ type: 'mouseMove', x: ${Math.round(r.x)}, y: ${Math.round(r.y)} }); return true`)
    await sleep(150)
    const tip = await q(`document.querySelector('#write a').title`)
    expect(tip.includes('https://hover.me') && tip.includes('单击打开'), `title ${JSON.stringify(tip)}`)
  })
  await test('D8', '链接编辑框点击别处时保存', async () => {
    await openFresh('Plain words to link.\n\nElsewhere.\n')
    const word = await app.page(`
      const t = document.querySelector('#write p').firstChild; const r = document.createRange(); r.setStart(t, 6); r.setEnd(t, 11)
      const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }`)
    await app.clickAt(word.x, word.y, { clickCount: 2 })
    await app.menu('link')
    await app.type('https://blur.me')
    await app.clickText('Elsewhere', 3)
    expect(!(await visible('.md-link-editor')), 'editor still open')
    expect((await q(`document.querySelector('#write a')?.getAttribute('href')`)) === 'https://blur.me', 'link not applied')
  })
  await test('D9', '图片路径框点别处时关闭', async () => {
    await openFresh('Text ![pic](a.png) end.\n\nOther line.\n')
    await app.click('#write .md-image')
    expect(await visible('#write .md-image-source'), 'source box not shown')
    await app.clickText('Other', 2)
    expect(!(await visible('#write .md-image-source')), 'source box still shown')
  })
  await test('D6', '插入图片并输入路径', async () => {
    await openFresh()
    await app.click('#write .ProseMirror')
    await app.menu('image')
    expect(await visible('.md-image-source'), 'source box not shown')
    expect((await active()).startsWith('TEXTAREA.md-image-source'), `focus ${await active()}`)
    await app.type('pixel.png')
    await app.key('Enter')
    await sleep(300)
    const img = await q(`(() => { const i = document.querySelector('#write .md-image img'); return i && { src: i.getAttribute('src'), w: i.naturalWidth } })()`)
    expect(img && img.src.endsWith('pixel.png') && img.w > 0, `img ${JSON.stringify(img)}`)
  })
  await test('D7', '单击图片修改 alt', async () => {
    const path = await openFresh('![](pixel.png)\n')
    await sleep(200)
    await app.click('#write .md-image img')
    expect(await visible('.md-image-source'), 'source not shown on click')
    await app.click('.md-image-source')
    await app.key('A', ['meta'])
    await app.type('![dot](pixel.png)')
    await app.key('Enter')
    const text = await save(path)
    expect(text.includes('![dot](pixel.png)'), `saved ${JSON.stringify(text)}`)
  })

  console.log('E. 扩展语法')
  const syntax = join(docs, 'syntax.md')
  await copyFile(join(ROOT, 'samples/syntax.md'), syntax)
  await test('E1', '扩展语法渲染', async () => {
    await app.answer('message', 1)
    await app.open(syntax)
    // Code blocks (math, diagrams) render once scrolled into view, as for a reader.
    for (const y of [400, 800, 1200, 1600, 2400]) {
      await app.page(`document.querySelector('#scroller').scrollTop = ${y}; return 1`)
      await sleep(400)
    }
    await sleep(2500)
    const got = await q(`({
      mark: document.querySelectorAll('#write mark.md-highlight').length, sup: document.querySelectorAll('#write sup.md-sup').length,
      sub: document.querySelectorAll('#write sub.md-sub').length, emoji: document.querySelectorAll('#write .md-emoji').length,
      u: document.querySelectorAll('#write u').length, kbd: document.querySelectorAll('#write kbd').length,
      alerts: document.querySelectorAll('#write .md-alert').length, toc: document.querySelectorAll('#write .md-toc-item').length,
      diagram: !!document.querySelector('#write .md-diagram svg'), katex: document.querySelectorAll('#write .katex').length,
      htmlBlock: !!document.querySelector('#write .md-html-block') })`)
    const missing = Object.entries(got).filter(([, v]) => !v).map(([k]) => k)
    expect(missing.length === 0, `missing ${missing.join(', ')}`)
  })
  await test('E2', '点击目录跳转', async () => {
    await app.page(`document.querySelector('#scroller').scrollTop = 0; return 1`)
    await app.click('#write .md-toc-item', 'Math')
    await sleep(800)
    const got = await q(`(() => { const s = document.querySelector('#scroller'); const h = [...document.querySelectorAll('#write h2')].find((e) => e.textContent === 'Math')
      return { delta: Math.round(h.getBoundingClientRect().top - s.getBoundingClientRect().top), atBottom: s.scrollTop + s.clientHeight >= s.scrollHeight - 2, visible: h.getBoundingClientRect().bottom < s.getBoundingClientRect().bottom } })()`)
    // Near the end of a document the heading cannot reach the top; it must at least be in view.
    expect((got.delta >= -5 && got.delta < 120) || (got.atBottom && got.visible), `heading ${JSON.stringify(got)}`)
  })
  await test('E3', '光标进入高亮显示 ==', async () => {
    await app.clickText('highlighted', 3)
    const metas = await html('#write .md-meta-inline')
    expect(metas.filter((m) => m === '==').length === 2, `metas ${JSON.stringify(metas)}`)
  })
  await test('E4', '编辑行内公式', async () => {
    const path = await openFresh('Inline $a+b$ math.\n')
    await sleep(300)
    await app.click('#write [data-type="math_inline"]')
    expect(await visible('.milkdown-latex-inline-edit'), 'math editor not shown')
    await app.click('.milkdown-latex-inline-edit .ProseMirror')
    expect(await visible('.milkdown-latex-inline-edit'), 'math editor vanished after clicking into it')
    await app.key('A', ['meta'])
    await app.type('c^2')
    await app.key('Enter')
    await sleep(200)
    const text = await save(path)
    expect(text.includes('$c^2$'), `saved ${JSON.stringify(text)}`)
  })

  console.log('F. 源码模式')
  await test('E5', '行内公式编辑框：点别处保存 / Esc 不改', async () => {
    const path = await openFresh('Inline $a+b$ math.\n\nNext paragraph.\n\n## Far heading\n')
    await sleep(300)
    const shown = () => q(`document.querySelector('.milkdown-latex-inline-edit')?.dataset.show === 'true'`)
    await app.click('#write [data-type="math_inline"]')
    expect(await shown(), 'math editor not shown')
    await app.click('.milkdown-latex-inline-edit .ProseMirror')
    await app.key('End')
    await app.type('+c')
    await app.clickText('Far', 2)
    expect(!(await shown()), 'still shown after clicking elsewhere')
    expect((await save(path)).includes('$a+b+c$'), 'edit lost when clicking elsewhere')
    await app.click('#write [data-type="math_inline"]')
    await app.clickText('math', 2)
    expect(!(await shown()), 'still shown after clicking the same paragraph')
    await app.click('#write [data-type="math_inline"]')
    await app.click('.milkdown-latex-inline-edit .ProseMirror')
    await app.key('End')
    await app.type('+d')
    await app.key('Escape')
    expect(!(await shown()), 'still shown after Esc')
    expect(await q(`document.querySelector('#write .ProseMirror').contains(document.activeElement)`), 'caret not back in the document')
    expect((await save(path)).includes('$a+b+c$'), 'Esc changed the formula')
  })
  await test('F1', '切换源代码模式', async () => {
    await app.open(basic)
    await app.menu('toggle-source')
    expect(await visible('#source'), 'source hidden')
    expect((await q(`document.querySelector('#source .cm-content').textContent`)).includes('# Basic'), 'markdown missing')
    expect((await app.menuChecked('toggle-source')) === true, 'menu not checked')
  })
  await test('F2', '源码编辑后切回', async () => {
    await app.clickText('Second line here', 16, '#source')
    await app.type(' EDIT')
    await app.menu('toggle-source')
    expect(await visible('#wysiwyg'), 'wysiwyg hidden')
    expect((await q(`document.querySelector('#write').textContent`)).includes('Second line here EDIT.'), 'edit missing')
  })
  await test('F3', '源码模式查找', async () => {
    await app.menu('toggle-source')
    await app.menu('find')
    expect((await count('#source .cm-search')) === 1, 'no CodeMirror search panel')
    await app.key('Escape')
    await app.menu('toggle-source')
  })

  console.log('G. 查找替换')
  await test('G1', '查找计数与高亮', async () => {
    await openFresh('apple Apple apple pie. Banana apple.\n')
    await app.click('#write .ProseMirror')
    await app.menu('find')
    expect((await active()).startsWith('INPUT.find-input'), `focus ${await active()}`)
    await app.type('apple')
    expect((await q(`document.querySelector('.find-count').textContent`)) === '1 / 4', `count ${await q(`document.querySelector('.find-count').textContent`)}`)
    expect((await count('#write .md-search-hit')) === 4, 'highlights')
  })
  await test('G2', '回车 / ⇧回车', async () => {
    await app.key('Enter')
    expect((await q(`document.querySelector('.find-count').textContent`)) === '2 / 4', 'next')
    await app.key('Enter', ['shift'])
    expect((await q(`document.querySelector('.find-count').textContent`)) === '1 / 4', 'prev')
  })
  await test('G3', '区分大小写', async () => {
    await app.click('.find-toggle[data-toggle="case"]')
    expect((await q(`document.querySelector('.find-count').textContent`)).endsWith('/ 3'), 'case-sensitive count')
    await app.click('.find-toggle[data-toggle="case"]')
  })
  await test('G4', '替换与全部替换', async () => {
    await app.menu('replace')
    expect(await visible('.replace-input'), 'replace row hidden')
    await app.click('.replace-input')
    await app.type('pear')
    await app.click('[data-action="replace"]')
    expect((await q(`document.querySelector('.find-count').textContent`)).endsWith('/ 3'), 'replace one')
    await app.click('[data-action="replace-all"]')
    expect((await q(`document.querySelector('.find-count').textContent`)) === '无结果', 'replace all')
    expect((await q(`document.querySelector('#write p').textContent`)).split('pear').length === 5, 'text not replaced')
  })
  await test('G5', 'Esc 关闭查找', async () => {
    await app.click('.find-input')
    await app.key('Escape')
    expect(!(await visible('#findbar')), 'findbar open')
    expect((await count('#write .md-search-hit')) === 0, 'highlights remain')
  })

  console.log('H. 侧边栏')
  const folder = join(docs, 'folder')
  await mkdir(join(folder, 'sub'), { recursive: true })
  await writeFile(join(folder, 'alpha.md'), '# Alpha\n\nFirst file.\n')
  await writeFile(join(folder, 'beta.md'), '# Beta\n\nHas a needle inside.\n')
  await writeFile(join(folder, 'sub', 'gamma.md'), '# Gamma\n\nNested.\n')
  await test('H1', '⇧⌘L 开关侧边栏', async () => {
    const open = await q(`document.documentElement.classList.contains('sidebar-open')`)
    await app.menu('toggle-sidebar')
    expect((await q(`document.documentElement.classList.contains('sidebar-open')`)) === !open, 'not toggled')
    await app.menu('toggle-sidebar')
  })
  await test('H2', '大纲跳转与高亮', async () => {
    await openFresh(['# First', ...Array.from({ length: 30 }, (_, i) => `Line ${i}.`), '## Second', ...Array.from({ length: 30 }, (_, i) => `More ${i}.`), '## Third', 'End.'].join('\n\n'))
    await app.menu('view-outline')
    await app.click('.outline-item', 'Third')
    await sleep(800)
    expect((await q(`document.querySelector('.outline-item.active')?.textContent`)) === 'Third', 'not active')
  })
  await test('H3', '打开文件夹显示文档列表', async () => {
    await app.answer('open', folder)
    await app.menu('open-folder')
    await sleep(400)
    expect((await count('.article')) === 3, `articles ${await count('.article')}`)
    expect((await q(`document.querySelector('.sidebar-title').textContent`)) === '文档', 'title')
    await app.answer('open', null)
  })
  await test('H4', '点击文档打开', async () => {
    await app.click('.article', 'beta')
    expect((await title()) === 'beta.md', `title ${await title()}`)
    expect((await q(`document.querySelector('.article.active')?.textContent.includes('beta')`)) === true, 'not highlighted')
  })
  await test('H5', '文件树展开 / 折叠 / 打开', async () => {
    await app.click('.sidebar-button[data-view="tree"]')
    expect((await count('.tree-row')) >= 5, 'tree rows')
    await app.click('.tree-row[data-kind="folder"]', 'sub')
    expect(!(await q(`[...document.querySelectorAll('.tree-row')].some((r) => r.textContent.includes('gamma'))`)), 'not collapsed')
    await app.click('.tree-row[data-kind="folder"]', 'sub')
    await app.click('.tree-row[data-kind="file"]', 'gamma')
    expect((await title()) === 'gamma.md', `title ${await title()}`)
  })
  await test('H6', '文件夹搜索', async () => {
    await app.click('.sidebar-button[data-view="search"]')
    await app.click('.search-input')
    await app.type('needle')
    await sleep(600)
    expect((await count('.search-hit')) === 1, `hits ${await count('.search-hit')}`)
    await app.click('.search-hit')
    await sleep(300)
    expect((await title()) === 'beta.md', `title ${await title()}`)
    expect(await visible('#findbar'), 'findbar not opened on hit')
    await app.click('.find-input')
    await app.key('Escape')
  })
  await test('H8', '拖动调整侧边栏宽度', async () => {
    const before = (await app.rect('#sidebar')).width
    const handle = await app.rect('#sidebar-resizer')
    await app.drag({ x: handle.x, y: handle.y }, { x: handle.x + 80, y: handle.y })
    const after = (await app.rect('#sidebar')).width
    expect(Math.abs(after - before - 80) <= 4, `width ${before} → ${after}`)
    await app.drag({ x: handle.x + 80, y: handle.y }, { x: handle.x, y: handle.y })
  })
  await test('H7', '底部按钮切换视图', async () => {
    await app.click('.sidebar-button[data-view="outline"]')
    expect((await q(`document.querySelector('.sidebar-title').textContent`)) === '大纲', 'outline')
    await app.click('.sidebar-button[data-view="articles"]')
    expect((await q(`document.querySelector('.sidebar-title').textContent`)) === '文档', 'articles')
  })

  console.log('I. 快速打开')
  await test('I1', '模糊搜索并打开', async () => {
    await app.menu('open-quickly')
    expect(await visible('#quick-open'), 'not shown')
    await app.type('gam')
    expect((await q(`document.querySelector('.quick-open-item .quick-open-name')?.textContent`)) === 'gamma.md', 'gamma not first')
    await app.key('Enter')
    expect((await title()) === 'gamma.md', `title ${await title()}`)
  })
  await test('I2', 'Esc 关闭', async () => {
    await app.menu('open-quickly')
    await app.key('Escape')
    expect(!(await visible('#quick-open')), 'still open')
  })
  await test('I3', '点击外部关闭', async () => {
    await app.menu('open-quickly')
    await app.clickAt(30, 600)
    expect(!(await visible('#quick-open')), 'still open')
  })

  console.log('J. 主题与视图')
  await test('J1', '主题菜单切换与勾选', async () => {
    for (const theme of ['night', 'gothic', 'newsprint', 'pixyll', 'whitey', 'github']) {
      await app.clickMenuItem(`theme-${theme}`)
      expect((await q(`document.documentElement.dataset.theme`)) === theme, `theme ${theme} not applied`)
      expect((await app.menuChecked(`theme-${theme}`)) === true, `menu not checked for ${theme}`)
    }
  })
  await test('J2', '专注模式', async () => {
    await openFresh('First para.\n\nSecond para.\n')
    await app.menu('toggle-focus')
    await app.clickText('Second', 2)
    await sleep(400) // the fade is a 0.2s transition
    const op = await q(`[...document.querySelectorAll('#write .ProseMirror > p')].map((p) => getComputedStyle(p).opacity)`)
    await app.menu('toggle-focus')
    expect(Number(op[0]) < 0.5 && Number(op[1]) === 1, `opacity ${op}`)
  })
  await test('J3', '打字机模式', async () => {
    await openFresh(Array.from({ length: 80 }, (_, i) => `Paragraph ${i}.`).join('\n\n'))
    await app.menu('toggle-typewriter')
    await app.clickText('Paragraph 40', 5)
    await app.type(' x')
    await sleep(600)
    const got = await q(`(() => { const sel = getSelection(); if (!sel.rangeCount) return { error: 'no selection', active: document.activeElement.className }
      const range = sel.getRangeAt(0); const r = range.getClientRects()[0] ?? range.startContainer.parentElement.getBoundingClientRect()
      const s = document.querySelector('#scroller').getBoundingClientRect(); return { off: Math.round(r.top - (s.top + s.height / 2)), text: range.startContainer.textContent.slice(0, 20) } })()`)
    await app.menu('toggle-typewriter')
    expect(got && Math.abs(got.off) < 80, `caret ${JSON.stringify(got)}`)
  })
  await test('J4', '显示 / 隐藏状态栏', async () => {
    await app.menu('toggle-statusbar')
    expect(!(await visible('#footer')), 'footer visible')
    await app.menu('toggle-statusbar')
  })
  await test('J5', '缩放', async () => {
    await app.menu('zoom-in')
    const z1 = await q(`getComputedStyle(document.documentElement).getPropertyValue('--zoom')`)
    await app.menu('zoom-reset')
    const z2 = await q(`getComputedStyle(document.documentElement).getPropertyValue('--zoom')`)
    expect(z1.trim() === '1.1' && z2.trim() === '1', `zoom ${z1} ${z2}`)
  })

  console.log('K. 状态栏')
  await test('K1', '鼠标移动显示、打字隐藏', async () => {
    await openFresh('Text.\n')
    await hoverFooter()
    expect(await q(`document.documentElement.classList.contains('footer-visible')`), 'not shown on mouse move')
    await app.clickText('Text', 2)
    await app.type('a')
    await sleep(400)
    expect(!(await q(`document.documentElement.classList.contains('footer-visible')`)), 'not hidden while typing')
  })
  await test('K2', '字数弹层', async () => {
    await hoverFooter()
    await app.click('#word-count')
    expect(await visible('#word-count-popover'), 'popover not shown')
    await app.clickText('Te', 1)
    expect(!(await visible('#word-count-popover')), 'popover not closed')
  })
  await test('K3', '状态栏按钮', async () => {
    await hoverFooter()
    await app.click('#toggle-mode')
    expect(await q(`document.documentElement.classList.contains('source-mode')`), 'source not toggled')
    await hoverFooter()
    await app.click('#toggle-mode')
    await hoverFooter()
    const open = await q(`document.documentElement.classList.contains('sidebar-open')`)
    await app.click('#toggle-sidebar')
    expect((await q(`document.documentElement.classList.contains('sidebar-open')`)) === !open, 'sidebar not toggled')
    await hoverFooter()
    await app.click('#toggle-sidebar')
  })

  console.log('L. 偏好设置')
  await test('L1', '打开与关闭', async () => {
    await app.menu('preferences')
    expect(await visible('#preferences'), 'not opened')
    await app.click('.prefs-close')
    expect(!(await visible('#preferences')), 'not closed by ✕')
    await app.menu('preferences')
    await app.key('Escape')
    expect(!(await visible('#preferences')), 'not closed by Esc')
    await app.menu('preferences')
    await app.clickAt(10, 400)
    expect(!(await visible('#preferences')), 'not closed by outside click')
  })
  await test('L2', '字号与正文宽度', async () => {
    await app.menu('preferences')
    await app.page(`const s = document.querySelector('[data-pref="fontSize"]'); s.value = '18'; s.dispatchEvent(new Event('change')); const w = document.querySelector('[data-pref="lineWidth"]'); w.value = 'wide'; w.dispatchEvent(new Event('change')); return 1`)
    const font = await q(`getComputedStyle(document.querySelector('#write')).fontSize`)
    const width = await q(`getComputedStyle(document.querySelector('#write')).maxWidth`)
    await app.page(`const s = document.querySelector('[data-pref="fontSize"]'); s.value = '16'; s.dispatchEvent(new Event('change')); const w = document.querySelector('[data-pref="lineWidth"]'); w.value = 'default'; w.dispatchEvent(new Event('change')); return 1`)
    await app.key('Escape')
    expect(font === '18px' && width === '1280px', `font ${font} width ${width}`)
  })
  await test('L3', '关闭自动配对', async () => {
    await app.menu('preferences')
    await app.click('.prefs-nav-item[data-section="editor"]')
    await app.click('[data-pref="autoPair"]')
    await app.key('Escape')
    await openFresh()
    await app.click('#write .ProseMirror')
    await app.type('(')
    const text = await q(`document.querySelector('#write p').textContent`)
    await app.menu('preferences')
    await app.click('.prefs-nav-item[data-section="editor"]')
    await app.click('[data-pref="autoPair"]')
    await app.key('Escape')
    expect(text === '(', `text ${JSON.stringify(text)}`)
  })

  console.log('M. Front Matter')
  await test('M1', '显示 front matter', async () => {
    await openFresh('---\ntitle: Hello\n---\n\nBody.\n')
    expect(await visible('.md-front-matter'), 'not shown')
    expect((await q(`document.querySelector('.md-front-matter').value`)) === 'title: Hello', 'value')
  })
  await test('M2', '编辑 front matter 并保存', async () => {
    const path = await openFresh('---\ntitle: Hello\n---\n\nBody.\n')
    await app.click('.md-front-matter')
    await app.key('End', ['meta'])
    await app.type('\nauthor: me')
    const text = await save(path)
    expect(text.startsWith('---\ntitle: Hello\nauthor: me\n---'), `saved ${JSON.stringify(text)}`)
  })
  await test('M3', '清空后退格删除', async () => {
    const path = await openFresh('---\ntitle: Hello\n---\n\nBody.\n')
    await app.click('.md-front-matter')
    await app.key('A', ['meta'])
    await app.key('Backspace')
    await app.key('Backspace')
    expect(!(await visible('.md-front-matter')), 'still shown')
    const text = await save(path)
    expect(text.startsWith('Body.'), `saved ${JSON.stringify(text)}`)
  })
  await test('M4', '插入 front matter', async () => {
    await openFresh('Body.\n')
    await app.clickText('Body', 2)
    await app.menu('front-matter')
    expect(await visible('.md-front-matter'), 'not shown')
    expect((await active()).startsWith('TEXTAREA'), `focus ${await active()}`)
  })

  console.log('N. 右键菜单与保存一致性')
  await test('N1', '右键段落菜单', async () => {
    await openFresh('Make me a heading.\n')
    await app.clickText('Make', 2)
    const r = await app.rect('#write p')
    await app.clickAt(r.left + 20, r.y, { button: 'right' })
    const items = await app.lastPopupLabels()
    const top = items.map((item) => (typeof item === 'string' ? item : Object.keys(item)[0]))
    for (const label of ['剪切', '拷贝', '粘贴', '段落', '格式', '插入']) expect(top.includes(label), `missing ${label}: ${top}`)
    expect(!top.includes('表格'), 'table submenu outside table')
  })
  await test('N2', '右键 › 段落 › 1 级标题', async () => {
    await app.clickPopupItem(['段落', '1 级标题'])
    expect((await html('#write h1'))[0] === 'Make me a heading.', 'not heading')
  })
  const cases = JSON.parse(await readFile(join(ROOT, 'src/renderer/src/roundtrip-cases.json'), 'utf8'))
  for (const [name, markdown] of Object.entries(cases.cases)) {
    await test('N3', `往返保存 ${name}`, async () => {
      const path = await openFresh(markdown + '\n')
      await sleep(150)
      const text = (await save(path)).trim()
      expect(text === markdown || text === cases.normalizations[name], `saved ${JSON.stringify(text)}`)
    })
  }

  console.log('P. 问题清单 (docs/problems.md)')
  const setPref = (key, value) =>
    app.page(`const c = document.querySelector('[data-pref="${key}"]'); if (c.type === 'checkbox') c.checked = ${JSON.stringify(value)}; else c.value = ${JSON.stringify(value)}; c.dispatchEvent(new Event('change')); return true`)
  await test('P1', '红绿灯使用系统默认位置', async () => {
    const platform = await app.main(`return process.platform`)
    if (platform !== 'darwin') return
    expect((await app.main(`return win.getWindowButtonPosition()`)) === null, 'custom traffic light position is set')
  })
  await test('P2', '窄窗口下侧边栏不遮挡正文', async () => {
    const original = await app.main(`return win.getSize()`)
    try {
      await openFresh('# Narrow\n\nSome text that must stay visible next to the sidebar.\n')
      if (!(await q(`document.documentElement.classList.contains('sidebar-open')`))) await app.menu('toggle-sidebar')
      for (const width of [700, 560]) {
        await app.main(`win.setSize(${width}, 700); return true`)
        await sleep(400)
        const sidebar = await app.rect('#sidebar')
        const main = await app.rect('.main')
        expect(sidebar.right <= main.left + 1, `${width}px: sidebar ${sidebar.right} overlaps editor ${main.left}`)
        expect(main.width >= 359, `${width}px: editor only ${main.width}px wide`)
      }
    } finally {
      await app.main(`win.setSize(${original[0]}, ${original[1]}); return true`)
      await sleep(300)
    }
  })
  const searchDir = join(docs, 'search-folder')
  await mkdir(searchDir, { recursive: true })
  await writeFile(join(searchDir, 'aaa-many.md'), Array.from({ length: 400 }, (_, i) => `common line ${i}`).join('\n'))
  await writeFile(join(searchDir, 'bold.md'), '这里有一段**粗体**文字，还有 [链接文本](https://x.y)。\n')
  await writeFile(join(searchDir, 'wrapped.md'), 'The quick brown\nfox jumps over.\n')
  await writeFile(join(searchDir, 'Project Notes.md'), 'Nothing to see.\n')
  await writeFile(join(searchDir, 'zzz-last.md'), 'only one common word here\n')
  const searchFor = async (query) => {
    const input = await app.rect('.search-input')
    await app.clickAt(input.x, input.y, { clickCount: 3 })
    await app.key('Backspace')
    await app.type(query)
    await sleep(700)
    return q(`[...document.querySelectorAll('.search-file')].map((e) => e.textContent)`)
  }
  await test('P3', '文件夹搜索：忽略标记、跨行、文件名、多关键字、不漏后面的文件', async () => {
    await app.answer('open', searchDir)
    await app.menu('open-folder')
    await sleep(400)
    await app.answer('open', null)
    await app.click('.sidebar-button[data-view="search"]')
    expect((await searchFor('粗体文字')).includes('bold.md'), 'markup in the way')
    expect((await searchFor('链接文本')).includes('bold.md'), 'link text not found')
    expect((await searchFor('brown fox')).includes('wrapped.md'), 'phrase across lines not found')
    expect((await searchFor('jumps quick')).includes('wrapped.md'), 'words in another order not found')
    expect((await searchFor('project notes')).includes('Project Notes.md'), 'file name not found')
    const common = await searchFor('common')
    expect(common.includes('zzz-last.md') && common.includes('aaa-many.md'), `files ${JSON.stringify(common)}`)
    await app.click('.search-file', 'zzz-last')
    await sleep(300)
    expect((await title()) === 'zzz-last.md', `title ${await title()}`)
  })
  await test('P4', '文档列表图标与大纲图标不同', async () => {
    const icons = await q(`['articles', 'outline'].map((v) => document.querySelector('.sidebar-button[data-view="' + v + '"] svg').innerHTML)`)
    expect(icons[0] !== icons[1] && icons[0].includes('M5.5 1.5'), 'articles icon unchanged')
  })
  await test('P5', '标题始终在右侧区域居中', async () => {
    const centered = async () => {
      await sleep(350)
      const titleBox = await app.rect('#title-wrap')
      const main = await app.rect('.main')
      return Math.abs(titleBox.x - main.x)
    }
    if (!(await q(`document.documentElement.classList.contains('sidebar-open')`))) await app.menu('toggle-sidebar')
    expect((await centered()) <= 2, `off by ${await centered()}`)
    const handle = await app.rect('#sidebar-resizer')
    await app.drag({ x: handle.x, y: handle.y }, { x: handle.x + 90, y: handle.y })
    expect((await centered()) <= 2, `after resize off by ${await centered()}`)
    await app.drag({ x: handle.x + 90, y: handle.y }, { x: handle.x, y: handle.y })
    await app.menu('toggle-sidebar')
    expect((await centered()) <= 2, `sidebar hidden: off by ${await centered()}`)
  })
  await test('P7', '退格一次删除标题类型', async () => {
    const path = await openFresh('### Third level\n\nText.\n')
    await app.clickText('Third', 0)
    await app.key('Home')
    await app.key('Backspace')
    const text = await save(path)
    expect(text.startsWith('Third level\n'), `saved ${JSON.stringify(text)}`)
  })
  await test('P8', '文件树箭头足够大', async () => {
    await app.answer('open', folder)
    await app.menu('open-folder')
    await sleep(300)
    await app.answer('open', null)
    await app.menu('view-tree')
    const arrow = await app.rect('.tree-row[data-kind="folder"] .disclosure')
    const glyph = await app.rect('.tree-row[data-kind="folder"] .disclosure svg')
    expect(arrow && arrow.width >= 16 && glyph.width >= 10, `arrow ${JSON.stringify(arrow)} glyph ${JSON.stringify(glyph)}`)
    await app.click('.tree-row[data-kind="folder"] .disclosure')
    expect((await count('.tree-row[data-kind="folder"] .disclosure.expanded')) === 0, 'did not collapse')
    await app.click('.tree-row[data-kind="folder"] .disclosure')
  })
  const syntaxDoc = join(docs, 'syntax.md')
  await copyFile(join(ROOT, 'samples/syntax.md'), syntaxDoc)
  await test('P13', '导出 HTML：扩展语法、目录、图表、公式与主题样式', async () => {
    await app.answer('message', 1)
    await app.open(syntaxDoc)
    await sleep(1500)
    const target = join(docs, 'export-styled.html')
    await app.answer('save', target)
    await app.menu('export-html')
    await sleep(1500)
    const out = await readFile(target, 'utf8')
    for (const needle of ['<mark', '<sub', '<sup', '😄', 'md-alert', 'href="#', '<svg', 'class="katex', 'data-theme="github"', '--bg-color']) {
      expect(out.includes(needle), `missing ${needle}`)
    }
    const body = out.slice(out.indexOf('<body>'))
    for (const raw of ['==highlighted==', ':smile:', '[toc]', '[!NOTE]', 'contenteditable', 'md-hidden-syntax']) expect(!body.includes(raw), `raw ${raw} left in`)
  })
  await test('P13b', '导出 HTML：图片相对路径 / 内嵌', async () => {
    await openFresh('Image ![dot](pixel.png) here.\n')
    await sleep(300)
    const sub = join(docs, 'exports')
    await mkdir(sub, { recursive: true })
    await app.answer('save', join(sub, 'linked.html'))
    await app.menu('export-html')
    await sleep(800)
    expect((await readFile(join(sub, 'linked.html'), 'utf8')).includes('src="../pixel.png"'), 'image not linked relatively')
    await app.menu('preferences')
    await app.click('.prefs-nav-item[data-section="export"]')
    await setPref('htmlEmbedImages', true)
    await app.key('Escape')
    await app.answer('save', join(sub, 'embedded.html'))
    await app.menu('export-html')
    await sleep(800)
    await app.menu('preferences')
    await setPref('htmlEmbedImages', false)
    await app.key('Escape')
    expect((await readFile(join(sub, 'embedded.html'), 'utf8')).includes('src="data:image/png;base64,'), 'image not embedded')
  })
  await test('P9', '导出 PDF：使用页面设置，公式不再是源码', async () => {
    await app.answer('message', 1)
    await app.open(syntaxDoc)
    await sleep(1000)
    await app.menu('preferences')
    await app.click('.prefs-nav-item[data-section="export"]')
    await setPref('pdfPageSize', 'Letter')
    await app.key('Escape')
    const target = join(docs, 'export.pdf')
    await app.answer('save', target)
    await app.menu('export-pdf')
    // Done when the status message says so (the file exists while it is still being written).
    for (let i = 0; i < 60 && !(await q(`document.querySelector('#toast')?.textContent ?? ''`)).startsWith('已导出'); i++) await sleep(250)
    await app.menu('preferences')
    await setPref('pdfPageSize', 'A4')
    await app.key('Escape')
    const pdf = await readFile(target)
    expect(pdf.subarray(0, 5).toString() === '%PDF-' && pdf.length > 20000, `pdf ${pdf.length} bytes`)
    // US Letter is 612 × 792 points.
    expect(/MediaBox\s*\[\s*0 0 612 792/.test(pdf.toString('latin1')), 'page size not Letter')
  })
  await test('P13c', '导出 HTML（无样式）', async () => {
    const target = join(docs, 'export-plain.html')
    await app.answer('save', target)
    await app.menu('export-html-plain')
    await sleep(600)
    const out = await readFile(target, 'utf8')
    expect(!out.includes('<style') && out.includes('<math') && out.includes('<h1'), 'plain export wrong')
  })
  await test('P10', '偏好设置：分组与拖动', async () => {
    await app.menu('preferences')
    const labels = await q(`[...document.querySelectorAll('.prefs-nav-item')].map((b) => b.textContent)`)
    expect(JSON.stringify(labels) === JSON.stringify(['通用', '编辑器', '图像', '导出', '外观']), `sections ${JSON.stringify(labels)}`)
    await app.click('.prefs-nav-item[data-section="image"]')
    expect(await visible('[data-pref="imageInsert"]'), 'image section not shown')
    expect(!(await visible('[data-pref="autoSave"]')), 'other sections still shown')
    const before = await app.rect('.prefs-panel')
    const header = await app.rect('.prefs-header')
    await app.drag({ x: header.x - 100, y: header.y }, { x: header.x - 20, y: header.y + 60 })
    const after = await app.rect('.prefs-panel')
    expect(Math.abs(after.left - before.left - 80) <= 2 && Math.abs(after.top - before.top - 60) <= 2, `moved ${after.left - before.left}, ${after.top - before.top}`)
    await app.key('Escape')
    await app.menu('preferences')
    const reopened = await app.rect('.prefs-panel')
    expect(Math.abs(reopened.left - after.left) <= 2, 'position not kept')
    await app.click('.prefs-nav-item[data-section="appearance"]')
    await app.menu('theme-night')
    expect((await q(`document.querySelector('[data-pref="theme"]').value`)) === 'night', 'dialog not updated by the menu')
    await app.menu('theme-github')
    await app.key('Escape')
  })
  await test('P12', '图片网址自动换行，可以选中其中一部分', async () => {
    const url = 'https://example.com/images/a/very/long/path/that/keeps/going/and/going/and/going/forever/and/ever/picture-name.png'
    await openFresh(`Text ![remote](${url}) after.\n`)
    await app.main(`win.setSize(700, 700); return true`)
    await sleep(300)
    try {
      // The remote image loads or fails (offline); either way something must be clickable.
      for (let i = 0; i < 40 && !(await q(`document.querySelector('#write .md-image').getBoundingClientRect().width > 0`)); i++) await sleep(250)
      await app.click('#write .md-image')
      await sleep(200)
      const box = await app.page(`const s = document.querySelector('.md-image-source'); const r = s.getBoundingClientRect(); return { tag: s.tagName, left: r.left, top: r.top, width: r.width, height: r.height, scroll: s.scrollWidth - s.clientWidth, line: parseFloat(getComputedStyle(s).lineHeight) }`)
      expect(box.tag === 'TEXTAREA' && box.scroll <= 1, `box ${JSON.stringify(box)}`)
      expect(box.height > box.line * 1.8, `not wrapped: ${box.height}px`)
      const y = box.top + box.line / 2 + 2
      await app.drag({ x: box.left + 60, y }, { x: box.left + 200, y })
      const sel = await q(`(() => { const s = document.querySelector('.md-image-source'); return [document.activeElement === s, s.selectionStart, s.selectionEnd, s.value.length] })()`)
      expect(sel[0] && sel[2] - sel[1] > 5 && sel[2] - sel[1] < sel[3], `selection ${JSON.stringify(sel)}`)
    } finally {
      await app.main(`win.setSize(1180, 800); return true`)
      await sleep(300)
    }
  })

  // A stand-in for PicGo.app's upload server; skipped if a real PicGo is listening.
  const http = await import('node:http')
  const picgoRequests = []
  const picgo = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const list = JSON.parse(body || '{}').list ?? []
      picgoRequests.push(list)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ success: true, result: list.map((path) => `https://picgo.example/${basename(path)}`) }))
    })
  })
  const picgoListening = await new Promise((done) => {
    picgo.once('error', () => done(false))
    picgo.listen(36677, '127.0.0.1', () => done(true))
  })
  const pasteImage = () =>
    app.page(`const bytes = Uint8Array.from(atob(${JSON.stringify(PIXEL.toString('base64'))}), (c) => c.charCodeAt(0))
      const data = new DataTransfer(); data.items.add(new File([bytes], 'shot.png', { type: 'image/png' }))
      document.querySelector('#write .ProseMirror').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      return true`)
  await test('P6', '图片上传：PicGo (app)、插入时上传、上传全部本地图片', async () => {
    if (!picgoListening) return console.log('      (skipped: port 36677 is in use)')
    await app.menu('preferences')
    await app.click('.prefs-nav-item[data-section="image"]')
    await setPref('uploadService', 'picgo-app')
    await setPref('imageInsert', 'upload')
    await app.click('[data-action="test-upload"]')
    await sleep(800)
    expect((await q(`document.querySelector('[data-status="upload"]').textContent`)).includes('https://picgo.example/'), 'test upload failed')
    await app.key('Escape')
    const path = await openFresh('Paste here: \n\nLocal ![dot](pixel.png)\n')
    await app.clickText('Paste here', 11)
    await app.key('End')
    await pasteImage()
    await sleep(800)
    let text = await save(path)
    expect(/!\[[^\]]*\]\(https:\/\/picgo\.example\/[^)]*shot\.png\)/.test(text), `pasted image not uploaded: ${JSON.stringify(text)}`)
    await app.menu('upload-images')
    await sleep(800)
    text = await save(path)
    expect(text.includes('![dot](https://picgo.example/pixel.png)'), `local image not uploaded: ${JSON.stringify(text)}`)
    expect(picgoRequests.some((list) => list.some((p) => p.endsWith(join(docs, 'pixel.png')))), 'wrong file sent')
  })
  await test('P6b', '图片上传：自定义命令，失败时保留本地图片', async () => {
    const command = `'${process.execPath}' -e "console.log('https://cmd.example/' + require('path').basename(process.argv[1]))"`
    await app.menu('preferences')
    await app.click('.prefs-nav-item[data-section="image"]')
    await setPref('uploadService', 'custom')
    await setPref('uploadCommand', command)
    await setPref('imageInsert', 'upload')
    await app.click('[data-action="test-upload"]')
    for (let i = 0; i < 40 && (await q(`document.querySelector('[data-status="upload"]').textContent`)).startsWith('正在'); i++) await sleep(250)
    expect((await q(`document.querySelector('[data-status="upload"]').textContent`)).includes('https://cmd.example/'), await q(`document.querySelector('[data-status="upload"]').textContent`))
    await setPref('uploadCommand', 'false')
    await app.key('Escape')
    const path = await openFresh('Paste here: \n')
    await app.clickText('Paste here', 11)
    await app.key('End')
    await pasteImage()
    for (let i = 0; i < 40 && !(await count('#write .md-image')); i++) await sleep(250)
    const text = await save(path)
    expect(/!\[[^\]]*\]\(assets\/[^)]*shot\.png\)/.test(text), `not kept locally: ${JSON.stringify(text)}`)
    expect((await q(`document.querySelector('#toast')?.dataset.kind`)) === 'error', 'no error shown')
    await app.menu('preferences')
    await setPref('imageInsert', 'assets')
    await setPref('uploadService', 'picgo-app')
    await setPref('uploadCommand', '')
    await app.key('Escape')
  })
  picgo.close()

  await test('P11', '自定义主题：主题文件夹里的 CSS 重启后可选', async () => {
    const themes = join(await app.main(`return electron.app.getPath('userData')`), 'themes')
    await mkdir(themes, { recursive: true })
    await writeFile(join(themes, 'ocean-breeze.css'), ':root { --bg-color: rgb(1, 2, 3); color-scheme: dark; }\n#write h1 { letter-spacing: 3px; }\n')
    // Restart the window the way a relaunch would read the folder again.
    await app.main(`win.webContents.reload(); return true`)
    for (let i = 0; i < 40 && !(await app.page(`return !!document.querySelector('#write .ProseMirror')`).catch(() => false)); i++) await sleep(250)
    await sleep(500)
    expect(existsSync(join(themes, 'README.md')), 'theme folder guide missing')
    await app.clickMenuItem('theme-custom:ocean-breeze')
    expect((await q(`getComputedStyle(document.body).backgroundColor`)) === 'rgb(1, 2, 3)', 'custom theme not applied')
    expect(await app.menuChecked('theme-custom:ocean-breeze'), 'menu not checked')
    expect((await app.main(`return win.getBackgroundColor()`)).toLowerCase() === '#010203', 'window background not synced')
    await app.menu('preferences')
    await app.click('.prefs-nav-item[data-section="appearance"]')
    expect((await q(`[...document.querySelectorAll('[data-pref="theme"] option')].map((o) => o.textContent)`)).includes('Ocean Breeze'), 'not in preferences')
    await app.key('Escape')
    await app.clickMenuItem('theme-github')
    expect((await q(`getComputedStyle(document.body).backgroundColor`)) === 'rgb(255, 255, 255)', 'did not switch back')
  })
  console.log('Q. 问题清单第二轮 (docs/problems.md)')
  await test('Q1', '窗口原生外观跟随主题（红绿灯不再被压扁）', async () => {
    if ((await app.main(`return process.platform`)) !== 'darwin') return
    await app.clickMenuItem('theme-night')
    expect((await app.main(`return [electron.nativeTheme.themeSource, electron.nativeTheme.shouldUseDarkColors]`)).join() === 'dark,true', 'night is not dark')
    await app.clickMenuItem('theme-github')
    expect((await app.main(`return [electron.nativeTheme.themeSource, electron.nativeTheme.shouldUseDarkColors]`)).join() === 'light,false', 'github is not light')
  })
  await test('Q2', '偏好设置分组前有单色图标', async () => {
    await app.menu('preferences')
    const icons = await q(`[...document.querySelectorAll('.prefs-nav-item')].map((b) => { const svg = b.querySelector('svg'); return svg ? [svg.getAttribute('stroke'), Math.round(svg.getBoundingClientRect().width)].join() : null })`)
    expect(icons.length === 5 && icons.every((icon) => icon === 'currentColor,16'), `icons ${JSON.stringify(icons)}`)
    expect(JSON.stringify(await q(`[...document.querySelectorAll('.prefs-nav-item')].map((b) => b.textContent)`)) === JSON.stringify(['通用', '编辑器', '图像', '导出', '外观']), 'labels changed')
    await app.key('Escape')
  })
  await writeFile(join(docs, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#4a90d9"/></svg>')
  const imageBox = () => q(`(() => { const i = document.querySelector('#write .md-image img'), p = i.closest('p').getBoundingClientRect(), r = i.getBoundingClientRect(); return { width: Math.round(r.width), left: Math.round(r.left - p.left), right: Math.round(p.right - r.right) } })()`)
  await test('Q3', '拖动手柄调整图片大小，双击恢复', async () => {
    const path = await openFresh('Intro\n\n![pic](pic.svg)\n\nAfter.\n')
    for (let i = 0; i < 20 && (await imageBox()).width !== 200; i++) await sleep(100)
    expect(!(await visible('#write .md-image-resize')), 'handle shown before the image is selected')
    await app.click('#write .md-image img')
    // Selecting shows the source box above the picture, so measure afterwards.
    const img = await app.rect('#write .md-image img')
    const handle = await app.rect('#write .md-image-resize')
    expect(handle && handle.width > 0 && Math.abs(handle.x - img.right) < 8 && Math.abs(handle.y - img.bottom) < 8, `handle ${JSON.stringify(handle)}`)
    // Centered: the image shrinks on both sides, twice the pointer's distance.
    await app.drag({ x: handle.x, y: handle.y }, { x: handle.x - 40, y: handle.y })
    expect((await imageBox()).width === 120, `width ${JSON.stringify(await imageBox())}`)
    let text = await save(path)
    expect(text.includes('<img src="pic.svg" alt="pic" width="120" />'), `saved ${JSON.stringify(text)}`)
    await app.key('Z', ['meta'])
    expect((await imageBox()).width === 200, 'undo did not restore the size')
    await app.key('Z', ['meta', 'shift'])
    // Reopened, it is still an image (selectable, resizable), not raw HTML.
    await app.answer('message', 1)
    await app.open(path)
    await sleep(300)
    expect((await count('#write .md-image')) === 1 && (await imageBox()).width === 120, `reopened ${JSON.stringify(await imageBox())}`)
    await app.click('#write .md-image img')
    const handle2 = await app.rect('#write .md-image-resize')
    await app.clickAt(handle2.x, handle2.y, { clickCount: 1 })
    await app.clickAt(handle2.x, handle2.y, { clickCount: 2 })
    await sleep(150)
    text = await save(path)
    expect(text.includes('![pic](pic.svg)') && (await imageBox()).width === 200, `not reset: ${JSON.stringify(text)}`)
  })
  await test('Q4', '图片对齐：默认居中，可改为居左 / 居右', async () => {
    await openFresh('![pic](pic.svg)\n\nText ![inline](pic.svg) here.\n')
    for (let i = 0; i < 20 && (await imageBox()).width !== 200; i++) await sleep(100)
    let box = await imageBox()
    expect(Math.abs(box.left - box.right) <= 2, `not centered ${JSON.stringify(box)}`)
    expect((await q(`getComputedStyle(document.querySelectorAll('#write p')[1]).textAlign`)) === 'start', 'image in text was aligned')
    await app.menu('preferences')
    await app.click('.prefs-nav-item[data-section="image"]')
    expect((await q(`document.querySelector('[data-pref="imageAlign"]').value`)) === 'center', 'default is not center')
    await setPref('imageAlign', 'right')
    box = await imageBox()
    expect(box.right <= 1 && box.left > 100, `not right ${JSON.stringify(box)}`)
    await setPref('imageAlign', 'left')
    box = await imageBox()
    expect(box.left <= 1, `not left ${JSON.stringify(box)}`)
    await setPref('imageAlign', 'center')
    await app.key('Escape')
  })
  await test('Q5', '选择自定义主题时内置主题不再同时打勾', async () => {
    const themes = join(await app.main(`return electron.app.getPath('userData')`), 'themes')
    // P11 adds the theme; create it here when running Q on its own.
    if ((await app.menuChecked('theme-custom:ocean-breeze')) === null) {
      await mkdir(themes, { recursive: true })
      await writeFile(join(themes, 'ocean-breeze.css'), ':root { --bg-color: rgb(1, 2, 3); color-scheme: dark; }\n')
      await app.main(`win.webContents.reload(); return true`)
      for (let i = 0; i < 40 && !(await app.page(`return !!document.querySelector('#write .ProseMirror')`).catch(() => false)); i++) await sleep(250)
      await sleep(500)
    }
    await app.clickMenuItem('theme-night')
    await app.clickMenuItem('theme-custom:ocean-breeze')
    const checked = async () => {
      const ids = ['theme-github', 'theme-night', 'theme-custom:ocean-breeze']
      return Object.fromEntries(await Promise.all(ids.map(async (id) => [id.replace('theme-', ''), await app.menuChecked(id)])))
    }
    let state = await checked()
    expect(!state.night && !state.github && state['custom:ocean-breeze'], `checked ${JSON.stringify(state)}`)
    await app.clickMenuItem('theme-github')
    state = await checked()
    expect(state.github && !state['custom:ocean-breeze'] && !state.night, `checked ${JSON.stringify(state)}`)
    // Choosing the current theme again keeps it checked.
    await app.clickMenuItem('theme-github')
    expect(await app.menuChecked('theme-github'), 'unchecked by a second click')
  })
  await test('Q6', 'PicGo 端口可以配置，默认 36677', async () => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ success: true, result: (JSON.parse(body || '{}').list ?? []).map((path) => `https://port.example/${basename(path)}`) }))
      })
    })
    const port = await new Promise((done) => server.listen(0, '127.0.0.1', () => done(server.address().port)))
    try {
      await app.menu('preferences')
      await app.click('.prefs-nav-item[data-section="image"]')
      await setPref('uploadService', 'picgo-app')
      expect((await q(`document.querySelector('[data-pref="picgoPort"]').value`)) === '36677', 'default port is not 36677')
      await setPref('picgoPort', String(port))
      await app.click('[data-action="test-upload"]')
      for (let i = 0; i < 20 && (await q(`document.querySelector('[data-status="upload"]').textContent`)).startsWith('正在'); i++) await sleep(150)
      expect((await q(`document.querySelector('[data-status="upload"]').textContent`)).includes('https://port.example/'), await q(`document.querySelector('[data-status="upload"]').textContent`))
      await setPref('picgoPort', '70000')
      expect((await q(`document.querySelector('[data-pref="picgoPort"]').value`)) === String(port), 'invalid port accepted')
      await setPref('picgoPort', '')
      expect((await q(`document.querySelector('[data-pref="picgoPort"]').value`)) === '36677', 'empty port did not go back to the default')
      await app.key('Escape')
    } finally {
      server.close()
    }
  })
  const caretAfter = () => q(`(() => { const s = getSelection(), n = s.anchorNode; const before = n.nodeType === 1 ? n.childNodes[s.anchorOffset - 1] : null; return before?.className ?? (n.nodeType === 3 ? 'text:' + n.textContent.slice(0, s.anchorOffset) : n.nodeName) })()`)
  await test('Q7', '光标可以移到 ** 外侧，退格删除 * 取消加粗', async () => {
    const path = await openFresh('Make **1** bold here\n\nEnd **bold**\n\nKeep **this** word\n')
    await app.clickText('1', 1)
    expect((await count('#write p:first-child .md-meta')) === 2, 'syntax not revealed')
    await app.key('Right')
    expect((await caretAfter()).includes('md-meta-close'), `caret not after **: ${await caretAfter()}`)
    await app.key('Backspace')
    let text = await save(path)
    expect(text.startsWith('Make \\*\\*1\\* bold here\n'), `after backspace ${JSON.stringify(text)}`)
    // Typing the * back makes it bold again.
    await app.type('*')
    text = await save(path)
    expect(text.startsWith('Make **1** bold here\n'), `after retyping ${JSON.stringify(text)}`)
    // A click past the closing ** puts the caret outside: typed text is not bold.
    await app.clickText('bold', 1, '#write p:nth-child(2)')
    const close = await app.rect('#write p:nth-child(2) .md-meta-close')
    await app.clickAt(close.right + 20, close.y)
    await app.type('X')
    // Left from inside the text steps over nothing; Delete before the closing ** removes a *.
    await app.clickText('this', 4, '#write p:nth-child(3)')
    await app.key('Delete')
    text = await save(path)
    expect(text.includes('End **bold**X\n') && text.includes('Keep \\*\\*this\\* word'), `saved ${JSON.stringify(text)}`)
  })

  console.log('R. 问题清单第三轮 (docs/problems.md)')
  // Whether the footer button has the theme's active-item gray behind it.
  const toggleGray = (id) =>
    q(`(() => { const probe = document.body.appendChild(document.createElement('div')); probe.style.background = 'var(--active-file-bg-color)'
      const gray = getComputedStyle(probe).backgroundColor; probe.remove(); return getComputedStyle(document.getElementById('${id}')).backgroundColor === gray })()`)
  await test('R1', '侧边栏、源码按钮打开时带浅灰背景', async () => {
    await openFresh('Text.\n')
    const sidebar = await q(`document.documentElement.classList.contains('sidebar-open')`)
    if (sidebar) await app.menu('toggle-sidebar')
    for (const theme of ['github', 'night']) {
      await app.menu(`theme-${theme}`)
      await hoverFooter()
      expect(!(await toggleGray('toggle-mode')) && !(await toggleGray('toggle-sidebar')), `${theme}: gray while off`)
      // Clicked with the mouse still on the button: the gray is not replaced by the hover background.
      await app.click('#toggle-mode')
      await hoverFooter()
      await app.click('#toggle-sidebar')
      await hoverFooter()
      expect((await toggleGray('toggle-mode')) && (await toggleGray('toggle-sidebar')), `${theme}: not gray while on`)
      await app.click('#toggle-sidebar')
      await hoverFooter()
      await app.click('#toggle-mode')
    }
    await app.menu('theme-github')
    if (sidebar) await app.menu('toggle-sidebar')
  })
  console.log('S. 数据安全 (docs/optimization-plan.md v0.2)')
  const editorText = (target = app) => target.page(`return document.querySelector('#write .ProseMirror').textContent`)
  const noticeKind = (target = app) => target.page(`const n = document.querySelector('#notice'); return n.hidden ? null : n.dataset.kind`)
  const noticeText = (target = app) => target.page(`return document.querySelector('#notice').textContent.replace(/\s+/g, ' ').trim()`)
  async function waitFor(check, ms = 4000) {
    for (let waited = 0; waited < ms; waited += 100) {
      if (await check()) return true
      await sleep(100)
    }
    return false
  }
  const history = (path) => app.page(`const list = await window.mtypora.listHistory(${JSON.stringify(path)}); return Promise.all(list.map((e) => window.mtypora.readHistory(${JSON.stringify(path)}, e.id)))`)
  const draftsIn = (profile) => (existsSync(join(profile, 'drafts')) ? readdirSync(join(profile, 'drafts')).filter((n) => n.endsWith('.json')) : [])

  await test('S1', '保存不留临时文件，符号链接保持为链接', async () => {
    const path = await openFresh('Atomic.\n')
    await app.clickText('Atomic', 6)
    await app.type(' write')
    expect((await save(path)) === 'Atomic write.\n', 'not saved')
    expect(!readdirSync(docs).some((name) => name.endsWith('.m-typora-tmp')), 'temporary file left behind')
    const real = await fixture('Linked.\n')
    const link = join(docs, `link-${counter}.md`)
    await symlink(real, link)
    await app.answer('message', 1)
    await app.open(link)
    await app.clickText('Linked', 6)
    await app.type(' through')
    await app.menu('save')
    await sleep(200)
    expect(lstatSync(link).isSymbolicLink(), 'the link was replaced by a file')
    expect((await readFile(real, 'utf8')) === 'Linked through.\n', `target ${await readFile(real, 'utf8')}`)
  })
  await test('S2', '写入失败时原文件不变并提示', async () => {
    const dir = join(docs, 'locked')
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'locked.md')
    await writeFile(path, 'Locked.\n')
    await app.answer('message', 1)
    await app.open(path)
    await app.clickText('Locked', 6)
    await app.type(' change')
    await chmod(dir, 0o555)
    try {
      await app.menu('save')
      await sleep(300)
      expect((await readFile(path, 'utf8')) === 'Locked.\n', 'file changed')
      const toast = await q(`document.querySelector('#toast')?.textContent ?? ''`)
      expect(toast.startsWith('保存失败'), `toast ${toast}`)
      expect(await edited(), 'not marked edited')
    } finally {
      await chmod(dir, 0o755)
    }
  })
  await test('S3', '无未保存修改时，外部修改自动载入', async () => {
    const path = await openFresh('Outside one.\n')
    await writeFile(path, 'Outside two.\n')
    expect(await waitFor(async () => (await editorText()).includes('Outside two')), `text ${await editorText()}`)
    expect(!(await edited()), 'marked edited')
    expect((await noticeKind()) === null, 'notice shown')
  })
  await test('S4', '有未保存修改时外部修改出现提示，可载入外部版本', async () => {
    const path = await openFresh('Mine.\n')
    await app.clickText('Mine', 4)
    await app.type(' edited')
    await writeFile(path, 'Theirs.\n')
    expect(await waitFor(async () => (await noticeKind()) === 'conflict'), 'no conflict notice')
    expect((await editorText()).includes('Mine edited'), 'edits replaced without asking')
    await app.click('#notice .notice-button', '载入外部版本')
    expect((await editorText()) === 'Theirs.', `text ${await editorText()}`)
    expect(!(await edited()) && (await noticeKind()) === null, 'still edited or notice shown')
  })
  await test('S5', '保留我的版本：覆盖外部版本，外部版本进入历史', async () => {
    const path = await openFresh('Base.\n')
    await app.clickText('Base', 4)
    await app.type(' mine')
    await writeFile(path, 'External.\n')
    expect(await waitFor(async () => (await noticeKind()) === 'conflict'), 'no conflict notice')
    await app.click('#notice .notice-button', '保留我的版本')
    expect((await noticeKind()) === null, 'notice still shown')
    expect((await save(path)) === 'Base mine.\n', 'not overwritten')
    expect((await history(path)).includes('External.\n'), 'external version not kept')
  })
  await test('S6', '保存前发现外部修改：不覆盖', async () => {
    const path = await openFresh('Quick.\n')
    await app.clickText('Quick', 5)
    await app.type(' edit')
    // Saved before the file watcher reports the change.
    await writeFile(path, 'Sneaky.\n')
    await app.menu('save')
    expect((await readFile(path, 'utf8')) === 'Sneaky.\n', 'outside change overwritten')
    expect((await noticeKind()) === 'conflict', `notice ${await noticeKind()}`)
  })
  await test('S7', '文件被删除：提示，保存时另存为原位置', async () => {
    const path = await openFresh('Doomed.\n')
    await rm(path)
    expect(await waitFor(async () => (await noticeKind()) === 'deleted'), 'no deleted notice')
    expect(await edited(), 'not marked edited')
    await app.answer('save', null)
    await app.menu('save')
    const dialog = (await app.e2e()).dialogs.at(-1)
    expect(dialog[0] === 'save' && dialog[1] === path, `dialog ${JSON.stringify(dialog)}`)
    // Brought back unchanged: the notice goes away.
    await writeFile(path, 'Doomed.\n')
    expect(await waitFor(async () => (await noticeKind()) === null), 'notice still shown')
    expect(!(await edited()), 'still edited')
  })
  await test('S11', '历史版本：保存前保留旧版本，可预览、恢复、撤销', async () => {
    const path = await openFresh('Version one.\n')
    await app.clickText('one', 3)
    await app.type(' plus')
    await save(path)
    await app.clickText('plus', 4)
    await app.type(' more')
    expect((await save(path)) === 'Version one plus more.\n', 'second save')
    // The second save came right after the first: only the original was kept.
    const kept = await history(path)
    expect(kept.length === 1 && kept[0] === 'Version one.\n', `history ${JSON.stringify(kept)}`)
    await app.menu('history')
    expect(await visible('#history'), 'dialog not shown')
    expect(await waitFor(async () => (await q(`document.querySelector('.history-preview').textContent`)) === 'Version one.\n'), 'preview')
    await app.click('#history .dialog-button', '恢复此版本')
    expect(!(await visible('#history')), 'dialog still open')
    expect((await editorText()) === 'Version one.', `restored ${await editorText()}`)
    expect(await edited(), 'restore is not an edit')
    await app.menu('undo')
    expect((await editorText()) === 'Version one plus more.', `undo ${await editorText()}`)
  })
  await test('S12', '同一文件只在一个窗口中打开', async () => {
    const path = await openFresh('Shared.\n')
    const firstId = await app.main(`return win.id`)
    await app.main(`electron.Menu.getApplicationMenu().items.flatMap((i) => i.submenu?.items ?? []).find((i) => i.label === '新建窗口').click(); return true`)
    const other = `electron.BrowserWindow.getAllWindows().find((w) => w.id !== ${firstId})`
    const inOther = (code) => app.main(`return ${other}.webContents.executeJavaScript(${JSON.stringify(`(async () => { ${code} })()`)})`)
    try {
      expect(await waitFor(() => inOther(`return !!document.querySelector('#write .ProseMirror')`).catch(() => false)), 'second window not ready')
      await sleep(300)
      expect((await inOther(`return window.mtypora.focusOpenWindow(${JSON.stringify(path)})`)) === true, 'not found in the first window')
      await app.main(`${other}.webContents.send('open-path', ${JSON.stringify(path)}); return true`)
      await sleep(600)
      expect((await inOther(`return document.querySelector('#title').textContent`)) === '未命名', 'opened a second time')
      expect((await app.main(`return electron.BrowserWindow.getAllWindows().length`)) === 2, 'window count')
    } finally {
      await app.main(`${other}?.destroy(); return true`)
    }
  })
  await test('S13', '侧边栏随文件夹的外部变化刷新', async () => {
    const folder = join(docs, 'watched')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'first.md'), '# First\n')
    await app.answer('open', folder)
    await app.menu('open-folder')
    await app.answer('open', null)
    await sleep(300)
    await writeFile(join(folder, 'fresh-note.md'), '# Fresh\n')
    expect(await waitFor(async () => (await q(`document.querySelector('#sidebar').textContent`)).includes('fresh-note')), 'new file not listed')
  })

  // Separate app instances with their own profiles: crash recovery and the default preferences.
  await test('S8', '崩溃后恢复未命名文档的内容', async () => {
    const first = await launch({ port: 9241 })
    await first.page(`document.querySelector('#write .ProseMirror').focus(); return true`)
    await first.type('Unsaved words')
    await sleep(2600)
    expect(draftsIn(first.profile).length === 1, `drafts ${draftsIn(first.profile)}`)
    await first.kill()
    const second = await launch({ port: 9241, profile: first.profile })
    try {
      expect(await waitFor(async () => (await noticeKind(second)) === 'restored'), 'no restore notice')
      expect((await editorText(second)) === 'Unsaved words', `text ${await editorText(second)}`)
      await second.click('#notice .notice-button', '丢弃')
      expect((await editorText(second)) === '' && (await noticeKind(second)) === null, 'not discarded')
      expect(await waitFor(async () => draftsIn(first.profile).length === 0), 'draft left behind')
    } finally {
      await second.close()
    }
  })
  await test('S9', '崩溃期间文件被外部修改：恢复时说明，并提供另存为副本', async () => {
    const path = await fixture('Original.\n')
    const first = await launch({ port: 9241, prefs: { autoSave: false } })
    await first.open(path)
    await first.clickText('Original', 8)
    await first.type(' typed')
    await sleep(2600)
    await first.kill()
    await writeFile(path, 'Changed meanwhile.\n')
    const second = await launch({ port: 9241, profile: first.profile })
    try {
      expect(await waitFor(async () => (await noticeKind(second)) === 'restored'), 'no restore notice')
      expect((await editorText(second)) === 'Original typed.', `text ${await editorText(second)}`)
      const text = await noticeText(second)
      expect(text.includes('外部修改') && text.includes('另存为副本'), `notice ${text}`)
      // Auto-save is held back while the notice is open, so the outside change survives.
      await sleep(1500)
      const onDisk = await readFile(path, 'utf8')
      expect(onDisk === 'Changed meanwhile.\n', `overwritten: ${JSON.stringify(onDisk)}`)
    } finally {
      await second.close()
    }
  })
  await test('S10', '新用户默认开启自动保存', async () => {
    const path = await fixture('Fresh profile.\n')
    const fresh = await launch({ port: 9241 })
    try {
      await fresh.open(path)
      await fresh.clickText('profile', 7)
      await fresh.type(' saved')
      expect(await waitFor(async () => (await readFile(path, 'utf8')) === 'Fresh profile saved.\n', 3000), 'not auto-saved')
      expect(!(await fresh.page(`return document.documentElement.classList.contains('doc-edited')`)), 'still marked edited')
    } finally {
      await fresh.close()
    }
  })

  console.log('T. 保持窗口在最前端')
  const onTop = () => app.main(`return win.isAlwaysOnTop()`)
  const unpin = async () => {
    if (await onTop()) await app.menu('toggle-always-on-top')
  }
  await test('T1', '状态栏按钮与菜单切换置顶', async () => {
    await openFresh('Sticky.\n')
    try {
      await hoverFooter()
      expect(!(await toggleGray('toggle-always-on-top')), 'gray while off')
      await app.click('#toggle-always-on-top')
      await hoverFooter()
      expect(await onTop(), 'window not on top')
      expect(await app.menuChecked('toggle-always-on-top'), 'menu not checked')
      expect(await toggleGray('toggle-always-on-top'), 'button not gray')
      await app.clickMenuItem('toggle-always-on-top')
      await hoverFooter()
      expect(!(await onTop()), 'still on top')
      expect(!(await app.menuChecked('toggle-always-on-top')), 'menu still checked')
      expect(!(await toggleGray('toggle-always-on-top')), 'still gray')
    } finally {
      await unpin()
    }
  })
  await test('T2', '菜单勾选跟随当前窗口', async () => {
    await app.menu('toggle-always-on-top')
    const firstId = await app.main(`return win.id`)
    await app.main(`electron.Menu.getApplicationMenu().items.flatMap((i) => i.submenu?.items ?? []).find((i) => i.label === '新建窗口').click(); return true`)
    // With two windows open, the harness's `win` may be either one: name both by id.
    const first = `electron.BrowserWindow.fromId(${firstId})`
    const other = `electron.BrowserWindow.getAllWindows().find((w) => w.id !== ${firstId})`
    try {
      expect(await waitFor(() => app.main(`return ${other}.webContents.executeJavaScript("!!document.querySelector('#write .ProseMirror')")`).catch(() => false)), 'second window not ready')
      await sleep(300)
      // The windows never take focus from the user during the suite: deliver the focus event directly.
      await app.main(`${other}.emit('focus'); return true`)
      expect(!(await app.main(`return ${other}.isAlwaysOnTop()`)), 'new window on top')
      expect(!(await app.menuChecked('toggle-always-on-top')), 'checked for the new window')
      await app.main(`${first}.emit('focus'); return true`)
      expect(await app.menuChecked('toggle-always-on-top'), 'not checked again for the first window')
    } finally {
      await app.main(`${other}?.destroy(); return true`)
      await unpin()
    }
  })
  await test('T3', '渲染进程崩溃后仍显示已置顶', async () => {
    await app.menu('toggle-always-on-top')
    try {
      await app.main(`win.webContents.forcefullyCrashRenderer(); return true`)
      const shown = () => q(`!!document.querySelector('#write .ProseMirror') && document.documentElement.classList.contains('always-on-top')`).catch(() => false)
      expect(await waitFor(shown, 8000), 'not shown as pinned after the reload')
      expect(await app.menuChecked('toggle-always-on-top'), 'menu not checked after the reload')
    } finally {
      await unpin()
    }
  })

  console.log('U. 顺手体验 (docs/optimization-plan.md v0.3 Step A)')
  await test('U1', '在当前文件夹和选中子文件夹中快速新建并重命名', async () => {
    const newDir = join(docs, 'quick-new')
    await mkdir(join(newDir, 'notes'), { recursive: true })
    await writeFile(join(newDir, 'existing.md'), '# Existing\n')
    await writeFile(join(newDir, 'notes', 'child.md'), '# Child\n')
    await app.answer('open', newDir)
    await app.menu('open-folder')
    await app.answer('open', null)
    await sleep(350)
    expect(await visible('.sidebar-new-button'), 'sidebar + button hidden')
    await app.click('.sidebar-new-button')
    expect(await waitFor(async () => existsSync(join(newDir, '未命名.md'))), '未命名.md not created')
    if ((await app.main(`return process.platform`)) === 'darwin') {
      expect(await waitFor(async () => q(`document.querySelector('#title').isContentEditable`)), 'title not renaming')
      await app.type('draft-one')
      await app.key('Enter')
      expect(await waitFor(async () => existsSync(join(newDir, 'draft-one.md'))), 'draft-one.md not renamed')
      expect((await title()) === 'draft-one.md', `title ${await title()}`)
    }
    await app.menu('new')
    expect(await waitFor(async () => existsSync(join(newDir, '未命名.md'))), 'second 未命名.md not created')
    if (await q(`document.querySelector('#title').isContentEditable`)) await app.key('Escape')
    await app.menu('new')
    expect(await waitFor(async () => existsSync(join(newDir, '未命名 2.md'))), '未命名 2.md not created')
    if (await q(`document.querySelector('#title').isContentEditable`)) await app.key('Escape')
    await app.click('.sidebar-button[data-view="tree"]')
    await app.click('.tree-row[data-kind="folder"]', 'notes')
    await app.menu('new')
    expect(await waitFor(async () => existsSync(join(newDir, 'notes', '未命名.md'))), 'subfolder 未命名.md not created')
    if (await q(`document.querySelector('#title').isContentEditable`)) await app.key('Escape')
  })
  await test('U2', '重启后恢复上次打开的文件、滚动位置和光标位置', async () => {
    const longPath = await fixture('# Top\n\n' + Array.from({ length: 60 }, (_, i) => `Paragraph number ${i}.`).join('\n\n') + '\n', 'restore-pos.md')
    const first = await launch({ port: 9241, prefs: { autoSave: false } })
    let savedScroll = 0
    try {
      await first.open(longPath)
      expect(await waitFor(async () => (await first.page(`return document.querySelector('#title').textContent`)) === 'restore-pos.md'), 'file not opened')
      await first.clickText('Paragraph number 35', 5)
      await first.page(`document.querySelector('#scroller').scrollTop = 500; return true`)
      await sleep(400)
      savedScroll = await first.page(`return Math.round(document.querySelector('#scroller').scrollTop)`)
      expect(savedScroll > 100, `initial scroll ${savedScroll}`)
      await first.main(`win.close(); return true`)
      expect(await waitFor(async () => (await first.main(`return electron.BrowserWindow.getAllWindows().length`).catch(() => 0)) === 0), 'window did not close')
    } finally {
      await first.close()
    }
    const second = await launch({ port: 9241, profile: first.profile })
    try {
      expect(await waitFor(async () => (await second.page(`return document.querySelector('#title').textContent`)) === 'restore-pos.md', 5000), 'last file not restored')
      await sleep(300)
      const restored = await second.page(`return { scroll: Math.round(document.querySelector('#scroller').scrollTop), caret: getSelection().anchorNode?.parentElement?.closest('p')?.textContent ?? '' }`)
      expect(Math.abs(restored.scroll - savedScroll) <= 25, `restored scroll ${restored.scroll} vs ${savedScroll}`)
      expect(restored.caret.includes('Paragraph number 35'), `restored caret ${JSON.stringify(restored.caret)}`)
    } finally {
      await second.close()
    }
    await rm(longPath)
    const third = await launch({ port: 9241, profile: first.profile })
    try {
      await sleep(400)
      expect((await third.page(`return document.querySelector('#title').textContent`)) === '未命名', 'missing file did not fallback to untitled')
      expect((await third.page(`return document.querySelector('#write .ProseMirror').textContent`)) === '', 'editor not empty on missing file')
    } finally {
      await third.close()
    }
  })
  await test('U3', '重启后记住窗口大小', async () => {
    const first = await launch({ port: 9241, size: '' })
    try {
      await first.main(`win.setSize(920, 660); return true`)
      await sleep(450)
      await first.main(`win.close(); return true`)
      expect(await waitFor(async () => (await first.main(`return electron.BrowserWindow.getAllWindows().length`).catch(() => 0)) === 0), 'window did not close')
    } finally {
      await first.close()
    }
    const second = await launch({ port: 9241, size: '', profile: first.profile })
    try {
      const got = await second.main(`return win.getSize()`)
      expect(Math.abs(got[0] - 920) <= 2 && Math.abs(got[1] - 660) <= 2, `size ${JSON.stringify(got)}`)
    } finally {
      await second.close()
    }
  })

  await test('U4', '侧边栏右键文件管理与空文件夹显示', async () => {
    const manageDir = join(docs, 'sidebar-manage')
    await mkdir(join(manageDir, 'empty-sub'), { recursive: true })
    await mkdir(join(manageDir, 'assets'), { recursive: true })
    await writeFile(join(manageDir, 'assets', 'pic.png'), PIXEL)
    await writeFile(join(manageDir, 'alpha.md'), '# Alpha\n')
    await app.answer('open', manageDir)
    await app.menu('open-folder')
    await app.answer('open', null)
    await sleep(350)
    await app.click('.sidebar-button[data-view="tree"]')
    await sleep(150)
    const folderRows = await html('.tree-row[data-kind="folder"]')
    expect(folderRows.includes('empty-sub'), `empty folder missing: ${JSON.stringify(folderRows)}`)
    expect(!folderRows.includes('assets'), `non-markdown folder visible: ${JSON.stringify(folderRows)}`)

    const bodyRect = await app.rect('.sidebar-body')
    await app.clickAt(bodyRect.left + 30, bodyRect.bottom - 10, { button: 'right' })
    await sleep(120)
    const rootMenu = await app.lastPopupLabels()
    expect(rootMenu.includes('新建文件') && rootMenu.includes('新建文件夹'), `root menu ${JSON.stringify(rootMenu)}`)
    await app.clickPopupItem(['新建文件夹'])
    expect(await waitFor(() => q(`!!document.querySelector('.sidebar-rename-input')`)), 'folder rename input not shown')
    await app.type('chapter-1')
    await app.key('Enter')
    expect(await waitFor(async () => existsSync(join(manageDir, 'chapter-1'))), 'chapter-1 dir not created')
    expect(await waitFor(async () => (await html('.tree-row[data-kind="folder"]')).includes('chapter-1')), 'chapter-1 not in tree')

    await app.click('.tree-row[data-kind="folder"]', 'chapter-1', { button: 'right' })
    await sleep(120)
    await app.clickPopupItem(['新建文件'])
    expect(await waitFor(() => q(`!!document.querySelector('.sidebar-rename-input')`)), 'file rename input not shown')
    await app.type('note')
    await app.key('Enter')
    const notePath = join(manageDir, 'chapter-1', 'note.md')
    expect(await waitFor(async () => existsSync(notePath)), 'note.md not created')
    expect(await waitFor(async () => (await title()) === 'note.md'), `title ${await title()}`)

    await app.click('.tree-row[data-kind="file"]', 'note.md', { button: 'right' })
    await sleep(120)
    await app.main(`await electron.clipboard.writeText(''); return true`)
    await app.clickPopupItem(['复制路径'])
    await sleep(150)
    const copiedPath = await app.main(`return electron.clipboard.readText()`)
    expect(copiedPath === notePath, `copied path ${JSON.stringify(copiedPath)}`)

    await app.click('.tree-row[data-kind="file"]', 'note.md', { button: 'right' })
    await sleep(120)
    await app.clickPopupItem(['在访达中显示'])
    await sleep(150)
    expect((await app.e2e()).shell.some(([k, p]) => k === 'showItemInFolder' && p === notePath), 'note not revealed')

    await app.click('.tree-row[data-kind="file"]', 'note.md', { button: 'right' })
    await sleep(120)
    await app.clickPopupItem(['重命名'])
    expect(await waitFor(() => q(`!!document.querySelector('.sidebar-rename-input')`)), 'rename input not shown')
    await app.type('note-renamed')
    await app.key('Enter')
    const renamedPath = join(manageDir, 'chapter-1', 'note-renamed.md')
    expect(await waitFor(async () => existsSync(renamedPath) && !existsSync(notePath)), 'file not renamed')
    expect(await waitFor(async () => (await title()) === 'note-renamed.md'), `renamed title ${await title()}`)

    await app.click('.tree-row[data-kind="file"]', 'note-renamed.md', { button: 'right' })
    await sleep(120)
    await app.clickPopupItem(['移到废纸篓'])
    expect(await waitFor(async () => !existsSync(renamedPath)), 'trashed file still exists')
    expect((await app.e2e()).shell.some(([k, p]) => k === 'trashItem' && p === renamedPath), 'trashItem not called')
    expect(await waitFor(async () => (await noticeKind()) === 'deleted'), `notice ${await noticeKind()}`)
    expect(await edited(), 'open doc not marked edited after trash')
  })

  await test('U5', '拼写检查开关与代码块 / 行内代码 / 公式豁免', async () => {
    expect((await q(`document.querySelector('#write .ProseMirror').getAttribute('spellcheck')`)) === 'false', 'default DOM spellcheck not false')
    expect((await app.main(`return win.webContents.session.isSpellCheckerEnabled()`)) === false, 'default session spellcheck not false')

    await app.menu('preferences')
    await app.click('.prefs-nav-item[data-section="editor"]')
    await app.click('[data-pref="spellcheck"]')
    await app.key('Escape')

    await openFresh('Normal `inlineCode` text $x+y$ end.\n\n```js\nconst typo = 1\n```\n')
    await sleep(350)
    expect((await q(`document.querySelector('#write .ProseMirror').getAttribute('spellcheck')`)) === 'true', 'DOM spellcheck not enabled')
    expect((await app.main(`return win.webContents.session.isSpellCheckerEnabled()`)) === true, 'session spellcheck not enabled')
    expect((await q(`document.querySelector('#write code')?.getAttribute('spellcheck')`)) === 'false', 'inline code spellcheck not false')
    expect((await q(`document.querySelector('#write .milkdown-code-block .cm-content')?.getAttribute('spellcheck')`)) === 'false', 'code fence spellcheck not false')

    await app.click('#write [data-type="math_inline"]')
    await app.click('.milkdown-latex-inline-edit .ProseMirror')
    await sleep(100)
    expect((await q(`document.querySelector('.milkdown-latex-inline-edit .ProseMirror')?.getAttribute('spellcheck')`)) === 'false', 'inline math spellcheck not false')
    await app.key('Escape')

    await app.menu('preferences')
    await app.click('.prefs-nav-item[data-section="editor"]')
    await app.click('[data-pref="spellcheck"]')
    await app.key('Escape')
    expect((await q(`document.querySelector('#write .ProseMirror').getAttribute('spellcheck')`)) === 'false', 'DOM spellcheck not restored')
    expect((await app.main(`return win.webContents.session.isSpellCheckerEnabled()`)) === false, 'session spellcheck not restored')
  })

  await test('U6', '交互细节：链接 title 保留、表格限高、快速打开与 IME 保护', async () => {
    // 1) Link preserves title & refreshes hover tooltip after edit
    const linkPath = await openFresh('A [site](https://old.com "Keep Title") link.\n')
    await app.clickText('site', 2)
    await app.menu('link')
    await app.key('A', ['meta'])
    await app.type('https://new.com')
    await app.key('Enter')
    const linkSaved = await save(linkPath)
    expect(linkSaved.includes('https://new.com') && linkSaved.includes('Keep Title'), `saved ${JSON.stringify(linkSaved)}`)
    const linkRect = await app.rect('#write a')
    await app.main(`win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 300 }); return true`)
    await sleep(80)
    await app.main(`win.webContents.sendInputEvent({ type: 'mouseMove', x: ${Math.round(linkRect.x)}, y: ${Math.round(linkRect.y)} }); return true`)
    await sleep(150)
    const tip = await q(`document.querySelector('#write a').title`)
    expect(tip.includes('https://new.com') && !tip.includes('https://old.com'), `stale tooltip ${JSON.stringify(tip)}`)

    // 2) Table resize clamps excessive rows/cols instead of freezing
    await openFresh(TABLE)
    await app.clickText('1', 0, '#write table')
    await app.click('.md-table-toolbar [data-action="resize"]')
    await app.click('.md-table-panel input[name="rows"]')
    await app.key('A', ['meta'])
    await app.type('999')
    await app.click('.md-table-panel input[name="cols"]')
    await app.key('A', ['meta'])
    await app.type('99')
    await app.key('Enter')
    expect((await tableState()).size === '100 × 30', `clamped size ${(await tableState()).size}`)

    // 3) Quick open uses relative paths for folder files, updates selection without broken list, filters deleted files
    const gonePath = await fixture('Gone soon.\n', 'vanished-recent.md')
    await openFresh('')
    await app.open(gonePath)
    await rm(gonePath)
    const qoDir = join(docs, 'qo-folder')
    await mkdir(join(qoDir, 'sub'), { recursive: true })
    await writeFile(join(qoDir, 'root-note.md'), '# Root\n')
    await writeFile(join(qoDir, 'sub', 'in-folder.md'), '# Sub\n')
    await app.answer('open', qoDir)
    await app.menu('open-folder')
    await app.answer('open', null)
    await sleep(300)
    await app.menu('open-quickly')
    expect(await waitFor(() => q(`document.querySelectorAll('.quick-open-item').length >= 2`)), 'quick-open empty')
    const qoItems = await q(`[...document.querySelectorAll('.quick-open-item')].map((el) => ({ name: el.querySelector('.quick-open-name').textContent, path: el.querySelector('.quick-open-path').textContent }))`)
    expect(!qoItems.some((item) => item.name === 'vanished-recent.md'), `deleted file remained: ${JSON.stringify(qoItems)}`)
    const subItem = qoItems.find((item) => item.name === 'in-folder.md')
    expect(subItem && subItem.path === join('sub', 'in-folder.md'), `expected relative path, got ${JSON.stringify(subItem)}`)
    await app.key('Down')
    expect((await q(`document.querySelector('.quick-open-item.selected')?.dataset.index`)) === '1', 'arrow down selection failed')
    await app.key('Up')
    expect((await q(`document.querySelector('.quick-open-item.selected')?.dataset.index`)) === '0', 'arrow up selection failed')
    await app.key('Escape')

    // 4) Find bar ignores Enter during IME composition
    await openFresh('one match and one more.\n')
    await app.click('#write .ProseMirror')
    await app.menu('find')
    await app.type('one')
    await sleep(120)
    expect((await q(`document.querySelector('.find-count').textContent`)) === '1 / 2', `count ${await q(`document.querySelector('.find-count').textContent`)}`)
    await app.page(`document.querySelector('.find-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })); return true`)
    expect((await q(`document.querySelector('.find-count').textContent`)) === '1 / 2', 'IME Enter stepped find')
    await app.key('Enter')
    expect((await q(`document.querySelector('.find-count').textContent`)) === '2 / 2', 'real Enter did not step find')
    await app.key('Escape')
  })

  await test('U7', '代码块选中高亮跟随主题，不再变黑', async () => {
    await openFresh('```bash\ngit fetch origin\ngit switch -c branch origin/master\nadmin/src/line1\nadmin/src/line2\nadmin/src/line3\n```\n')
    await sleep(350)
    const selectLines = async () => {
      const r1 = await app.rect('#write .milkdown-code-block .cm-line', 'admin/src/line1')
      const r2 = await app.rect('#write .milkdown-code-block .cm-line', 'admin/src/line3')
      await app.drag({ x: r1.left + 10, y: r1.y }, { x: r2.left + 80, y: r2.y })
      await sleep(150)
      return q(`(() => {
        const ed = document.querySelector('#write .milkdown-code-block .cm-editor')
        const bgs = [...ed.querySelectorAll('.cm-selectionBackground')]
        return {
          count: bgs.length,
          bg: bgs[0] ? getComputedStyle(bgs[0]).backgroundColor : null,
          caret: getComputedStyle(ed.querySelector('.cm-content')).caretColor
        }
      })()`)
    }
    try {
      const light = await selectLines()
      expect(light.count >= 2, `light selection count ${light.count}`)
      expect(light.bg === 'rgb(181, 214, 252)', `light selection bg ${light.bg}`)
      expect(light.caret !== 'rgb(255, 255, 255)', `oneDark caret leaked: ${light.caret}`)

      await app.clickMenuItem('theme-night')
      const dark = await selectLines()
      expect(dark.count >= 2, `dark selection count ${dark.count}`)
      expect(dark.bg === 'rgb(74, 137, 220)', `dark selection bg ${dark.bg}`)
    } finally {
      await app.clickMenuItem('theme-github')
    }
  })

  await test('U8', '表格调整行列按回车保留当前单元格内容', async () => {
    const dispatchKey = async (key, code, vk, text) => {
      await app.main(`
        const dbg = win.webContents.debugger
        if (!dbg.isAttached()) dbg.attach('1.3')
        await dbg.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: ${JSON.stringify(key)},
          code: ${JSON.stringify(code)},
          windowsVirtualKeyCode: ${vk},
          nativeVirtualKeyCode: ${vk},
          ...(${JSON.stringify(text ?? null)} ? { text: ${JSON.stringify(text ?? '')}, unmodifiedText: ${JSON.stringify(text ?? '')} } : {})
        })
        await dbg.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: ${JSON.stringify(key)},
          code: ${JSON.stringify(code)},
          windowsVirtualKeyCode: ${vk},
          nativeVirtualKeyCode: ${vk}
        })
        return true
      `)
      await sleep(120)
    }
    const realEnter = () => dispatchKey('Enter', 'Enter', 13, '\r')
    const realEscape = () => dispatchKey('Escape', 'Escape', 27)

    await openFresh('# 0. 概况\n\n| 指标 | 数值 |\n| --- | --- |\n| 分支自身提交 | 36 个 |\n| 改动文件 | 84 个 |\n| 分支落后 master | 241 个提交 |\n')
    await app.clickText('数值', 2, '#write table')
    await app.click('.md-table-toolbar [data-action="resize"]')
    await app.click('.md-table-panel input[name="rows"]')
    await app.key('A', ['meta'])
    await app.type('5')
    await realEnter()
    let st = await tableState()
    expect(st.size === '5 × 2', `size ${st.size}`)
    expect(st.panel === null, 'panel still open after rows Enter')
    expect(await inTable(), 'caret not in table after rows Enter')
    expect((await rows())[0] === '指标|数值', `row0 cleared: ${JSON.stringify(await rows())}`)
    expect((await rows())[1] === '分支自身提交|36 个', `row1 changed: ${JSON.stringify(await rows())}`)

    await app.click('.md-table-toolbar [data-action="resize"]')
    await app.click('.md-table-panel input[name="cols"]')
    await app.key('A', ['meta'])
    await app.type('3')
    await realEnter()
    st = await tableState()
    expect(st.size === '5 × 3', `size ${st.size}`)
    expect((await rows())[0] === '指标|数值|', `row0 cleared on cols Enter: ${JSON.stringify(await rows())}`)

    await app.clickText('36 个', 2, '#write table')
    await app.click('.md-table-toolbar [data-action="resize"]')
    await app.click('.md-table-panel input[name="cols"]')
    await app.key('A', ['meta'])
    await app.type('4')
    await realEnter()
    st = await tableState()
    expect(st.size === '5 × 4', `size ${st.size}`)
    expect((await rows())[1] === '分支自身提交|36 个||', `body cell cleared on cols Enter: ${JSON.stringify(await rows())}`)

    await app.clickText('数值', 2, '#write table')
    await app.click('.md-table-toolbar [data-action="resize"]')
    await app.click('.md-table-panel input[name="rows"]')
    await realEscape()
    st = await tableState()
    expect(st.panel === null, 'panel still open after Esc')
    expect((await active()).startsWith('DIV.ProseMirror'), `focus ${await active()}`)
    expect((await rows())[0] === '指标|数值||', `row0 changed on Esc: ${JSON.stringify(await rows())}`)
  })
} finally {
  const errors = app.logs
    .join('')
    .split('\n')
    .filter((line) => /CONSOLE\(\d+\)|Uncaught|\[error\]/i.test(line) && /error|uncaught/i.test(line) && !/Autofill|DevTools|btm_database/i.test(line))
  await app.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (errors.length) console.log(`renderer errors:\n${errors.slice(0, 10).join('\n')}`)
  if (failed.length) {
    console.log('failed:')
    for (const f of failed) console.log(`  ${f.id} ${f.name}: ${f.error}`)
    process.exitCode = 1
  }
  console.log(`docs: ${docs}`)
}

void basename
