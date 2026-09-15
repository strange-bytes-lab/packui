import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SECURITY_HEADERS } from './router.ts'

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
 * The second layer under the README renderer.
 *
 * `composables/markdown.ts` is safe by construction and stays that way; this is what
 * makes a future bug in it non-exploitable rather than merely unlikely. Everything the
 * UI needs is same-origin, so the policy can be this narrow: no inline script (the
 * theme bootstrap is a real file for exactly this reason), no remote anything, and no
 * framing. `data:` is allowed for images only because the bundler inlines small icons;
 * a README's images never become <img> at all.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

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
    res.writeHead(403, SECURITY_HEADERS).end('Forbidden')
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
    res.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain' })
    res.end('packui UI is not built. Run `pnpm build:ui`.')
    return
  }

  const ext = extname(filePath)
  const isHtml = ext === '.html'

  // Only Vite's fingerprinted output is safe to cache forever. Anything else — the
  // shell, the theme bootstrap — keeps its name across releases, so caching it
  // immutably would pin users to whichever version they first loaded.
  const isFingerprinted = filePath.startsWith(join(uiRoot, 'assets') + sep)

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': MIME_TYPES[ext] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': isFingerprinted ? 'public, max-age=31536000, immutable' : 'no-cache',
    // Only the document needs a policy; it governs everything it then loads.
    ...(isHtml ? { 'content-security-policy': CONTENT_SECURITY_POLICY } : {}),
  })
  createReadStream(filePath).pipe(res)
}
