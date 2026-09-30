import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { mapWithConcurrency } from '../core/cache.ts'
import { forgetRecentProject, listRecentProjects, recordRecentProject } from '../core/recent.ts'
import { toDisplayPath } from '../core/report.ts'
import { readJsonBody, sendError, sendJson, type RequestContext } from '../router.ts'
import type { RefreshableAccess } from './access.ts'

/**
 * The project list, and the two ways the user changes it from the UI: adding a folder
 * and forgetting one.
 *
 * Adding extends the path allowlist, so it is held to the same bar as every other
 * write: it is a POST, so the server has already checked the session token and a
 * loopback Origin before this runs. What it accepts is narrow — an existing directory
 * holding a package.json, outside any node_modules — so the allowlist still only
 * ever holds projects, never an arbitrary directory.
 */

export interface ProjectsOptions {
  /** The project packui was launched against, or null outside any project. */
  launched: string | null
  /** Where the folder picker opens, and what a relative path is resolved against. */
  startDir: string
  /** Persist additions to ~/.packui/recent.json. Off for tests and embedders. */
  remember: boolean
}

export interface ProjectEntry {
  path: string
  displayPath: string
  name: string
}

/** The largest directory listing sent to the picker; the rest is summarised. */
const MAX_ENTRIES = 1000

/** `~` and `~/x` mean the home directory, as they would in a shell. */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

function toAbsolute(requested: string, base: string): string {
  const expanded = expandHome(requested.trim())
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded)
}

function insideNodeModules(path: string): boolean {
  return path.split(sep).includes('node_modules')
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() === true
}

async function projectName(path: string): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) as {
      name?: unknown
    }
    return typeof manifest.name === 'string' && manifest.name !== ''
      ? manifest.name
      : basename(path)
  } catch {
    return basename(path)
  }
}

export function createProjectsRoutes(options: ProjectsOptions, access: RefreshableAccess) {
  /**
   * Projects added this session, newest first. Always kept, so adding works even when
   * nothing is persisted; with `remember` on they are also written to recent.json.
   */
  const added: string[] = []

  const trusted = async (): Promise<string[]> => {
    const recent = options.remember ? (await listRecentProjects()).map((entry) => entry.path) : []
    return [...new Set([...added, ...recent])]
  }

  async function entries(): Promise<ProjectEntry[]> {
    const paths = await trusted()
    const present = await Promise.all(
      paths.map(async (path) =>
        (await isFile(join(path, 'package.json')))
          ? { path, displayPath: toDisplayPath(path), name: await projectName(path) }
          : null,
      ),
    )
    return present.filter((entry): entry is ProjectEntry => entry !== null)
  }

  const list = async ({ res }: RequestContext): Promise<void> => {
    await access.refresh()
    sendJson(res, 200, {
      launched: options.launched,
      startDir: options.startDir,
      recent: await entries(),
    })
  }

  const add = async ({ req, res }: RequestContext): Promise<void> => {
    let body: { path?: unknown }
    try {
      body = await readJsonBody<{ path?: unknown }>(req, 8 * 1024)
    } catch {
      sendError(res, 400, 'Expected a JSON body')
      return
    }
    if (typeof body.path !== 'string' || body.path.trim() === '') {
      sendError(res, 400, 'Expected a folder path')
      return
    }

    const path = toAbsolute(body.path, options.startDir)
    if (insideNodeModules(path)) {
      sendError(
        res,
        400,
        'That folder is inside node_modules, so it is a dependency, not a project',
      )
      return
    }
    const info = await stat(path).catch(() => null)
    if (info === null || !info.isDirectory()) {
      sendError(res, 404, `No folder at ${toDisplayPath(path)}`)
      return
    }
    if (!(await isFile(join(path, 'package.json')))) {
      sendError(res, 422, `No package.json in ${toDisplayPath(path)}`)
      return
    }

    const existing = added.indexOf(path)
    if (existing !== -1) added.splice(existing, 1)
    added.unshift(path)
    if (options.remember) await recordRecentProject(path)
    await access.refresh()

    sendJson(res, 200, {
      project: { path, displayPath: toDisplayPath(path), name: await projectName(path) },
    })
  }

  const forget = async ({ res, url }: RequestContext): Promise<void> => {
    const requested = url.searchParams.get('path')
    if (requested === null) {
      sendError(res, 400, 'Expected a path')
      return
    }
    const path = resolve(requested)
    if (options.launched !== null && path === resolve(options.launched)) {
      sendError(res, 400, 'packui was launched on this project, so it cannot be forgotten')
      return
    }
    const index = added.indexOf(path)
    if (index !== -1) added.splice(index, 1)
    if (options.remember) await forgetRecentProject(path)
    await access.refresh()
    sendJson(res, 200, { ok: true })
  }

  /**
   * One level of a folder tree, for the picker. Directories only, with hidden ones and
   * node_modules left out, each marked with whether it holds a package.json. It reads
   * names, never contents, and adds nothing to the allowlist.
   */
  const browse = async ({ res, url }: RequestContext): Promise<void> => {
    const requested = url.searchParams.get('path')
    const path = requested === null ? options.startDir : toAbsolute(requested, options.startDir)

    let dirents
    try {
      dirents = await readdir(path, { withFileTypes: true })
    } catch {
      sendError(res, 404, `Cannot read ${toDisplayPath(path)}`)
      return
    }

    const candidates = dirents
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .filter((entry) => !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))

    const shown = candidates.slice(0, MAX_ENTRIES)
    const checked = await mapWithConcurrency(shown, 16, async (name) => {
      const full = join(path, name)
      // A symlink counts only when it leads to a directory.
      if ((await stat(full).catch(() => null))?.isDirectory() !== true) return null
      return { name, path: full, isProject: await isFile(join(full, 'package.json')) }
    })

    const parent = dirname(path)
    sendJson(res, 200, {
      path,
      displayPath: toDisplayPath(path),
      parent: parent === path ? null : parent,
      isProject: await isFile(join(path, 'package.json')),
      insideNodeModules: insideNodeModules(path),
      entries: checked.filter((entry) => entry !== null),
      truncated: candidates.length > shown.length,
    })
  }

  return { trusted, list, add, forget, browse }
}
