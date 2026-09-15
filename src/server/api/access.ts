import { resolve } from 'node:path'

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
