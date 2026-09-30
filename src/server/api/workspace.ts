import { findRangeMismatches, findWorkspace } from '../core/workspace.ts'
import { sendError, sendJson, type RequestContext } from '../router.ts'
import { resolveAllowedProject, type RefreshableAccess } from './access.ts'

/**
 * The workspace the requested project belongs to: its packages, for the sidebar, and
 * the dependencies declared with different ranges in different packages — the drift
 * that no single package's table can show.
 */
export function createWorkspaceHandler(access: RefreshableAccess) {
  return async ({ res, url }: RequestContext): Promise<void> => {
    // A package added since boot should be selectable without restarting packui.
    await access.refresh()
    const projectPath = resolveAllowedProject(url.searchParams.get('path'), access)
    if (projectPath === null) {
      sendError(res, 403, 'Unknown project')
      return
    }

    const workspace = await findWorkspace(projectPath)
    if (workspace === null) {
      sendJson(res, 200, { workspace: null, mismatches: [] })
      return
    }

    sendJson(res, 200, {
      workspace: {
        root: workspace.root,
        packages: workspace.packages.map((member) => ({
          path: member.path,
          relative: member.relative,
          name: member.name,
        })),
      },
      mismatches: await findRangeMismatches(workspace),
    })
  }
}
