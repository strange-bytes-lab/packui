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
