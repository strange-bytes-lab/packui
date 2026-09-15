import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
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
