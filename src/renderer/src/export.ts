import katex from 'katex'
import { escapeHtml } from './markdown-utils'

/** A self-contained copy of the default (Github) theme's document styles. */
const EXPORT_CSS = `
body {
  margin: 0;
  background: #fff;
  color: #333;
  font: 16px/1.6 "Open Sans", "Clear Sans", "Helvetica Neue", Helvetica, Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
}
#write { max-width: 860px; margin: 0 auto; padding: 30px 30px 100px; }
h1, h2, h3, h4, h5, h6 { position: relative; margin: 1em 0 1rem; font-weight: bold; line-height: 1.4; }
h1 { font-size: 2.25em; line-height: 1.2; padding-bottom: .3em; border-bottom: 1px solid #eee; }
h2 { font-size: 1.75em; line-height: 1.225; padding-bottom: .3em; border-bottom: 1px solid #eee; }
h3 { font-size: 1.5em; line-height: 1.43; }
h4 { font-size: 1.25em; }
h5, h6 { font-size: 1em; }
h6 { color: #777; }
p, blockquote, ul, ol, dl, table { margin: .8em 0; }
a { color: #4183c4; }
li > ol, li > ul { margin: 0; }
blockquote { border-left: 4px solid #dfe2e5; padding: 0 15px; color: #777; }
code { background: #f3f4f4; border: 1px solid #e7eaed; border-radius: 3px; padding: 0 2px; font-size: .9em; font-family: monospace; }
pre { background: #f8f8f8; border: 1px solid #e7eaed; border-radius: 3px; padding: 8px 4px 6px; overflow: auto; }
pre code { background: none; border: 0; padding: 0 8px; font-size: .9em; }
table { border-collapse: collapse; }
table tr { border: 1px solid #dfe2e5; }
table tr:nth-child(2n), thead { background: #f8f8f8; }
th, td { border: 1px solid #dfe2e5; padding: 6px 13px; }
th { font-weight: bold; }
hr { height: 2px; padding: 0; margin: 16px 0; background: #e7e7e7; border: 0; }
img { max-width: 100%; }
li[data-item-type="task"] { list-style: none; position: relative; }
li[data-item-type="task"]::before { content: "☐"; position: absolute; left: -1.3em; }
li[data-item-type="task"][data-checked="true"]::before { content: "☑"; }
.math-block { text-align: center; margin: 1em 0; }
`

/** Builds a standalone HTML page from the editor's serialized document. */
export function buildHtmlDocument(title: string, bodyHtml: string, styled = true): string {
  const container = document.createElement('div')
  container.innerHTML = bodyHtml

  // Block math is stored as a ```latex code block; render it for the export.
  container.querySelectorAll<HTMLElement>('pre[data-language="latex"]').forEach((pre) => {
    const block = document.createElement('div')
    block.className = 'math-block'
    block.innerHTML = katex.renderToString(pre.textContent ?? '', { displayMode: true, throwOnError: false })
    pre.replaceWith(block)
  })
  container.querySelectorAll<HTMLElement>('pre[data-language]').forEach((pre) => {
    pre.querySelector('code')?.classList.add(`language-${pre.dataset.language}`)
  })

  const head = styled
    ? `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@${katex.version}/dist/katex.min.css">\n<style>${EXPORT_CSS}</style>`
    : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${head}
</head>
<body>
<div id="write">
${container.innerHTML}
</div>
</body>
</html>
`
}
