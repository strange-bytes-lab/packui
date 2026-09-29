import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { mapWithConcurrency } from './cache.ts'
import { lookupDirectories } from './installed.ts'

/**
 * The installed dependency graph, read from node_modules the way Node itself resolves
 * imports — so it works for every layout without parsing a lockfile:
 *
 * - npm, yarn classic and bun hoist, and nest only what conflicts; walking upward from
 *   a package finds its nested copy first and the hoisted one after.
 * - pnpm keeps each package at `.pnpm/<name>@<version>/node_modules/<name>` with its
 *   dependencies linked beside it. Resolving from the package's *real* path finds
 *   those siblings, which is why every node is identified by realpath.
 *
 * Direct dependencies are the roots. Each node records the nodes its dependencies and
 * optional dependencies resolved to; one that resolves to nothing (an optional one
 * that was not installed) is simply absent.
 */

export interface InstallNode {
  /** Real path of the package directory. Unique per installed copy. */
  id: string
  name: string
  version: string
  dependencies: string[]
}

export interface InstallGraph {
  nodes: Map<string, InstallNode>
  /** Direct dependency name to the node it resolved to. */
  roots: Map<string, string>
  /** True when the walk hit MAX_NODES, so the graph is a prefix, not the whole tree. */
  truncated: boolean
}

/** Far beyond any real project; only here so a pathological tree cannot stall a request. */
const MAX_NODES = 25_000

interface Manifest {
  name?: unknown
  version?: unknown
  dependencies?: unknown
  optionalDependencies?: unknown
}

function names(record: unknown): string[] {
  return typeof record === 'object' && record !== null ? Object.keys(record) : []
}

/**
 * Walks upward from `from` looking for `node_modules/<name>`, as Node does. Inside the
 * project it stops at `stopAt`, so a stray node_modules in a parent directory is never
 * mistaken for part of this tree. A package whose real path is outside the project (a
 * pnpm store configured elsewhere, a linked package) resolves up to the filesystem root.
 */
async function resolveFrom(from: string, name: string, stopAt: string): Promise<string | null> {
  const inside = from === stopAt || from.startsWith(stopAt + sep)
  let current = from
  for (let depth = 0; depth < 64; depth += 1) {
    if (basename(current) !== 'node_modules') {
      const candidate = join(current, 'node_modules', name)
      const info = await lstat(join(candidate, 'package.json')).catch(() => null)
      if (info !== null) return candidate
    }
    if (inside && current === stopAt) return null
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
  return null
}

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Manifest
  } catch {
    return null
  }
}

export async function buildInstallGraph(
  projectPath: string,
  directNames: readonly string[],
  stopAt: string = projectPath,
): Promise<InstallGraph> {
  // Real, because node ids are real paths and the boundary check compares against them.
  const root = await realpath(resolve(stopAt)).catch(() => resolve(stopAt))
  const nodes = new Map<string, InstallNode>()
  const roots = new Map<string, string>()
  const queue: string[] = []

  async function visit(dir: string): Promise<string | null> {
    const id = await realpath(dir).catch(() => null)
    if (id === null) return null
    if (nodes.has(id)) return id
    if (nodes.size >= MAX_NODES) return null
    const manifest = await readManifest(id)
    if (manifest === null || typeof manifest.version !== 'string') return null
    nodes.set(id, {
      id,
      name: typeof manifest.name === 'string' ? manifest.name : basename(id),
      version: manifest.version,
      dependencies: [],
    })
    queue.push(id)
    return id
  }

  // Direct dependencies resolve like the project's own imports: from the project up to
  // the workspace root.
  for (const name of directNames) {
    for (const directory of lookupDirectories(projectPath, stopAt)) {
      const candidate = join(directory, 'node_modules', name)
      const id = await visit(candidate)
      if (id !== null) {
        roots.set(name, id)
        break
      }
    }
  }

  while (queue.length > 0) {
    const batch = queue.splice(0, queue.length)
    await mapWithConcurrency(batch, 16, async (id) => {
      const node = nodes.get(id)
      const manifest = await readManifest(id)
      if (node === undefined || manifest === null) return
      // Peers are deliberately not edges: the parent provides them, so following them
      // would make a Vite plugin "pull in" all of Vite, weigh it, and blame it for
      // Vite's advisories.
      const wanted = new Set([
        ...names(manifest.dependencies),
        ...names(manifest.optionalDependencies),
      ])
      for (const name of wanted) {
        const dir = await resolveFrom(id, name, root)
        if (dir === null) continue
        const child = await visit(dir)
        if (child !== null && child !== id) node.dependencies.push(child)
      }
    })
  }

  return { nodes, roots, truncated: nodes.size >= MAX_NODES }
}

/** Every node reachable from `start`, including itself. */
export function reachableFrom(graph: InstallGraph, start: string): Set<string> {
  const seen = new Set<string>([start])
  const stack = [start]
  while (stack.length > 0) {
    const node = graph.nodes.get(stack.pop() as string)
    for (const child of node?.dependencies ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      stack.push(child)
    }
  }
  return seen
}

/**
 * The shortest chain from any direct dependency to each node, as node ids. Multi-source
 * breadth-first, so a package reachable several ways reports its most direct route —
 * which is the one worth upgrading.
 */
export function shortestChains(graph: InstallGraph): Map<string, string[]> {
  const parent = new Map<string, string | null>()
  const queue: string[] = []
  for (const id of graph.roots.values()) {
    if (parent.has(id)) continue
    parent.set(id, null)
    queue.push(id)
  }
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index] as string
    for (const child of graph.nodes.get(id)?.dependencies ?? []) {
      if (parent.has(child)) continue
      parent.set(child, id)
      queue.push(child)
    }
  }

  const chains = new Map<string, string[]>()
  for (const id of parent.keys()) {
    const chain: string[] = []
    let cursor: string | null | undefined = id
    while (cursor !== null && cursor !== undefined) {
      chain.unshift(cursor)
      cursor = parent.get(cursor)
    }
    chains.set(id, chain)
  }
  return chains
}

/** For each node, the direct dependencies that pull it in. */
export function directDependentsOf(graph: InstallGraph): Map<string, Set<string>> {
  const via = new Map<string, Set<string>>()
  for (const [name, id] of graph.roots) {
    for (const reached of reachableFrom(graph, id)) {
      const set = via.get(reached) ?? new Set<string>()
      set.add(name)
      via.set(reached, set)
    }
  }
  return via
}

/**
 * Bytes on disk for one package, excluding its nested node_modules (those are nodes of
 * their own) and not following symlinks (a link is someone else's bytes).
 */
export async function packageSize(dir: string, budget = { files: 20_000 }): Promise<number> {
  let total = 0
  async function walk(current: string): Promise<void> {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (budget.files <= 0) return
      const full = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      budget.files -= 1
      const info = await lstat(full).catch(() => null)
      total += info?.size ?? 0
    }
  }
  await walk(dir)
  return total
}

/** A display label for a node, relative to the project for the rare unnamed one. */
export function label(graph: InstallGraph, id: string, projectPath: string): string {
  const node = graph.nodes.get(id)
  return node === undefined ? relative(projectPath, id) : `${node.name}@${node.version}`
}
