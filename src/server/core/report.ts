import { homedir } from 'node:os'
import { basename } from 'node:path'
import semver from 'semver'
import type {
  AlignmentState,
  DependencyReport,
  DependencyRow,
  OutdatedSeverity,
} from '../../shared/types.ts'
import { projectContext } from './context.ts'
import { detectPackageManager } from './detect.ts'
import { readInstalledVersions } from './installed.ts'
import { findLockfileDrift } from './lockdrift.ts'
import { alignmentForDependency, worstAlignment } from './lockfile.ts'
import { readManifest } from './manifest.ts'

/** Collapses the home directory to `~` so long paths stay readable in the sidebar. */
function toDisplayPath(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/**
 * How far behind the installed version is. Null `latest` means enrichment has not
 * run yet (or the registry lookup failed), which is reported as 'unknown' rather
 * than being quietly rendered as up to date.
 */
export function outdatedSeverity(
  installed: string | null,
  latest: string | null,
): OutdatedSeverity {
  if (installed === null || latest === null) return 'unknown'

  // Coercion is a fallback for odd installed versions, not the default path: it drops
  // the prerelease tag, which would make 3.0.0-beta.1 look identical to 3.0.0.
  const current =
    semver.valid(installed, { loose: true }) ?? semver.coerce(installed, { loose: true })
  const target = semver.valid(latest, { loose: true })
  if (current === null || target === null) return 'unknown'
  if (semver.gte(current, target)) return 'current'

  const difference = semver.diff(current, target)
  switch (difference) {
    case 'major':
    case 'premajor':
      return 'major'
    case 'minor':
    case 'preminor':
      return 'minor'
    case 'patch':
    case 'prepatch':
    case 'prerelease':
      return 'patch'
    default:
      return 'current'
  }
}

/**
 * Builds the dependency table from local state only — no network. The UI renders
 * this immediately and fills in latest versions and vulnerabilities as they arrive.
 */
export async function buildReport(projectPath: string): Promise<DependencyReport> {
  const context = await projectContext(projectPath)
  const [manifest, detection] = await Promise.all([
    readManifest(projectPath),
    // A workspace package has no lockfile of its own; the root's is the one that counts.
    detectPackageManager(context.root),
  ])

  const installed = await readInstalledVersions(
    projectPath,
    manifest.dependencies.map((dependency) => dependency.name),
    context.root,
  )

  const drift = await findLockfileDrift(
    context.root,
    detection.lockfile,
    context.importer,
    manifest.raw,
  )
  const drifted = new Set((drift ?? []).map((entry) => entry.name))

  const dependencies: DependencyRow[] = manifest.dependencies.map((dependency) => {
    const installedVersion = installed.get(dependency.name) ?? null
    const alignment = alignmentForDependency(
      dependency.range,
      installedVersion,
      detection.hasNodeModules,
    )
    return {
      name: dependency.name,
      kind: dependency.kind,
      declared: dependency.range,
      installed: installedVersion,
      latest: null,
      outdated: 'unknown',
      // Installed-state problems outrank drift: they are what breaks first.
      alignment: alignment === 'aligned' && drifted.has(dependency.name) ? 'stale' : alignment,
      deprecated: null,
      vulnerabilities: null,
    }
  })

  const states: AlignmentState[] = dependencies.map((row) => row.alignment)
  // A dependency removed from package.json but still locked has no row to carry it.
  if (drift !== null && drift.length > 0) states.push('stale')

  return {
    project: {
      scope: 'project',
      path: projectPath,
      displayPath: toDisplayPath(projectPath),
      name: manifest.name === 'unnamed project' ? basename(projectPath) : manifest.name,
      packageManager: detection.packageManager,
      lockfile: detection.lockfile,
      hasNodeModules: detection.hasNodeModules,
      workspace:
        context.workspace === null ? null : { root: context.root, relative: context.importer },
    },
    dependencies,
    drift,
    alignment: worstAlignment(states),
    generatedAt: new Date().toISOString(),
  }
}
