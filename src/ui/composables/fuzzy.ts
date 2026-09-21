/**
 * Subsequence matching with a score, sized for package names rather than prose.
 *
 * Package names are punctuated — `@scope/name`, `plugin-vue`, `core.js` — so the
 * scoring rewards a match that starts a segment. That is what lets `pv` find
 * `@vitejs/plugin-vue` without every name that happens to hold a p before a v
 * ranking alongside it.
 *
 * Plain substring matches always outrank scattered ones, so typing a package name
 * in full behaves exactly as the old `includes` filter did.
 */

/** Characters that begin a new segment of a package name. */
const BOUNDARY = /[@/\-._]/

export interface FuzzyMatch {
  score: number
  /** Indices into the haystack that were matched, for highlighting. */
  indices: number[]
}

export function fuzzyMatch(haystack: string, needle: string): FuzzyMatch | null {
  if (needle === '') return { score: 0, indices: [] }

  const text = haystack.toLowerCase()
  const pattern = needle.toLowerCase()

  const indices: number[] = []
  let score = 0
  let cursor = 0
  let run = 0

  for (const char of pattern) {
    const at = text.indexOf(char, cursor)
    if (at === -1) return null

    if (at === 0) score += 12
    else if (BOUNDARY.test(text.charAt(at - 1))) score += 9

    if (at === cursor && indices.length > 0) {
      run += 1
      score += 5 + run
    } else {
      run = 0
      // A long jump between matched characters is a weaker match, but only up to a
      // point — otherwise a match late in a long name can never compete.
      score -= Math.min(at - cursor, 6)
    }

    indices.push(at)
    cursor = at + 1
  }

  // A contiguous hit is what the user usually meant; keep it clear of the noise.
  if (text.includes(pattern)) score += 40

  // Among equally good matches, the shorter name is the more likely target.
  return { score: score - text.length * 0.1, indices }
}

export interface Segment {
  text: string
  matched: boolean
}

/** Splits a name into alternating plain and matched runs, for rendering. */
export function highlight(haystack: string, indices: readonly number[]): Segment[] {
  if (indices.length === 0) return [{ text: haystack, matched: false }]

  const marked = new Set(indices)
  const segments: Segment[] = []

  // Indexed by code unit, because that is what the match indices are.
  for (let index = 0; index < haystack.length; index += 1) {
    const matched = marked.has(index)
    const last = segments.at(-1)
    if (last !== undefined && last.matched === matched) last.text += haystack.charAt(index)
    else segments.push({ text: haystack.charAt(index), matched })
  }

  return segments
}
