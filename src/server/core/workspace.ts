import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { isDirectoryLike } from './fsutil.ts'

/**
 * Monorepo workspaces: npm, yarn and bun declare them in package.json's `workspaces`,
 * pnpm in pnpm-workspace.yaml. Either way there is one root holding the lockfile and
 * (usually) the hoisted node_modules, and many packages each with their own manifest.
 *
 * packui treats each package as a project of its own for reading, but everything that
 * touches the lockfile — the project lock, the snapshot, the drift check, the package
 * manager's working directory — goes through the root. Two packages installing at once
 * would be two processes writing one lockfile.
 */

export interface WorkspacePackage {
  /** Absolute path to the package directory. */
  path: string
  /** POSIX path relative to the root, `.` for the root itself. The lockfile importer key. */
  relative: string
  name: string
}

export interface Workspace {
  root: string
  packages: WorkspacePackage[]
}

/** A pattern like `packages/**` in a large repo must not walk forever. */
const MAX_PACKAGES = 500
const SKIP = new Set(['node_modules', '.git'])

export function toPosix(path: string): string {
  return path.split(sep).join('/')
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** The `packages:` list of pnpm-workspace.yaml — a flat list of quoted or bare globs. */
export function readPnpmWorkspacePatterns(text: string): string[] {
  const patterns: string[] = []
  let inPackages = false
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inPackages = /^packages\s*:/.test(line)
      continue
    }
    if (!inPackages) continue
    const item = /^\s+-\s*(.+?)\s*(#.*)?$/.exec(line)
    if (item?.[1] === undefined) continue
    patterns.push(item[1].replace(/^(['"])(.*)\1$/, '$2'))
  }
  return patterns
}

/** Workspace globs declared at `root`, or null when it declares none. */
export async function readWorkspacePatterns(root: string): Promise<string[] | null> {
  try {
    const text = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8')
    // pnpm 10 keeps settings in this file too, so its presence alone means nothing:
    // a single project with `onlyBuiltDependencies` is not a workspace.
    const patterns = readPnpmWorkspacePatterns(text)
    if (patterns.length > 0) return patterns
  } catch {
    // Not a pnpm workspace; fall through to package.json.
  }

  const manifest = await readJson(join(root, 'package.json'))
  const declared = manifest?.workspaces
  // Both `["packages/*"]` and yarn's `{ packages: ["packages/*"], nohoist: [...] }`.
  const list = Array.isArray(declared)
    ? declared
    : typeof declared === 'object' && declared !== null
      ? (declared as { packages?: unknown }).packages
      : undefined
  if (!Array.isArray(list)) return null
  return list.filter((entry): entry is string => typeof entry === 'string')
}

/** One glob segment: `*` and `?` within a directory name. */
function segmentMatcher(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`)
}

async function listDirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries
      .filter(
        (entry) => isDirectoryLike(entry) && !SKIP.has(entry.name) && !entry.name.startsWith('.'),
      )
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * Expands workspace globs to directories. Supports what workspace configs use in
 * practice — literal paths, `*` within a segment, `**` across segments, and `!`
 * exclusions — and deliberately nothing that would need a glob library.
 */
export async function expandWorkspacePatterns(
  root: string,
  patterns: readonly string[],
): Promise<string[]> {
  const found = new Set<string>()
  const excluded: RegExp[] = []

  async function walk(dir: string, segments: readonly string[]): Promise<void> {
    if (found.size >= MAX_PACKAGES) return
    if (segments.length === 0) {
      found.add(dir)
      return
    }
    const [head, ...rest] = segments as [string, ...string[]]
    if (head === '**') {
      await walk(dir, rest)
      for (const child of await listDirs(dir)) await walk(join(dir, child), segments)
      return
    }
    if (!/[*?]/.test(head)) {
      await walk(join(dir, head), rest)
      return
    }
    const matcher = segmentMatcher(head)
    for (const child of await listDirs(dir)) {
      if (matcher.test(child)) await walk(join(dir, child), rest)
    }
  }

  for (const raw of patterns) {
    const pattern = raw.trim().replace(/^\.\//, '').replace(/\/+$/, '')
    if (pattern.startsWith('!')) {
      const body = pattern.slice(1).replace(/^\.\//, '')
      const regex = body
        .split('/')
        .map((segment) => (segment === '**' ? '.*' : segmentMatcher(segment).source.slice(1, -1)))
        .join('/')
      excluded.push(new RegExp(`^${regex}$`))
      continue
    }
    // Never outside the root: a `../elsewhere` workspace is not ours to read.
    if (pattern === '' || pattern.split('/').includes('..')) continue
    await walk(root, pattern.split('/'))
  }

  const result: string[] = []
  for (const dir of found) {
    const rel = toPosix(relative(root, dir))
    if (excluded.some((regex) => regex.test(rel))) continue
    const info = await stat(join(dir, 'package.json')).catch(() => null)
    if (info?.isFile()) result.push(dir)
  }
  return result.sort()
}

async function describe(root: string, dir: string): Promise<WorkspacePackage> {
  const manifest = await readJson(join(dir, 'package.json'))
  const rel = toPosix(relative(root, dir)) || '.'
  return {
    path: dir,
    relative: rel,
    name: typeof manifest?.name === 'string' ? manifest.name : rel,
  }
}

/** The workspace rooted exactly at `root`, or null if it declares none. */
export async function readWorkspace(root: string): Promise<Workspace | null> {
  const patterns = await readWorkspacePatterns(root)
  if (patterns === null) return null
  const dirs = await expandWorkspacePatterns(root, patterns)
  const members = await Promise.all(
    dirs.filter((dir) => dir !== root).map((dir) => describe(root, dir)),
  )
  // Declared but empty — `packages/*` before the first package exists — is a single project.
  if (members.length === 0) return null
  return { root, packages: [await describe(root, root), ...members] }
}

/**
 * The workspace `projectPath` belongs to, found by walking upward — so packui works
 * the same whether it is launched at the root or inside one package. A parent that
 * declares workspaces but does not list this directory is not its workspace.
 */
export async function findWorkspace(projectPath: string): Promise<Workspace | null> {
  const key = resolve(projectPath)
  const hit = memo.get(key)
  if (hit !== undefined && Date.now() - hit.at < MEMO_MS) return hit.value
  const value = await searchUpward(key)
  memo.set(key, { at: Date.now(), value })
  return value
}

/**
 * Every report asks, and the answer changes only when someone adds a package. A few
 * seconds is long enough to make a page load cheap and short enough that a new
 * package shows up on the next refresh.
 */
const MEMO_MS = 5000
const memo = new Map<string, { at: number; value: Workspace | null }>()

async function searchUpward(projectPath: string): Promise<Workspace | null> {
  let current = projectPath
  for (;;) {
    const workspace = await readWorkspace(current)
    if (
      workspace !== null &&
      workspace.packages.some((member) => member.path === resolve(projectPath))
    ) {
      return workspace
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** The same dependency declared with different ranges in different packages. */
export interface RangeMismatch {
  name: string
  declarations: { package: string; relative: string; range: string; field: string }[]
}

const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

/**
 * Dependencies whose declared range differs between packages. Local protocols
 * (`workspace:`, `link:`, `file:`, `portal:`) point at siblings rather than a version,
 * so they never count as a mismatch.
 */
export async function findRangeMismatches(workspace: Workspace): Promise<RangeMismatch[]> {
  const byName = new Map<string, RangeMismatch['declarations']>()
  for (const member of workspace.packages) {
    const manifest = await readJson(join(member.path, 'package.json'))
    if (manifest === null) continue
    for (const field of FIELDS) {
      const record = manifest[field]
      if (typeof record !== 'object' || record === null) continue
      for (const [name, range] of Object.entries(record as Record<string, unknown>)) {
        if (typeof range !== 'string' || /^(workspace|link|file|portal):/.test(range)) continue
        const list = byName.get(name) ?? []
        list.push({ package: member.name, relative: member.relative, range, field })
        byName.set(name, list)
      }
    }
  }

  return [...byName.entries()]
    .filter(([, declarations]) => new Set(declarations.map((entry) => entry.range)).size > 1)
    .map(([name, declarations]) => ({ name, declarations }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
