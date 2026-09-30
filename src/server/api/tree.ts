import { auditTree } from '../core/audit.ts'
import { projectContext } from '../core/context.ts'
import { readManifest } from '../core/manifest.ts'
import { loadRegistryConfig } from '../core/npmrc.ts'
import { measureWeight } from '../core/weight.ts'
import { sendError, sendJson, type RequestContext } from '../router.ts'
import { resolveAllowedProject, type ProjectAccess } from './access.ts'

/**
 * Whole-tree views: advisories in indirect dependencies, and what the tree weighs.
 * Both walk every installed package, so neither runs as part of the table's own load.
 */

async function prepare(url: URL, access: ProjectAccess) {
  const projectPath = resolveAllowedProject(url.searchParams.get('path'), access)
  if (projectPath === null) return null
  const [context, manifest] = await Promise.all([
    projectContext(projectPath),
    readManifest(projectPath),
  ])
  return {
    projectPath,
    root: context.root,
    names: manifest.dependencies.map((dependency) => dependency.name),
  }
}

export function createAuditHandler(access: ProjectAccess) {
  return async ({ req, res, url }: RequestContext): Promise<void> => {
    const controller = new AbortController()
    req.on('close', () => controller.abort())
    try {
      const target = await prepare(url, access)
      if (target === null) {
        sendError(res, 403, 'Unknown project')
        return
      }
      const config = await loadRegistryConfig(
        target.root === target.projectPath ? [target.root] : [target.root, target.projectPath],
      )
      const audit = await auditTree(
        target.projectPath,
        target.names,
        target.root,
        config,
        controller.signal,
      )
      sendJson(res, 200, audit)
    } catch (error) {
      if (controller.signal.aborted) return
      sendError(res, 502, error instanceof Error ? error.message : 'Audit failed')
    }
  }
}

export function createWeightHandler(access: ProjectAccess) {
  return async ({ res, url }: RequestContext): Promise<void> => {
    try {
      const target = await prepare(url, access)
      if (target === null) {
        sendError(res, 403, 'Unknown project')
        return
      }
      sendJson(res, 200, await measureWeight(target.projectPath, target.names, target.root))
    } catch (error) {
      sendError(res, 422, error instanceof Error ? error.message : 'Could not measure the tree')
    }
  }
}
