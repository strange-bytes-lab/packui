import { isFresh, readCache, writeCache } from './cache.ts'

/**
 * A small GitHub client for release notes, CHANGELOG files and repository status.
 *
 * Unauthenticated, GitHub allows 60 API requests an hour. Every response is cached
 * with its ETag, and a revalidation that comes back 304 does not count against that
 * limit, so a warm cache costs almost nothing. `GITHUB_TOKEN` (or `GH_TOKEN`) raises
 * the limit if it is set; it is sent to api.github.com only, never to an override.
 */

const DEFAULT_API = 'https://api.github.com'
const API = process.env.PACKUI_GITHUB_API ?? DEFAULT_API
const RAW = process.env.PACKUI_GITHUB_RAW ?? 'https://raw.githubusercontent.com'

export interface GithubRepo {
  owner: string
  repo: string
}

/** owner/repo from a normalized https://github.com URL, or null for any other host. */
export function githubRepoFromUrl(url: string | null): GithubRepo | null {
  if (url === null) return null
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'github.com') return null
    const [owner, repo] = parsed.pathname.replace(/^\/+/, '').split('/')
    if (!owner || !repo) return null
    const valid = /^[A-Za-z0-9_.-]+$/
    const name = repo.replace(/\.git$/, '')
    return valid.test(owner) && valid.test(name) ? { owner, repo: name } : null
  } catch {
    return null
  }
}

export type GithubResult<T> =
  { ok: true; value: T } | { ok: false; reason: 'not-found' | 'rate-limited' | 'unreachable' }

function token(): string | undefined {
  if (API !== DEFAULT_API) return undefined
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined
}

async function cachedGet<T>(
  namespace: string,
  url: string,
  ttlMs: number,
  parse: (response: Response) => Promise<T>,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<GithubResult<T>> {
  const cached = await readCache<T>(namespace, url)
  if (isFresh(cached, ttlMs) && cached !== null) return { ok: true, value: cached.value }

  try {
    const response = await fetch(url, {
      headers: { ...headers, ...(cached?.etag ? { 'if-none-match': cached.etag } : {}) },
      signal: signal ?? null,
    })
    if (response.status === 304 && cached !== null) {
      await writeCache(namespace, url, { ...cached, storedAt: Date.now() })
      return { ok: true, value: cached.value }
    }
    if (response.status === 404) return { ok: false, reason: 'not-found' }
    if (response.status === 403 || response.status === 429) {
      return cached === null
        ? { ok: false, reason: 'rate-limited' }
        : { ok: true, value: cached.value }
    }
    if (!response.ok) {
      return cached === null
        ? { ok: false, reason: 'unreachable' }
        : { ok: true, value: cached.value }
    }
    const value = await parse(response)
    await writeCache(namespace, url, {
      value,
      etag: response.headers.get('etag'),
      storedAt: Date.now(),
    })
    return { ok: true, value }
  } catch {
    return cached === null
      ? { ok: false, reason: 'unreachable' }
      : { ok: true, value: cached.value }
  }
}

function apiHeaders(): Record<string, string> {
  const auth = token()
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(auth === undefined ? {} : { authorization: `Bearer ${auth}` }),
  }
}

export interface GithubRelease {
  tag: string
  name: string | null
  body: string | null
  url: string | null
  publishedAt: string | null
  prerelease: boolean
}

/** The most recent hundred releases. Drafts are never returned to unauthenticated callers. */
export function fetchReleases(repo: GithubRepo, signal?: AbortSignal) {
  const url = `${API}/repos/${repo.owner}/${repo.repo}/releases?per_page=100`
  return cachedGet<GithubRelease[]>(
    'gh-releases',
    url,
    60 * 60 * 1000,
    async (response) => {
      const list = (await response.json()) as Record<string, unknown>[]
      return list
        .filter((entry) => entry.draft !== true)
        .map((entry) => ({
          tag: typeof entry.tag_name === 'string' ? entry.tag_name : '',
          name: typeof entry.name === 'string' ? entry.name : null,
          // Bodies can be enormous; the drawer shows a few screens at most.
          body: typeof entry.body === 'string' ? entry.body.slice(0, 20_000) : null,
          url: typeof entry.html_url === 'string' ? entry.html_url : null,
          publishedAt: typeof entry.published_at === 'string' ? entry.published_at : null,
          prerelease: entry.prerelease === true,
        }))
    },
    apiHeaders(),
    signal,
  )
}

export interface GithubRepoStatus {
  archived: boolean
  pushedAt: string | null
  stars: number | null
  openIssues: number | null
}

export function fetchRepoStatus(repo: GithubRepo, signal?: AbortSignal) {
  return cachedGet<GithubRepoStatus>(
    'gh-repo',
    `${API}/repos/${repo.owner}/${repo.repo}`,
    24 * 60 * 60 * 1000,
    async (response) => {
      const body = (await response.json()) as Record<string, unknown>
      return {
        archived: body.archived === true,
        pushedAt: typeof body.pushed_at === 'string' ? body.pushed_at : null,
        stars: typeof body.stargazers_count === 'number' ? body.stargazers_count : null,
        openIssues: typeof body.open_issues_count === 'number' ? body.open_issues_count : null,
      }
    },
    apiHeaders(),
    signal,
  )
}

/** A file from the default branch. Not the API, so it does not touch the rate limit. */
export function fetchRawFile(repo: GithubRepo, path: string, signal?: AbortSignal) {
  const safe = path
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .map(encodeURIComponent)
    .join('/')
  return cachedGet<string>(
    'gh-raw',
    `${RAW}/${repo.owner}/${repo.repo}/HEAD/${safe}`,
    60 * 60 * 1000,
    async (response) => (await response.text()).slice(0, 1024 * 1024),
    {},
    signal,
  )
}
