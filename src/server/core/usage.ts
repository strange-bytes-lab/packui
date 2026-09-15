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
const SOURCE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.mts', '.cts', '.tsx',
  '.vue', '.svelte', '.astro',
])

/** Directories that are generated, vendored, or irrelevant to what the project imports. */
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

async function* walk(current: string, budget: { left: number }): AsyncGenerator<string> {
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
      yield* walk(full, budget)
      continue
    }

    if (!entry.isFile()) continue
    const dot = entry.name.lastIndexOf('.')
    if (dot === -1 || !SOURCE_EXTENSIONS.has(entry.name.slice(dot))) continue

    budget.left -= 1
    yield full
  }
}

export async function findUsages(
  projectPath: string,
  packageName: string,
): Promise<UsageReport> {
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
export async function findDependents(
  projectPath: string,
  packageName: string,
): Promise<string[]> {
  const modulesRoot = join(projectPath, 'node_modules')
  const dependents: string[] = []

  async function inspect(dir: string, name: string): Promise<void> {
    try {
      const manifest = JSON.parse(
        await readFile(join(dir, 'package.json'), 'utf8'),
      ) as {
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
