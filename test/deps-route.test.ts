import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { startServer, type RunningServer } from '../src/server/index.ts'
import { sessionToken } from '../src/server/security.ts'
import type { DependencyReport } from '../src/shared/types.ts'

const projectPath = fileURLToPath(new URL('./fixtures/pnpm-project', import.meta.url))

describe('GET /api/deps', () => {
  let server: RunningServer
  let base: string

  beforeAll(async () => {
    server = await startServer({ projectPath })
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
    server = await startServer({ projectPath })
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

describe('GET /api/impact', () => {
  let server: RunningServer
  let base: string

  beforeAll(async () => {
    server = await startServer({ projectPath })
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

  it('requires a token', async () => {
    const response = await fetch(`${base}/api/impact?name=aligned-pkg`)
    expect(response.status).toBe(401)
  })
})
