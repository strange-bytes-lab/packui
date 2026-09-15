import { buildReport } from '../core/report.ts'
import { sendError, sendJson, type RequestContext } from '../router.ts'
import { resolveAllowedProject, type ProjectAccess } from './access.ts'

export function createDepsHandler(access: ProjectAccess) {
  return async ({ res, url }: RequestContext): Promise<void> => {
    const projectPath = resolveAllowedProject(
      url.searchParams.get('path'),
      access.allowedProjects(),
    )

    if (projectPath === null) {
      sendError(res, 403, 'Unknown project')
      return
    }

    try {
      sendJson(res, 200, await buildReport(projectPath))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not read project'
      sendError(res, 422, message)
    }
  }
}
