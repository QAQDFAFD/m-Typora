export interface SearchQuery {
  text: string
  caseSensitive: boolean
  wholeWord: boolean
}

export interface TextMatch {
  index: number
  length: number
}

// Match Latin/Cyrillic/etc. letters, digits and underscores, excluding CJK ideographs and kana/hangul
// so "全词匹配" does not treat surrounding Chinese characters as part of the same word.
const NON_CJK_WORD = /(?!\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul})[\p{L}\p{N}_]/u

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function firstChar(text: string): string {
  for (const ch of text) return ch
  return ''
}

function lastChar(text: string): string {
  let last = ''
  for (const ch of text) last = ch
  return last
}

/** Finds all occurrences of `query.text` in a single block of plain text. */
export function findTextMatches(text: string, query: SearchQuery): TextMatch[] {
  if (!query.text) return []
  const pattern = new RegExp(escapeRegExp(query.text), query.caseSensitive ? 'gu' : 'giu')
  const checkStart = query.wholeWord && NON_CJK_WORD.test(firstChar(query.text))
  const checkEnd = query.wholeWord && NON_CJK_WORD.test(lastChar(query.text))
  const matches: TextMatch[] = []
  for (const found of text.matchAll(pattern)) {
    const length = found[0].length
    if (length === 0) continue
    const index = found.index!
    if (checkStart && index > 0 && NON_CJK_WORD.test(lastChar(text.slice(Math.max(0, index - 2), index)))) continue
    const end = index + length
    if (checkEnd && end < text.length && NON_CJK_WORD.test(firstChar(text.slice(end, Math.min(text.length, end + 2))))) continue
    matches.push({ index, length })
  }
  return matches
}
