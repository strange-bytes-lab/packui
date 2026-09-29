import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Recent projects extend the allowlist, so these check both halves: that a project
 * launched before becomes switchable, and that nothing else does.
 */
const npmProject = fileURLToPath(new URL('./fixtures/npm-project', import.meta.url))
const pnpmProject = fileURLToPath(new URL('./fixtures/pnpm-project', import.meta.url))

let home: string
const originalHome = process.env.HOME

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'packui-recent-'))
  process.env.HOME = home
  // ~/.packui is resolved at import time.
  vi.resetModules()
})

afterEach(async () => {
  process.env.HOME = originalHome
  await rm(home, { recursive: true, force: true })
})

async function boot(projectPath: string, rememberProjects: boolean) {
  const { startServer } = await import('../src/server/index.ts')
  const { sessionToken } = await import('../src/server/security.ts')
  const server = await startServer({ projectPath, port: 0, rememberProjects })
  const get = (path: string) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    })
  return { server, get }
}

describe('recent projects', () => {
  it('records the launched project', async () => {
    const { server } = await boot(npmProject, true)
    await server.close()
    const stored = JSON.parse(await readFile(join(home, '.packui', 'recent.json'), 'utf8')) as {
      projects: { path: string }[]
    }
    expect(stored.projects.map((entry) => entry.path)).toEqual([npmProject])
  })

  it('makes a previously launched project readable and lists it', async () => {
    const first = await boot(npmProject, true)
    await first.server.close()

    const { server, get } = await boot(pnpmProject, true)
    try {
      const deps = await get(`/api/deps?path=${encodeURIComponent(npmProject)}`)
      expect(deps.status).toBe(200)

      const projects = (await (await get('/api/projects')).json()) as {
        recent: { path: string; name: string }[]
      }
      expect(projects.recent.map((entry) => entry.path)).toEqual([pnpmProject, npmProject])
      expect(projects.recent[1]?.name).toBe('npm-fixture')
    } finally {
      await server.close()
    }
  })

  it('neither records nor trusts history unless asked to', async () => {
    const first = await boot(npmProject, true)
    await first.server.close()

    const { server, get } = await boot(pnpmProject, false)
    try {
      const deps = await get(`/api/deps?path=${encodeURIComponent(npmProject)}`)
      expect(deps.status).toBe(403)
      const projects = (await (await get('/api/projects')).json()) as { recent: unknown[] }
      expect(projects.recent).toEqual([])
    } finally {
      await server.close()
    }
  })

  it('still refuses paths that were never launched', async () => {
    const { server, get } = await boot(pnpmProject, true)
    try {
      const response = await get(`/api/deps?path=${encodeURIComponent('/etc')}`)
      expect(response.status).toBe(403)
    } finally {
      await server.close()
    }
  })
})
