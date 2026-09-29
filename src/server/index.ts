import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createProjectAccess, type RefreshableAccess } from './api/access.ts'
import { createDepsHandler } from './api/deps.ts'
import { createEnrichHandler } from './api/enrich.ts'
import { globalDepsHandler, globalScopesHandler } from './api/globals.ts'
import { createImpactHandler } from './api/impact.ts'
import { pruneCache } from './core/cache.ts'
import { listRecentProjects, recordRecentProject } from './core/recent.ts'
import { toDisplayPath } from './core/report.ts'
import { createMutateHandler, createRollbackHandler, createSnapshotsHandler } from './api/mutate.ts'
import { createPackageHandler } from './api/package.ts'
import { createWorkspaceHandler } from './api/workspace.ts'
import { Router, sendError, sendJson } from './router.ts'
import { hasAllowedOrigin, hasValidToken, sessionToken } from './security.ts'
import { serveStatic } from './static.ts'

/**
 * "PACK" on a phone keypad. Deliberately not in the range everyone's dev servers
 * live in — 3000, 5173, 8080 and friends collide constantly, and a stable port means
 * a bookmarked packui tab keeps working across restarts. If it is taken, the server
 * walks upward rather than failing.
 */
export const DEFAULT_PORT = 7225

const PORT_ATTEMPTS = 20

export interface StartOptions {
  /** Absolute path of the project packui was launched against. */
  projectPath: string
  /** Preferred port. Defaults to DEFAULT_PORT; 0 lets the OS pick any free one. */
  port?: number
  /**
   * Record this project in ~/.packui/recent.json and allow switching to the ones
   * recorded before. The CLI turns this on; tests and embedders leave it off so they
   * neither write to nor trust the user's history.
   */
  rememberProjects?: boolean
}

export interface RunningServer {
  url: string
  port: number
  close: () => Promise<void>
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function buildRouter(options: StartOptions, access: RefreshableAccess): Router {
  const router = new Router()

  router.get('/api/health', ({ res }) => {
    sendJson(res, 200, { ok: true, projectPath: options.projectPath })
  })

  router.get('/api/workspace', createWorkspaceHandler(access))

  router.get('/api/projects', async ({ res }) => {
    const recent = options.rememberProjects === true ? await listRecentProjects() : []
    await access.refresh()
    const allowed = new Set(access.allowedProjects())
    sendJson(res, 200, {
      recent: recent
        .filter((entry) => allowed.has(entry.path))
        .map((entry) => ({ ...entry, displayPath: toDisplayPath(entry.path) })),
    })
  })
  router.get('/api/deps', createDepsHandler(access))
  router.get('/api/enrich', createEnrichHandler(access))
  router.get('/api/package', createPackageHandler(access))
  router.get('/api/snapshots', createSnapshotsHandler(access))
  router.get('/api/impact', createImpactHandler(access))

  // Global scopes are discovered from the package managers themselves rather than
  // supplied by the client, so they need no path allowlist.
  router.get('/api/global/scopes', globalScopesHandler)
  router.get('/api/global/deps', globalDepsHandler)

  // Write endpoints. These additionally require a loopback Origin, enforced for all
  // mutating methods in the request handler below.
  router.post('/api/mutate', createMutateHandler(access))
  router.post('/api/rollback', createRollbackHandler(access))

  return router
}

export async function startServer(options: StartOptions): Promise<RunningServer> {
  // Nothing else deletes a cache entry, and a boot is the one moment where spending a
  // little disk IO costs the user nothing. Not awaited: it must never delay the UI.
  void pruneCache()

  if (options.rememberProjects === true) await recordRecentProject(options.projectPath)
  const access = createProjectAccess(options.projectPath, async () =>
    options.rememberProjects === true
      ? (await listRecentProjects()).map((entry) => entry.path)
      : [],
  )
  await access.refresh()
  const router = buildRouter(options, access)

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

  const preferred = options.port ?? DEFAULT_PORT

  const listenOn = (port: number): Promise<void> =>
    new Promise<void>((resolvePromise, rejectPromise) => {
      const onError = (error: NodeJS.ErrnoException): void => rejectPromise(error)
      server.once('error', onError)
      // Loopback only. Never 0.0.0.0 — this API can run package manager commands.
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError)
        resolvePromise()
      })
    })

  // An explicit 0 means "any free port", so there is nothing to walk.
  const candidates =
    preferred === 0
      ? [0]
      : Array.from({ length: PORT_ATTEMPTS }, (_unused, offset) => preferred + offset)

  let listenError: unknown = null
  for (const candidate of candidates) {
    try {
      await listenOn(candidate)
      listenError = null
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // Only a busy port is worth retrying; anything else is a real failure.
      if (code !== 'EADDRINUSE') throw error
      listenError = error
    }
  }
  if (listenError !== null) throw listenError

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
