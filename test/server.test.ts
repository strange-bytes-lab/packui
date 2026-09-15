import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer, type RunningServer } from '../src/server/index.ts'
import { sessionToken } from '../src/server/security.ts'

/**
 * The API can run package manager commands against real projects, so these are
 * not incidental checks — they are the boundary that makes the server safe to run.
 */
/**
 * Tests always bind port 0 so the OS assigns a free one. The production default is a
 * fixed port, and several servers run per file (plus files in parallel), so inheriting
 * that default makes them race for the same port range.
 */
describe('server security boundary', () => {
  let server: RunningServer
  let base: string

  beforeAll(async () => {
    server = await startServer({ projectPath: process.cwd(), port: 0 })
    base = `http://127.0.0.1:${server.port}`
  })

  afterAll(async () => {
    await server.close()
  })

  it('serves an API request carrying a valid token', async () => {
    const response = await fetch(`${base}/api/health?t=${sessionToken}`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true })
  })

  it('accepts the token via the Authorization header', async () => {
    const response = await fetch(`${base}/api/health`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    })
    expect(response.status).toBe(200)
  })

  it('rejects an API request with no token', async () => {
    const response = await fetch(`${base}/api/health`)
    expect(response.status).toBe(401)
  })

  it('rejects an API request with a wrong token', async () => {
    const response = await fetch(`${base}/api/health?t=not-the-token`)
    expect(response.status).toBe(401)
  })

  it('rejects a mutating request from a foreign origin even with a valid token', async () => {
    const response = await fetch(`${base}/api/health?t=${sessionToken}`, {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
    })
    expect(response.status).toBe(403)
  })

  it('allows a mutating request from the loopback UI origin', async () => {
    const response = await fetch(`${base}/api/health?t=${sessionToken}`, {
      method: 'POST',
      headers: { origin: `http://127.0.0.1:${server.port}` },
    })
    // 404 because /api/health has no POST route — the point is it got past the origin gate.
    expect(response.status).toBe(404)
  })

  it('binds to loopback only', () => {
    expect(server.url).toContain('127.0.0.1')
  })
})
