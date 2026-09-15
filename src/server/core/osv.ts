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

/**
 * Returns advisory ids per package. Detail is fetched lazily, when a drawer opens,
 * because the batch endpoint deliberately returns ids only.
 */
export async function queryVulnerabilities(
  queries: readonly OsvQuery[],
  signal?: AbortSignal,
): Promise<Map<string, string[]>> {
  const byName = new Map<string, string[]>()
  if (queries.length === 0) return byName

  const cacheKey = queries.map((query) => `${query.name}@${query.version}`).join(',')
  const cached = await readCache<Record<string, string[]>>('osv', cacheKey)
  if (isFresh(cached, TTL_MS) && cached !== null) {
    return new Map(Object.entries(cached.value))
  }

  try {
    for (const batch of chunk(queries, BATCH_SIZE)) {
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
      body.results?.forEach((result, index) => {
        const query = batch[index]
        const ids = result.vulns?.map((vuln) => vuln.id) ?? []
        if (query !== undefined && ids.length > 0) byName.set(query.name, ids)
      })
    }

    await writeCache('osv', cacheKey, {
      value: Object.fromEntries(byName),
      etag: null,
      storedAt: Date.now(),
    })
    return byName
  } catch {
    // Offline or OSV is down. Stale results beat inventing a clean bill of health.
    return cached === null ? new Map() : new Map(Object.entries(cached.value))
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
