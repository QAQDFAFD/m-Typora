import assert from 'node:assert/strict'
import test from 'node:test'
import { countPlainText, countText, dirName, escapeHtml, extractHeadings, fileName, stripExtension } from '../../src/renderer/src/markdown-utils.ts'

test('countText and countPlainText match for CJK and Latin text', () => {
  const md = '# 标题 Title\n\n你好 world，这是 [链接](https://example.com)！\n\n```js\nconst hidden = 1;\n```\n'
  const fromMd = countText(md)
  assert.equal(fromMd.words, 10)
  assert.equal(fromMd.lines, 8)

  const plain = countPlainText('标题 Title\n你好 world，这是 链接！', 8)
  assert.equal(plain.words, fromMd.words)
  assert.equal(plain.minutes, fromMd.minutes)
  assert.equal(countText('').lines, 0)
  assert.equal(countPlainText('', 0).words, 0)
})

test('extractHeadings ignores fenced code/math blocks and strips inline links', () => {
  const md = [
    '# [Home](https://a.b) *Docs*',
    '```sh',
    '# not a heading',
    '```',
    '$$',
    '# also ignored',
    '$$',
    '## Section `two` ##'
  ].join('\n')
  assert.deepEqual(extractHeadings(md), [
    { level: 1, text: 'Home Docs', line: 1 },
    { level: 2, text: 'Section two', line: 8 }
  ])
})

test('path and HTML helpers handle edge cases', () => {
  assert.equal(fileName(null), '未命名')
  assert.equal(fileName('/a/b/c.md'), 'c.md')
  assert.equal(fileName('C:\\a\\b\\c.md'), 'c.md')
  assert.equal(stripExtension('note.markdown'), 'note')
  assert.equal(dirName('/a/b/c.md'), '/a/b')
  assert.equal(escapeHtml(`<a "x" & 'y'>`), '&#60;a &#34;x&#34; &#38; &#39;y&#39;&#62;')
})
