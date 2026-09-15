import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

/**
 * packui's API can execute package manager commands against real projects, so the
 * server is treated as a privileged surface even though it only listens on loopback.
 * Any page in the user's browser can reach 127.0.0.1, so loopback alone is not a boundary.
 */

/**
 * Per-session bearer token. Regenerated every boot; never written to disk.
 *
 * In dev, `scripts/dev.mjs` generates the token up front and passes it to both the
 * server and the Vite proxy so the proxied UI can authenticate. This is only honored
 * when PACKUI_DEV is set, so a stray env var can never weaken a real session.
 */
export const sessionToken =
  process.env.PACKUI_DEV === '1' && process.env.PACKUI_TOKEN
    ? process.env.PACKUI_TOKEN
    : randomBytes(32).toString('base64url')

/** Where `pnpm dev` serves the UI. See vite.config.ts. */
const DEV_UI_PORT = 7332

function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** Accepts the token from an Authorization header or the `t` query parameter. */
export function hasValidToken(req: IncomingMessage, url: URL): boolean {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    return safeEquals(header.slice('Bearer '.length), sessionToken)
  }
  const query = url.searchParams.get('t')
  return query !== null && safeEquals(query, sessionToken)
}

/**
 * Rejects cross-origin requests, which is the defense against DNS rebinding:
 * an attacker-controlled page that resolves a hostname to 127.0.0.1 still sends
 * its own Origin, and a browser will not let it forge one.
 */
export function hasAllowedOrigin(req: IncomingMessage, port: number): boolean {
  const origin = req.headers.origin
  // Same-origin non-CORS requests (and non-browser clients) may omit Origin entirely.
  if (origin === undefined) return true

  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  const isLoopbackHost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
  if (!isLoopbackHost) return false

  // The Vite dev server runs on its own port and proxies to us, so it has to be
  // allowed — but only while it exists. In a released build 7332 is just a port any
  // local process can bind, and trusting it there would hand mutation rights to
  // whatever happens to be listening on it.
  const allowedPorts = new Set([String(port)])
  if (process.env.PACKUI_DEV === '1') allowedPorts.add(String(DEV_UI_PORT))

  return allowedPorts.has(parsed.port)
}
