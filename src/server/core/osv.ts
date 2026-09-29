import { isFresh, readCache, writeCache } from './cache.ts'
import type { VulnerabilitySummary } from '../../shared/types.ts'

/**
 * Client for the OSV.dev API.
 *
 * OSV is used rather than `npm audit` because it is package-manager agnostic —
 * the same query works whether the project is on npm, pnpm, yarn or bun — and
 * because it exposes structured advisory detail for the drawer.
 */

const OSV = process.env.PACKUI_OSV ?? 'https://api.osv.dev/v1'
const TTL_MS = 6 * 60 * 60 * 1000 // six hours
const BATCH_SIZE = 500 // the API accepts up to 1000 queries per request

export interface OsvQuery {
  name: string
  version: string
}

interface QueryBatchResponse {
  results?: Array<{ vulns?: Array<{ id: string }> }>
}

export interface AdvisoryDetail {
  id: string
  summary: string | null
  details: string | null
  severity: VulnerabilitySummary['worst']
  /** Versions that resolve the advisory, newest first. */
  fixedIn: string[]
  references: string[]
}

/**
 * OSV reports CVSS vectors and a coarse database_specific severity. The coarse
 * value is what the npm ecosystem uses, so prefer it and fall back to the vector.
 */
function readSeverity(vuln: Record<string, unknown>): VulnerabilitySummary['worst'] {
  const specific = vuln.database_specific as { severity?: unknown } | undefined
  const raw = typeof specific?.severity === 'string' ? specific.severity.toLowerCase() : null
  if (raw === 'low' || raw === 'moderate' || raw === 'high' || raw === 'critical') return raw
  if (raw === 'medium') return 'moderate'
  return null
}

const SEVERITY_ORDER: Record<NonNullable<VulnerabilitySummary['worst']>, number> = {
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
}

export function worstSeverity(
  severities: ReadonlyArray<VulnerabilitySummary['worst']>,
): VulnerabilitySummary['worst'] {
  return severities.reduce<VulnerabilitySummary['worst']>((worst, current) => {
    if (current === null) return worst
    if (worst === null) return current
    return SEVERITY_ORDER[current] > SEVERITY_ORDER[worst] ? current : worst
  }, null)
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

/** One cache entry per exact version, which is what the answer actually depends on. */
function cacheKeyFor(query: OsvQuery): string {
  return `${query.name}@${query.version}`
}

/**
 * Returns advisory ids per package. Detail is fetched lazily, when a drawer opens,
 * because the batch endpoint deliberately returns ids only.
 *
 * Cached per `name@version` rather than per request. Keying on the whole dependency
 * set meant one version bump invalidated every result, and two projects sharing most
 * of their dependencies shared no cache at all. A given version's advisories do not
 * change from one project to the next, so the entries are reusable everywhere. Only
 * the misses are sent to the API; the batching is what makes that cheap.
 */
export async function queryVulnerabilities(
  queries: readonly OsvQuery[],
  signal?: AbortSignal,
): Promise<Map<string, string[]>> {
  return (await queryVulnerabilitiesDetailed(queries, signal)).ids
}

export interface VulnerabilityAnswer {
  /** Advisory ids per package name. Packages with none are absent. */
  ids: Map<string, string[]>
  /**
   * Names that got no answer at all — OSV was unreachable and nothing was cached.
   * Absence from `ids` means "no advisories" only for names not listed here.
   */
  unchecked: Set<string>
}

/** As queryVulnerabilities, but says which packages could not be checked at all. */
export async function queryVulnerabilitiesDetailed(
  queries: readonly OsvQuery[],
  signal?: AbortSignal,
): Promise<VulnerabilityAnswer> {
  const byName = new Map<string, string[]>()
  const unchecked = new Set<string>()
  if (queries.length === 0) return { ids: byName, unchecked }

  const entries = await Promise.all(
    queries.map(
      async (query) => [query, await readCache<string[]>('osv', cacheKeyFor(query))] as const,
    ),
  )

  const misses: OsvQuery[] = []
  /** Expired entries, kept as the fallback if the API cannot be reached. */
  const stale = new Map<string, string[]>()

  for (const [query, cached] of entries) {
    if (isFresh(cached, TTL_MS) && cached !== null) {
      if (cached.value.length > 0) byName.set(query.name, cached.value)
      continue
    }
    if (cached !== null) stale.set(cacheKeyFor(query), cached.value)
    misses.push(query)
  }

  if (misses.length === 0) return { ids: byName, unchecked }

  const answered = new Set<string>()
  try {
    for (const batch of chunk(misses, BATCH_SIZE)) {
      const response = await fetch(`${OSV}/querybatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          queries: batch.map((query) => ({
            package: { name: query.name, ecosystem: 'npm' },
            version: query.version,
          })),
        }),
        signal: signal ?? null,
      })

      if (!response.ok) throw new Error(`OSV responded ${response.status}`)

      const body = (await response.json()) as QueryBatchResponse
      // Results are positional: index N answers query N.
      const results = body.results ?? []

      for (const [index, query] of batch.entries()) {
        const ids = results[index]?.vulns?.map((vuln) => vuln.id) ?? []
        // "No advisories" is an answer worth caching too, and it is the common one.
        await writeCache('osv', cacheKeyFor(query), {
          value: ids,
          etag: null,
          storedAt: Date.now(),
        })
        answered.add(cacheKeyFor(query))
        if (ids.length > 0) byName.set(query.name, ids)
      }
    }

    return { ids: byName, unchecked }
  } catch {
    // Offline or OSV is down. Stale results beat inventing a clean bill of health, and
    // a package with neither is reported as unchecked rather than as clean.
    for (const query of misses) {
      const key = cacheKeyFor(query)
      if (answered.has(key)) continue
      const fallback = stale.get(key)
      if (fallback === undefined) unchecked.add(query.name)
      else if (fallback.length > 0 && !byName.has(query.name)) byName.set(query.name, fallback)
    }
    return { ids: byName, unchecked }
  }
}

export async function fetchAdvisory(
  id: string,
  signal?: AbortSignal,
): Promise<AdvisoryDetail | null> {
  const cached = await readCache<AdvisoryDetail>('advisory', id)
  if (isFresh(cached, TTL_MS) && cached !== null) return cached.value

  try {
    const response = await fetch(`${OSV}/vulns/${encodeURIComponent(id)}`, {
      signal: signal ?? null,
    })
    if (!response.ok) return cached?.value ?? null

    const vuln = (await response.json()) as Record<string, unknown>

    const affected = Array.isArray(vuln.affected) ? vuln.affected : []
    const fixedIn = affected.flatMap((entry: Record<string, unknown>) => {
      const ranges = Array.isArray(entry.ranges) ? entry.ranges : []
      return ranges.flatMap((range: Record<string, unknown>) => {
        const events = Array.isArray(range.events) ? range.events : []
        return events
          .map((event: Record<string, unknown>) => event.fixed)
          .filter((fixed): fixed is string => typeof fixed === 'string')
      })
    })

    const references = Array.isArray(vuln.references)
      ? vuln.references
          .map((reference: Record<string, unknown>) => reference.url)
          .filter((url): url is string => typeof url === 'string')
      : []

    const detail: AdvisoryDetail = {
      id,
      summary: typeof vuln.summary === 'string' ? vuln.summary : null,
      details: typeof vuln.details === 'string' ? vuln.details : null,
      severity: readSeverity(vuln),
      fixedIn: [...new Set(fixedIn)],
      references,
    }

    await writeCache('advisory', id, { value: detail, etag: null, storedAt: Date.now() })
    return detail
  } catch {
    return cached?.value ?? null
  }
}
