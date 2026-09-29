import semver from 'semver'
import { isFresh, mapWithConcurrency, readCache, writeCache } from './cache.ts'
import {
  authorizationFor,
  defaultRegistryConfig,
  registryFor,
  type RegistryConfig,
} from './npmrc.ts'

/**
 * Client for the npm registry — registry.npmjs.org, or whichever registry `.npmrc`
 * maps a package to (see core/npmrc.ts).
 *
 * The table only needs versions, dist-tags and deprecation, so it requests the
 * *abbreviated* packument — the full document runs to megabytes for popular
 * packages and carries READMEs we only want when a drawer opens.
 */

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
function registryUrl(config: RegistryConfig, name: string): string {
  return `${registryFor(config, name)}/${name.replace('/', '%2F')}`
}

/**
 * Headers for one registry request. The credential, if any, is chosen by the URL
 * itself, so a token configured for one registry cannot ride along to another.
 */
function requestHeaders(
  config: RegistryConfig,
  url: string,
  extra: Record<string, string>,
): Record<string, string> {
  const authorization = authorizationFor(config, url)
  return authorization === undefined ? extra : { ...extra, authorization }
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
  config: RegistryConfig = defaultRegistryConfig(),
): Promise<PackageInfo | null> {
  const url = registryUrl(config, name)
  // Keyed by URL, so the same name on a private registry never reads the public
  // registry's entry. The key holds no credential; the header is not part of it.
  const cached = await readCache<AbbreviatedPackument>('registry', url)
  if (isFresh(cached, TTL_MS) && cached !== null) return toPackageInfo(name, cached.value)

  try {
    const response = await fetch(url, {
      headers: requestHeaders(config, url, {
        accept: ABBREVIATED,
        // A revalidation that has not changed costs a 304 and no body.
        ...(cached?.etag ? { 'if-none-match': cached.etag } : {}),
      }),
      signal: signal ?? null,
    })

    if (response.status === 304 && cached !== null) {
      await writeCache('registry', url, { ...cached, storedAt: Date.now() })
      return toPackageInfo(name, cached.value)
    }

    if (!response.ok) {
      // A private or unpublished package is a normal outcome, not an error.
      return cached === null ? null : toPackageInfo(name, cached.value)
    }

    const packument = (await response.json()) as AbbreviatedPackument
    await writeCache('registry', url, {
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
  config: RegistryConfig = defaultRegistryConfig(),
): Promise<Map<string, PackageInfo | null>> {
  const infos = await mapWithConcurrency(names, CONCURRENCY, (name) =>
    fetchPackageInfo(name, signal, config),
  )
  return new Map(names.map((name, index) => [name, infos[index] ?? null]))
}

/**
 * Metadata for the drawer, from the *per-version* document at `/<pkg>/latest`.
 *
 * Not the full packument: that runs to megabytes for a popular package because it
 * carries every version ever published, and all four fields below are a few hundred
 * bytes of it. The README is not here either — the registry returns an empty `readme`
 * field these days, so it is read from node_modules instead. See core/readme.ts.
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
  config: RegistryConfig = defaultRegistryConfig(),
): Promise<PackageDetail | null> {
  const url = `${registryUrl(config, name)}/latest`
  const cached = await readCache<PackageDetail>('detail', url)
  if (isFresh(cached, TTL_MS) && cached !== null) return cached.value

  try {
    const response = await fetch(url, {
      headers: requestHeaders(config, url, cached?.etag ? { 'if-none-match': cached.etag } : {}),
      signal: signal ?? null,
    })

    if (response.status === 304 && cached !== null) {
      await writeCache('detail', url, { ...cached, storedAt: Date.now() })
      return cached.value
    }

    if (!response.ok) return cached?.value ?? null

    const version = (await response.json()) as {
      homepage?: unknown
      license?: unknown
      description?: unknown
      repository?: { url?: unknown } | string
    }

    const repositoryUrl =
      typeof version.repository === 'string'
        ? version.repository
        : typeof version.repository?.url === 'string'
          ? version.repository.url
          : null

    const detail: PackageDetail = {
      homepage: typeof version.homepage === 'string' ? version.homepage : null,
      repository: repositoryUrl,
      license: typeof version.license === 'string' ? version.license : null,
      description: typeof version.description === 'string' ? version.description : null,
    }

    await writeCache('detail', url, {
      value: detail,
      etag: response.headers.get('etag'),
      storedAt: Date.now(),
    })
    return detail
  } catch {
    return cached?.value ?? null
  }
}
