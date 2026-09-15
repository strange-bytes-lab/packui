import { readInstalledVersion } from '../core/installed.ts'
import { readManifest } from '../core/manifest.ts'
import { findDependents, findUsages, type Usage } from '../core/usage.ts'
import { sendError, sendJson, type RequestContext } from '../router.ts'
import { resolveAllowedProject, type ProjectAccess } from './access.ts'
import type { DependencyKind } from '../../shared/types.ts'

/**
 * What removing a package would affect. Read-only, and requested before the remove
 * confirmation opens so the user decides with the consequences in front of them
 * rather than after the fact.
 */
export interface RemovalImpact {
  name: string
  installed: string | null
  declared: string | null
  kind: DependencyKind | null
  /** Source files that import this package. */
  usages: Usage[]
  usageFileCount: number
  filesScanned: number
  /** True if the scan hit its file budget, so an empty result is not conclusive. */
  truncated: boolean
  /** Installed packages that declare this one as a dependency. */
  dependents: string[]
  /** Highest-level summary the UI uses to pick its tone. */
  risk: 'safe' | 'caution' | 'breaking'
}

function assessRisk(usageCount: number, dependents: number, truncated: boolean): RemovalImpact['risk'] {
  // Anything importing it will break at runtime the moment it is gone.
  if (usageCount > 0) return 'breaking'
  // Another package needing it leaves an unmet dependency after removal.
  if (dependents > 0) return 'caution'
  // An incomplete scan cannot claim "nothing uses this".
  if (truncated) return 'caution'
  return 'safe'
}

export function createImpactHandler(access: ProjectAccess) {
  return async ({ res, url }: RequestContext): Promise<void> => {
    const projectPath = resolveAllowedProject(url.searchParams.get('path'), access.allowedProjects())
    if (projectPath === null) {
      sendError(res, 403, 'Unknown project')
      return
    }

    const name = url.searchParams.get('name')
    if (name === null || !/^(@[\w.-]+\/)?[\w.-]+$/.test(name)) {
      sendError(res, 400, 'Invalid package name')
      return
    }

    try {
      const [manifest, installed, usageReport, dependents] = await Promise.all([
        readManifest(projectPath),
        readInstalledVersion(projectPath, name),
        findUsages(projectPath, name),
        findDependents(projectPath, name),
      ])

      const declared = manifest.dependencies.find((dependency) => dependency.name === name)

      const uniqueFiles = new Set(usageReport.usages.map((usage) => usage.file))

      const impact: RemovalImpact = {
        name,
        installed,
        declared: declared?.range ?? null,
        kind: declared?.kind ?? null,
        // Cap what is sent; the count is what matters, the samples are illustrative.
        usages: usageReport.usages.slice(0, 50),
        usageFileCount: uniqueFiles.size,
        filesScanned: usageReport.filesScanned,
        truncated: usageReport.truncated,
        dependents,
        risk: assessRisk(usageReport.usages.length, dependents.length, usageReport.truncated),
      }

      sendJson(res, 200, impact)
    } catch (error) {
      sendError(res, 422, error instanceof Error ? error.message : 'Could not analyse removal')
    }
  }
}
