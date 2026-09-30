import { enrichReport } from '../core/enrich.ts'
import { loadRegistryConfig } from '../core/npmrc.ts'
import { detectGlobalScopes, listGlobalPackages } from '../core/global.ts'
import { findScope, reportForScope } from './globals.ts'
import { buildReport } from '../core/report.ts'
import { sendError, sendJson, type RequestContext } from '../router.ts'
import { resolveAllowedProject, type ProjectAccess } from './access.ts'
import type { DependencyReport } from '../../shared/types.ts'

/** Builds the local report for whichever scope was asked for, or null if unknown. */
async function reportFor(url: URL, access: ProjectAccess): Promise<DependencyReport | null> {
  if (url.searchParams.get('scope') === 'global') {
    const scope = findScope(await detectGlobalScopes(), url.searchParams.get('id'))
    if (scope === undefined) return null
    return reportForScope(scope, await listGlobalPackages(scope))
  }

  const projectPath = resolveAllowedProject(url.searchParams.get('path'), access)
  return projectPath === null ? null : buildReport(projectPath)
}

/** Lowest precedence first: a workspace root's .npmrc, then the package's own. */
export function npmrcDirectories(report: DependencyReport): string[] {
  if (report.project.scope !== 'project') return []
  const root = report.project.workspace?.root
  return root === undefined || root === report.project.path
    ? [report.project.path]
    : [root, report.project.path]
}

export function createEnrichHandler(access: ProjectAccess) {
  return async ({ req, res, url }: RequestContext): Promise<void> => {
    // Abort outstanding registry work if the client navigates away or refreshes.
    const controller = new AbortController()
    req.on('close', () => controller.abort())

    try {
      const report = await reportFor(url, access)
      if (report === null) {
        sendError(res, 403, 'Unknown project')
        return
      }
      // Globals have no project .npmrc; the user's own configuration still applies.
      const config = await loadRegistryConfig(npmrcDirectories(report))
      sendJson(res, 200, { rows: await enrichReport(report, controller.signal, config) })
    } catch (error) {
      if (controller.signal.aborted) return
      sendError(res, 502, error instanceof Error ? error.message : 'Enrichment failed')
    }
  }
}
