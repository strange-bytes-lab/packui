import { computed, ref, type Ref } from 'vue'
import type { DependencyRow } from '@shared/types'
import { fuzzyMatch } from '@/composables/fuzzy'

export type KindFilter = 'all' | 'prod' | 'dev'

/** Client-side search and filtering over an already-loaded dependency table. */
export function useFilters(rows: Ref<readonly DependencyRow[]>) {
  const query = ref('')
  const kind = ref<KindFilter>('all')
  const problemsOnly = ref(false)

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

    // With nothing typed every score is 0, so the server's order is preserved.
    if (needle !== '') {
      kept.sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name))
    }

    return kept.map((entry) => entry.row)
  })

  return { query, kind, problemsOnly, filtered }
}
