import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * A plain JSON file cache under ~/.packui/cache.
 *
 * Files rather than a database: the contents are inspectable, individually
 * deletable, and a corrupted entry costs one refetch instead of a migration.
 * Entries carry an ETag so a refresh past the TTL usually costs a 304.
 */

export const packuiHome = join(homedir(), '.packui')
const cacheRoot = join(packuiHome, 'cache')

export interface CacheEntry<T> {
  value: T
  etag: string | null
  storedAt: number
}

/** Package names contain characters that are unsafe or case-colliding as filenames. */
function cachePath(namespace: string, key: string): string {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 32)
  return join(cacheRoot, namespace, `${digest}.json`)
}

export async function readCache<T>(namespace: string, key: string): Promise<CacheEntry<T> | null> {
  try {
    return JSON.parse(await readFile(cachePath(namespace, key), 'utf8')) as CacheEntry<T>
  } catch {
    return null
  }
}

export async function writeCache<T>(
  namespace: string,
  key: string,
  entry: CacheEntry<T>,
): Promise<void> {
  const target = cachePath(namespace, key)
  try {
    await mkdir(join(cacheRoot, namespace), { recursive: true })
    // Write then rename, so a crash mid-write cannot leave a half-written entry
    // that would be read back as corrupt JSON.
    const temporary = `${target}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(entry), 'utf8')
    await rename(temporary, target)
  } catch {
    // A cache that cannot be written is a performance problem, not a failure.
  }
}

export function isFresh(entry: CacheEntry<unknown> | null, ttlMs: number): boolean {
  return entry !== null && Date.now() - entry.storedAt < ttlMs
}

/** Well past any TTL: an entry this old belongs to a package nobody looks at any more. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** A ceiling on file count, for the case where everything is recent but enormous. */
const MAX_ENTRIES_PER_NAMESPACE = 5000

/**
 * Drops stale cache entries. Nothing else ever deletes one, so without this
 * ~/.packui/cache only grows — a few bytes per package per version, forever.
 *
 * Called once at boot and deliberately not awaited: an unprunable cache is untidy,
 * never a failure, and the server has better things to start doing.
 */
export async function pruneCache(): Promise<void> {
  const namespaces = await readdir(cacheRoot).catch(() => [])

  for (const namespace of namespaces) {
    const directory = join(cacheRoot, namespace)
    const files = await readdir(directory).catch(() => [])

    const stats = await Promise.all(
      files.map(async (file) => {
        const path = join(directory, file)
        const info = await stat(path).catch(() => null)
        return info === null ? null : { path, modified: info.mtimeMs }
      }),
    )

    const present = stats.filter(
      (entry): entry is { path: string; modified: number } => entry !== null,
    )
    const cutoff = Date.now() - MAX_AGE_MS

    // Oldest first, so the count cap drops the least recently useful entries.
    present.sort((a, b) => a.modified - b.modified)

    const excess = Math.max(0, present.length - MAX_ENTRIES_PER_NAMESPACE)
    for (const [index, entry] of present.entries()) {
      if (index >= excess && entry.modified >= cutoff) continue
      await rm(entry.path, { force: true })
    }
  }
}

/**
 * Bounds how many requests hit an external API at once. Without this, a project
 * with 300 dependencies would open 300 sockets simultaneously.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0

  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++
      const item = items[index]
      if (item === undefined) continue
      results[index] = await worker(item)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}
