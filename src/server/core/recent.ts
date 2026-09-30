import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { packuiHome } from './cache.ts'

/**
 * Projects packui has been launched against or had opened in it, so the sidebar can
 * switch between them without a restart.
 *
 * This list extends the path allowlist, so where entries come from matters. Two
 * things add one: the CLI at boot, for the project named on the command line, and
 * `POST /api/projects`, which carries the session token and a loopback Origin like
 * every other write and accepts only a directory holding a package.json outside any
 * node_modules. Nothing reads a path into it from a GET.
 */

const MAX_RECENT = 10

export interface RecentProject {
  path: string
  openedAt: string
}

function recentFile(): string {
  return join(packuiHome, 'recent.json')
}

async function readList(): Promise<RecentProject[]> {
  try {
    const parsed = JSON.parse(await readFile(recentFile(), 'utf8')) as { projects?: unknown }
    if (!Array.isArray(parsed.projects)) return []
    return parsed.projects.filter(
      (entry): entry is RecentProject =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as RecentProject).path === 'string' &&
        typeof (entry as RecentProject).openedAt === 'string',
    )
  } catch {
    return []
  }
}

async function writeList(list: RecentProject[]): Promise<void> {
  try {
    await mkdir(packuiHome, { recursive: true })
    const temporary = `${recentFile()}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify({ projects: list.slice(0, MAX_RECENT) }), 'utf8')
    await rename(temporary, recentFile())
  } catch {
    // Remembering projects is a convenience.
  }
}

/** Moves `path` to the front of the list. A write failure is never a boot failure. */
export async function recordRecentProject(path: string): Promise<void> {
  const absolute = resolve(path)
  const list = (await readList()).filter((entry) => entry.path !== absolute)
  list.unshift({ path: absolute, openedAt: new Date().toISOString() })
  await writeList(list)
}

/** Drops `path` from the list, which also takes it off the allowlist. */
export async function forgetRecentProject(path: string): Promise<void> {
  const absolute = resolve(path)
  const list = await readList()
  const kept = list.filter((entry) => entry.path !== absolute)
  if (kept.length !== list.length) await writeList(kept)
}

/** Recent projects that still have a package.json, most recent first, with their names. */
export async function listRecentProjects(): Promise<(RecentProject & { name: string })[]> {
  const list = await readList()
  const present = await Promise.all(
    list.map(async (entry) => {
      const info = await stat(join(entry.path, 'package.json')).catch(() => null)
      if (info?.isFile() !== true) return null
      const manifest = await readFile(join(entry.path, 'package.json'), 'utf8')
        .then((text) => JSON.parse(text) as { name?: unknown })
        .catch(() => ({}) as { name?: unknown })
      return {
        ...entry,
        name: typeof manifest.name === 'string' ? manifest.name : basename(entry.path),
      }
    }),
  )
  return present.filter((entry): entry is RecentProject & { name: string } => entry !== null)
}
