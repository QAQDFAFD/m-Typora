# m-typora

一个复刻 Typora 体验的“所见即所得” Markdown 编辑器：输入 Markdown 语法，内容就地渲染，保存下来的仍然是纯 `.md` 文件。

界面以 Typora 1.13（macOS，默认 Github 主题）为参照：在同一窗口尺寸下逐项测量字号、行距、边距和配色后还原；正文、列表、代码块和文档列表的行位置与原版的偏差在 0–4px 以内。实现原理与对照方法见 [docs/typora-architecture.md](docs/typora-architecture.md)。所有代码、样式和图标均为原创，没有使用 Typora 的任何代码或资源。

## 功能

**编辑**
- 即时渲染；光标进入粗体、斜体、行内代码、删除线、链接时显示对应的 Markdown 标记（Typora 的标志性行为）
- 源代码模式（`⌘/`），与所见即所得视图双向同步
- YAML Front Matter 显示为文档顶部的灰色等宽块
- 代码块使用经典 CodeMirror 配色，语言选择器只在编辑时出现；KaTeX 公式；GFM 表格与任务列表
- Typora 扩展语法：`==高亮==`、`H~2~O` 下标、`X^2^` 上标、`:smile:` 表情、`<u>下划线</u>`（`⌘U`）与常用行内 HTML、HTML 块、`> [!NOTE]` 等 Callout、`[toc]` 目录、mermaid 图表；光标进入时显示源码
- 保存不改内容：图片 alt/title、下标、Callout、`[toc]`、`array[0]` 这类方括号都原样写回（`npm run dev:web` 后在开发者工具执行 `await mtyporaRoundTrip()` 可跑回归用例）
- 点击图片显示可编辑的 `![alt](src "title")` 源码
- 表格（参照 Typora 的《Table Editing》）：输入 `| 表头 | 表头 |` 回车建表；回车跳到下一行，`⌘↩` 下方插入行，`⇧⌘⌫` 删除行；光标在表格内时表头上方出现工具栏（调整行列数、列对齐、插入/移动/删除行列、删除表格），右键菜单和“段落 › 表格”里有同样的操作
- 链接：悬停提示“⌘ + 单击打开链接”，`⌘K` 在链接下方编辑地址
- 括号与引号自动配对；`⌘`+点击打开链接
- 查找与替换（`⌘F` / `⌥⌘F`，支持区分大小写和全词匹配）
- 粘贴/拖入的图片自动复制到文档旁的 `assets/` 目录

**界面**
- 隐藏式标题栏，居中显示文件名、“已编辑”标记和文件操作菜单（重命名、另存为、在访达中显示、复制路径）
- 侧边栏（`⇧⌘L`，可拖动调整宽度）：文档列表、文件树、可折叠大纲、文件夹全文搜索
- 状态栏在移动鼠标时浮现、打字时隐藏：侧边栏开关、源码模式开关、字数统计（点击查看词数 / 字符 / 行数 / 阅读时间）
- 快速打开（`⇧⌘O`）：模糊搜索最近文件和当前文件夹
- 六套主题：Github、Gothic、Newsprint、Night、Pixyll、Whitey（只有 Github 按原版实测还原，其余为近似实现）
- 专注模式（`F8`）、打字机模式（`F9`）、缩放
- 跨平台：macOS 使用隐藏式标题栏；Windows / Linux 使用系统标题栏（标题里显示文件名和未保存标记），快捷键提示自动换成 Ctrl / Shift / Alt，并带有各平台的中文与等宽字体回退；窗口窄于 760px 时侧边栏浮在正文上方

**菜单与文件**
- 与 Typora 相同的菜单结构：文件 / 编辑 / 段落 / 格式 / 视图 / 主题 / 窗口 / 帮助，菜单勾选状态与编辑器同步
- Typora 的快捷键：`⌘1–6` 标题、`⌘0` 段落、`⌘=` / `⌘-` 调整标题级别、`⌥⌘T` 表格、`⌥⌘C` 代码块、`⌥⌘B` 公式块、`⌥⌘Q` 引用、`⌥⌘O/U/X` 列表、`⌃\`` 行内代码、`⌘K` 链接等
- 编辑区右键菜单（拷贝为 Markdown、粘贴为纯文本、段落、格式、插入）
- 偏好设置（`⌘,`）：自动保存、主题、字号、正文宽度、状态栏、自动配对
- 导出 PDF、HTML、HTML（无样式），打印；关闭未保存的文档时提示

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面外壳 | Electron（主进程负责窗口、原生菜单、文件 IO、导出） |
| 进程桥 | `contextBridge` 白名单 API，开启 `contextIsolation` |
| 编辑内核 | [Milkdown Crepe](https://milkdown.dev)（ProseMirror + remark），关闭了它的浮动工具栏、块手柄和斜杠菜单 |
| Typora 行为 | 自写的 ProseMirror 插件：语法显示、查找替换、专注/打字机、自动配对 |
| 源码模式 | CodeMirror 6 + `@codemirror/lang-markdown` |
| 字体 | Open Sans、Raleway（`@fontsource`，OFL 许可） |
| 构建 | electron-vite + TypeScript |

## 开发

```bash
npm install
npm run dev        # Electron 开发模式（带热更新）
npm run dev:web    # 只在浏览器中运行编辑器界面（http://localhost:5199）
npm run typecheck
npm run build      # 输出到 out/
npm run smoke      # 构建后启动一次 Electron，截图到 out/smoke.png 并退出
```

冒烟测试可以指定文件、文件夹和窗口尺寸，便于与参考截图逐像素对比：

```bash
M_TYPORA_SMOKE=out/shot.png M_TYPORA_SMOKE_SIZE=1411x923 M_TYPORA_SMOKE_FILE="$PWD/samples/showcase.md" npx electron .
```

> Electron 45 在首次运行时才会下载二进制。如果网络慢，可以先执行：
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`

## 目录结构

```
src/
├── main/            Electron 主进程：窗口、Typora 式菜单、文件 IO、搜索、导出
├── preload/         暴露给渲染进程的 window.mtypora API
├── shared/          主进程与渲染进程共享的类型与主题列表
└── renderer/
    └── src/
        ├── app.ts            应用状态与命令分发
        ├── wysiwyg.ts        Milkdown Crepe 封装与段落/格式命令
        ├── syntax-reveal.ts  光标处显示 Markdown 标记
        ├── extended-syntax.ts 高亮、上下标、表情、HTML、Callout、目录的渲染
        ├── markdown-config.ts 序列化规则（不多加转义、单 ~ 为下标）
        ├── image-view.ts     图片显示与源码编辑
        ├── table-tools.ts    表格工具栏、表格快捷键与行列操作
        ├── link-editor.ts    ⌘K 链接编辑与悬停提示
        ├── diagrams.ts       mermaid 图表（按需加载）
        ├── roundtrip.ts      保存不改内容的回归用例（开发模式）
        ├── search-plugin.ts  查找替换（ProseMirror 装饰）
        ├── auto-pair.ts      括号/引号自动配对
        ├── focus-plugin.ts   专注 / 打字机模式
        ├── source.ts         CodeMirror 源码模式
        ├── sidebar.ts        文档列表、文件树、大纲、搜索
        ├── findbar.ts / quick-open.ts / preferences.ts / front-matter.ts
        ├── themes/           Github、Newsprint、Night、Pixyll、Whitey
        └── styles/           窗口外框与编辑器结构样式
samples/             对照用的示例文档
```

## 已知差异

- 行内标记（`**` 等）以只读方式显示，修改格式请用快捷键或删除后重输；Typora 中这些标记可以直接编辑。
- 表格的行列不能拖拽排序，请用工具栏或菜单里的“上移 / 下移 / 左移 / 右移”。
- 保存时会做少量不改变含义的规范化：表格源码按列宽重新对齐（中文按两个字符宽计算）、引用式链接改为行内链接、`===` 标题改为 `#`、行尾两个空格的换行改为 `\`。
- Windows / Linux 的界面只按代码路径适配，尚未在真机上验证。
- 被空行拆开的 HTML 块（如 `<details>` 中间夹着 Markdown）按源码显示，不渲染。
- 尚未实现：脚注插入命令、Pandoc 多格式导出、导出图片、图片上传服务、版本历史、自定义主题目录。
