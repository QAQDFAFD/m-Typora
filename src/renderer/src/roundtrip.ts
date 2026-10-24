/**
 * Dev-only regression check: every case must survive "open → save" unchanged, and the
 * saved text must render exactly like the original. Run `await mtyporaRoundTrip()` in devtools.
 * Cases follow the syntax list of Typora's bundled "Markdown Reference" and are shared with
 * the end-to-end tests (scripts/e2e).
 */
import data from './roundtrip-cases.json'

export const ROUND_TRIP_CASES: Record<string, string> = data.cases

/** Rewrites that keep the meaning (the document renders identically) but change the text. */
export const KNOWN_NORMALIZATIONS: Record<string, string> = data.normalizations

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
