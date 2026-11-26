import assert from 'node:assert/strict'
import test from 'node:test'
import { joinFrontMatter, splitFrontMatter } from '../../src/renderer/src/front-matter.ts'
import { findTextMatches } from '../../src/renderer/src/search-match.ts'

test('splitFrontMatter and joinFrontMatter handle empty and populated YAML cleanly', () => {
  assert.deepEqual(splitFrontMatter('---\ntitle: Demo\n---\n\n# Heading\n'), { yaml: 'title: Demo', body: '# Heading\n' })
  assert.deepEqual(splitFrontMatter('---\r\na: 1\r\n---\r\nBody'), { yaml: 'a: 1', body: 'Body' })
  assert.deepEqual(splitFrontMatter('---\n---\n\n# Empty\n'), { yaml: '', body: '# Empty\n' })
  assert.deepEqual(splitFrontMatter('---\n\n---\nBody'), { yaml: '', body: 'Body' })
  assert.deepEqual(splitFrontMatter('---\n\nHorizontal rule\n'), { yaml: null, body: '---\n\nHorizontal rule\n' })
  assert.equal(joinFrontMatter('', '# Empty\n'), '---\n---\n\n# Empty\n')
  assert.equal(joinFrontMatter('a: 1', 'Body'), '---\na: 1\n---\n\nBody')
  assert.equal(joinFrontMatter(null, 'Body'), 'Body')
})

test('findTextMatches supports CJK wholeWord, Latin wholeWord boundaries, and symbol endings', () => {
  assert.deepEqual(findTextMatches('测试一下 中文测试。', { text: '测试', caseSensitive: false, wholeWord: true }), [
    { index: 0, length: 2 },
    { index: 7, length: 2 }
  ])
  assert.deepEqual(findTextMatches('foo foobar foo测试', { text: 'foo', caseSensitive: false, wholeWord: true }), [
    { index: 0, length: 3 },
    { index: 11, length: 3 }
  ])
  assert.deepEqual(findTextMatches('use c++ and clang', { text: 'c++', caseSensitive: false, wholeWord: true }), [{ index: 4, length: 3 }])
  assert.deepEqual(findTextMatches('Foo and foo', { text: 'Foo', caseSensitive: true, wholeWord: true }), [{ index: 0, length: 3 }])
})
