import { enrichReport } from '../core/enrich.ts'
import { buildReport } from '../core/report.ts'
import { sendError, sendJson, type RequestContext } from '../router.ts'
import { resolveAllowedProject, type ProjectAccess } from './access.ts'

export function createEnrichHandler(access: ProjectAccess) {
  return async ({ req, res, url }: RequestContext): Promise<void> => {
    const projectPath = resolveAllowedProject(url.searchParams.get('path'), access.allowedProjects())
    if (projectPath === null) {
      sendError(res, 403, 'Unknown project')
      return
    }

    // Abort outstanding registry work if the client navigates away or refreshes.
    const controller = new AbortController()
    req.on('close', () => controller.abort())

    try {
      const report = await buildReport(projectPath)
      sendJson(res, 200, { rows: await enrichReport(report, controller.signal) })
    } catch (error) {
      if (controller.signal.aborted) return
      sendError(res, 502, error instanceof Error ? error.message : 'Enrichment failed')
    }
  }
}
