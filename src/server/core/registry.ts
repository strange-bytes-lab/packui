import semver from 'semver'
import { isFresh, mapWithConcurrency, readCache, writeCache } from './cache.ts'

/**
 * Client for registry.npmjs.org.
 *
 * The table only needs versions, dist-tags and deprecation, so it requests the
 * *abbreviated* packument — the full document runs to megabytes for popular
 * packages and carries READMEs we only want when a drawer opens.
 */

const REGISTRY = process.env.PACKUI_REGISTRY ?? 'https://registry.npmjs.org'
const ABBREVIATED = 'application/vnd.npm.install-v1+json'
const TTL_MS = 60 * 60 * 1000 // one hour
const CONCURRENCY = 8

export interface PackageInfo {
  name: string
  latest: string | null
  versions: string[]
  deprecated: string | null
}

interface AbbreviatedPackument {
  'dist-tags'?: Record<string, string>
  versions?: Record<string, { deprecated?: unknown }>
}

/** Scoped names must be encoded, or `@scope/name` reads as an extra path segment. */
function registryUrl(name: string): string {
  return `${REGISTRY}/${name.replace('/', '%2F')}`
}

function toPackageInfo(name: string, packument: AbbreviatedPackument): PackageInfo {
  const versions = Object.keys(packument.versions ?? {}).filter(
    (version) => semver.valid(version) !== null,
  )
  const latest = packument['dist-tags']?.latest ?? null

  // Deprecation is per-version; the one that matters for the table is the latest.
  const latestEntry = latest === null ? undefined : packument.versions?.[latest]
  const deprecated =
    typeof latestEntry?.deprecated === 'string' && latestEntry.deprecated.length > 0
      ? latestEntry.deprecated
      : null

  return { name, latest, versions: semver.rsort(versions), deprecated }
}

export async function fetchPackageInfo(
  name: string,
  signal?: AbortSignal,
): Promise<PackageInfo | null> {
  const cached = await readCache<AbbreviatedPackument>('registry', name)
  if (isFresh(cached, TTL_MS) && cached !== null) return toPackageInfo(name, cached.value)

  try {
    const response = await fetch(registryUrl(name), {
      headers: {
        accept: ABBREVIATED,
        // A revalidation that has not changed costs a 304 and no body.
        ...(cached?.etag ? { 'if-none-match': cached.etag } : {}),
      },
      signal: signal ?? null,
    })

    if (response.status === 304 && cached !== null) {
      await writeCache('registry', name, { ...cached, storedAt: Date.now() })
      return toPackageInfo(name, cached.value)
    }

    if (!response.ok) {
      // A private or unpublished package is a normal outcome, not an error.
      return cached === null ? null : toPackageInfo(name, cached.value)
    }

    const packument = (await response.json()) as AbbreviatedPackument
    await writeCache('registry', name, {
      value: packument,
      etag: response.headers.get('etag'),
      storedAt: Date.now(),
    })
    return toPackageInfo(name, packument)
  } catch {
    // Offline, or the registry is unreachable. Stale data beats no data; null
    // surfaces in the UI as "not checked" rather than as "up to date".
    return cached === null ? null : toPackageInfo(name, cached.value)
  }
}

export async function fetchManyPackageInfos(
  names: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, PackageInfo | null>> {
  const infos = await mapWithConcurrency(names, CONCURRENCY, (name) =>
    fetchPackageInfo(name, signal),
  )
  return new Map(names.map((name, index) => [name, infos[index] ?? null]))
}

/**
 * Metadata for the drawer, from the full packument. The README is NOT here:
 * the registry returns an empty `readme` field these days, so it is read from
 * node_modules instead — see core/readme.ts.
 */
export interface PackageDetail {
  homepage: string | null
  repository: string | null
  license: string | null
  description: string | null
}

export async function fetchPackageDetail(
  name: string,
  signal?: AbortSignal,
): Promise<PackageDetail | null> {
  const cached = await readCache<PackageDetail>('detail', name)
  if (isFresh(cached, TTL_MS) && cached !== null) return cached.value

  try {
    const response = await fetch(registryUrl(name), { signal: signal ?? null })
    if (!response.ok) return cached?.value ?? null

    const full = (await response.json()) as {
      homepage?: unknown
      license?: unknown
      description?: unknown
      repository?: { url?: unknown } | string
    }

    const repositoryUrl =
      typeof full.repository === 'string'
        ? full.repository
        : typeof full.repository?.url === 'string'
          ? full.repository.url
          : null

    const detail: PackageDetail = {
      homepage: typeof full.homepage === 'string' ? full.homepage : null,
      repository: repositoryUrl,
      license: typeof full.license === 'string' ? full.license : null,
      description: typeof full.description === 'string' ? full.description : null,
    }

    await writeCache('detail', name, { value: detail, etag: null, storedAt: Date.now() })
    return detail
  } catch {
    return cached?.value ?? null
  }
}
