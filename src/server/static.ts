import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The built SPA lives at dist/ui; this module is bundled to dist/server/index.js. */
const uiRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../ui')

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

/**
 * Resolves a URL pathname to a file inside the UI root, or null if it escapes.
 * Normalizing before joining is what stops `../` traversal.
 */
function resolveWithinUiRoot(pathname: string): string | null {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\.]+)/, '')
  const candidate = join(uiRoot, relative)
  if (candidate !== uiRoot && !candidate.startsWith(uiRoot + sep)) return null
  return candidate
}

export async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const resolved = resolveWithinUiRoot(pathname === '/' ? '/index.html' : pathname)
  if (resolved === null) {
    res.writeHead(403).end('Forbidden')
    return
  }

  let filePath = resolved
  let info = await stat(filePath).catch(() => null)

  // SPA fallback: unknown paths render the app shell rather than 404ing.
  if (info === null || info.isDirectory()) {
    filePath = join(uiRoot, 'index.html')
    info = await stat(filePath).catch(() => null)
  }

  if (info === null) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('packui UI is not built. Run `pnpm build:ui`.')
    return
  }

  const ext = extname(filePath)
  // Vite fingerprints hashed assets, so they are safe to cache forever.
  // index.html must never be, or upgrades would not be picked up.
  const cacheControl = filePath.endsWith('index.html')
    ? 'no-cache'
    : 'public, max-age=31536000, immutable'

  res.writeHead(200, {
    'content-type': MIME_TYPES[ext] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': cacheControl,
  })
  createReadStream(filePath).pipe(res)
}
