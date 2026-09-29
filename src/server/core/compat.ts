import semver from 'semver'
import { readInstalledVersion } from './installed.ts'
import type { VersionManifest } from './registry.ts'

/**
 * Whether a target version fits this project, checked before the upgrade runs rather
 * than discovered after it. Most "upgraded and it broke" is one of two things the
 * target's manifest already says: it needs a newer Node, or it expects a peer the
 * project has at the wrong version (or not at all).
 */

export interface EngineCheck {
  /** The target's `engines.node`, or null when it declares none. */
  required: string | null
  /** The Node running packui — the one the project's scripts run under, too. */
  runtime: string
  /** Whether the runtime satisfies it. Null when there is nothing to check. */
  runtimeOk: boolean | null
  /** The project's own `engines.node`, if it declares one. */
  project: string | null
  /**
   * True when the target supports fewer Node versions than the project promises —
   * the project would be claiming support it no longer has. Null when either side is
   * missing or unparseable.
   */
  narrows: boolean | null
}

export interface PeerCheck {
  name: string
  range: string
  optional: boolean
  installed: string | null
  /** Null when the range is not something semver can evaluate. */
  satisfied: boolean | null
}

export interface CompatReport {
  name: string
  version: string
  engines: EngineCheck
  peers: PeerCheck[]
  deprecated: string | null
  /** True when anything above is a reason to stop and look. */
  concerns: boolean
}

export function checkEngines(
  required: string | null,
  project: string | null,
  runtime: string = process.versions.node,
): EngineCheck {
  const validRequired = required !== null && semver.validRange(required) !== null
  const validProject = project !== null && semver.validRange(project) !== null
  return {
    required,
    runtime,
    runtimeOk: validRequired
      ? semver.satisfies(runtime, required, { includePrerelease: true })
      : null,
    project,
    narrows:
      validRequired && validProject
        ? !semver.subset(project, required, { includePrerelease: true })
        : null,
  }
}

export async function checkCompatibility(
  manifest: VersionManifest,
  name: string,
  projectPath: string,
  projectEnginesNode: string | null,
  stopAt?: string,
): Promise<CompatReport> {
  const engines = checkEngines(manifest.engines.node ?? null, projectEnginesNode)

  const peers = await Promise.all(
    Object.entries(manifest.peerDependencies).map(async ([peer, range]): Promise<PeerCheck> => {
      const installed = await readInstalledVersion(projectPath, peer, stopAt)
      const optional = manifest.optionalPeers.includes(peer)
      let satisfied: boolean | null = null
      if (installed === null) satisfied = optional ? null : false
      else if (semver.validRange(range) !== null) {
        satisfied = semver.satisfies(installed, range, { includePrerelease: true })
      }
      return { name: peer, range, optional, installed, satisfied }
    }),
  )
  peers.sort((a, b) => Number(a.optional) - Number(b.optional) || a.name.localeCompare(b.name))

  const concerns =
    engines.runtimeOk === false ||
    engines.narrows === true ||
    manifest.deprecated !== null ||
    peers.some((peer) => peer.satisfied === false)

  return {
    name,
    version: manifest.version,
    engines,
    peers,
    deprecated: manifest.deprecated,
    concerns,
  }
}
