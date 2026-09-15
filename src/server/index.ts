import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Router, sendError, sendJson } from './router.ts'
import { hasAllowedOrigin, hasValidToken, sessionToken } from './security.ts'
import { serveStatic } from './static.ts'

export interface StartOptions {
  /** Absolute path of the project packui was launched against. */
  projectPath: string
  /** Preferred port; 0 lets the OS pick a free one. */
  port?: number
}

export interface RunningServer {
  url: string
  port: number
  close: () => Promise<void>
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function buildRouter(options: StartOptions): Router {
  const router = new Router()

  router.get('/api/health', ({ res }) => {
    sendJson(res, 200, { ok: true, projectPath: options.projectPath })
  })

  return router
}

export async function startServer(options: StartOptions): Promise<RunningServer> {
  const router = buildRouter(options)

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // The Host header is untrusted; it only ever fills in the base of a URL we parse.
    const url = new URL(req.url ?? '/', `http://127.0.0.1`)

    if (!url.pathname.startsWith('/api/')) {
      void serveStatic(url.pathname, res).catch(() => {
        res.writeHead(500).end('Internal error')
      })
      return
    }

    const port = (server.address() as AddressInfo | null)?.port ?? 0
    if (MUTATING_METHODS.has(req.method ?? '') && !hasAllowedOrigin(req, port)) {
      sendError(res, 403, 'Cross-origin request rejected')
      return
    }
    if (!hasValidToken(req, url)) {
      sendError(res, 401, 'Missing or invalid session token')
      return
    }

    const handler = router.match(req.method ?? 'GET', url.pathname)
    if (handler === null) {
      sendError(res, 404, 'Not found')
      return
    }

    void (async () => {
      try {
        await handler({ req, res, url })
      } catch (error) {
        if (!res.headersSent) {
          sendError(res, 500, error instanceof Error ? error.message : 'Internal error')
        }
      }
    })()
  })

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    // Loopback only. Never 0.0.0.0 — this API can run package manager commands.
    server.listen(options.port ?? 0, '127.0.0.1', resolvePromise)
  })

  const port = (server.address() as AddressInfo).port

  return {
    port,
    url: `http://127.0.0.1:${port}/?t=${sessionToken}`,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise())
      }),
  }
}
