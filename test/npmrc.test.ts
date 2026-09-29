import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  authorizationFor,
  isPrivatelyScoped,
  loadRegistryConfig,
  nerfDart,
  parseNpmrc,
  registryFor,
} from '../src/server/core/npmrc.ts'
import { restoreHome, setHome } from './helpers/home.ts'

/**
 * Credentials from .npmrc are the one secret packui handles. These pin down that a
 * token only ever goes to the registry it is keyed to.
 */
let home: string
let project: string
const originalUserConfig = process.env.NPM_CONFIG_USERCONFIG

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'packui-npmrc-'))
  project = join(home, 'project')
  await mkdir(project)
  setHome(home)
  delete process.env.NPM_CONFIG_USERCONFIG
  vi.resetModules()
})

afterEach(async () => {
  restoreHome()
  if (originalUserConfig === undefined) delete process.env.NPM_CONFIG_USERCONFIG
  else process.env.NPM_CONFIG_USERCONFIG = originalUserConfig
  delete process.env.PACKUI_TEST_TOKEN
  vi.unstubAllGlobals()
  await rm(home, { recursive: true, force: true })
})

describe('parsing', () => {
  it('reads keys, strips quotes and comments, expands environment variables', () => {
    const values = parseNpmrc(
      [
        '; a comment',
        '# another',
        'registry = "https://npm.example.com/"',
        '@corp:registry=https://npm.corp.example/api/',
        '//npm.corp.example/api/:_authToken=${CORP_TOKEN}',
        '//npm.corp.example/api/:always-auth=true',
      ].join('\n'),
      { CORP_TOKEN: 'secret' },
    )
    expect(values.get('registry')).toBe('https://npm.example.com/')
    expect(values.get('@corp:registry')).toBe('https://npm.corp.example/api/')
    expect(values.get('//npm.corp.example/api/:_authToken')).toBe('secret')
  })

  it('nerf-darts a registry URL the way npm keys credentials', () => {
    expect(nerfDart('https://npm.corp.example/api')).toBe('//npm.corp.example/api/')
    expect(nerfDart('http://localhost:4873/')).toBe('//localhost:4873/')
  })
})

describe('configuration', () => {
  it('maps scopes to their registry and the nearest file wins', async () => {
    await writeFile(
      join(home, '.npmrc'),
      'registry=https://user.example/\n@corp:registry=https://a.example/',
    )
    await writeFile(join(project, '.npmrc'), '@corp:registry=https://b.example/')
    const config = await loadRegistryConfig([project])

    expect(config.registry).toBe('https://user.example')
    expect(registryFor(config, '@corp/lib')).toBe('https://b.example')
    expect(registryFor(config, '@other/lib')).toBe('https://user.example')
    expect(registryFor(config, 'lodash')).toBe('https://user.example')
    expect(isPrivatelyScoped(config, '@corp/lib')).toBe(true)
    expect(isPrivatelyScoped(config, 'lodash')).toBe(false)
  })

  it('treats a scope mapped to the public registry as public', async () => {
    await writeFile(join(project, '.npmrc'), '@types:registry=https://registry.npmjs.org/')
    const config = await loadRegistryConfig([project])
    expect(isPrivatelyScoped(config, '@types/node')).toBe(false)
  })
})

describe('credentials', () => {
  async function corpConfig() {
    process.env.PACKUI_TEST_TOKEN = 'tok-123'
    await writeFile(
      join(project, '.npmrc'),
      [
        '@corp:registry=https://npm.corp.example/api/',
        '//npm.corp.example/api/:_authToken=${PACKUI_TEST_TOKEN}',
        '//basic.example/:username=me',
        `//basic.example/:_password=${Buffer.from('pw').toString('base64')}`,
      ].join('\n'),
    )
    return loadRegistryConfig([project])
  }

  it('attaches a token to requests under its registry', async () => {
    const config = await corpConfig()
    expect(authorizationFor(config, 'https://npm.corp.example/api/@corp%2Flib')).toBe(
      'Bearer tok-123',
    )
  })

  it('never sends a token to another host, even one sharing its prefix', async () => {
    const config = await corpConfig()
    expect(authorizationFor(config, 'https://registry.npmjs.org/lodash')).toBeUndefined()
    expect(authorizationFor(config, 'https://npm.corp.example.evil.test/api/x')).toBeUndefined()
    expect(authorizationFor(config, 'https://npm.corp.example/other/x')).toBeUndefined()
  })

  it('never sends a token over plain http to a remote host', async () => {
    const config = await corpConfig()
    expect(authorizationFor(config, 'http://npm.corp.example/api/x')).toBeUndefined()
  })

  it('builds basic auth from username and base64 password', async () => {
    const config = await corpConfig()
    expect(authorizationFor(config, 'https://basic.example/pkg')).toBe(
      `Basic ${Buffer.from('me:pw').toString('base64')}`,
    )
  })

  it('fetches a scoped package from its registry with its token, and nothing else with it', async () => {
    const config = await corpConfig()
    const calls: { url: string; headers: Record<string, string> }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
        return new Response(JSON.stringify({ 'dist-tags': { latest: '1.0.0' } }), { status: 200 })
      }),
    )
    const { fetchPackageInfo } = await import('../src/server/core/registry.ts')
    await fetchPackageInfo('@corp/lib', undefined, config)
    await fetchPackageInfo('lodash', undefined, config)

    expect(calls[0]?.url).toBe('https://npm.corp.example/api/@corp%2Flib')
    expect(calls[0]?.headers.authorization).toBe('Bearer tok-123')
    expect(calls[1]?.url).toBe('https://registry.npmjs.org/lodash')
    expect(calls[1]?.headers.authorization).toBeUndefined()
  })

  it('does not send privately scoped package names to OSV', async () => {
    const config = await corpConfig()
    const bodies: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('osv')) bodies.push(String(init?.body))
        return new Response(JSON.stringify({ results: [{}] }), { status: 200 })
      }),
    )
    const { enrichReport } = await import('../src/server/core/enrich.ts')
    const rows = await enrichReport(
      {
        project: {
          scope: 'project',
          path: project,
          displayPath: project,
          name: 'p',
          packageManager: 'npm',
          lockfile: null,
          hasNodeModules: true,
        },
        dependencies: [
          {
            name: '@corp/lib',
            kind: 'prod',
            declared: '^1.0.0',
            installed: '1.0.0',
            latest: null,
            outdated: 'unknown',
            alignment: 'aligned',
            deprecated: null,
            vulnerabilities: null,
          },
        ],
        drift: null,
        alignment: 'aligned',
        generatedAt: '',
      },
      undefined,
      config,
    )
    expect(bodies.join('')).not.toContain('@corp/lib')
    expect(rows[0]?.vulnerabilityCheck).toBe('private')
  })
})
