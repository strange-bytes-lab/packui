import { homedir } from 'node:os'
import { basename } from 'node:path'
import semver from 'semver'
import type {
  AlignmentState,
  DependencyReport,
  DependencyRow,
  OutdatedSeverity,
} from '../../shared/types.ts'
import { detectPackageManager } from './detect.ts'
import { readInstalledVersions } from './installed.ts'
import { alignmentForDependency, isLockfileStale, worstAlignment } from './lockfile.ts'
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

  const current = semver.coerce(installed, { loose: true })
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
  const [manifest, detection] = await Promise.all([
    readManifest(projectPath),
    detectPackageManager(projectPath),
  ])

  const installed = await readInstalledVersions(
    projectPath,
    manifest.dependencies.map((dependency) => dependency.name),
  )

  const dependencies: DependencyRow[] = manifest.dependencies.map((dependency) => {
    const installedVersion = installed.get(dependency.name) ?? null
    return {
      name: dependency.name,
      kind: dependency.kind,
      declared: dependency.range,
      installed: installedVersion,
      latest: null,
      outdated: 'unknown',
      alignment: alignmentForDependency(
        dependency.range,
        installedVersion,
        detection.hasNodeModules,
      ),
      deprecated: null,
      vulnerabilities: null,
    }
  })

  const states: AlignmentState[] = dependencies.map((row) => row.alignment)
  if (await isLockfileStale(projectPath, detection.lockfile)) states.push('stale')

  return {
    project: {
      scope: 'project',
      path: projectPath,
      displayPath: toDisplayPath(projectPath),
      name: manifest.name === 'unnamed project' ? basename(projectPath) : manifest.name,
      packageManager: detection.packageManager,
      lockfile: detection.lockfile,
      hasNodeModules: detection.hasNodeModules,
    },
    dependencies,
    alignment: worstAlignment(states),
    generatedAt: new Date().toISOString(),
  }
}
