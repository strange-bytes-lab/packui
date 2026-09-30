import { computed, ref } from 'vue'
import type { DependencyReport } from '@shared/types'
import { apiFetch } from '@/composables/useApi'
import type { TreeAudit } from '@/types/insights'

interface EnrichedRow {
  name: string
  latest: string | null
  versions: string[]
  deprecated: string | null
  outdated: DependencyReport['dependencies'][number]['outdated']
  vulnerabilities: DependencyReport['dependencies'][number]['vulnerabilities']
  vulnerabilityCheck: DependencyReport['dependencies'][number]['vulnerabilityCheck']
  registryModified: string | null
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

/**
 * Which list the table is currently showing. No path means the launched project.
 * `home` is the project picker, shown when packui was launched outside a project.
 */
export type Selection =
  { kind: 'project'; path?: string } | { kind: 'global'; id: string } | { kind: 'home' }

export interface WorkspacePackageSummary {
  path: string
  relative: string
  name: string
}

export interface RangeMismatch {
  name: string
  declarations: { package: string; relative: string; range: string; field: string }[]
}

export interface RecentProjectSummary {
  path: string
  displayPath: string
  name: string
}

export interface WorkspaceSummary {
  root: string
  packages: WorkspacePackageSummary[]
}

const report = ref<DependencyReport | null>(null)
const globalScopes = ref<GlobalScopeSummary[]>([])
const selection = ref<Selection>({ kind: 'project' })
const loading = ref(false)
const enriching = ref(false)
const error = ref<string | null>(null)
const enrichError = ref<string | null>(null)
const workspace = ref<WorkspaceSummary | null>(null)
const mismatches = ref<RangeMismatch[]>([])
const recentProjects = ref<RecentProjectSummary[]>([])
/** The launched project; null when launched outside one, undefined until known. */
const launched = ref<string | null | undefined>(undefined)
/** Where the add-folder picker opens: the directory packui was started in. */
const startDir = ref<string | null>(null)
const treeAudit = ref<TreeAudit | null>(null)
const auditing = ref(false)
const auditError = ref<string | null>(null)
let auditGeneration = 0
let auditInFlight: AbortController | null = null

/**
 * Enrichment is slow and the sidebar is fast, so a response can arrive after the user
 * has already switched lists. Rows are matched by name, which hides most of it — but a
 * package present in both lists would take the wrong version data, which is exactly the
 * kind of quiet wrongness this tool exists to catch elsewhere.
 */
let enrichGeneration = 0
let enrichInFlight: AbortController | null = null

/** Query string identifying the current selection, shared by every endpoint. */
function selectionQuery(): string {
  const current = selection.value
  if (current.kind === 'global') return `?scope=global&id=${encodeURIComponent(current.id)}`
  if (current.kind === 'home') return ''
  return current.path === undefined ? '' : `?path=${encodeURIComponent(current.path)}`
}

/**
 * An endpoint path with the current selection appended, whether or not it already has
 * a query string. Every per-project request goes through this, so the drawer and the
 * removal dialog read the package the table is showing rather than the launched one.
 */
export function withSelection(path: string): string {
  const query = selectionQuery()
  if (query === '') return path
  return path.includes('?') ? `${path}&${query.slice(1)}` : `${path}${query}`
}

/** Projects packui was launched against or opened before, for switching without a restart. */
export async function loadRecentProjects(): Promise<void> {
  try {
    const body = await apiFetch<{
      launched: string | null
      startDir: string
      recent: RecentProjectSummary[]
    }>('/projects')
    recentProjects.value = body.recent
    launched.value = body.launched
    startDir.value = body.startDir
  } catch {
    recentProjects.value = []
  }
}

/** Adds a folder to the project list. The server checks it holds a package.json. */
export async function addProject(path: string): Promise<RecentProjectSummary> {
  const { project } = await apiFetch<{ project: RecentProjectSummary }>('/projects', {
    method: 'POST',
    body: JSON.stringify({ path }),
  })
  await loadRecentProjects()
  return project
}

/** Takes a project off the list. Its files are untouched. */
export async function forgetProject(path: string): Promise<void> {
  await apiFetch(`/projects?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
  await loadRecentProjects()
}

/** The workspace the shown project belongs to (the launched one by default). */
export async function loadWorkspace(path?: string): Promise<void> {
  try {
    const query = path === undefined ? '' : `?path=${encodeURIComponent(path)}`
    const body = await apiFetch<{
      workspace: WorkspaceSummary | null
      mismatches: RangeMismatch[]
    }>(`/workspace${query}`)
    workspace.value = body.workspace
    mismatches.value = body.mismatches
  } catch {
    // Best-effort, like global discovery: the project view works without it.
    workspace.value = null
    mismatches.value = []
  }
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
  error.value = null
  if (target.kind === 'home') {
    // Superseding both generations first, so the aborted requests land as stale
    // rather than as errors.
    enrichGeneration += 1
    auditGeneration += 1
    enrichInFlight?.abort()
    auditInFlight?.abort()
    enriching.value = false
    auditing.value = false
    report.value = null
    treeAudit.value = null
    return
  }
  loading.value = true

  const path =
    target.kind === 'global'
      ? `/global/deps?id=${encodeURIComponent(target.id)}`
      : withSelection('/deps')

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
  await audit()
}

/**
 * Advisories in indirect dependencies. Runs after the table has its registry data,
 * because it walks every installed package and asks OSV about each — the table must
 * never wait on it. Global scopes have no tree of their own to walk.
 */
async function audit(): Promise<void> {
  const generation = ++auditGeneration
  auditInFlight?.abort()
  treeAudit.value = null
  auditError.value = null
  if (report.value?.project.scope !== 'project') return

  const controller = new AbortController()
  auditInFlight = controller
  auditing.value = true
  try {
    const result = await apiFetch<TreeAudit>(withSelection('/audit'), {
      signal: controller.signal,
    })
    if (generation === auditGeneration) treeAudit.value = result
  } catch (cause) {
    if (generation !== auditGeneration) return
    auditError.value = cause instanceof Error ? cause.message : 'Could not audit the tree'
  } finally {
    if (generation === auditGeneration) auditing.value = false
  }
}

export const loadProject = load

async function enrich(): Promise<void> {
  const generation = ++enrichGeneration

  // The server honours the abort and stops its registry work, so this is not just a
  // client-side discard.
  enrichInFlight?.abort()
  const controller = new AbortController()
  enrichInFlight = controller

  enriching.value = true
  enrichError.value = null

  try {
    const { rows } = await apiFetch<{ rows: EnrichedRow[] }>(`/enrich${selectionQuery()}`, {
      signal: controller.signal,
    })
    if (generation !== enrichGeneration) return

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
        vulnerabilityCheck: enriched.vulnerabilityCheck,
        registryModified: enriched.registryModified,
      }
    })
  } catch (cause) {
    // A superseded request is not a failure; the newer one owns the state now.
    if (generation !== enrichGeneration) return
    // The local half of the table is still valid and still shown; only the
    // registry-derived columns are missing.
    enrichError.value = cause instanceof Error ? cause.message : 'Could not reach the registry'
  } finally {
    if (generation === enrichGeneration) enriching.value = false
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
    workspace,
    mismatches,
    recentProjects,
    launched,
    startDir,
    treeAudit,
    auditing,
    auditError,
    selectionQuery,
    isGlobal: computed(() => report.value?.project.scope === 'global'),
    project: computed(() => report.value?.project ?? null),
    dependencies: computed(() => report.value?.dependencies ?? []),
  }
}
