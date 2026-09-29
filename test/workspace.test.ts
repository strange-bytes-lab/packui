import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBatchCommands, buildCommand } from '../src/server/core/commands.ts'
import { lookupDirectories } from '../src/server/core/installed.ts'
import { buildReport } from '../src/server/core/report.ts'
import {
  expandWorkspacePatterns,
  findRangeMismatches,
  findWorkspace,
  readPnpmWorkspacePatterns,
  readWorkspace,
} from '../src/server/core/workspace.ts'
import { startServer, type RunningServer } from '../src/server/index.ts'
import { sessionToken } from '../src/server/security.ts'
import type { DependencyReport } from '../src/shared/types.ts'

const root = fileURLToPath(new URL('./fixtures/workspace-project', import.meta.url))
const app = join(root, 'packages', 'app')
const util = join(root, 'packages', 'util')

describe('workspace detection', () => {
  it('lists the root first, then every package the globs match', async () => {
    const workspace = await readWorkspace(root)
    expect(workspace?.packages.map((member) => [member.relative, member.name])).toEqual([
      ['.', 'workspace-fixture'],
      ['packages/app', '@fixture/app'],
      ['packages/util', '@fixture/util'],
    ])
  })

  it('finds the workspace from inside one of its packages', async () => {
    const workspace = await findWorkspace(util)
    expect(workspace?.root).toBe(root)
  })

  it('does not adopt a directory the globs do not list', async () => {
    expect(await findWorkspace(join(root, 'ignored', 'pkg'))).toBeNull()
  })

  it('reads the packages list of pnpm-workspace.yaml and nothing else', () => {
    const text = [
      'packages:',
      "  - 'apps/*'",
      '  - "packages/**"  # everything',
      '  - "!**/test/**"',
      'onlyBuiltDependencies:',
      '  - esbuild',
    ].join('\n')
    expect(readPnpmWorkspacePatterns(text)).toEqual(['apps/*', 'packages/**', '!**/test/**'])
  })

  it('treats a pnpm-workspace.yaml holding only settings as a single project', async () => {
    // packui's own repository is exactly this: pnpm 11 keeps allowBuilds there.
    expect(await readWorkspace(fileURLToPath(new URL('..', import.meta.url)))).toBeNull()
  })

  describe('glob expansion', () => {
    let dir: string
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'packui-globs-'))
      for (const path of [
        'apps/web',
        'packages/deep/nested',
        'packages/deep/test/x',
        'tools/cli',
      ]) {
        await mkdir(join(dir, path), { recursive: true })
        await writeFile(join(dir, path, 'package.json'), '{}')
      }
      await mkdir(join(dir, 'packages/node_modules/dep'), { recursive: true })
      await writeFile(join(dir, 'packages/node_modules/dep/package.json'), '{}')
    })
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('handles *, **, literals and exclusions, and never enters node_modules', async () => {
      const found = await expandWorkspacePatterns(dir, [
        'apps/*',
        'packages/**',
        '!**/test/**',
        './tools/cli',
        '../outside',
      ])
      expect(found.map((path) => path.slice(dir.length + 1))).toEqual([
        'apps/web',
        'packages/deep/nested',
        'tools/cli',
      ])
    })
  })
})

describe('workspace reports', () => {
  it('resolves hoisted dependencies from the root and unhoisted ones locally', async () => {
    const report = await buildReport(app)
    const byName = new Map(report.dependencies.map((row) => [row.name, row]))
    expect(byName.get('shared-lib')?.installed).toBe('1.2.0')
    expect(byName.get('only-app')?.installed).toBe('2.0.1')
    expect(report.project.packageManager).toBe('npm')
    expect(report.project.lockfile).toBe('package-lock.json')
    expect(report.project.workspace).toEqual({ root, relative: 'packages/app' })
    expect(report.drift).toEqual([])
  })

  it("checks a package's ranges against its own importer in the root lockfile", async () => {
    const report = await buildReport(util)
    expect(report.drift).toEqual([
      { name: 'shared-lib', field: 'dependencies', declared: '^1.1.0', locked: '^1.0.0' },
    ])
    expect(report.alignment).toBe('stale')
  })

  it('looks up node_modules from the package to the root, and no further', () => {
    expect(lookupDirectories(app, root)).toEqual([app, join(root, 'packages'), root])
    expect(lookupDirectories(root, root)).toEqual([root])
    // A stopAt that is not an ancestor falls back to the project alone.
    expect(lookupDirectories(app, util)).toEqual([app])
  })

  it('finds ranges that differ between packages', async () => {
    const workspace = await readWorkspace(root)
    const mismatches = await findRangeMismatches(workspace!)
    expect(mismatches.map((mismatch) => mismatch.name)).toEqual(['shared-lib'])
    expect(mismatches[0]?.declarations.map((entry) => entry.range).sort()).toEqual([
      '^1.0.0',
      '^1.0.0',
      '^1.1.0',
    ])
  })
})

describe('workspace commands', () => {
  const request = {
    action: 'upgrade' as const,
    name: 'vue',
    version: '3.5.13',
    kind: 'dev' as const,
  }

  it('targets a package with --workspace under npm, from the root', () => {
    const built = buildCommand('npm', request, 'packages/app')
    expect(built.args).toEqual(['install', 'vue@3.5.13', '--save-dev', '--workspace=packages/app'])
    expect(built.cwd).toBeUndefined()
  })

  it.each(['pnpm', 'yarn', 'bun'] as const)('runs %s inside the package directory', (pm) => {
    const built = buildCommand(pm, request, 'packages/app')
    expect(built.cwd).toBe('packages/app')
    expect(built.display.startsWith('cd packages/app && ')).toBe(true)
  })

  it('leaves the root package alone', () => {
    const built = buildCommand('pnpm', request, '.')
    expect(built.cwd).toBeUndefined()
    expect(built.display).toBe('pnpm add vue@3.5.13 -D')
  })

  it('applies to every batch group', () => {
    const commands = buildBatchCommands(
      'npm',
      [request, { ...request, name: 'react', kind: 'prod' }],
      'packages/app',
    )
    expect(commands.every((built) => built.args.at(-1) === '--workspace=packages/app')).toBe(true)
  })
})

describe('workspace snapshots', () => {
  let home: string
  let ws: string
  const originalHome = process.env.HOME

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'packui-home-'))
    ws = await mkdtemp(join(tmpdir(), 'packui-ws-'))
    process.env.HOME = home
    vi.resetModules()
  })

  afterEach(async () => {
    process.env.HOME = originalHome
    await rm(home, { recursive: true, force: true })
    await rm(ws, { recursive: true, force: true })
  })

  it("snapshots the package's manifest with the root's lockfile, and restores both", async () => {
    const { createSnapshot, restoreSnapshot } = await import('../src/server/core/backup.ts')
    const pkg = join(ws, 'packages', 'a')
    await mkdir(pkg, { recursive: true })
    await writeFile(join(pkg, 'package.json'), 'pkg-before')
    await writeFile(join(ws, 'pnpm-lock.yaml'), 'lock-before')

    const snapshot = await createSnapshot(pkg, 'test', ws)
    expect(snapshot.files).toEqual(['package.json', '@root/pnpm-lock.yaml'])

    await writeFile(join(pkg, 'package.json'), 'pkg-after')
    await writeFile(join(ws, 'pnpm-lock.yaml'), 'lock-after')
    await restoreSnapshot(pkg, snapshot.id, ws)

    expect(await readFile(join(pkg, 'package.json'), 'utf8')).toBe('pkg-before')
    expect(await readFile(join(ws, 'pnpm-lock.yaml'), 'utf8')).toBe('lock-before')
  })

  it('refuses to restore into a root other than the one it was taken for', async () => {
    const { createSnapshot, restoreSnapshot } = await import('../src/server/core/backup.ts')
    const pkg = join(ws, 'packages', 'a')
    await mkdir(pkg, { recursive: true })
    await writeFile(join(pkg, 'package.json'), '{}')
    await writeFile(join(ws, 'pnpm-lock.yaml'), 'lock')
    const snapshot = await createSnapshot(pkg, 'test', ws)

    await expect(restoreSnapshot(pkg, snapshot.id, home)).rejects.toThrow(/different workspace/)
  })
})

describe('workspace access', () => {
  let server: RunningServer
  let base: string

  beforeAll(async () => {
    // Launched inside one package: its siblings and the root become readable too.
    server = await startServer({ projectPath: app, port: 0 })
    base = `http://127.0.0.1:${server.port}`
  })

  afterAll(async () => {
    await server.close()
  })

  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: { authorization: `Bearer ${sessionToken}` } })

  it('lists the workspace the launched package belongs to', async () => {
    const response = await get('/api/workspace')
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      workspace: { packages: { relative: string }[] }
      mismatches: { name: string }[]
    }
    expect(body.workspace.packages.map((member) => member.relative)).toEqual([
      '.',
      'packages/app',
      'packages/util',
    ])
    expect(body.mismatches.map((mismatch) => mismatch.name)).toEqual(['shared-lib'])
  })

  it('reads a sibling package and the root', async () => {
    for (const path of [util, root]) {
      const response = await get(`/api/deps?path=${encodeURIComponent(path)}`)
      expect(response.status).toBe(200)
      const report = (await response.json()) as DependencyReport
      expect(report.project.path).toBe(path)
    }
  })

  it('still refuses a directory the workspace does not list', async () => {
    const response = await get(`/api/deps?path=${encodeURIComponent(join(root, 'ignored', 'pkg'))}`)
    expect(response.status).toBe(403)
  })
})
