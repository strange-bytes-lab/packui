import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import semver from 'semver'
import type { AlignmentState } from '../../shared/types.ts'

/**
 * Alignment answers "does what's declared match what's installed?" without parsing
 * any lockfile — see the rationale in core/installed.ts.
 *
 * It catches the desyncs that actually bite: a range edited without reinstalling,
 * a dependency added to package.json but never installed, and a stale lockfile.
 */

/**
 * Ranges semver cannot evaluate — workspace protocols, local paths, git URLs,
 * npm aliases and tags. These are installed by the package manager in ways we
 * cannot verify against a version number, so we never report them as broken.
 */
function isVerifiableRange(range: string): boolean {
  return semver.validRange(range, { loose: true }) !== null
}

export function alignmentForDependency(
  range: string,
  installed: string | null,
  hasNodeModules: boolean,
): AlignmentState {
  if (!hasNodeModules) return 'unknown'
  if (installed === null) return 'missing'
  if (!isVerifiableRange(range)) return 'aligned'
  return semver.satisfies(installed, range, { loose: true, includePrerelease: true })
    ? 'aligned'
    : 'unsatisfied'
}

/**
 * True when package.json has been modified since the lockfile was last written,
 * which usually means someone edited a range and has not installed yet.
 */
export async function isLockfileStale(
  projectPath: string,
  lockfile: string | null,
): Promise<boolean> {
  if (lockfile === null) return false
  try {
    const [manifestStat, lockStat] = await Promise.all([
      stat(join(projectPath, 'package.json')),
      stat(join(projectPath, lockfile)),
    ])
    return manifestStat.mtimeMs > lockStat.mtimeMs
  } catch {
    return false
  }
}

/** Worst-case wins, so the UI can surface a single honest project-level verdict. */
const SEVERITY: Record<AlignmentState, number> = {
  aligned: 0,
  stale: 1,
  unknown: 2,
  unsatisfied: 3,
  missing: 4,
}

export function worstAlignment(states: readonly AlignmentState[]): AlignmentState {
  return states.reduce<AlignmentState>(
    (worst, state) => (SEVERITY[state] > SEVERITY[worst] ? state : worst),
    'aligned',
  )
}
