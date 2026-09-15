/**
 * The server requires a per-session token on every /api call. The CLI puts it in
 * the opening URL; we capture it once and strip it from the address bar so it does
 * not linger in browser history, screenshots or shared links.
 */
const token = (() => {
  const url = new URL(window.location.href)
  const fromQuery = url.searchParams.get('t')
  if (fromQuery !== null) {
    url.searchParams.delete('t')
    window.history.replaceState(null, '', url)
    sessionStorage.setItem('packui:token', fromQuery)
    return fromQuery
  }
  return sessionStorage.getItem('packui:token') ?? ''
})()

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  })

  if (!response.ok) {
    const detail = await response
      .json()
      .then((body: { error?: string }) => body.error)
      .catch(() => null)
    throw new ApiError(detail ?? response.statusText, response.status)
  }

  return (await response.json()) as T
}
