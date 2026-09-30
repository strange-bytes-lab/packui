import { resolve } from 'node:path'
import { findWorkspace } from '../core/workspace.ts'

export interface ProjectAccess {
  /** Projects the server is permitted to read. Anything else is rejected. */
  allowedProjects: () => readonly string[]
  /**
   * The project a request that names no path means: the one packui was launched
   * against, or null when it was launched outside any project.
   */
  defaultProject: () => string | null
}

/**
 * Project paths arrive from the client, so they are resolved and checked against an
 * allowlist rather than trusted. Without this the API would read, and later mutate,
 * any project on the machine.
 */
export function resolveAllowedProject(
  requested: string | null,
  access: ProjectAccess,
): string | null {
  if (requested === null) return access.defaultProject()
  const candidate = resolve(requested)
  return access.allowedProjects().includes(candidate) ? candidate : null
}

export interface RefreshableAccess extends ProjectAccess {
  /** Re-reads workspace membership, so a package added since boot becomes readable. */
  refresh: () => Promise<void>
}

/**
 * The allowlist is every project the user pointed packui at themselves — the one it
 * was launched against, ones it was launched against or opened before (see
 * core/recent.ts), and ones added this session — plus the packages of any workspace
 * those belong to. Workspace membership is read from the workspace's own
 * configuration on disk, never from a request.
 *
 * `launched` is null when packui was started outside a project. The UI then opens on
 * its project picker, and a request that names no path is refused rather than
 * silently pointed at whichever project happens to be most recent.
 */
export function createProjectAccess(
  launched: string | null,
  trusted: () => Promise<readonly string[]> = async () => [],
): RefreshableAccess {
  const home = launched === null ? null : resolve(launched)
  let allowed: string[] = home === null ? [] : [home]

  return {
    allowedProjects: () => allowed,
    defaultProject: () => home,
    refresh: async () => {
      const seeds = [...(home === null ? [] : [home]), ...(await trusted()).map((p) => resolve(p))]
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
