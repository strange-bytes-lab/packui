import { mapWithConcurrency } from './cache.ts'
import {
  buildInstallGraph,
  directDependentsOf,
  packageSize,
  reachableFrom,
  type InstallGraph,
} from './tree.ts'

/**
 * What each direct dependency costs on disk, and which packages are installed more
 * than once at different versions.
 *
 * Three numbers per dependency, because "how big is it" has three honest answers:
 * its own files; everything it pulls in; and what removing it would actually free —
 * the part of its tree no other direct dependency also needs.
 */

export interface DirectWeight {
  name: string
  version: string
  own: number
  withDependencies: number
  /** Bytes reachable only through this dependency: what removing it would free. */
  exclusive: number
  /** Installed packages in its tree, itself included. */
  packages: number
}

export interface DuplicateVersion {
  version: string
  copies: number
  /** Packages that depend on this version, as name@version, a few at most. */
  requiredBy: string[]
  bytes: number
}

export interface Duplicate {
  name: string
  versions: DuplicateVersion[]
}

export interface WeightReport {
  packages: number
  totalBytes: number
  /** True when either the graph or the size walk hit its limit. */
  truncated: boolean
  direct: DirectWeight[]
  duplicates: Duplicate[]
}

/** Bounds the size walk: a node_modules can hold hundreds of thousands of files. */
const FILE_BUDGET = 400_000

export async function measureWeight(
  projectPath: string,
  directNames: readonly string[],
  stopAt: string,
  prebuilt?: InstallGraph,
): Promise<WeightReport> {
  const graph = prebuilt ?? (await buildInstallGraph(projectPath, directNames, stopAt))
  const budget = { files: FILE_BUDGET }

  const ids = [...graph.nodes.keys()]
  const sizes = new Map<string, number>()
  await mapWithConcurrency(ids, 8, async (id) => {
    sizes.set(id, await packageSize(id, budget))
  })
  const sum = (set: Iterable<string>): number => {
    let total = 0
    for (const id of set) total += sizes.get(id) ?? 0
    return total
  }

  const via = directDependentsOf(graph)
  const direct: DirectWeight[] = []
  for (const [name, id] of graph.roots) {
    const reached = reachableFrom(graph, id)
    const exclusive = [...reached].filter((node) => (via.get(node)?.size ?? 0) === 1)
    direct.push({
      name,
      version: graph.nodes.get(id)?.version ?? '',
      own: sizes.get(id) ?? 0,
      withDependencies: sum(reached),
      exclusive: sum(exclusive),
      packages: reached.size,
    })
  }
  direct.sort((a, b) => b.withDependencies - a.withDependencies)

  // Parents, for "who wants this version".
  const parents = new Map<string, string[]>()
  for (const node of graph.nodes.values()) {
    for (const child of node.dependencies) {
      const list = parents.get(child) ?? []
      list.push(`${node.name}@${node.version}`)
      parents.set(child, list)
    }
  }

  const byName = new Map<string, Map<string, { copies: string[] }>>()
  for (const node of graph.nodes.values()) {
    const versions = byName.get(node.name) ?? new Map<string, { copies: string[] }>()
    const entry = versions.get(node.version) ?? { copies: [] }
    entry.copies.push(node.id)
    versions.set(node.version, entry)
    byName.set(node.name, versions)
  }

  const rootIds = new Set(graph.roots.values())
  const duplicates: Duplicate[] = []
  for (const [name, versions] of byName) {
    if (versions.size < 2) continue
    duplicates.push({
      name,
      versions: [...versions.entries()]
        .map(([version, { copies }]) => ({
          version,
          copies: copies.length,
          requiredBy: [
            ...new Set(
              copies.flatMap((id) => (rootIds.has(id) ? ['(direct)'] : (parents.get(id) ?? []))),
            ),
          ].slice(0, 5),
          bytes: sum(copies),
        }))
        .sort((a, b) => b.copies - a.copies || a.version.localeCompare(b.version)),
    })
  }
  duplicates.sort((a, b) => b.versions.length - a.versions.length || a.name.localeCompare(b.name))

  return {
    packages: graph.nodes.size,
    totalBytes: sum(ids),
    truncated: graph.truncated || budget.files <= 0,
    direct,
    duplicates,
  }
}
