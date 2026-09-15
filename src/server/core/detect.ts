import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { PackageManager } from '../../shared/types.ts'

/**
 * Lockfile names, in the order we trust them. A project can end up with more than
 * one (switching package managers leaves the old file behind), so the explicit
 * `packageManager` field wins when present.
 */
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
]

const KNOWN: ReadonlySet<string> = new Set<PackageManager>(['npm', 'pnpm', 'yarn', 'bun'])

export interface DetectionResult {
  packageManager: PackageManager | null
  /** Filename of the lockfile that was found, if any. */
  lockfile: string | null
  hasNodeModules: boolean
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

/** Reads the Corepack-style `packageManager` field, e.g. "pnpm@9.1.0". */
async function readPackageManagerField(projectPath: string): Promise<PackageManager | null> {
  try {
    const raw = await readFile(join(projectPath, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { packageManager?: unknown }
    if (typeof parsed.packageManager !== 'string') return null
    const name = parsed.packageManager.split('@')[0]
    return name !== undefined && KNOWN.has(name) ? (name as PackageManager) : null
  } catch {
    return null
  }
}

export async function detectPackageManager(projectPath: string): Promise<DetectionResult> {
  const found: Array<readonly [string, PackageManager]> = []
  for (const entry of LOCKFILES) {
    if (await exists(join(projectPath, entry[0]))) found.push(entry)
  }

  const declared = await readPackageManagerField(projectPath)
  // Prefer the lockfile that matches the declared manager, so a leftover lockfile
  // from a previous package manager does not send mutations through the wrong CLI.
  const preferred = declared === null ? undefined : found.find(([, pm]) => pm === declared)
  const chosen = preferred ?? found[0]

  return {
    packageManager: declared ?? chosen?.[1] ?? null,
    lockfile: chosen?.[0] ?? null,
    hasNodeModules: await exists(join(projectPath, 'node_modules')),
  }
}
