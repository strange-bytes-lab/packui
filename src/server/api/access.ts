import { resolve } from 'node:path'
import { findWorkspace } from '../core/workspace.ts'

export interface ProjectAccess {
  /** Projects the server is permitted to read. Anything else is rejected. */
  allowedProjects: () => readonly string[]
}

/**
 * Project paths arrive from the client, so they are resolved and checked against an
 * allowlist rather than trusted. Without this the API would read, and later mutate,
 * any project on the machine.
 */
export function resolveAllowedProject(
  requested: string | null,
  allowed: readonly string[],
): string | null {
  if (allowed.length === 0) return null
  if (requested === null) return allowed[0] ?? null
  const candidate = resolve(requested)
  return allowed.includes(candidate) ? candidate : null
}

export interface RefreshableAccess extends ProjectAccess {
  /** Re-reads workspace membership, so a package added since boot becomes readable. */
  refresh: () => Promise<void>
}

/**
 * The allowlist is every project the user pointed packui at themselves — the one it
 * was launched against, and (see core/recent.ts) ones it was launched against before —
 * plus the packages of any workspace those belong to. Nothing the client sends can add
 * to it: workspace membership is read from the workspace's own configuration on disk.
 *
 * The launched project is always first, which makes it the default for requests that
 * name no path.
 */
export function createProjectAccess(
  launched: string,
  trusted: () => Promise<readonly string[]> = async () => [],
): RefreshableAccess {
  let allowed: string[] = [resolve(launched)]

  return {
    allowedProjects: () => allowed,
    refresh: async () => {
      const seeds = [resolve(launched), ...(await trusted()).map((path) => resolve(path))]
      const next = new Set<string>()
      for (const seed of seeds) {
        next.add(seed)
        const workspace = await findWorkspace(seed).catch(() => null)
        for (const member of workspace?.packages ?? []) next.add(member.path)
      }
      allowed = [...next]
    },
  }
}
