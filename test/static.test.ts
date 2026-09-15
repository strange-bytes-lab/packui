import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serveStatic } from '../src/server/static.ts'

/** Anything that escapes dist/ui would expose the user's filesystem over HTTP. */
describe('static file serving', () => {
  async function request(path: string): Promise<{ status: number; body: string }> {
    const server = createServer((req, res) => {
      void serveStatic(new URL(req.url ?? '/', 'http://127.0.0.1').pathname, res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`)
      return { status: response.status, body: await response.text() }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  it('serves the app shell at the root', async () => {
    const { status, body } = await request('/')
    expect(status).toBe(200)
    expect(body).toContain('<div id="app">')
  })

  it.each([
    '/../package.json',
    '/%2e%2e%2fpackage.json',
    '/../../../../etc/passwd',
    '/assets/../../package.json',
  ])('does not escape the UI root for %s', async (path) => {
    const { body } = await request(path)
    expect(body).not.toContain('"name": "packui"')
    expect(body).not.toContain('root:')
  })

  it('falls back to the app shell for unknown paths', async () => {
    const { status, body } = await request('/projects/some-project')
    expect(status).toBe(200)
    expect(body).toContain('<div id="app">')
  })
})
