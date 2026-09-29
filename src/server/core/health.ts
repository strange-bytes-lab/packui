import { isFresh, readCache, writeCache } from './cache.ts'
import { fetchRepoStatus, type GithubRepo, type GithubRepoStatus } from './github.ts'

/**
 * Signs of life for a package: when the registry last saw a change, how many people
 * install it, and whether its repository is still open. Deprecation catches the
 * maintainers who say goodbye; these catch the ones who simply stop.
 */

const DOWNLOADS = process.env.PACKUI_DOWNLOADS ?? 'https://api.npmjs.org/downloads/point/last-week'
const DOWNLOADS_TTL_MS = 24 * 60 * 60 * 1000

export interface PackageHealth {
  /** Upper bound on the time since the last publish; see PackageInfo.modified. */
  modified: string | null
  weeklyDownloads: number | null
  repository: GithubRepoStatus | null
  /** Why repository status is missing, when a GitHub repository was known. */
  repositoryUnavailable: 'not-found' | 'rate-limited' | 'unreachable' | null
}

export async function fetchWeeklyDownloads(
  name: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const url = `${DOWNLOADS}/${name}`
  const cached = await readCache<number | null>('downloads', url)
  if (isFresh(cached, DOWNLOADS_TTL_MS) && cached !== null) return cached.value
  try {
    const response = await fetch(url, { signal: signal ?? null })
    if (!response.ok) return cached?.value ?? null
    const body = (await response.json()) as { downloads?: unknown }
    const value = typeof body.downloads === 'number' ? body.downloads : null
    await writeCache('downloads', url, { value, etag: null, storedAt: Date.now() })
    return value
  } catch {
    return cached?.value ?? null
  }
}

export async function fetchPackageHealth(
  name: string,
  modified: string | null,
  repo: GithubRepo | null,
  includeDownloads: boolean,
  signal?: AbortSignal,
): Promise<PackageHealth> {
  const [weeklyDownloads, repository] = await Promise.all([
    includeDownloads ? fetchWeeklyDownloads(name, signal) : Promise.resolve(null),
    repo === null ? Promise.resolve(null) : fetchRepoStatus(repo, signal),
  ])
  return {
    modified,
    weeklyDownloads,
    repository: repository?.ok ? repository.value : null,
    repositoryUnavailable: repository === null || repository.ok ? null : repository.reason,
  }
}
