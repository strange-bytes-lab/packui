import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildInstallGraph, directDependentsOf, shortestChains } from '../src/server/core/tree.ts'
import { suggestFix } from '../src/server/core/audit.ts'
import { measureWeight } from '../src/server/core/weight.ts'

let dir: string
let home: string
const originalHome = process.env.HOME

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'packui-tree-'))
  home = await mkdtemp(join(tmpdir(), 'packui-tree-home-'))
  process.env.HOME = home
  vi.resetModules()
})

afterEach(async () => {
  process.env.HOME = originalHome
  vi.unstubAllGlobals()
  await rm(dir, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

async function pkg(
  at: string,
  name: string,
  version: string,
  dependencies: Record<string, string> = {},
  extra: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(at, { recursive: true })
  await writeFile(
    join(at, 'package.json'),
    JSON.stringify({ name, version, dependencies, ...extra }),
  )
}

/**
 * npm-style hoisting: `app-lib` needs `util@2` while the hoisted copy is `util@1`, so
 * npm nests `util@2` under it.
 */
async function hoistedLayout(): Promise<void> {
  const modules = join(dir, 'node_modules')
  await pkg(dir, 'project', '1.0.0', { 'app-lib': '^1.0.0', util: '^1.0.0' })
  await pkg(join(modules, 'app-lib'), 'app-lib', '1.0.0', { util: '^2.0.0', leaf: '^1.0.0' })
  await pkg(join(modules, 'app-lib', 'node_modules', 'util'), 'util', '2.0.0')
  await pkg(join(modules, 'util'), 'util', '1.0.0', { leaf: '^1.0.0' })
  await pkg(join(modules, 'leaf'), 'leaf', '1.0.0', {}, { peerDependencies: { util: '*' } })
  await writeFile(join(modules, 'leaf', 'index.js'), 'x'.repeat(1000))
}

/** pnpm-style: every package lives in .pnpm and its dependencies are linked beside it. */
async function pnpmLayout(): Promise<void> {
  const modules = join(dir, 'node_modules')
  const store = join(modules, '.pnpm')
  await pkg(dir, 'project', '1.0.0', { 'app-lib': '^1.0.0' })
  const appLib = join(store, 'app-lib@1.0.0', 'node_modules', 'app-lib')
  await pkg(appLib, 'app-lib', '1.0.0', { leaf: '^1.0.0' })
  const leaf = join(store, 'leaf@1.0.0', 'node_modules', 'leaf')
  await pkg(leaf, 'leaf', '1.0.0')
  await symlink(leaf, join(store, 'app-lib@1.0.0', 'node_modules', 'leaf'), 'dir')
  await symlink(appLib, join(modules, 'app-lib'), 'dir')
}

describe('install graph', () => {
  it('resolves nested copies before hoisted ones, as Node does', async () => {
    await hoistedLayout()
    const graph = await buildInstallGraph(dir, ['app-lib', 'util'])
    const labels = [...graph.nodes.values()].map((node) => `${node.name}@${node.version}`).sort()
    expect(labels).toEqual(['app-lib@1.0.0', 'leaf@1.0.0', 'util@1.0.0', 'util@2.0.0'])

    const appLib = graph.nodes.get(graph.roots.get('app-lib') as string)
    const children = appLib?.dependencies.map((id) => graph.nodes.get(id)?.version)
    expect(children?.sort()).toEqual(['1.0.0', '2.0.0'])
  })

  it('follows pnpm links through their real paths', async () => {
    await pnpmLayout()
    const graph = await buildInstallGraph(dir, ['app-lib'])
    expect([...graph.nodes.values()].map((node) => node.name).sort()).toEqual(['app-lib', 'leaf'])
  })

  it('does not follow peer dependencies, which the parent provides', async () => {
    await hoistedLayout()
    const graph = await buildInstallGraph(dir, ['app-lib'])
    const leaf = [...graph.nodes.values()].find((node) => node.name === 'leaf')
    expect(leaf?.dependencies).toEqual([])
  })

  it('never resolves outside the project boundary', async () => {
    // A node_modules in a parent directory is not part of this project's tree.
    const inner = join(dir, 'inner')
    await pkg(inner, 'inner', '1.0.0', { stray: '*' })
    await pkg(join(dir, 'node_modules', 'stray'), 'stray', '1.0.0')
    const graph = await buildInstallGraph(inner, ['stray'])
    expect(graph.nodes.size).toBe(0)
  })

  it('reports the shortest chain and every direct dependency that reaches a node', async () => {
    await hoistedLayout()
    const graph = await buildInstallGraph(dir, ['app-lib', 'util'])
    const leaf = [...graph.nodes.values()].find((node) => node.name === 'leaf') as { id: string }
    const chain = shortestChains(graph)
      .get(leaf.id)
      ?.map((id) => graph.nodes.get(id)?.name)
    expect(chain).toHaveLength(2)
    expect(chain?.at(-1)).toBe('leaf')
    expect([...(directDependentsOf(graph).get(leaf.id) ?? [])].sort()).toEqual(['app-lib', 'util'])
  })
})

describe('weight', () => {
  it('reports own, total and exclusive size, and duplicate versions', async () => {
    await hoistedLayout()
    const report = await measureWeight(dir, ['app-lib', 'util'], dir)
    const appLib = report.direct.find((entry) => entry.name === 'app-lib')
    // Itself, its nested util@2 and leaf. util@1 belongs to the other root.
    expect(appLib?.packages).toBe(3)
    // leaf is shared with util, so removing app-lib frees only itself and util@2.
    expect(appLib?.exclusive).toBeLessThan(appLib?.withDependencies ?? 0)
    expect(appLib?.withDependencies).toBeGreaterThanOrEqual(1000)
    expect(report.duplicates.map((duplicate) => duplicate.name)).toEqual(['util'])
    expect(report.duplicates[0]?.versions.map((version) => version.version).sort()).toEqual([
      '1.0.0',
      '2.0.0',
    ])
  })
})

describe('indirect advisories', () => {
  it('picks the lowest version past every advisory', () => {
    const advisory = (fixedIn: string[]) => ({
      id: 'x',
      summary: null,
      details: null,
      severity: null,
      fixedIn,
      references: [],
    })
    expect(suggestFix('1.0.0', [advisory(['1.0.5', '2.0.1']), advisory(['1.2.0'])])).toBe('1.2.0')
    expect(suggestFix('1.0.0', [advisory([])])).toBeNull()
  })

  it('finds a vulnerable indirect copy, its chain and the direct dependencies behind it', async () => {
    await hoistedLayout()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/querybatch')) {
          const body = JSON.parse(String(init?.body)) as {
            queries: { package: { name: string }; version: string }[]
          }
          return new Response(
            JSON.stringify({
              results: body.queries.map((query) =>
                query.package.name === 'util' && query.version === '2.0.0'
                  ? { vulns: [{ id: 'GHSA-util' }] }
                  : {},
              ),
            }),
          )
        }
        return new Response(
          JSON.stringify({
            id: 'GHSA-util',
            database_specific: { severity: 'HIGH' },
            affected: [{ ranges: [{ events: [{ introduced: '0' }, { fixed: '2.0.3' }] }] }],
          }),
        )
      }),
    )

    const { auditTree } = await import('../src/server/core/audit.ts')
    const { defaultRegistryConfig } = await import('../src/server/core/npmrc.ts')
    const audit = await auditTree(dir, ['app-lib', 'util'], dir, defaultRegistryConfig())

    // util@1 is direct and not examined here; util@2 is nested under app-lib.
    expect(audit.vulnerable).toHaveLength(1)
    expect(audit.vulnerable[0]).toMatchObject({
      name: 'util',
      version: '2.0.0',
      suggested: '2.0.3',
      chain: ['app-lib@1.0.0', 'util@2.0.0'],
      via: ['app-lib'],
      advisories: { count: 1, worst: 'high' },
    })
    expect(audit.byDirect).toEqual({ 'app-lib': { count: 1, worst: 'high' } })
    expect(audit.unchecked).toBe(0)
  })

  it('counts copies it could not check instead of calling them clean', async () => {
    await hoistedLayout()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    const { auditTree } = await import('../src/server/core/audit.ts')
    const { defaultRegistryConfig } = await import('../src/server/core/npmrc.ts')
    const audit = await auditTree(dir, ['app-lib', 'util'], dir, defaultRegistryConfig())
    expect(audit.vulnerable).toEqual([])
    expect(audit.unchecked).toBe(2)
  })
})
