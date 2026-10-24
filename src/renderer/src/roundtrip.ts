/**
 * Dev-only regression check: every case must survive "open → save" unchanged, and the
 * saved text must render exactly like the original. Run `await mtyporaRoundTrip()` in devtools.
 * Cases follow the syntax list of Typora's bundled "Markdown Reference".
 */
export const ROUND_TRIP_CASES: Record<string, string> = {
  imageTitle: '![alt text](a.png "Title")',
  imageInline: 'Before ![logo](img/logo.png) after.',
  subscript: 'H~2~O',
  superscript: 'X^2^',
  highlight: 'A ==highlighted== word.',
  strike: 'A ~~struck~~ word.',
  tildeLiteral: 'Approx ~5 minutes.',
  callout: '> [!NOTE]\n> Useful information.',
  calloutList: '> [!WARNING]\n> Be careful.\n>\n> - one\n> - two',
  toc: '[toc]',
  tocUpper: '[TOC]',
  arrayIndex: 'Use array[0] and map[key] here.',
  checkboxText: 'Option [x] or [ ] in prose.',
  literalLink: 'Literal \\[a](b) stays text.',
  literalTask: '- \\[ ] not a task',
  literalFootnote: 'Literal \\[^1] here.',
  realLink: 'A [real link](https://example.com).',
  footnote: 'Text with note[^1].\n\n[^1]: The note.',
  emoji: 'Smile :smile: and :heart_eyes:',
  underline: 'An <u>underlined</u> word.',
  inlineHtml: 'A <span style="color:red">red</span> word.',
  mermaid: '```mermaid\ngraph LR\nA --> B\n```',
  mathInline: 'Euler $e^{i\\pi}+1=0$ here.',
  mathBlock: '$$\nx^2\n$$',
  escapes: 'snake_case and 2*3*4 and a_b_c',
  taskList: '- [x] done\n- [ ] todo',
  table: '| a | b |\n| --- | --- |\n| 1 | 2 |',
  tableAligned: '| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |',
  tablePadded: '| 场景 | 推荐     |\n| ---- | -------- |\n| 简单 | **加粗** |'
}

/** Rewrites that keep the meaning (the document renders identically) but change the text. */
export const KNOWN_NORMALIZATIONS: Record<string, string> = {
  literalLink: 'Literal \\[a]\\(b) stays text.',
  // Table source is re-padded so columns line up by display width.
  tableAligned: '| Left | Center | Right |\n| :--- | :----: | ----: |\n| a    |    b   |     c |'
}

interface Harness {
  load(markdown: string): void
  save(): string
  html(): string
}

export async function runRoundTrip(harness: Harness): Promise<{ failed: string[]; details: Record<string, string> }> {
  const wait = () => new Promise((resolve) => setTimeout(resolve, 120))
  const failed: string[] = []
  const details: Record<string, string> = {}
  for (const [name, markdown] of Object.entries(ROUND_TRIP_CASES)) {
    harness.load(markdown)
    await wait()
    const before = harness.html()
    const saved = harness.save().trim()
    harness.load(saved)
    await wait()
    const problems: string[] = []
    if (saved !== markdown && saved !== KNOWN_NORMALIZATIONS[name]) problems.push(`saved as ${JSON.stringify(saved)}`)
    if (harness.html() !== before) problems.push('renders differently after reload')
    details[name] = problems.length ? problems.join('; ') : 'ok'
    if (problems.length) failed.push(name)
  }
  return { failed, details }
}
