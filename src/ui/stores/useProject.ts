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

export interface GlobalScopeSummary {
  id: string
  label: string
  installer: string
  packageManager: string
  nodeVersion: string | null
  active: boolean
  rootCount: number
  roots: string[]
}

/** Which list the table is currently showing. */
export type Selection = { kind: 'project' } | { kind: 'global'; id: string }

const report = ref<DependencyReport | null>(null)
const globalScopes = ref<GlobalScopeSummary[]>([])
const selection = ref<Selection>({ kind: 'project' })
const loading = ref(false)
const enriching = ref(false)
const error = ref<string | null>(null)
const enrichError = ref<string | null>(null)

/** Query string identifying the current selection, shared by every endpoint. */
function selectionQuery(): string {
  return selection.value.kind === 'global'
    ? `?scope=global&id=${encodeURIComponent(selection.value.id)}`
    : ''
}

export async function loadGlobalScopes(): Promise<void> {
  try {
    const { scopes } = await apiFetch<{ scopes: GlobalScopeSummary[] }>('/global/scopes')
    globalScopes.value = scopes
  } catch {
    // Global discovery is best-effort; the project view still works without it.
    globalScopes.value = []
  }
}

/**
 * Local state first, network second. The table is readable the moment the manifest
 * and node_modules have been read; latest versions and advisories land after.
 */
export async function load(target: Selection = selection.value): Promise<void> {
  selection.value = target
  loading.value = true
  error.value = null

  const path = target.kind === 'global' ? `/global/deps?id=${encodeURIComponent(target.id)}` : '/deps'

  try {
    report.value = await apiFetch<DependencyReport>(path)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not read this list'
    report.value = null
    return
  } finally {
    loading.value = false
  }

  await enrich()
}

export const loadProject = load

async function enrich(): Promise<void> {
  enriching.value = true
  enrichError.value = null

  try {
    const { rows } = await apiFetch<{ rows: EnrichedRow[] }>(`/enrich${selectionQuery()}`)
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
  } catch (cause) {
    // The local half of the table is still valid and still shown; only the
    // registry-derived columns are missing.
    enrichError.value = cause instanceof Error ? cause.message : 'Could not reach the registry'
  } finally {
    enriching.value = false
  }
}

export function useProject() {
  return {
    report,
    globalScopes,
    selection,
    loading,
    enriching,
    error,
    enrichError,
    selectionQuery,
    isGlobal: computed(() => report.value?.project.scope === 'global'),
    project: computed(() => report.value?.project ?? null),
    dependencies: computed(() => report.value?.dependencies ?? []),
  }
}
