import { computed, ref } from 'vue'
import type { DependencyReport } from '@shared/types'
import { apiFetch } from '@/composables/useApi'

interface EnrichedRow {
  name: string
  latest: string | null
  versions: string[]
  deprecated: string | null
  outdated: DependencyReport['dependencies'][number]['outdated']
  vulnerabilities: DependencyReport['dependencies'][number]['vulnerabilities']
}

/**
 * A single shared report, kept module-level so the sidebar and the table read the
 * same state without prop drilling. Vue's reactivity is sufficient here; a store
 * library would be another dependency for no benefit.
 */
const report = ref<DependencyReport | null>(null)
const versionsByPackage = ref<Record<string, string[]>>({})
const loading = ref(false)
const enriching = ref(false)
const error = ref<string | null>(null)
const enrichError = ref<string | null>(null)

/**
 * Local state first, network second. The table is readable the moment package.json
 * and node_modules have been read; latest versions and advisories land after.
 */
export async function loadProject(path?: string): Promise<void> {
  loading.value = true
  error.value = null
  const query = path === undefined ? '' : `?path=${encodeURIComponent(path)}`

  try {
    report.value = await apiFetch<DependencyReport>(`/deps${query}`)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not read this project'
    report.value = null
    return
  } finally {
    loading.value = false
  }

  await enrich(query)
}

async function enrich(query: string): Promise<void> {
  enriching.value = true
  enrichError.value = null

  try {
    const { rows } = await apiFetch<{ rows: EnrichedRow[] }>(`/enrich${query}`)
    const byName = new Map(rows.map((row) => [row.name, row]))
    const current = report.value
    if (current === null) return

    current.dependencies = current.dependencies.map((row) => {
      const enriched = byName.get(row.name)
      if (enriched === undefined) return row
      return {
        ...row,
        latest: enriched.latest,
        outdated: enriched.outdated,
        deprecated: enriched.deprecated,
        vulnerabilities: enriched.vulnerabilities,
      }
    })

    versionsByPackage.value = Object.fromEntries(rows.map((row) => [row.name, row.versions]))
  } catch (cause) {
    // The local half of the table is still valid and still shown; only the
    // registry-derived columns are missing.
    enrichError.value =
      cause instanceof Error ? cause.message : 'Could not reach the registry'
  } finally {
    enriching.value = false
  }
}

export function useProject() {
  return {
    report,
    loading,
    enriching,
    error,
    enrichError,
    versionsByPackage,
    project: computed(() => report.value?.project ?? null),
    dependencies: computed(() => report.value?.dependencies ?? []),
  }
}
