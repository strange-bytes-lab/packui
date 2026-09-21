// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import DependencyTable from '../src/ui/components/DependencyTable.vue'
import type { DependencyRow } from '../src/shared/types.ts'
import type { SortDirection, SortKey } from '../src/ui/composables/sorting.ts'

/**
 * The whole row opens the drawer, and the row also carries the two actions that
 * change the project. If a click on Remove reached the row handler, the impact
 * dialog would open with the drawer behind it — these tests are that boundary.
 */

function row(overrides: Partial<DependencyRow> = {}): DependencyRow {
  return {
    name: 'left-pad',
    kind: 'prod',
    declared: '^1.3.0',
    installed: '1.3.0',
    latest: '1.3.1',
    outdated: 'patch',
    alignment: 'aligned',
    deprecated: null,
    vulnerabilities: null,
    ...overrides,
  }
}

function mountTable(props: {
  rows: DependencyRow[]
  pending?: boolean
  query?: string
  global?: boolean
  sortKey?: SortKey
  sortDirection?: SortDirection
}) {
  // Attached to the document: a detached tree has no selection, which the
  // drag-selection case below depends on.
  return mount(DependencyTable, { props, attachTo: document.body })
}

describe('DependencyTable — row activation', () => {
  it('opens the drawer from anywhere in the row', async () => {
    const table = mountTable({ rows: [row()] })

    await table.get('tr.row').trigger('click')

    expect(table.emitted('select')).toEqual([['left-pad']])
  })

  it('opens the drawer from the name button exactly once', async () => {
    const table = mountTable({ rows: [row()] })

    await table.get('button.name').trigger('click')

    expect(table.emitted('select')).toEqual([['left-pad']])
  })

  it('upgrades without also opening the drawer', async () => {
    const table = mountTable({ rows: [row()] })

    await table.get('button.action:not(.action--danger)').trigger('click')

    expect(table.emitted('upgrade')).toHaveLength(1)
    expect(table.emitted('select')).toBeUndefined()
  })

  it('removes without also opening the drawer', async () => {
    const table = mountTable({ rows: [row()] })

    await table.get('button.action--danger').trigger('click')

    expect(table.emitted('remove')).toHaveLength(1)
    expect(table.emitted('select')).toBeUndefined()
  })

  it('ignores a click that ended a text selection', async () => {
    const table = mountTable({ rows: [row()] })
    const range = document.createRange()
    range.selectNodeContents(table.get('td.col-version').element)
    window.getSelection()?.addRange(range)
    // Guard the guard: without a real selection this test would pass vacuously.
    expect(window.getSelection()?.toString()).toBe('^1.3.0')

    await table.get('tr.row').trigger('click')

    expect(table.emitted('select')).toBeUndefined()
    window.getSelection()?.removeAllRanges()
    table.unmount()
  })
})

describe('DependencyTable — pending registry data', () => {
  it('skeletons the registry columns rather than claiming an answer', () => {
    const table = mountTable({ rows: [row({ latest: null, outdated: 'unknown' })], pending: true })

    expect(table.findAll('.skeleton')).toHaveLength(2)
    // An em dash here would read as "checked, nothing found".
    expect(table.get('table').attributes('aria-busy')).toBe('true')
    expect(table.text()).not.toContain('—')
  })

  it('shows the real values once enrichment has landed', () => {
    const table = mountTable({ rows: [row()], pending: false })

    expect(table.findAll('.skeleton')).toHaveLength(0)
    expect(table.text()).toContain('1.3.1')
  })
})

describe('DependencyTable — filter highlighting', () => {
  it('marks the matched characters without altering the name', () => {
    const table = mountTable({ rows: [row({ name: '@vitejs/plugin-vue' })], query: 'pv' })

    const name = table.get('button.name')
    // The segments are separate elements; the text they add up to must still be the
    // package name, with no whitespace introduced between them.
    expect(name.text()).toBe('@vitejs/plugin-vue')
    expect(name.findAll('.hit').map((hit) => hit.text())).toEqual(['p', 'v'])
  })

  it('marks nothing when the filter is empty', () => {
    const table = mountTable({ rows: [row()], query: '' })

    expect(table.get('button.name').text()).toBe('left-pad')
    expect(table.findAll('.hit')).toHaveLength(0)
  })
})

describe('DependencyTable — column sorting', () => {
  it('asks for a sort when a header is clicked', async () => {
    const table = mountTable({ rows: [row()] })

    await table.get('th.col-name button.sort').trigger('click')

    expect(table.emitted('sort')).toEqual([['name']])
  })

  it('reports the active column to assistive technology', () => {
    const table = mountTable({ rows: [row()], sortKey: 'latest', sortDirection: 'desc' })

    expect(table.get('th.col-name').attributes('aria-sort')).toBe('none')
    const latest = table.findAll('th.col-version').at(-1)
    expect(latest?.attributes('aria-sort')).toBe('descending')
  })

  it('offers no Kind or Declared column for a global scope', () => {
    const table = mountTable({ rows: [row()], global: true })

    expect(table.findAll('th.col-kind')).toHaveLength(0)
    expect(table.findAll('th.col-version')).toHaveLength(2)
  })

  it('keeps the status dot and the status sort in agreement', () => {
    const vulnerable = row({
      outdated: 'patch',
      vulnerabilities: { count: 1, worst: 'critical', ids: [] },
    })
    const table = mountTable({ rows: [vulnerable] })

    // rowStatus is shared with compareRows; if it drifts, this label changes.
    expect(table.get('.dot').attributes('aria-label')).toBe(
      'Vulnerable — critical severity advisory',
    )
  })
})
