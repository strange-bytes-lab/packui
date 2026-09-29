import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Registry configuration from `.npmrc`, so packages from a private registry are looked
 * up where they actually live instead of being reported as "not checked" forever.
 *
 * Only what packui needs is read: the default registry, per-scope registries, and the
 * credentials keyed to a registry URL. Credentials are the sensitive part, and the
 * rules for them are narrow on purpose:
 *
 * - A credential is sent only to the registry it is keyed to, matched by host and
 *   path prefix exactly as npm keys it (`//host/path/:_authToken`). It is never sent
 *   to a different host, and never sent anywhere over plain http except loopback.
 * - Credentials never leave the server process: not to the browser, not into the
 *   cache under ~/.packui, not into an error message.
 *
 * Files are read lowest precedence first — the user's ~/.npmrc, then a workspace
 * root's, then the project's — so the nearest file wins, as it does for npm.
 */

export const PUBLIC_REGISTRY = 'https://registry.npmjs.org'

export interface RegistryAuth {
  /** `//host/path/` — the nerf-darted registry URL the credential belongs to. */
  prefix: string
  header: string
}

export interface RegistryConfig {
  /** The registry for unscoped packages, and scoped ones with no mapping. No trailing slash. */
  registry: string
  /** `@scope` to registry URL, for scopes mapped to their own registry. */
  scopes: Map<string, string>
  auth: RegistryAuth[]
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/** `${VAR}` and pnpm's `${VAR?}`. An unset variable expands to nothing, as in npm. */
function expandEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z0-9_]+)\??\}/g, (_match, name: string) => env[name] ?? '')
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Parses the ini subset npm writes: `key=value`, `;` and `#` comments, no sections. */
export function parseNpmrc(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): Map<string, string> {
  const values = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith(';') || line.startsWith('#') || line.startsWith('[')) {
      continue
    }
    const equals = line.indexOf('=')
    if (equals === -1) continue
    const key = expandEnv(line.slice(0, equals).trim(), env)
    values.set(key, expandEnv(unquote(line.slice(equals + 1)), env))
  }
  return values
}

/** `https://host/path` → `//host/path/`, the form npm keys credentials by. */
export function nerfDart(url: string): string | null {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`
    return `//${parsed.host}${path}`
  } catch {
    return null
  }
}

function buildConfig(files: ReadonlyArray<Map<string, string>>, fallback: string): RegistryConfig {
  const merged = new Map<string, string>()
  for (const file of files) for (const [key, value] of file) merged.set(key, value)

  const scopes = new Map<string, string>()
  const byPrefix = new Map<string, Map<string, string>>()

  for (const [key, value] of merged) {
    const scoped = /^(@[^:]+):registry$/.exec(key)
    if (scoped?.[1] !== undefined && value !== '') {
      scopes.set(scoped[1], trimSlash(value))
      continue
    }
    const credential = /^(\/\/.+?\/?):(_authToken|_auth|username|_password)$/.exec(key)
    if (credential?.[1] !== undefined && credential[2] !== undefined) {
      const prefix = credential[1].endsWith('/') ? credential[1] : `${credential[1]}/`
      const entry = byPrefix.get(prefix) ?? new Map<string, string>()
      entry.set(credential[2], value)
      byPrefix.set(prefix, entry)
    }
  }

  const auth: RegistryAuth[] = []
  for (const [prefix, fields] of byPrefix) {
    const token = fields.get('_authToken')
    const basic = fields.get('_auth')
    const username = fields.get('username')
    const password = fields.get('_password')
    let header: string | null = null
    if (token) header = `Bearer ${token}`
    else if (basic) header = `Basic ${basic}`
    else if (username && password) {
      // npm stores `_password` base64-encoded.
      const decoded = Buffer.from(password, 'base64').toString('utf8')
      header = `Basic ${Buffer.from(`${username}:${decoded}`).toString('base64')}`
    }
    if (header !== null) auth.push({ prefix, header })
  }
  // Longest prefix first, so the most specific credential wins.
  auth.sort((a, b) => b.prefix.length - a.prefix.length)

  const registry = merged.get('registry')
  return { registry: trimSlash(registry ? registry : fallback), scopes, auth }
}

async function readNpmrc(path: string): Promise<Map<string, string>> {
  try {
    return parseNpmrc(await readFile(path, 'utf8'))
  } catch {
    return new Map()
  }
}

/**
 * The registry configuration for a project. `directories` are read in order, lowest
 * precedence first, after the user config — pass the workspace root before the
 * package. With no directories this is the user's own configuration, which is what
 * global packages use.
 *
 * PACKUI_REGISTRY overrides the default registry for tests and offline mirrors; it
 * does not remove scope mappings.
 */
export async function loadRegistryConfig(
  directories: readonly string[] = [],
): Promise<RegistryConfig> {
  const userConfig = process.env.NPM_CONFIG_USERCONFIG ?? join(homedir(), '.npmrc')
  const files = await Promise.all(
    [userConfig, ...directories.map((dir) => join(dir, '.npmrc'))].map(readNpmrc),
  )
  const config = buildConfig(files, PUBLIC_REGISTRY)
  if (process.env.PACKUI_REGISTRY) config.registry = trimSlash(process.env.PACKUI_REGISTRY)
  return config
}

/** The configuration used when nothing has been read: the public registry, no auth. */
export function defaultRegistryConfig(): RegistryConfig {
  return {
    registry: trimSlash(process.env.PACKUI_REGISTRY ?? PUBLIC_REGISTRY),
    scopes: new Map(),
    auth: [],
  }
}

export function registryFor(config: RegistryConfig, name: string): string {
  if (name.startsWith('@')) {
    const scope = name.slice(0, name.indexOf('/'))
    const mapped = config.scopes.get(scope)
    if (mapped !== undefined) return mapped
  }
  return config.registry
}

/**
 * True when a package resolves through a registry its scope was explicitly mapped to.
 * Those are the packages OSV cannot know about, and whose names should not be sent to
 * a public vulnerability database in the first place.
 */
export function isPrivatelyScoped(config: RegistryConfig, name: string): boolean {
  if (!name.startsWith('@')) return false
  const mapped = config.scopes.get(name.slice(0, name.indexOf('/')))
  return mapped !== undefined && mapped !== trimSlash(PUBLIC_REGISTRY)
}

/**
 * The Authorization header for a request, or undefined. The credential's prefix must
 * match the request URL's host and leading path exactly, and the request must be
 * https — or http to loopback, where a local registry such as Verdaccio lives.
 */
export function authorizationFor(config: RegistryConfig, url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return undefined

  const target = `//${parsed.host}${parsed.pathname}`
  return config.auth.find((entry) => target.startsWith(entry.prefix))?.header
}
