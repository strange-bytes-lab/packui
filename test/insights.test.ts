import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  entriesFromChangelog,
  entriesFromReleases,
  versionFromTag,
} from '../src/server/core/changelog.ts'
import { checkCompatibility, checkEngines } from '../src/server/core/compat.ts'
import { githubRepoFromUrl } from '../src/server/core/github.ts'
import { formatAge, formatBytes, yearsSince } from '../src/ui/composables/format.ts'

let home: string
const originalHome = process.env.HOME

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'packui-insights-'))
  process.env.HOME = home
  vi.resetModules()
})

afterEach(async () => {
  process.env.HOME = originalHome
  vi.unstubAllGlobals()
  await rm(home, { recursive: true, force: true })
})

describe('engines', () => {
  it('checks the running Node against the target', () => {
    expect(checkEngines('>=20', null, '22.1.0').runtimeOk).toBe(true)
    expect(checkEngines('>=24', null, '22.1.0').runtimeOk).toBe(false)
    expect(checkEngines(null, '>=22', '22.1.0').runtimeOk).toBeNull()
  })

  it('flags a target that supports fewer Node versions than the project promises', () => {
    expect(checkEngines('>=22.12', '>=22', '22.20.0').narrows).toBe(true)
    expect(checkEngines('>=18', '>=22', '22.20.0').narrows).toBe(false)
    expect(checkEngines('not a range', '>=22', '22.20.0').narrows).toBeNull()
  })
})

describe('peers', () => {
  it('reports missing, mismatched and optional peers', async () => {
    const dir = join(home, 'project')
    await mkdir(join(dir, 'node_modules', 'vue'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'vue', 'package.json'), '{"version":"2.7.0"}')

    const report = await checkCompatibility(
      {
        version: '5.0.0',
        engines: {},
        peerDependencies: { vue: '^3.0.0', react: '>=18', typescript: '>=5' },
        optionalPeers: ['typescript'],
        repository: null,
        repositoryDirectory: null,
        deprecated: null,
      },
      'plugin',
      dir,
      null,
    )
    expect(report.peers).toEqual([
      { name: 'react', range: '>=18', optional: false, installed: null, satisfied: false },
      { name: 'vue', range: '^3.0.0', optional: false, installed: '2.7.0', satisfied: false },
      { name: 'typescript', range: '>=5', optional: true, installed: null, satisfied: null },
    ])
    expect(report.concerns).toBe(true)
  })
})

describe('release tags', () => {
  it.each([
    ['v1.2.3', 'pkg', '1.2.3'],
    ['1.2.3', 'pkg', '1.2.3'],
    ['pkg@1.2.3', 'pkg', '1.2.3'],
    ['@scope/pkg@1.2.3', '@scope/pkg', '1.2.3'],
    ['pkg-v1.2.3', '@scope/pkg', '1.2.3'],
    ['v2.0.0-beta.1', 'pkg', '2.0.0-beta.1'],
    // A sibling's tag in a monorepo must not appear in this package's drawer.
    ['other@1.2.3', 'pkg', null],
    ['@scope/other@1.2.3', '@scope/pkg', null],
    ['nightly', 'pkg', null],
  ])('%s for %s → %s', (tag, name, expected) => {
    expect(versionFromTag(tag, name)).toBe(expected)
  })

  it('keeps only versions after the installed one, up to the target, newest first', () => {
    const release = (tag: string) => ({
      tag,
      name: tag,
      body: `notes ${tag}`,
      url: null,
      publishedAt: null,
      prerelease: false,
    })
    const entries = entriesFromReleases(
      [
        release('v1.0.0'),
        release('v1.1.0'),
        release('v1.2.0'),
        release('v2.0.0'),
        release('other@1.1.5'),
      ],
      'pkg',
      '1.0.0',
      '1.2.0',
    )
    expect(entries.map((entry) => entry.version)).toEqual(['1.2.0', '1.1.0'])
  })
})

describe('CHANGELOG parsing', () => {
  const text = [
    '# Changelog',
    '',
    '## [2.0.0] - 2025-03-01',
    '### Breaking',
    '- removed the thing',
    '',
    '## 1.2.0 (2024-11-02)',
    '- added a thing',
    '',
    '## v1.1.0',
    '- fixed a thing',
    '',
    '## 1.0.0',
    '- first',
  ].join('\n')

  it('splits by version headings, keeping sub-headings in the body', () => {
    const entries = entriesFromChangelog(text, '1.0.0', '2.0.0')
    expect(entries.map((entry) => entry.version)).toEqual(['2.0.0', '1.2.0', '1.1.0'])
    expect(entries[0]?.body).toContain('### Breaking')
    expect(entries[0]?.date).toBe('2025-03-01')
    expect(entries[1]?.date).toBe('2024-11-02')
  })

  it('includes everything up to the target when nothing is installed', () => {
    expect(entriesFromChangelog(text, null, '1.1.0').map((entry) => entry.version)).toEqual([
      '1.1.0',
      '1.0.0',
    ])
  })
})

describe('GitHub', () => {
  it('reads owner and repo from github.com URLs only', () => {
    expect(githubRepoFromUrl('https://github.com/vuejs/core')).toEqual({
      owner: 'vuejs',
      repo: 'core',
    })
    expect(githubRepoFromUrl('https://github.com/vuejs/core.git/')).toEqual({
      owner: 'vuejs',
      repo: 'core',
    })
    expect(githubRepoFromUrl('https://gitlab.com/a/b')).toBeNull()
    expect(githubRepoFromUrl('https://github.com/only-owner')).toBeNull()
    expect(githubRepoFromUrl(null)).toBeNull()
  })

  it('falls back to the CHANGELOG when releases have no matching versions', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        if (url.includes('/releases')) return new Response('[]')
        if (url.endsWith('/packages/lib/CHANGELOG.md')) return new Response('nope', { status: 404 })
        return new Response('## 1.1.0\n- fixed\n## 1.0.0\n- first\n')
      }),
    )
    const { buildChangelog } = await import('../src/server/core/changelog.ts')
    const changelog = await buildChangelog(
      { owner: 'o', repo: 'r' },
      'lib',
      'packages/lib',
      '1.0.0',
      '1.1.0',
    )
    expect(changelog.source).toBe('changelog')
    expect(changelog.entries.map((entry) => entry.version)).toEqual(['1.1.0'])
    // The package's own directory is tried before the repository root.
    expect(urls.findIndex((url) => url.includes('packages/lib'))).toBeLessThan(
      urls.findIndex((url) => url.endsWith('/HEAD/CHANGELOG.md')),
    )
  })

  it('says GitHub rate-limited it rather than that there are no notes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/releases')
          ? new Response('limited', { status: 403 })
          : new Response('missing', { status: 404 }),
      ),
    )
    const { buildChangelog } = await import('../src/server/core/changelog.ts')
    const changelog = await buildChangelog({ owner: 'o', repo: 'r' }, 'lib', null, '1.0.0', '1.1.0')
    expect(changelog.unavailable).toBe('rate-limited')
  })

  it('sends GITHUB_TOKEN to the GitHub API and nowhere else', async () => {
    process.env.GITHUB_TOKEN = 'gh-secret'
    const seen: { url: string; auth: string | undefined }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>
        seen.push({ url, auth: headers.authorization })
        return new Response(url.includes('/releases') ? '[]' : '## 1.1.0\n')
      }),
    )
    try {
      const { buildChangelog } = await import('../src/server/core/changelog.ts')
      await buildChangelog({ owner: 'o', repo: 'r' }, 'lib', null, '1.0.0', '1.1.0')
    } finally {
      delete process.env.GITHUB_TOKEN
    }
    expect(seen.find((call) => call.url.startsWith('https://api.github.com'))?.auth).toBe(
      'Bearer gh-secret',
    )
    expect(seen.find((call) => call.url.includes('raw.githubusercontent'))?.auth).toBeUndefined()
  })

  it('reports an archived repository and weekly downloads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('downloads')
          ? new Response(JSON.stringify({ downloads: 12345 }))
          : new Response(JSON.stringify({ archived: true, pushed_at: '2020-01-01T00:00:00Z' })),
      ),
    )
    const { fetchPackageHealth } = await import('../src/server/core/health.ts')
    const health = await fetchPackageHealth(
      'lib',
      '2020-01-02T00:00:00Z',
      { owner: 'o', repo: 'r' },
      true,
    )
    expect(health).toMatchObject({
      weeklyDownloads: 12345,
      repository: { archived: true, pushedAt: '2020-01-01T00:00:00Z' },
      repositoryUnavailable: null,
    })
  })

  it('does not ask for download counts when told not to', async () => {
    const stub = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', stub)
    const { fetchPackageHealth } = await import('../src/server/core/health.ts')
    await fetchPackageHealth('@corp/private', null, null, false)
    expect(stub).not.toHaveBeenCalled()
  })
})

describe('formatting', () => {
  const now = Date.parse('2026-06-01T00:00:00Z')
  it('describes ages coarsely', () => {
    expect(formatAge('2026-05-31T12:00:00Z', now)).toBe('today')
    expect(formatAge('2026-05-20T00:00:00Z', now)).toBe('12 days ago')
    expect(formatAge('2025-12-01T00:00:00Z', now)).toBe('5 months ago')
    expect(formatAge('2023-01-01T00:00:00Z', now)).toBe('3 years ago')
    expect(yearsSince('2024-05-01T00:00:00Z', now)).toBe(2)
    expect(yearsSince(null, now)).toBeNull()
  })

  it('formats bytes in decimal units', () => {
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1500)).toBe('1.5 kB')
    expect(formatBytes(161_900_000)).toBe('162 MB')
  })
})
