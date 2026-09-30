import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restoreHome, setHome } from './helpers/home.ts'

let home: string
const saved = { ...process.env }

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'packui-version-'))
  setHome(home)
  delete process.env.PACKUI_NO_UPDATE_CHECK
  delete process.env.NO_UPDATE_NOTIFIER
  process.env.NPM_CONFIG_USERCONFIG = join(home, '.npmrc')
  vi.resetModules()
})

afterEach(async () => {
  restoreHome()
  vi.unstubAllGlobals()
  for (const key of ['PACKUI_NO_UPDATE_CHECK', 'NO_UPDATE_NOTIFIER', 'NPM_CONFIG_USERCONFIG']) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  await rm(home, { recursive: true, force: true })
})

function stubLatest(latest: string) {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ 'dist-tags': { latest }, versions: {} })),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const own = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}

describe('update check', () => {
  it("reads the running version from packui's own package.json", async () => {
    const { currentVersion } = await import('../src/server/core/version.ts')
    expect(await currentVersion()).toBe(own.version)
  })

  it('announces only a newer version on the latest tag', async () => {
    const { isNewer } = await import('../src/server/core/version.ts')
    expect(isNewer('0.4.0', '0.3.0')).toBe(true)
    expect(isNewer('0.3.0', '0.3.0')).toBe(false)
    expect(isNewer('0.2.9', '0.3.0')).toBe(false)
    expect(isNewer(null, '0.3.0')).toBe(false)
    expect(isNewer('not-a-version', '0.3.0')).toBe(false)
  })

  it('asks the registry for the abbreviated packument', async () => {
    const fetchMock = stubLatest('99.0.0')
    const { checkForUpdate } = await import('../src/server/core/version.ts')
    expect(await checkForUpdate()).toEqual({
      current: own.version,
      latest: '99.0.0',
      updateAvailable: true,
    })
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toBe('https://registry.npmjs.org/@strange-bytes%2Fpackui')
  })

  it('treats offline as no update known, never as an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    const { checkForUpdate } = await import('../src/server/core/version.ts')
    expect(await checkForUpdate()).toEqual({
      current: own.version,
      latest: null,
      updateAvailable: false,
    })
  })

  it.each(['PACKUI_NO_UPDATE_CHECK', 'NO_UPDATE_NOTIFIER'])('is turned off by %s', async (key) => {
    process.env[key] = '1'
    const fetchMock = stubLatest('99.0.0')
    const { checkForUpdate } = await import('../src/server/core/version.ts')
    expect((await checkForUpdate()).updateAvailable).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
