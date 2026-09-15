import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

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
export async function readInstalledVersion(
  projectPath: string,
  packageName: string,
): Promise<string | null> {
  try {
    const manifestPath = join(projectPath, 'node_modules', packageName, 'package.json')
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

export async function readInstalledVersions(
  projectPath: string,
  packageNames: readonly string[],
): Promise<Map<string, string | null>> {
  const entries = await Promise.all(
    packageNames.map(
      async (name) => [name, await readInstalledVersion(projectPath, name)] as const,
    ),
  )
  return new Map(entries)
}
