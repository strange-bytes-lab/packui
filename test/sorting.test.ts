import { ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { compareRows, compareVersions } from '../src/ui/composables/sorting.ts'
import { useFilters } from '../src/ui/composables/useFilters.ts'
import type { DependencyRow } from '../src/shared/types.ts'

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

describe('compareVersions', () => {
  it('orders by number, not by string', () => {
    // The whole reason this exists: a string sort puts 1.10.0 before 1.9.0.
    expect(compareVersions('1.9.0', '1.10.0')).toBeLessThan(0)
    expect(compareVersions('2.0.0', '10.0.0')).toBeLessThan(0)
  })

  it('places a prerelease below the release it precedes', () => {
    expect(compareVersions('3.0.0-beta.1', '3.0.0')).toBeLessThan(0)
    expect(compareVersions('3.0.0-alpha.1', '3.0.0-beta.1')).toBeLessThan(0)
    expect(compareVersions('3.0.0-rc.2', '3.0.0-rc.10')).toBeLessThan(0)
  })

  it('sorts a numeric prerelease identifier below an alphanumeric one', () => {
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0)
  })

  it('puts a missing version last', () => {
    expect(compareVersions(null, '1.0.0')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', null)).toBeLessThan(0)
  })

  it('falls back to a numeric collation for versions it cannot parse', () => {
    expect(compareVersions('1.0.0b', 'latest')).toBeLessThan(0)
  })
})

describe('compareRows', () => {
  it('keeps a missing version last whichever way the column points', () => {
    const present = row('a', { installed: '1.0.0' })
    const absent = row('b', { installed: null })

    expect(compareRows(absent, present, 'installed', 'asc')).toBeGreaterThan(0)
    expect(compareRows(absent, present, 'installed', 'desc')).toBeGreaterThan(0)
  })

  it('ranks status the same way the dot colours it', () => {
    const vulnerable = row('a', {
      outdated: 'patch',
      vulnerabilities: { count: 1, worst: 'critical', ids: [] },
    })
    const behind = row('b', { outdated: 'minor' })

    // A critical advisory outranks being a minor behind, exactly as StatusDot says.
    expect(compareRows(vulnerable, behind, 'status', 'desc')).toBeLessThan(0)
  })

  it('breaks ties on the name so the order is stable', () => {
    expect(compareRows(row('axios'), row('zod'), 'kind', 'desc')).toBeLessThan(0)
  })
})

describe('useFilters — column sorting', () => {
  it('sorts by the chosen column and cycles direction, then off', () => {
    const rows = ref([row('b', { latest: '1.9.0' }), row('a', { latest: '1.10.0' })])
    const { sortKey, sortDirection, toggleSort, filtered } = useFilters(rows)

    toggleSort('latest')
    expect(sortDirection.value).toBe('asc')
    expect(filtered.value.map((entry) => entry.name)).toEqual(['b', 'a'])

    toggleSort('latest')
    expect(sortDirection.value).toBe('desc')
    expect(filtered.value.map((entry) => entry.name)).toEqual(['a', 'b'])

    toggleSort('latest')
    expect(sortKey.value).toBeNull()
    // Back to the order the server sent.
    expect(filtered.value.map((entry) => entry.name)).toEqual(['b', 'a'])
  })

  it('leads with the loudest rows when sorting by status', () => {
    const rows = ref([row('calm'), row('loud', { outdated: 'major' })])
    const { toggleSort, filtered } = useFilters(rows)

    toggleSort('status')

    expect(filtered.value.map((entry) => entry.name)).toEqual(['loud', 'calm'])
  })

  it('lets a column sort override relevance order', () => {
    const rows = ref([row('vitest'), row('vite')])
    const { query, toggleSort, filtered } = useFilters(rows)

    query.value = 'vite'
    expect(filtered.value.map((entry) => entry.name)).toEqual(['vite', 'vitest'])

    toggleSort('name')
    expect(filtered.value.map((entry) => entry.name)).toEqual(['vite', 'vitest'])

    toggleSort('name')
    expect(filtered.value.map((entry) => entry.name)).toEqual(['vitest', 'vite'])
  })
})
