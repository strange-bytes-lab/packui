import { detectGlobalScopes, listGlobalPackages, type GlobalScope } from '../core/global.ts'
import { sendError, sendJson, type RequestContext } from '../router.ts'
import type { DependencyReport } from '../../shared/types.ts'

/**
 * Global scopes are discovered from the toolchain rather than supplied by the client,
 * so they need no path allowlist — the `id` parameter only selects among what was
 * already found on disk.
 */

export function findScope(scopes: readonly GlobalScope[], id: string | null): GlobalScope | undefined {
  return id === null ? scopes[0] : scopes.find((scope) => scope.id === id)
}

export function reportForScope(scope: GlobalScope, dependencies: DependencyReport['dependencies']): DependencyReport {
  return {
    project: {
      scope: 'global',
      path: scope.roots[0] ?? '',
      displayPath: scope.roots.length > 1 ? `${scope.roots.length} tool directories` : (scope.roots[0] ?? ''),
      name: scope.label,
      packageManager: scope.packageManager,
      lockfile: null,
      hasNodeModules: true,
    },
    dependencies,
    // Globals have no manifest to drift from, so there is nothing to report.
    alignment: 'aligned',
    generatedAt: new Date().toISOString(),
  }
}

export const globalScopesHandler = async ({ res }: RequestContext): Promise<void> => {
  const scopes = await detectGlobalScopes()
  sendJson(res, 200, {
    scopes: scopes.map((scope) => ({
      id: scope.id,
      label: scope.label,
      installer: scope.installer,
      packageManager: scope.packageManager,
      nodeVersion: scope.nodeVersion,
      active: scope.active,
      rootCount: scope.roots.length,
      roots: scope.roots,
    })),
  })
}

export const globalDepsHandler = async ({ res, url }: RequestContext): Promise<void> => {
  const scopes = await detectGlobalScopes()
  const scope = findScope(scopes, url.searchParams.get('id'))

  if (scope === undefined) {
    sendError(res, 404, 'No such global scope')
    return
  }

  sendJson(res, 200, reportForScope(scope, await listGlobalPackages(scope)))
}
