import { computed, ref, type Ref } from 'vue'
import type { DependencyRow } from '@shared/types'

export type KindFilter = 'all' | 'prod' | 'dev'

/** Client-side search and filtering over an already-loaded dependency table. */
export function useFilters(rows: Ref<readonly DependencyRow[]>) {
  const query = ref('')
  const kind = ref<KindFilter>('all')
  const problemsOnly = ref(false)

  const filtered = computed(() => {
    const needle = query.value.trim().toLowerCase()

    return rows.value.filter((row) => {
      if (needle !== '' && !row.name.toLowerCase().includes(needle)) return false

      if (kind.value === 'prod' && row.kind !== 'prod') return false
      if (kind.value === 'dev' && row.kind !== 'dev') return false

      if (problemsOnly.value) {
        const misaligned = row.alignment !== 'aligned' && row.alignment !== 'unknown'
        const behind = row.outdated === 'major' || row.outdated === 'minor'
        const vulnerable = (row.vulnerabilities?.count ?? 0) > 0
        if (!misaligned && !behind && !vulnerable) return false
      }

      return true
    })
  })

  return { query, kind, problemsOnly, filtered }
}
