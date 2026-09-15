import type { IncomingMessage, ServerResponse } from 'node:http'

export interface RequestContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
}

export type Handler = (ctx: RequestContext) => Promise<void> | void

interface Route {
  method: string
  pattern: string
  handler: Handler
}

/**
 * A deliberately small router. packui has a handful of endpoints and no need for
 * path parameters yet, so matching is exact and there is no framework to ship.
 */
export class Router {
  readonly #routes: Route[] = []

  add(method: string, pattern: string, handler: Handler): this {
    this.#routes.push({ method, pattern, handler })
    return this
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler)
  }

  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler)
  }

  delete(pattern: string, handler: Handler): this {
    return this.add('DELETE', pattern, handler)
  }

  match(method: string, pathname: string): Handler | null {
    const route = this.#routes.find((r) => r.method === method && r.pattern === pathname)
    return route?.handler ?? null
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message })
}
