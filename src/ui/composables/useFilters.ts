import { computed, ref, type Ref } from 'vue'
import type { DependencyRow } from '@shared/types'
import { fuzzyMatch } from '@/composables/fuzzy'
import {
  compareRows,
  FIRST_DIRECTION,
  type SortDirection,
  type SortKey,
} from '@/composables/sorting'

export type KindFilter = 'all' | 'prod' | 'dev'

/** Client-side search and filtering over an already-loaded dependency table. */
export function useFilters(rows: Ref<readonly DependencyRow[]>) {
  const query = ref('')
  const kind = ref<KindFilter>('all')
  const problemsOnly = ref(false)
  const sortKey = ref<SortKey | null>(null)
  const sortDirection = ref<SortDirection>('asc')

  /**
   * Three states per column: the direction that column leads with, its opposite, then
   * off. "Off" has to be reachable, because it is the only way back to relevance order
   * while a filter is typed.
   */
  function toggleSort(key: SortKey): void {
    if (sortKey.value !== key) {
      sortKey.value = key
      sortDirection.value = FIRST_DIRECTION[key]
      return
    }

    if (sortDirection.value === FIRST_DIRECTION[key]) {
      sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc'
      return
    }

    sortKey.value = null
  }

  const filtered = computed(() => {
    const needle = query.value.trim()

    const kept: { row: DependencyRow; score: number }[] = []

    for (const row of rows.value) {
      if (kind.value === 'prod' && row.kind !== 'prod') continue
      if (kind.value === 'dev' && row.kind !== 'dev') continue

      if (problemsOnly.value) {
        const misaligned = row.alignment !== 'aligned' && row.alignment !== 'unknown'
        const behind = row.outdated === 'major' || row.outdated === 'minor'
        const vulnerable = (row.vulnerabilities?.count ?? 0) > 0
        if (!misaligned && !behind && !vulnerable) continue
      }

      const match = fuzzyMatch(row.name, needle)
      if (match === null) continue
      kept.push({ row, score: match.score })
    }

    const key = sortKey.value
    if (key !== null) {
      // An explicit column sort outranks relevance: the user asked for this order.
      kept.sort((a, b) => compareRows(a.row, b.row, key, sortDirection.value))
    } else if (needle !== '') {
      kept.sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name))
    }
    // With nothing typed and no column chosen, the server's order is preserved.

    return kept.map((entry) => entry.row)
  })

  return { query, kind, problemsOnly, sortKey, sortDirection, toggleSort, filtered }
}
