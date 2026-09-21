// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import DependencyTable from '../src/ui/components/DependencyTable.vue'
import type { DependencyRow } from '../src/shared/types.ts'

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

function mountTable(props: { rows: DependencyRow[]; pending?: boolean }) {
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
