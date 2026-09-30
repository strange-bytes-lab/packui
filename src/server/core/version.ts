import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'
import { loadRegistryConfig, type RegistryConfig } from './npmrc.ts'
import { fetchPackageInfo } from './registry.ts'

/**
 * Whether a newer packui has been published.
 *
 * It asks for the same abbreviated packument the table uses for every dependency, so
 * it rides the same hour-long, ETag-revalidated cache: a boot inside the hour costs
 * nothing, and one after it costs a 304. Offline is simply "no update known".
 *
 * `PACKUI_NO_UPDATE_CHECK=1`, or the conventional `NO_UPDATE_NOTIFIER`, turns it off.
 */

export const PACKAGE_NAME = '@strange-bytes/packui'

export interface VersionStatus {
  current: string | null
  latest: string | null
  updateAvailable: boolean
}

let current: Promise<string | null> | null = null

/**
 * The running version, from the nearest package.json that is packui's own. Walking
 * upward works from the bundle (`dist/server`) and from source (`src/server/core`)
 * alike, without a build-time define that tests would not see.
 */
export function currentVersion(): Promise<string | null> {
  current ??= (async () => {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let depth = 0; depth < 6; depth += 1) {
      try {
        const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
          name?: unknown
          version?: unknown
        }
        if (manifest.name === PACKAGE_NAME && typeof manifest.version === 'string') {
          return manifest.version
        }
      } catch {
        // Not here; keep walking.
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return null
  })()
  return current
}

export function updateChecksDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const off = (value: string | undefined) => value !== undefined && value !== '' && value !== '0'
  return off(env.PACKUI_NO_UPDATE_CHECK) || off(env.NO_UPDATE_NOTIFIER)
}

/** Compares against `latest` only: a prerelease on another dist-tag is not an update. */
export function isNewer(latest: string | null, running: string | null): boolean {
  if (latest === null || running === null) return false
  if (semver.valid(latest) === null || semver.valid(running) === null) return false
  return semver.gt(latest, running)
}

export async function checkForUpdate(
  signal?: AbortSignal,
  config?: RegistryConfig,
): Promise<VersionStatus> {
  const running = await currentVersion()
  if (updateChecksDisabled()) return { current: running, latest: null, updateAvailable: false }
  // The user's own .npmrc, so a machine that can only reach a mirror asks the mirror.
  const info = await fetchPackageInfo(PACKAGE_NAME, signal, config ?? (await loadRegistryConfig()))
  const latest = info?.latest ?? null
  return { current: running, latest, updateAvailable: isNewer(latest, running) }
}
