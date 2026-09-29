import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/**
 * Reads what is actually on disk rather than what a lockfile claims.
 *
 * `node_modules/<pkg>/package.json` carries the resolved version under every package
 * manager, which is what makes this the one PM-agnostic source of truth. The
 * alternative — parsing lockfiles — means four incompatible formats, one of which
 * (`bun.lockb`) is binary and one of which (`pnpm-lock.yaml`) would require shipping
 * a YAML parser.
 *
 * pnpm's symlinked layout is handled for free: `readFile` follows symlinks.
 */

/**
 * The directories whose node_modules can satisfy an import from `projectPath`, nearest
 * first. That is just `projectPath` for a standalone project. In a workspace it runs up
 * to the root, because every package manager hoists shared dependencies there and a
 * package's own node_modules holds only what could not be hoisted.
 */
export function lookupDirectories(projectPath: string, stopAt: string = projectPath): string[] {
  const directories: string[] = []
  let current = resolve(projectPath)
  const limit = resolve(stopAt)
  for (;;) {
    directories.push(current)
    if (current === limit) return directories
    const parent = dirname(current)
    // stopAt is not an ancestor: resolve against the project alone.
    if (parent === current) return [resolve(projectPath)]
    current = parent
  }
}

/** Where `packageName` is installed for `projectPath`, or null. See lookupDirectories. */
export async function resolvePackageDir(
  projectPath: string,
  packageName: string,
  stopAt?: string,
): Promise<string | null> {
  for (const directory of lookupDirectories(projectPath, stopAt)) {
    const candidate = join(directory, 'node_modules', packageName)
    const info = await stat(join(candidate, 'package.json')).catch(() => null)
    if (info !== null) return candidate
  }
  return null
}

export async function readInstalledVersion(
  projectPath: string,
  packageName: string,
  stopAt?: string,
): Promise<string | null> {
  const dir = await resolvePackageDir(projectPath, packageName, stopAt)
  if (dir === null) return null
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
      version?: unknown
    }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

export async function readInstalledVersions(
  projectPath: string,
  packageNames: readonly string[],
  stopAt?: string,
): Promise<Map<string, string | null>> {
  const entries = await Promise.all(
    packageNames.map(
      async (name) => [name, await readInstalledVersion(projectPath, name, stopAt)] as const,
    ),
  )
  return new Map(entries)
}
