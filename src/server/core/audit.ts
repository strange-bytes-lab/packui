import semver from 'semver'
import type { VulnerabilitySummary } from '../../shared/types.ts'
import { mapWithConcurrency } from './cache.ts'
import { isPrivatelyScoped, type RegistryConfig } from './npmrc.ts'
import {
  fetchAdvisory,
  queryVulnerabilitiesDetailed,
  worstSeverity,
  type AdvisoryDetail,
} from './osv.ts'
import {
  buildInstallGraph,
  directDependentsOf,
  label,
  shortestChains,
  type InstallGraph,
} from './tree.ts'

/**
 * Advisories in the packages your dependencies depend on. Most advisories live there,
 * not in anything package.json names, and the table cannot show them.
 *
 * Every installed copy is checked by exact version, so the OSV cache (keyed per
 * `name@version`) is shared with the table and with every other project. Packages
 * whose scope is mapped to a private registry are skipped, as they are in the table.
 */

export interface IndirectAdvisory {
  name: string
  version: string
  advisories: VulnerabilitySummary
  /** Every version that fixes at least one advisory, ascending. */
  fixedIn: string[]
  /**
   * The lowest version above the installed one that is past every advisory's fix, or
   * null when some advisory has no fix published. What an override would pin to.
   */
  suggested: string | null
  /** The shortest route from a direct dependency, as name@version labels. */
  chain: string[]
  /** Direct dependencies that pull this copy in. */
  via: string[]
}

export interface TreeAudit {
  /** Installed packages examined, direct and indirect. */
  packages: number
  truncated: boolean
  vulnerable: IndirectAdvisory[]
  /** Per direct dependency: how many vulnerable indirect copies it pulls in, and the worst. */
  byDirect: Record<string, { count: number; worst: VulnerabilitySummary['worst'] }>
  /** Copies OSV could not answer for, with nothing cached. Not counted as clean. */
  unchecked: number
  /** Copies from privately scoped registries, never sent to OSV. */
  privateSkipped: number
}

/** The fix that clears every advisory: above the installed version and past each one's fix. */
export function suggestFix(
  installed: string,
  advisories: readonly AdvisoryDetail[],
): string | null {
  let required: string | null = null
  for (const advisory of advisories) {
    const fixes = advisory.fixedIn
      .filter((version) => semver.valid(version) !== null && semver.gt(version, installed))
      .sort(semver.compare)
    const first = fixes[0]
    if (first === undefined) return null
    if (required === null || semver.gt(first, required)) required = first
  }
  return required
}

const SEVERITY_RANK = { critical: 4, high: 3, moderate: 2, low: 1 } as const

export async function auditTree(
  projectPath: string,
  directNames: readonly string[],
  stopAt: string,
  config: RegistryConfig,
  signal?: AbortSignal,
  prebuilt?: InstallGraph,
): Promise<TreeAudit> {
  const graph = prebuilt ?? (await buildInstallGraph(projectPath, directNames, stopAt))
  const rootIds = new Set(graph.roots.values())

  const indirect = [...graph.nodes.values()].filter((node) => !rootIds.has(node.id))
  const privateNodes = indirect.filter((node) => isPrivatelyScoped(config, node.name))
  const publicNodes = indirect.filter((node) => !isPrivatelyScoped(config, node.name))

  // One query per distinct name@version; several copies of one version share the answer.
  const distinct = new Map<string, { name: string; version: string }>()
  for (const node of publicNodes) distinct.set(`${node.name}@${node.version}`, node)
  const queries = [...distinct.values()]

  // queryVulnerabilities answers per name, so versions of the same name are asked
  // separately to keep their answers apart.
  const byVersion = new Map<string, string[]>()
  let unchecked = 0
  const rounds: { name: string; version: string }[][] = []
  for (const query of queries) {
    const round = rounds.find((candidate) => !candidate.some((entry) => entry.name === query.name))
    if (round === undefined) rounds.push([query])
    else round.push(query)
  }
  for (const round of rounds) {
    const answer = await queryVulnerabilitiesDetailed(round, signal)
    for (const query of round) {
      if (answer.unchecked.has(query.name)) unchecked += 1
      const ids = answer.ids.get(query.name)
      if (ids !== undefined) byVersion.set(`${query.name}@${query.version}`, ids)
    }
  }

  const allIds = [...new Set([...byVersion.values()].flat())]
  const details = new Map<string, AdvisoryDetail>()
  await mapWithConcurrency(allIds, 4, async (id) => {
    const detail = await fetchAdvisory(id, signal)
    if (detail !== null) details.set(id, detail)
  })

  const chains = shortestChains(graph)
  const via = directDependentsOf(graph)

  const vulnerable: IndirectAdvisory[] = []
  for (const node of publicNodes) {
    const ids = byVersion.get(`${node.name}@${node.version}`)
    if (ids === undefined || ids.length === 0) continue
    const advisories = ids
      .map((id) => details.get(id))
      .filter((detail): detail is AdvisoryDetail => detail !== undefined)
    const fixedIn = [...new Set(advisories.flatMap((advisory) => advisory.fixedIn))]
      .filter((version) => semver.valid(version) !== null)
      .sort(semver.compare)
    vulnerable.push({
      name: node.name,
      version: node.version,
      advisories: {
        count: ids.length,
        worst: worstSeverity(advisories.map((advisory) => advisory.severity)),
        ids,
      },
      fixedIn,
      // Without every advisory's detail there is no honest single answer.
      suggested: advisories.length === ids.length ? suggestFix(node.version, advisories) : null,
      chain: (chains.get(node.id) ?? [node.id]).map((id) => label(graph, id, projectPath)),
      via: [...(via.get(node.id) ?? [])].sort(),
    })
  }

  const rank = (entry: IndirectAdvisory): number =>
    entry.advisories.worst === null ? 0 : SEVERITY_RANK[entry.advisories.worst]
  vulnerable.sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name))

  const byDirect: TreeAudit['byDirect'] = {}
  for (const entry of vulnerable) {
    for (const name of entry.via) {
      const current = byDirect[name] ?? { count: 0, worst: null }
      byDirect[name] = {
        count: current.count + 1,
        worst: worstSeverity([current.worst, entry.advisories.worst]),
      }
    }
  }

  return {
    packages: graph.nodes.size,
    truncated: graph.truncated,
    vulnerable,
    byDirect,
    unchecked,
    privateSkipped: privateNodes.length,
  }
}
