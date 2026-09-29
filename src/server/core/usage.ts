import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { isDirectoryLike } from './fsutil.ts'

/**
 * Finds where a package is actually used before packui offers to remove it.
 *
 * Removing a dependency is the one action here that silently breaks a project at
 * runtime rather than at install time: the install succeeds, the lockfile updates,
 * and the failure shows up later in whatever imports it. Answering "what currently
 * imports this?" is the difference between an informed removal and a surprise.
 */

/** Source files worth scanning. Anything else cannot contain a JS import. */
// prettier-ignore
const SOURCE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.mts', '.cts', '.tsx',
  '.vue', '.svelte', '.astro',
])

/** Directories that are generated, vendored, or irrelevant to what the project imports. */
// prettier-ignore
const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.output', '.svelte-kit', '.turbo', '.cache', 'vendor',
])

/** Bounds on a scan, so a huge monorepo cannot stall a request. */
const MAX_FILES = 4000
const MAX_FILE_BYTES = 1024 * 1024

export interface Usage {
  /** Path relative to the project root. */
  file: string
  line: number
  snippet: string
}

export interface UsageReport {
  usages: Usage[]
  filesScanned: number
  /** True when the scan hit its limit, so "no usages" is not a guarantee. */
  truncated: boolean
}

/**
 * Matches the package as an import target, including subpath imports such as
 * `lodash/merge`. The name is escaped because package names may contain regex
 * metacharacters — `lodash.merge` and scoped names both do.
 */
function buildMatcher(packageName: string): RegExp {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const target = `${escaped}(?:/[^'"\`]*)?`
  return new RegExp(
    [
      // import x from 'pkg'  /  import 'pkg'  /  export … from 'pkg'
      `(?:import|export)\\s[^;]*?['"\`]${target}['"\`]`,
      `import\\s*\\(\\s*['"\`]${target}['"\`]`,
      `require\\s*\\(\\s*['"\`]${target}['"\`]`,
      // Vue SFC and bundler-style references
      `from\\s+['"\`]${target}['"\`]`,
    ].join('|'),
    'm',
  )
}

async function* walk(
  current: string,
  budget: { left: number },
  exclude: ReadonlySet<string> = new Set(),
): AsyncGenerator<string> {
  if (budget.left <= 0) return

  let entries
  try {
    entries = await readdir(current, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (budget.left <= 0) return
    const full = join(current, entry.name)

    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue
      if (exclude.has(full)) continue
      yield* walk(full, budget, exclude)
      continue
    }

    if (!entry.isFile()) continue
    const dot = entry.name.lastIndexOf('.')
    if (dot === -1 || !SOURCE_EXTENSIONS.has(entry.name.slice(dot))) continue

    budget.left -= 1
    yield full
  }
}

export async function findUsages(projectPath: string, packageName: string): Promise<UsageReport> {
  const matcher = buildMatcher(packageName)
  const usages: Usage[] = []
  const budget = { left: MAX_FILES }
  let filesScanned = 0

  for await (const file of walk(projectPath, budget)) {
    filesScanned += 1

    try {
      const info = await stat(file)
      if (info.size > MAX_FILE_BYTES) continue

      const contents = await readFile(file, 'utf8')
      // Cheap substring check first; the regex only runs on plausible files.
      if (!contents.includes(packageName)) continue

      const lines = contents.split(/\r?\n/)
      lines.forEach((line, index) => {
        if (!matcher.test(line)) return
        usages.push({
          file: relative(projectPath, file),
          line: index + 1,
          snippet: line.trim().slice(0, 200),
        })
      })
    } catch {
      // An unreadable file is not a reason to fail the whole scan.
    }
  }

  return { usages, filesScanned, truncated: budget.left <= 0 }
}

/**
 * Installed packages that declare this one as a dependency.
 *
 * Removing something another package depends on leaves that package with an
 * unmet dependency, which npm and pnpm report but yarn and bun can be quieter about.
 */
export async function findDependents(projectPath: string, packageName: string): Promise<string[]> {
  const modulesRoot = join(projectPath, 'node_modules')
  const dependents: string[] = []

  async function inspect(dir: string, name: string): Promise<void> {
    try {
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
        optionalDependencies?: Record<string, string>
      }

      const declares =
        manifest.dependencies?.[packageName] !== undefined ||
        manifest.peerDependencies?.[packageName] !== undefined ||
        manifest.optionalDependencies?.[packageName] !== undefined

      if (declares) dependents.push(name)
    } catch {
      // Not a package directory, or an unreadable manifest.
    }
  }

  let entries
  try {
    entries = await readdir(modulesRoot, { withFileTypes: true })
  } catch {
    return []
  }

  for (const entry of entries) {
    // Symlinks count: pnpm links every top-level package, so filtering them out
    // would report zero dependents for every pnpm project.
    if (!isDirectoryLike(entry) || entry.name === '.bin') continue

    // Scoped packages nest one level deeper.
    if (entry.name.startsWith('@')) {
      try {
        const scoped = await readdir(join(modulesRoot, entry.name), { withFileTypes: true })
        for (const inner of scoped) {
          if (!isDirectoryLike(inner)) continue
          await inspect(join(modulesRoot, entry.name, inner.name), `${entry.name}/${inner.name}`)
        }
      } catch {
        // Unreadable scope directory.
      }
      continue
    }

    if (entry.name.startsWith('.')) continue
    await inspect(join(modulesRoot, entry.name), entry.name)
  }

  return dependents.filter((name) => name !== packageName).sort()
}

/* ------------------------------------------------------------------ *
 * Every import, for the unused / undeclared view
 * ------------------------------------------------------------------ */

/** Every static or dynamic import target on a line. Global, so one line can hold several. */
const IMPORT_TARGET =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire(?:\.resolve)?\s*\(\s*|\bexport\s[^'"`;]*?from\s*)['"`]([^'"`\s]+)['"`]/g

/**
 * `// @vitest-environment jsdom` and `@jest-environment` load a package by name without
 * importing it. Jest also accepts the short form of `jest-environment-<name>`.
 */
const ENVIRONMENT_PRAGMA = /@(vitest|jest)-environment\s+([\w@/.-]+)/

function pragmaTargets(line: string): string[] {
  const match = ENVIRONMENT_PRAGMA.exec(line)
  if (match?.[2] === undefined) return []
  return match[1] === 'jest' ? [match[2], `jest-environment-${match[2]}`] : [match[2]]
}

/**
 * The package a bare specifier names, or null for anything that is not one: relative
 * and absolute paths, `node:` and other protocols, subpath imports (`#internal`), and
 * the `@/` and `~/` aliases bundlers conventionally map to the source tree.
 */
export function packageNameOf(specifier: string): string | null {
  if (/^[./#~]/.test(specifier) || specifier.startsWith('@/')) return null
  if (specifier.includes(':')) return null
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) {
    return parts.length >= 2 && parts[0] !== '@' ? `${parts[0]}/${parts[1]}` : null
  }
  return parts[0] ?? null
}

export interface ImportScan {
  /** Package name to the places it is imported. */
  imports: Map<string, Usage[]>
  /** Packages loaded by name without an import, such as a test-environment pragma. */
  loaded: Set<string>
  filesScanned: number
  truncated: boolean
}

/**
 * Collects every package imported anywhere under `projectPath`. `exclude` holds
 * directories to skip — a workspace root passes its member packages, whose imports are
 * theirs to declare, not the root's.
 */
export async function scanImports(
  projectPath: string,
  exclude: ReadonlySet<string> = new Set(),
): Promise<ImportScan> {
  const imports = new Map<string, Usage[]>()
  const loaded = new Set<string>()
  const budget = { left: MAX_FILES }
  let filesScanned = 0

  for await (const file of walk(projectPath, budget, exclude)) {
    filesScanned += 1
    try {
      const info = await stat(file)
      if (info.size > MAX_FILE_BYTES) continue
      const lines = (await readFile(file, 'utf8')).split(/\r?\n/)
      lines.forEach((line, index) => {
        // A pragma proves a package is used, but its short jest form names no real
        // package, so it never counts toward "undeclared".
        for (const target of pragmaTargets(line)) loaded.add(target)
        for (const match of line.matchAll(IMPORT_TARGET)) {
          const target = match[1] ?? ''
          const name = packageNameOf(target)
          if (name === null) continue
          const list = imports.get(name) ?? []
          list.push({
            file: relative(projectPath, file),
            line: index + 1,
            snippet: line.trim().slice(0, 200),
          })
          imports.set(name, list)
        }
      })
    } catch {
      // An unreadable file is not a reason to fail the whole scan.
    }
  }

  return { imports, loaded, filesScanned, truncated: budget.left <= 0 }
}
