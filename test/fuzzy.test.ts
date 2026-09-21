import { describe, expect, it } from 'vitest'
import { fuzzyMatch, highlight } from '../src/ui/composables/fuzzy.ts'
import { useFilters } from '../src/ui/composables/useFilters.ts'
import { ref } from 'vue'
import type { DependencyRow } from '../src/shared/types.ts'

function score(haystack: string, needle: string): number {
  const match = fuzzyMatch(haystack, needle)
  if (match === null) throw new Error(`${needle} did not match ${haystack}`)
  return match.score
}

describe('fuzzyMatch', () => {
  it('matches an empty needle against anything', () => {
    expect(fuzzyMatch('left-pad', '')).toEqual({ score: 0, indices: [] })
  })

  it('rejects characters that are not present in order', () => {
    expect(fuzzyMatch('left-pad', 'dap')).toBeNull()
    expect(fuzzyMatch('left-pad', 'zebra')).toBeNull()
  })

  it('matches across segment boundaries', () => {
    expect(fuzzyMatch('@vitejs/plugin-vue', 'pv')?.indices).toEqual([8, 15])
  })

  it('ranks a contiguous match above a scattered one', () => {
    expect(score('@vue/test-utils', 'test')).toBeGreaterThan(score('@types/estree', 'test'))
  })

  it('ranks a match that starts a segment above one buried mid-word', () => {
    // Same needle, two haystacks: "vue" begins a segment in the first and is a
    // scattered v-u-e in the second.
    expect(score('@vitejs/plugin-vue', 'vue')).toBeGreaterThan(score('jsdom-value-util', 'vue'))
  })

  it('prefers the shorter of two otherwise equal names', () => {
    expect(score('vue', 'vue')).toBeGreaterThan(score('vue-router-extra-long', 'vue'))
  })
})

describe('highlight', () => {
  it('splits into alternating runs that reassemble into the original', () => {
    const segments = highlight('plugin-vue', [0, 7, 8])
    expect(segments.map((segment) => segment.text).join('')).toBe('plugin-vue')
    expect(segments.filter((segment) => segment.matched).map((s) => s.text)).toEqual(['p', 'vu'])
  })

  it('returns the whole string unmarked when nothing matched', () => {
    expect(highlight('left-pad', [])).toEqual([{ text: 'left-pad', matched: false }])
  })
})

function row(name: string, overrides: Partial<DependencyRow> = {}): DependencyRow {
  return {
    name,
    kind: 'prod',
    declared: '^1.0.0',
    installed: '1.0.0',
    latest: '1.0.0',
    outdated: 'current',
    alignment: 'aligned',
    deprecated: null,
    vulnerabilities: null,
    ...overrides,
  }
}

describe('useFilters', () => {
  it('orders by relevance while a query is typed', () => {
    const rows = ref([row('@types/estree'), row('@vue/test-utils'), row('vitest')])
    const { query, filtered } = useFilters(rows)

    query.value = 'test'

    expect(filtered.value.map((entry) => entry.name)).toEqual([
      '@vue/test-utils',
      'vitest',
      '@types/estree',
    ])
  })

  it('keeps the server order when nothing is typed', () => {
    const rows = ref([row('zod'), row('axios')])
    const { filtered } = useFilters(rows)

    expect(filtered.value.map((entry) => entry.name)).toEqual(['zod', 'axios'])
  })

  it('still applies the kind and problem filters to a fuzzy match', () => {
    const rows = ref([row('vitest', { kind: 'dev' }), row('vite', { kind: 'prod' })])
    const { query, kind, filtered } = useFilters(rows)

    query.value = 'vit'
    kind.value = 'dev'

    expect(filtered.value.map((entry) => entry.name)).toEqual(['vitest'])
  })
})
