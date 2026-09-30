import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restoreHome, setHome } from './helpers/home.ts'

/**
 * Adding a project extends the path allowlist from a request, so these pin down what
 * it accepts, what it requires of the request, and that nothing else changes the list.
 */

let home: string
let dev: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'packui-projects-home-'))
  dev = await mkdtemp(join(tmpdir(), 'packui-projects-dev-'))
  setHome(home)
  vi.resetModules()

  // A "dev folder": two projects, a plain folder, a hidden one and a node_modules.
  for (const [path, manifest] of [
    ['app', { name: 'app', version: '1.0.0', dependencies: {} }],
    ['lib', { version: '1.0.0' }],
    ['node_modules/dep', { name: 'dep', version: '1.0.0' }],
    ['.hidden', { name: 'hidden', version: '1.0.0' }],
  ] as const) {
    await mkdir(join(dev, path), { recursive: true })
    await writeFile(join(dev, path, 'package.json'), JSON.stringify(manifest))
  }
  await mkdir(join(dev, 'plain'))
})

afterEach(async () => {
  restoreHome()
  await rm(home, { recursive: true, force: true })
  await rm(dev, { recursive: true, force: true })
})

async function boot(options: { projectPath: string | null; rememberProjects?: boolean }) {
  const { startServer } = await import('../src/server/index.ts')
  const { sessionToken } = await import('../src/server/security.ts')
  const server = await startServer({ ...options, startDir: dev, port: 0 })
  const base = `http://127.0.0.1:${server.port}`
  const auth = { authorization: `Bearer ${sessionToken}` }
  const get = (path: string) => fetch(`${base}${path}`, { headers: auth })
  const send = (method: string, path: string, body?: unknown, origin = base) =>
    fetch(`${base}${path}`, {
      method,
      headers: { ...auth, origin, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return { server, base, get, send, sessionToken }
}

describe('launched outside a project', () => {
  it('reports no launched project and refuses requests that name none', async () => {
    const { server, get } = await boot({ projectPath: null })
    try {
      const projects = (await (await get('/api/projects')).json()) as {
        launched: string | null
        startDir: string
        recent: unknown[]
      }
      expect(projects).toEqual({ launched: null, startDir: dev, recent: [] })
      expect((await get('/api/deps')).status).toBe(403)
      expect((await get(`/api/deps?path=${encodeURIComponent(join(dev, 'app'))}`)).status).toBe(403)
    } finally {
      await server.close()
    }
  })
})

describe('folder picker', () => {
  it('lists folders one level deep, marks projects and hides dot folders and node_modules', async () => {
    const { server, get } = await boot({ projectPath: null })
    try {
      const listing = (await (await get('/api/browse')).json()) as {
        path: string
        parent: string | null
        isProject: boolean
        entries: { name: string; isProject: boolean }[]
      }
      expect(listing.path).toBe(dev)
      expect(listing.isProject).toBe(false)
      expect(listing.parent).not.toBeNull()
      expect(listing.entries.map((entry) => [entry.name, entry.isProject])).toEqual([
        ['app', true],
        ['lib', true],
        ['plain', false],
      ])
    } finally {
      await server.close()
    }
  })

  it('resolves a relative path against the start folder and says so for an unreadable one', async () => {
    const { server, get } = await boot({ projectPath: null })
    try {
      const listing = (await (await get('/api/browse?path=app')).json()) as { isProject: boolean }
      expect(listing.isProject).toBe(true)
      expect((await get('/api/browse?path=missing')).status).toBe(404)
    } finally {
      await server.close()
    }
  })
})

describe('adding a project', () => {
  it('makes the folder readable and lists it, for the session only when not remembering', async () => {
    const { server, get, send } = await boot({ projectPath: null })
    try {
      const response = await send('POST', '/api/projects', { path: join(dev, 'app') })
      expect(response.status).toBe(200)
      const { project } = (await response.json()) as { project: { name: string; path: string } }
      expect(project).toMatchObject({ name: 'app', path: join(dev, 'app') })

      expect((await get(`/api/deps?path=${encodeURIComponent(join(dev, 'app'))}`)).status).toBe(200)
      const projects = (await (await get('/api/projects')).json()) as {
        recent: { name: string }[]
      }
      expect(projects.recent.map((entry) => entry.name)).toEqual(['app'])
      // A folder with no name in its manifest is named after the folder.
      await send('POST', '/api/projects', { path: 'lib' })
      const after = (await (await get('/api/projects')).json()) as { recent: { name: string }[] }
      expect(after.recent.map((entry) => entry.name)).toEqual(['lib', 'app'])
    } finally {
      await server.close()
    }
    await expect(readFile(join(home, '.packui', 'recent.json'), 'utf8')).rejects.toThrow()
  })

  it('accepts only a folder holding a package.json, outside node_modules', async () => {
    const { server, send } = await boot({ projectPath: null })
    try {
      expect((await send('POST', '/api/projects', { path: join(dev, 'plain') })).status).toBe(422)
      expect((await send('POST', '/api/projects', { path: join(dev, 'nope') })).status).toBe(404)
      expect(
        (await send('POST', '/api/projects', { path: join(dev, 'node_modules', 'dep') })).status,
      ).toBe(400)
      expect((await send('POST', '/api/projects', {})).status).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('is a write like any other: token and loopback Origin required', async () => {
    const { server, base, send } = await boot({ projectPath: null })
    try {
      const body = JSON.stringify({ path: join(dev, 'app') })
      const noToken = await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: { origin: base, 'content-type': 'application/json' },
        body,
      })
      expect(noToken.status).toBe(401)
      const crossOrigin = await send(
        'POST',
        '/api/projects',
        { path: join(dev, 'app') },
        'https://evil.example',
      )
      expect(crossOrigin.status).toBe(403)
    } finally {
      await server.close()
    }
  })

  it('remembers additions across restarts when asked to, and forgets them on request', async () => {
    const app = join(dev, 'app')
    const first = await boot({ projectPath: null, rememberProjects: true })
    expect((await first.send('POST', '/api/projects', { path: app })).status).toBe(200)
    await first.server.close()

    const stored = JSON.parse(await readFile(join(home, '.packui', 'recent.json'), 'utf8')) as {
      projects: { path: string }[]
    }
    expect(stored.projects.map((entry) => entry.path)).toEqual([app])

    vi.resetModules()
    const second = await boot({ projectPath: null, rememberProjects: true })
    try {
      const path = encodeURIComponent(app)
      expect((await second.get(`/api/deps?path=${path}`)).status).toBe(200)
      expect((await second.send('DELETE', `/api/projects?path=${path}`)).status).toBe(200)
      expect((await second.get(`/api/deps?path=${path}`)).status).toBe(403)
    } finally {
      await second.server.close()
    }
  })

  it('will not forget the launched project', async () => {
    const app = join(dev, 'app')
    const { server, send } = await boot({ projectPath: app })
    try {
      const response = await send('DELETE', `/api/projects?path=${encodeURIComponent(app)}`)
      expect(response.status).toBe(400)
    } finally {
      await server.close()
    }
  })
})
