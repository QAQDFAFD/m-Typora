# Typora 实现原理（外部观察）与 m-typora 设计

> 观察对象：`Typora-1.13.7.dmg`（macOS 通用二进制，x86_64 + arm64）。
>
> 范围说明：Typora 是闭源商业软件，其 EULA 第 7 条禁止反编译、逆向工程或推导源代码。
> 本文只基于**包的目录结构、链接的系统框架、Info.plist 以及随包公开的文档（Credits / Docs）**，
> 没有打开、反混淆或复制 `appsrc/main.js` 等核心代码，也没有复用其主题 CSS、图标与字体。
> m-typora 是使用开源库从零编写的原创实现。

## 1. 整体架构：原生外壳 + Web 编辑内核

```
Typora.app/Contents
├── MacOS/Typora                 原生 Cocoa 可执行文件（NSPrincipalClass = TyApplication）
├── Frameworks/Sparkle.framework 自动更新（CocoaPods 引入，见 Resources/Podfile）
└── Resources
    ├── *.lproj                  原生菜单/对话框的本地化
    └── TypeMark/                Web 前端 —— 真正的编辑器
        ├── index.html           编辑器页面，加载 base.css / mac.css / codemirror.css + appsrc/main.js
        ├── appsrc/main.js       webpack 打包并压缩的编辑器核心（闭源）
        ├── appsrc/finder-worker.js  Web Worker：后台文件搜索
        ├── lib/
        │   ├── codemirror/      代码块 / 源码模式的语法高亮
        │   ├── MathJax4/        数学公式（tex-svg）
        │   ├── diagram/         mermaid、flowchart/sequence 等图表
        │   ├── bootstrape/      UI 基础样式（Bootstrap）
        │   └── bin/{arm,x64}    平台相关的辅助二进制
        ├── page-dist/           设置页、欢迎页、许可页（独立的 SPA，含 cocoa.css / electron.css）
        ├── style/themes/        内置主题：github / gothic / newsprint / night / pixyll / whitey
        ├── locales/             Web 端文案本地化
        └── Docs/                随包帮助文档
```

关键结论：

1. **macOS 版不是 Electron**。可执行文件只链接系统框架（`WebKit`、`AppKit`、`PDFKit`、`Quartz` 等），
   编辑器跑在原生窗口内嵌的 **WKWebView** 中。`page-dist` 同时带有 `cocoa.css` 与 `electron.css`，
   说明同一套 Web 前端被两种外壳复用：macOS 用 Cocoa + WKWebView，Windows / Linux 用 Electron。
2. **原生层负责“系统能力”**：窗口与菜单、文件读写与权限、PDF 导出与打印（`PDFKit`、`PrintPanelAccessory.nib`）、
   自动更新（Sparkle）、Spotlight / 文件类型关联（`UniformTypeIdentifiers`）。原生层与 Web 层通过消息桥通信。
3. **Web 层负责“编辑体验”**。Credits 里列出的 `rangy`（跨浏览器的 Range/Selection 操作库）与 jQuery 表明：
   编辑器是基于 `contenteditable` 自研的“即时渲染”内核（TypeMark），而不是现成的编辑器框架。

## 2. “所见即所得”的核心原理

Typora 的标志性体验是 **Markdown 源码与渲染结果融为一体**：光标离开时显示渲染效果，光标进入某个块时露出该块的 Markdown 语法。
从行为上可以归纳为下面的模型（这是对这类编辑器的通用描述，并非 Typora 代码）：

| 环节 | 职责 |
|---|---|
| 文档模型 | 以“块”（段落、标题、列表、引用、代码块、表格、公式块……）为单位维护 Markdown 的结构化表示 |
| 输入规则 | 监听键入，匹配 `# `、`> `、`- `、` ``` `、`$$` 等前缀，就地把当前块转换成对应类型 |
| 渲染 | 普通块渲染为语义化 HTML；代码块交给 CodeMirror，公式交给 MathJax，图表交给 mermaid 等 |
| 选区映射 | 在 DOM 选区（rangy）与文档模型位置之间双向映射，保证光标和撤销/重做正确 |
| 序列化 | 文档模型 ⇄ Markdown 文本，保证“打开 → 编辑 → 保存”后源文件依旧是干净的 Markdown |
| 源码模式 | 同一份 Markdown 直接交给 CodeMirror 展示，与 WYSIWYG 视图来回切换 |
| 主题 | 编辑区就是普通 HTML，因此主题就是一份 CSS，用户可自行编写 |

## 3. m-typora 的实现映射

m-typora 采用与 Typora Windows/Linux 版相同的思路：**Electron 外壳 + Web 编辑内核**，
但编辑内核改用开源方案，避免自研 contenteditable 的巨大成本：

| Typora 组件 | m-typora 对应实现 | 说明 |
|---|---|---|
| 原生外壳（Cocoa / Electron） | Electron 主进程 `src/main` | 窗口、原生菜单、文件对话框、读写、导出 PDF |
| 消息桥 | `src/preload` + `contextBridge` | 渲染进程只拿到白名单 API，开启 `contextIsolation` |
| TypeMark 编辑内核 | [Milkdown Crepe](https://milkdown.dev)（ProseMirror + remark） | 文档模型、输入规则、Markdown 双向序列化 |
| CodeMirror（代码块） | Crepe 内置 CodeMirror 6 代码块 | 带语言高亮 |
| MathJax | KaTeX（Crepe 内置） | 行内 `$…$` 与块级 `$$…$$` |
| 源码模式 | CodeMirror 6 + `@codemirror/lang-markdown` | `⌘/` 在两种视图间切换，内容实时同步 |
| “光标处显示语法” | `src/renderer/src/syntax-reveal.ts` | ProseMirror 装饰：在包含光标的粗体 / 斜体 / 代码 / 链接两侧插入 `**`、`` ` ``、`[..](..)` 等标记 |
| 侧边栏 | `src/renderer/src/sidebar.ts` | 文档列表、文件树、可折叠大纲、文件夹全文搜索 |
| 查找替换 | `src/renderer/src/search-plugin.ts` | ProseMirror 装饰高亮所有匹配，支持逐个 / 全部替换 |
| 主题 | `src/renderer/src/themes/*.css` | 原创 CSS 实现的 Github / Newsprint / Night / Pixyll / Whitey，基于 CSS 变量 |
| 专注模式 / 打字机模式 | `focus-plugin.ts` + CSS | 只突出当前块；光标所在行保持在视口中部 |
| 导出 | HTML（含 / 不含样式）与 PDF（`webContents.printToPDF`） | 不依赖 Pandoc |
| 自动更新（Sparkle） | 未实现 | 本地工具不需要 |

## 4. 界面对照方法与实测值

界面还原只依据**正常使用时看到的样子**：用已安装的 Typora 打开 `samples/` 下的示例文档和文件夹，
只截取这些窗口，再用脚本对截图取色、测量像素位置。m-typora 用相同的窗口尺寸（1411×923）截图
（`M_TYPORA_SMOKE_SIZE`），逐行比较文字墨迹的纵向位置并调整 CSS，直到偏差在 0–4px（物理像素）以内。

| 项目 | 实测值（Typora 1.13 默认 Github 主题） |
|---|---|
| 正文 | Open Sans 16px，行高 1.6，颜色 `#333` |
| 正文区 | 宽 964px（`max-width: 1024px` 含左右 30px 内边距），居中；顶部距窗口 58px |
| 标题 | H1 2.25em / H2 1.75em / H3 1.5em / H4 1.25em / H5、H6 1em（H6 `#777`）；H1、H2 下方 1px `#eee` 分隔线，几乎贴着文字 |
| 列表 | 项间距 32.5px，列表之间 38px；嵌套依次为实心圆、空心圆、方块；任务列表为 macOS 原生风格的蓝色复选框 `#007aff` |
| 行内代码 | 等宽字体（Courier）0.9em，底色 `#f3f4f4`，边框 `#e7eaed`，圆角 3px |
| 代码块 | 底色 `#f8f8f8`，边框 `#e7eaed`，经典 CodeMirror 配色（关键字 `#708`、定义 `#00f`、局部变量 `#05a`、模板字符串 `#f50`） |
| 引用 | 左边框 4px `#dfe2e5`，文字 `#777` |
| 表格 | 宽 100%，边框 `#dfe2e5`，表头与偶数行底色 `#f8f8f8` |
| Front Matter | 灰色等宽块，底色 `#f7f7f7`，文字 `#777` |
| 标题栏 | 居中文件名，带文件图标和下拉箭头；聚焦时 `#595959`，失焦时 `#b7b7b7` |
| 侧边栏 | 宽 270px，底色 `#fafafa`，右边框 `#e8e8e8`；“文档”列表每项依次为文件夹名和相对时间（Courier `#aaa`）、粗体文件名加浅灰 `.md`、两行 Raleway 摘要（`#777`），项之间以 `#ececec` 分隔 |
| 状态栏 | 静止时不显示，移动鼠标时浮现 |

菜单结构和快捷键参考 Typora 随包公开的帮助文档以及它的公开行为。

## 5. 不在范围内

- 不解密、不反混淆、不加载 Typora 的任何代码或资源。
- 不实现许可证、激活相关逻辑。
- Pandoc 多格式导出、图床上传、mermaid 图表等可作为后续扩展。
