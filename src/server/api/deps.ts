import { resolve } from 'node:path'
import { buildReport } from '../core/report.ts'
import { sendError, sendJson, type RequestContext } from '../router.ts'

export interface DepsRouteOptions {
  /** Projects the server is permitted to read. Anything else is rejected. */
  allowedProjects: () => readonly string[]
}

/**
 * Project paths arrive from the client, so they are resolved and checked against an
 * allowlist rather than trusted. Without this the API would read any package.json
 * on the machine.
 */
function resolveAllowedProject(requested: string | null, allowed: readonly string[]): string | null {
  if (allowed.length === 0) return null
  if (requested === null) return allowed[0] ?? null
  const candidate = resolve(requested)
  return allowed.includes(candidate) ? candidate : null
}

export function createDepsHandler(options: DepsRouteOptions) {
  return async ({ res, url }: RequestContext): Promise<void> => {
    const projectPath = resolveAllowedProject(
      url.searchParams.get('path'),
      options.allowedProjects(),
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
