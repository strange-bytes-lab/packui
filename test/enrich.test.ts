import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * These run against a stubbed fetch rather than the live registry, so the suite
 * stays deterministic and works offline. The cache is redirected to a temp HOME so
 * tests never read or pollute the developer's real ~/.packui.
 */
let cacheHome: string
const originalHome = process.env.HOME

beforeEach(async () => {
  cacheHome = await mkdtemp(join(tmpdir(), 'packui-test-'))
  process.env.HOME = cacheHome
  vi.resetModules()
})

afterEach(async () => {
  process.env.HOME = originalHome
  vi.unstubAllGlobals()
  await rm(cacheHome, { recursive: true, force: true })
})

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('registry client', () => {
  it('reads latest, versions and deprecation from an abbreviated packument', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          'dist-tags': { latest: '2.1.0' },
          versions: {
            '1.0.0': {},
            '2.0.0': {},
            '2.1.0': { deprecated: 'use widget-next instead' },
          },
        }),
      ),
    )

    const { fetchPackageInfo } = await import('../src/server/core/registry.ts')
    const info = await fetchPackageInfo('widget')

    expect(info?.latest).toBe('2.1.0')
    expect(info?.deprecated).toBe('use widget-next instead')
    // Newest first, so a version picker can render the list directly.
    expect(info?.versions).toEqual(['2.1.0', '2.0.0', '1.0.0'])
  })

  it('requests the abbreviated document, not the full packument', async () => {
    const stub = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ 'dist-tags': { latest: '1.0.0' } }),
    )
    vi.stubGlobal('fetch', stub)

    const { fetchPackageInfo } = await import('../src/server/core/registry.ts')
    await fetchPackageInfo('widget')

    const headers = stub.mock.calls[0]?.[1]?.headers as Record<string, string>
    expect(headers.accept).toBe('application/vnd.npm.install-v1+json')
  })

  it('encodes scoped package names', async () => {
    const stub = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ 'dist-tags': { latest: '1.0.0' } }),
    )
    vi.stubGlobal('fetch', stub)

    const { fetchPackageInfo } = await import('../src/server/core/registry.ts')
    await fetchPackageInfo('@scope/widget')

    expect(stub.mock.calls[0]?.[0]).toContain('@scope%2Fwidget')
  })

  it('serves a cached packument without a second request', async () => {
    const stub = vi.fn(async () => jsonResponse({ 'dist-tags': { latest: '1.0.0' } }))
    vi.stubGlobal('fetch', stub)

    const { fetchPackageInfo } = await import('../src/server/core/registry.ts')
    await fetchPackageInfo('widget')
    await fetchPackageInfo('widget')

    expect(stub).toHaveBeenCalledTimes(1)
  })

  it('returns null rather than throwing when the registry is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND')
      }),
    )

    const { fetchPackageInfo } = await import('../src/server/core/registry.ts')
    await expect(fetchPackageInfo('widget')).resolves.toBeNull()
  })

  it('reads drawer detail from the per-version document, never the full packument', async () => {
    const stub = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({
        homepage: 'https://widget.test',
        license: 'MIT',
        description: 'A widget',
        repository: { url: 'git+https://github.com/owner/widget.git' },
      }),
    )
    vi.stubGlobal('fetch', stub)

    const { fetchPackageDetail } = await import('../src/server/core/registry.ts')
    const detail = await fetchPackageDetail('widget')

    // The full document carries every version ever published — megabytes for a
    // popular package — and these four fields are a few hundred bytes of it.
    const requested = String(stub.mock.calls[0]?.[0])
    expect(requested.endsWith('/widget/latest')).toBe(true)

    expect(detail?.license).toBe('MIT')
    expect(detail?.repository).toBe('git+https://github.com/owner/widget.git')
  })

  it('revalidates drawer detail with an ETag', async () => {
    const stub = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ license: 'MIT' }, { headers: { etag: 'W/"abc"' } }),
    )
    vi.stubGlobal('fetch', stub)

    const { fetchPackageDetail } = await import('../src/server/core/registry.ts')
    await fetchPackageDetail('widget')

    const stored = JSON.parse(
      await readFile(
        join(
          cacheHome,
          '.packui',
          'cache',
          'detail',
          `${createHash('sha256').update('widget').digest('hex').slice(0, 32)}.json`,
        ),
        'utf8',
      ),
    ) as { etag: string | null }

    expect(stored.etag).toBe('W/"abc"')
  })

  it('returns null for a package the registry does not have', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Not found', { status: 404 })))

    const { fetchPackageInfo } = await import('../src/server/core/registry.ts')
    await expect(fetchPackageInfo('private-thing')).resolves.toBeNull()
  })
})

describe('OSV client', () => {
  it('maps positional batch results back to their package', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          results: [{}, { vulns: [{ id: 'GHSA-aaaa' }, { id: 'GHSA-bbbb' }] }],
        }),
      ),
    )

    const { queryVulnerabilities } = await import('../src/server/core/osv.ts')
    const result = await queryVulnerabilities([
      { name: 'safe-pkg', version: '1.0.0' },
      { name: 'risky-pkg', version: '0.1.0' },
    ])

    expect(result.get('safe-pkg')).toBeUndefined()
    expect(result.get('risky-pkg')).toEqual(['GHSA-aaaa', 'GHSA-bbbb'])
  })

  it('reports no advisories rather than failing when OSV is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )

    const { queryVulnerabilities } = await import('../src/server/core/osv.ts')
    const result = await queryVulnerabilities([{ name: 'risky-pkg', version: '0.1.0' }])
    expect(result.size).toBe(0)
  })

  it('caches per package version, so a second project pays for nothing it shares', async () => {
    const stub = vi.fn(async () =>
      jsonResponse({ results: [{ vulns: [{ id: 'GHSA-aaaa' }] }, {}] }),
    )
    vi.stubGlobal('fetch', stub)

    const { queryVulnerabilities } = await import('../src/server/core/osv.ts')

    await queryVulnerabilities([
      { name: 'risky-pkg', version: '0.1.0' },
      { name: 'safe-pkg', version: '1.0.0' },
    ])

    // A different dependency set that happens to share both versions.
    const again = await queryVulnerabilities([
      { name: 'safe-pkg', version: '1.0.0' },
      { name: 'risky-pkg', version: '0.1.0' },
    ])

    expect(stub).toHaveBeenCalledTimes(1)
    expect(again.get('risky-pkg')).toEqual(['GHSA-aaaa'])
    // A clean result is cached too, and must not come back as "vulnerable".
    expect(again.get('safe-pkg')).toBeUndefined()
  })

  it('asks only about the versions it has no answer for', async () => {
    const first = vi.fn(async () => jsonResponse({ results: [{}] }))
    vi.stubGlobal('fetch', first)

    const { queryVulnerabilities } = await import('../src/server/core/osv.ts')
    await queryVulnerabilities([{ name: 'safe-pkg', version: '1.0.0' }])

    const second = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ results: [{ vulns: [{ id: 'GHSA-cccc' }] }] }),
    )
    vi.stubGlobal('fetch', second)

    const result = await queryVulnerabilities([
      { name: 'safe-pkg', version: '1.0.0' },
      // Same package, different version: a different question.
      { name: 'safe-pkg', version: '2.0.0' },
    ])

    const body = JSON.parse(String(second.mock.calls[0]?.[1]?.body)) as {
      queries: Array<{ version: string }>
    }
    expect(body.queries).toHaveLength(1)
    expect(body.queries[0]?.version).toBe('2.0.0')
    expect(result.get('safe-pkg')).toEqual(['GHSA-cccc'])
  })

  it('extracts severity, fixed versions and references from an advisory', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          id: 'GHSA-aaaa',
          summary: 'Prototype pollution',
          database_specific: { severity: 'CRITICAL' },
          affected: [
            { ranges: [{ events: [{ introduced: '0' }, { fixed: '1.2.6' }] }] },
            { ranges: [{ events: [{ fixed: '1.2.6' }] }] },
          ],
          references: [{ url: 'https://example.test/advisory' }],
        }),
      ),
    )

    const { fetchAdvisory } = await import('../src/server/core/osv.ts')
    const advisory = await fetchAdvisory('GHSA-aaaa')

    expect(advisory?.severity).toBe('critical')
    expect(advisory?.fixedIn).toEqual(['1.2.6'])
    expect(advisory?.references).toEqual(['https://example.test/advisory'])
  })

  it('ranks severity worst-first', async () => {
    const { worstSeverity } = await import('../src/server/core/osv.ts')
    expect(worstSeverity(['low', 'critical', 'moderate'])).toBe('critical')
    expect(worstSeverity(['low', null])).toBe('low')
    expect(worstSeverity([null, null])).toBeNull()
  })
})

describe('cache pruning', () => {
  it('drops entries past the age limit and keeps recent ones', async () => {
    const { writeCache, readCache, pruneCache } = await import('../src/server/core/cache.ts')

    await writeCache('registry', 'fresh-pkg', { value: 1, etag: null, storedAt: Date.now() })
    await writeCache('registry', 'ancient-pkg', { value: 1, etag: null, storedAt: 0 })

    // Pruning goes by file age, which is what survives a cache written by an older
    // version that stored a different shape.
    const ancient = join(
      cacheHome,
      '.packui',
      'cache',
      'registry',
      `${createHash('sha256').update('ancient-pkg').digest('hex').slice(0, 32)}.json`,
    )
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
    await utimes(ancient, longAgo, longAgo)

    await pruneCache()

    expect(await readCache('registry', 'fresh-pkg')).not.toBeNull()
    expect(await readCache('registry', 'ancient-pkg')).toBeNull()
  })

  it('does nothing when there is no cache yet', async () => {
    const { pruneCache } = await import('../src/server/core/cache.ts')
    await expect(pruneCache()).resolves.toBeUndefined()
  })
})

describe('concurrency helper', () => {
  it('preserves input order and respects the limit', async () => {
    const { mapWithConcurrency } = await import('../src/server/core/cache.ts')

    let active = 0
    let peak = 0

    const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (value) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return value * 2
    })

    expect(result).toEqual([2, 4, 6, 8, 10, 12, 14, 16])
    expect(peak).toBeLessThanOrEqual(3)
  })
})
