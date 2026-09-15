import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { startServer, type RunningServer } from '../src/server/index.ts'
import { sessionToken } from '../src/server/security.ts'
import type { DependencyReport } from '../src/shared/types.ts'

const projectPath = fileURLToPath(new URL('./fixtures/pnpm-project', import.meta.url))

/**
 * Tests always bind port 0 so the OS assigns a free one. The production default is a
 * fixed port, and several servers run per file (plus files in parallel), so inheriting
 * that default makes them race for the same port range.
 */
describe('GET /api/deps', () => {
  let server: RunningServer
  let base: string

  beforeAll(async () => {
    server = await startServer({ projectPath, port: 0 })
    base = `http://127.0.0.1:${server.port}`
  })

  afterAll(async () => {
    await server.close()
  })

  it('returns the report for the launched project', async () => {
    const response = await fetch(`${base}/api/deps?t=${sessionToken}`)
    expect(response.status).toBe(200)

    const report = (await response.json()) as DependencyReport
    expect(report.project.packageManager).toBe('pnpm')
    expect(report.dependencies.length).toBeGreaterThan(0)
  })

  it('refuses to read a project outside the allowlist', async () => {
    const response = await fetch(
      `${base}/api/deps?t=${sessionToken}&path=${encodeURIComponent('/etc')}`,
    )
    expect(response.status).toBe(403)
  })

  it('refuses a traversal attempt dressed up as a project path', async () => {
    const escape = `${projectPath}/../../../..`
    const response = await fetch(
      `${base}/api/deps?t=${sessionToken}&path=${encodeURIComponent(escape)}`,
    )
    expect(response.status).toBe(403)
  })

  it('still requires a token', async () => {
    const response = await fetch(`${base}/api/deps`)
    expect(response.status).toBe(401)
  })
})

describe('removal gate', () => {
  let server: RunningServer
  let base: string

  beforeAll(async () => {
    server = await startServer({ projectPath, port: 0 })
    base = `http://127.0.0.1:${server.port}`
  })

  afterAll(async () => {
    await server.close()
  })

  const post = (body: unknown) =>
    fetch(`${base}/api/mutate?t=${sessionToken}`, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('refuses a removal with no confirm field', async () => {
    const response = await post({ action: 'remove', name: 'aligned-pkg', kind: 'prod' })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('confirm'),
    })
  })

  it('refuses a removal whose confirm does not match the name', async () => {
    const response = await post({
      action: 'remove',
      name: 'aligned-pkg',
      kind: 'prod',
      confirm: 'aligned-pkgg',
    })
    expect(response.status).toBe(400)
  })

  it('refuses a confirm that matches a different package', async () => {
    const response = await post({
      action: 'remove',
      name: 'aligned-pkg',
      kind: 'prod',
      confirm: 'drifted-pkg',
    })
    expect(response.status).toBe(400)
  })

  it('does not require confirm for an upgrade', async () => {
    // Rejected for an invalid name, not for a missing confirm — proving the gate
    // is specific to removal rather than applied to every mutation.
    const response = await post({ action: 'upgrade', name: 'not a valid name!', version: '1.0.0' })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('Invalid package name'),
    })
  })
})

describe('batch limits', () => {
  let server: RunningServer
  let base: string

  beforeAll(async () => {
    server = await startServer({ projectPath, port: 0 })
    base = `http://127.0.0.1:${server.port}`
  })

  afterAll(async () => {
    await server.close()
  })

  it('refuses a batch larger than the cap', async () => {
    const packages = Array.from({ length: 101 }, (_unused, index) => ({
      name: `pkg-${index}`,
      version: '1.0.0',
      kind: 'prod',
    }))

    const response = await fetch(`${base}/api/mutate?t=${sessionToken}`, {
      method: 'POST',
      headers: {
        origin: `http://127.0.0.1:${server.port}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'upgrade', packages }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('limited to 100'),
    })
  })
})

describe('GET /api/impact', () => {
  let server: RunningServer
  let base: string

  beforeAll(async () => {
    server = await startServer({ projectPath, port: 0 })
    base = `http://127.0.0.1:${server.port}`
  })

  afterAll(async () => {
    await server.close()
  })

  it('reports impact for a package with no usages', async () => {
    const response = await fetch(
      `${base}/api/impact?t=${sessionToken}&name=aligned-pkg`,
    )
    expect(response.status).toBe(200)

    const impact = (await response.json()) as { risk: string; usageFileCount: number }
    expect(impact.usageFileCount).toBe(0)
    expect(impact.risk).toBe('safe')
  })

  it('validates the package name', async () => {
    const response = await fetch(`${base}/api/impact?t=${sessionToken}&name=../../etc`)
    expect(response.status).toBe(400)
  })

  // These are names the old per-route regex accepted. They are joined into
  // node_modules/<name> and into registry URLs, where a dot segment traverses.
  it.each(['..', '.', '@../..', '@./x', '-rf'])(
    'refuses %j as a package name on both name-taking routes',
    async (name) => {
      for (const route of ['impact', 'package']) {
        const response = await fetch(
          `${base}/api/${route}?t=${sessionToken}&name=${encodeURIComponent(name)}`,
        )
        expect(response.status).toBe(400)
      }
    },
  )

  it('still accepts a legacy uppercase package name', async () => {
    // JSONStream and friends predate npm's lowercase rule and are still installable,
    // so the validator must not treat them as suspicious.
    const response = await fetch(`${base}/api/impact?t=${sessionToken}&name=JSONStream`)
    expect(response.status).toBe(200)
  })

  it('requires a token', async () => {
    const response = await fetch(`${base}/api/impact?name=aligned-pkg`)
    expect(response.status).toBe(401)
  })
})
