import { execFile } from 'node:child_process'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { isDirectoryLike, listDirectoryNames } from './fsutil.ts'
import type { DependencyRow, PackageManager } from '../../shared/types.ts'

/**
 * Globally installed packages — the CLIs on your PATH, which nothing audits.
 *
 * Globals have no manifest to compare against: no declared range, no lockfile. What is
 * installed is the whole truth, so alignment is meaningless here. Outdatedness and
 * vulnerabilities still matter, and a global CLI is exactly the thing that sits at a
 * three-year-old version because nobody ever looks at it.
 *
 * Finding them is the hard part, because version managers scatter them:
 *
 * - `npm root -g` answers only for the *currently active* Node version. Under nvm,
 *   fnm, asdf or volta each installed Node version has its own global root, so
 *   packages installed under a version you have since switched away from are still on
 *   disk and still invisible to that command.
 * - volta is worse: `npm root -g` points at volta's Node image, which contains only
 *   npm and corepack. Tools installed with `volta install` live in a completely
 *   separate store, one isolated `lib/node_modules` per tool. On a volta machine,
 *   trusting `npm root -g` reports almost nothing and looks like an empty result
 *   rather than a wrong one — the worst kind of failure for an auditing tool.
 *
 * So packui asks the package managers where their globals are *and* probes the known
 * version-manager layouts, then dedupes by real path.
 */

const run = promisify(execFile)

/** Which tool installed the packages, which decides how they get upgraded. */
export type Installer = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'volta'

/**
 * A directory to scan for globally installed packages.
 *
 * `only` exists because volta's roots are not global roots at all: each is one tool's
 * private `lib/node_modules`, which npm populates flat, so the tool sits in there
 * beside its entire dependency tree. Listing the directory reports dozens of libraries
 * the user never installed. When `only` is set, just that one entry is a global.
 */
export interface GlobalRoot {
  path: string
  only?: string
}

export interface GlobalScope {
  id: string
  label: string
  installer: Installer
  /** The package manager used to mutate packages in this scope. */
  packageManager: PackageManager
  /** Directories to scan. volta contributes one root per installed tool. */
  roots: GlobalRoot[]
  nodeVersion: string | null
  /** True when this scope belongs to the currently active toolchain. */
  active: boolean
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  )
}

/** Follows symlinks: `volta install` of a local path links rather than copies. */
const listDirectories = listDirectoryNames

/* ------------------------------------------------------------------ *
 * Package managers, asked directly
 * ------------------------------------------------------------------ */

const ROOT_COMMANDS: ReadonlyArray<readonly [PackageManager, string, string[]]> = [
  ['npm', 'npm', ['root', '-g']],
  ['pnpm', 'pnpm', ['root', '-g']],
  ['yarn', 'yarn', ['global', 'dir']],
]

async function askForRoot(
  packageManager: PackageManager,
  command: string,
  args: string[],
): Promise<string | null> {
  try {
    const { stdout } = await run(command, args, {
      timeout: 10_000,
      // Never a shell: there is no user input here and no reason to involve one.
      shell: false,
      env: { ...process.env, NO_COLOR: '1' },
    })

    // Some of these print warnings alongside the path, so take the last line that
    // actually looks like one.
    const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    for (const line of lines.reverse()) {
      if (!line.startsWith('/') && !/^[A-Za-z]:\\/.test(line)) continue
      // `yarn global dir` returns the parent of node_modules, unlike `root -g`.
      const candidate = packageManager === 'yarn' ? join(line, 'node_modules') : line
      if (await isDirectory(candidate)) return candidate
    }
    return null
  } catch {
    // Not installed, not configured, or refused. All normal.
    return null
  }
}

/* ------------------------------------------------------------------ *
 * volta
 * ------------------------------------------------------------------ */

/**
 * volta installs each tool into its own isolated tree:
 *   ~/.volta/tools/image/packages/<tool>/lib/node_modules/<tool>
 *   ~/.volta/tools/image/packages/@scope/<tool>/lib/node_modules/@scope/<tool>
 */
async function voltaPackageRoots(): Promise<GlobalRoot[]> {
  const packagesDir = join(homedir(), '.volta', 'tools', 'image', 'packages')
  const roots: GlobalRoot[] = []

  for (const entry of await listDirectories(packagesDir)) {
    if (entry.startsWith('@')) {
      for (const scoped of await listDirectories(join(packagesDir, entry))) {
        const path = join(packagesDir, entry, scoped, 'lib', 'node_modules')
        // The directory owning the tree names the tool; everything else in there is
        // one of its dependencies.
        if (await isDirectory(path)) roots.push({ path, only: `${entry}/${scoped}` })
      }
      continue
    }
    const path = join(packagesDir, entry, 'lib', 'node_modules')
    if (await isDirectory(path)) roots.push({ path, only: entry })
  }

  return roots
}

async function voltaActiveNodeVersion(): Promise<string | null> {
  try {
    const raw = await readFile(
      join(homedir(), '.volta', 'tools', 'user', 'platform.json'),
      'utf8',
    )
    const parsed = JSON.parse(raw) as { node?: { runtime?: unknown } }
    return typeof parsed.node?.runtime === 'string' ? parsed.node.runtime : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Per-version layouts for the other version managers
 * ------------------------------------------------------------------ */

interface VersionedLayout {
  installer: 'npm'
  manager: string
  base: string
  /** Path from the version directory to its global node_modules. */
  suffix: string[]
}

const VERSIONED_LAYOUTS: VersionedLayout[] = [
  { installer: 'npm', manager: 'nvm', base: join(homedir(), '.nvm', 'versions', 'node'), suffix: ['lib', 'node_modules'] },
  { installer: 'npm', manager: 'volta', base: join(homedir(), '.volta', 'tools', 'image', 'node'), suffix: ['lib', 'node_modules'] },
  { installer: 'npm', manager: 'asdf', base: join(homedir(), '.asdf', 'installs', 'nodejs'), suffix: ['lib', 'node_modules'] },
  { installer: 'npm', manager: 'fnm', base: join(homedir(), '.local', 'share', 'fnm', 'node-versions'), suffix: ['installation', 'lib', 'node_modules'] },
  { installer: 'npm', manager: 'fnm', base: join(homedir(), 'Library', 'Application Support', 'fnm', 'node-versions'), suffix: ['installation', 'lib', 'node_modules'] },
]

/** Fixed locations used by n, Homebrew and system installs. */
const FIXED_ROOTS: ReadonlyArray<readonly [string, string]> = [
  ['n', join(homedir(), 'n', 'lib', 'node_modules')],
  ['homebrew', '/opt/homebrew/lib/node_modules'],
  ['system', '/usr/local/lib/node_modules'],
  ['system', '/usr/lib/node_modules'],
]

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

let cached: GlobalScope[] | null = null

/** Cached for the process lifetime: this spawns subprocesses and walks the disk. */
export async function detectGlobalScopes(): Promise<GlobalScope[]> {
  if (cached !== null) return cached

  const scopes: GlobalScope[] = []
  const activeNode = process.versions.node

  // 1. volta's own package store, which npm root -g never reveals.
  const voltaRoots = await voltaPackageRoots()
  if (voltaRoots.length > 0) {
    scopes.push({
      id: 'volta',
      label: 'volta tools',
      installer: 'volta',
      packageManager: 'npm',
      roots: voltaRoots,
      nodeVersion: await voltaActiveNodeVersion(),
      active: true,
    })
  }

  // 2. Whatever the active package managers report.
  for (const [packageManager, command, args] of ROOT_COMMANDS) {
    const root = await askForRoot(packageManager, command, args)
    if (root === null) continue
    scopes.push({
      id: packageManager,
      label: `${packageManager} global`,
      installer: packageManager,
      packageManager,
      roots: [{ path: root }],
      nodeVersion: packageManager === 'npm' ? activeNode : null,
      active: true,
    })
  }

  // 3. bun has a fixed location and no command that prints it.
  const bunRoot = join(homedir(), '.bun', 'install', 'global', 'node_modules')
  if (await isDirectory(bunRoot)) {
    scopes.push({
      id: 'bun',
      label: 'bun global',
      installer: 'bun',
      packageManager: 'bun',
      roots: [{ path: bunRoot }],
      nodeVersion: null,
      active: true,
    })
  }

  // 4. Every other installed Node version, so globals stranded on a version you
  //    have switched away from are visible rather than silently missing.
  for (const layout of VERSIONED_LAYOUTS) {
    for (const version of await listDirectories(layout.base)) {
      const root = join(layout.base, version, ...layout.suffix)
      if (!(await isDirectory(root))) continue

      const normalized = version.replace(/^v/, '')
      scopes.push({
        id: `${layout.manager}:${normalized}`,
        label: `${layout.manager} · node ${normalized}`,
        installer: 'npm',
        packageManager: 'npm',
        roots: [{ path: root }],
        nodeVersion: normalized,
        active: normalized === activeNode,
      })
    }
  }

  // 5. Fixed system locations.
  for (const [manager, root] of FIXED_ROOTS) {
    if (!(await isDirectory(root))) continue
    scopes.push({
      id: `${manager}:${root}`,
      label: `${manager} global`,
      installer: 'npm',
      packageManager: 'npm',
      roots: [{ path: root }],
      nodeVersion: null,
      active: false,
    })
  }

  cached = await dedupe(scopes)
  return cached
}

/**
 * Version managers and package managers routinely point at the same directory —
 * `npm root -g` under volta resolves to the same place as the volta node-version
 * layout. Dedupe on real paths so a scope is not listed twice under two names.
 */
async function dedupe(scopes: GlobalScope[]): Promise<GlobalScope[]> {
  const seen = new Set<string>()
  const result: GlobalScope[] = []

  for (const scope of scopes) {
    const resolved = await Promise.all(
      scope.roots.map(async (root) => ({
        ...root,
        path: await realpath(root.path).catch(() => root.path),
      })),
    )
    const key = resolved
      .map((root) => root.path)
      .sort()
      .join('|')
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ ...scope, roots: resolved })
  }

  // Active scopes first, then alphabetically, so the useful ones lead.
  return result.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    return a.label.localeCompare(b.label)
  })
}

/** Ships with the toolchain rather than being something the user chose to install. */
const BUILTIN = new Set(['npm', 'corepack'])

async function readPackage(dir: string, name: string): Promise<DependencyRow | null> {
  try {
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
      version?: unknown
    }
    if (typeof manifest.version !== 'string') return null

    return {
      name,
      kind: 'prod',
      // A global has no declared range. Showing the installed version keeps the
      // column honest rather than blank.
      declared: manifest.version,
      installed: manifest.version,
      latest: null,
      outdated: 'unknown',
      // Nothing to be out of sync with, so this is aligned by definition.
      alignment: 'aligned',
      deprecated: null,
      vulnerabilities: null,
    }
  } catch {
    return null
  }
}

async function readRoot(root: GlobalRoot): Promise<DependencyRow[]> {
  // A root that names its own package is a private tree, not a global root: read the
  // one package and ignore the dependencies sitting next to it.
  if (root.only !== undefined) {
    const row = await readPackage(join(root.path, ...root.only.split('/')), root.only)
    return row === null ? [] : [row]
  }

  const rows: DependencyRow[] = []
  const entries = await readdir(root.path, { withFileTypes: true }).catch(() => [])

  for (const entry of entries) {
    if (!isDirectoryLike(entry) || entry.name.startsWith('.') || entry.name === '.bin') continue

    if (entry.name.startsWith('@')) {
      for (const inner of await listDirectories(join(root.path, entry.name))) {
        const name = `${entry.name}/${inner}`
        const row = await readPackage(join(root.path, entry.name, inner), name)
        if (row !== null) rows.push(row)
      }
      continue
    }

    if (BUILTIN.has(entry.name)) continue
    const row = await readPackage(join(root.path, entry.name), entry.name)
    if (row !== null) rows.push(row)
  }

  return rows
}

export async function listGlobalPackages(scope: GlobalScope): Promise<DependencyRow[]> {
  const perRoot = await Promise.all(scope.roots.map(readRoot))

  // A volta scope spans many roots and the same tool can be reachable from more than
  // one of them, so keep the first occurrence of each name.
  const byName = new Map<string, DependencyRow>()
  for (const rows of perRoot) {
    for (const row of rows) {
      if (!byName.has(row.name)) byName.set(row.name, row)
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Only for tests; detection is cached for the process lifetime otherwise. */
export function resetGlobalScopeCache(): void {
  cached = null
}
