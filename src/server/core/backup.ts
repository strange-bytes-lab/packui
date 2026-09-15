import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { packuiHome } from './cache.ts'

/**
 * Snapshots a project's manifest and lockfile before packui changes anything.
 *
 * An upgrade can fail in the middle, resolve to something that does not build, or
 * simply turn out to be a bad idea. Every one of those is recoverable if the two
 * files that define the dependency tree were copied first, and unrecoverable if
 * they were not. The snapshot is taken before the package manager is spawned, not
 * after it succeeds.
 */

const backupsRoot = join(packuiHome, 'backups')

/** How many snapshots to keep per project before pruning the oldest. */
const KEEP_PER_PROJECT = 20

/** Only these two files define the dependency tree; node_modules is reproducible. */
const TRACKED_FILES = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]

export interface Snapshot {
  id: string
  projectPath: string
  createdAt: string
  files: string[]
  /** What the snapshot was taken for, shown in the UI. */
  label: string
}

function projectKey(projectPath: string): string {
  return createHash('sha256').update(projectPath).digest('hex').slice(0, 16)
}

function snapshotDir(projectPath: string, id: string): string {
  return join(backupsRoot, projectKey(projectPath), id)
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

export async function createSnapshot(projectPath: string, label: string): Promise<Snapshot> {
  // Sortable and unique: snapshots are listed and pruned by id order.
  const id = new Date().toISOString().replace(/[:.]/g, '-')
  const target = snapshotDir(projectPath, id)
  await mkdir(target, { recursive: true })

  const copied: string[] = []
  for (const file of TRACKED_FILES) {
    const source = join(projectPath, file)
    if (!(await exists(source))) continue
    await copyFile(source, join(target, file))
    copied.push(file)
  }

  if (copied.length === 0) {
    await rm(target, { recursive: true, force: true })
    throw new Error('Nothing to back up: no package.json found')
  }

  const snapshot: Snapshot = {
    id,
    projectPath,
    createdAt: new Date().toISOString(),
    files: copied,
    label,
  }

  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(target, 'packui-snapshot.json'), JSON.stringify(snapshot), 'utf8')

  await pruneSnapshots(projectPath)
  return snapshot
}

export async function listSnapshots(projectPath: string): Promise<Snapshot[]> {
  const root = join(backupsRoot, projectKey(projectPath))
  let ids: string[]
  try {
    ids = await readdir(root)
  } catch {
    return []
  }

  const { readFile } = await import('node:fs/promises')
  const snapshots = await Promise.all(
    ids.map(async (id) => {
      try {
        const raw = await readFile(join(root, id, 'packui-snapshot.json'), 'utf8')
        return JSON.parse(raw) as Snapshot
      } catch {
        return null
      }
    }),
  )

  // Newest first.
  return snapshots
    .filter((snapshot): snapshot is Snapshot => snapshot !== null)
    .sort((a, b) => b.id.localeCompare(a.id))
}

/**
 * Restores a snapshot's files over the project.
 *
 * This only puts package.json and the lockfile back. node_modules is left alone,
 * so the caller must follow with an install to make the tree match again —
 * restoreSnapshot on its own leaves the project in the "lockfile changed, not yet
 * installed" state that the alignment check is designed to catch.
 */
export async function restoreSnapshot(projectPath: string, id: string): Promise<Snapshot> {
  // `id` reaches here from a client request, so it is checked against what is
  // actually on disk rather than being joined into a path directly.
  const snapshots = await listSnapshots(projectPath)
  const snapshot = snapshots.find((candidate) => candidate.id === id)
  if (snapshot === undefined) throw new Error(`Unknown snapshot: ${id}`)

  const source = snapshotDir(projectPath, snapshot.id)

  // A lockfile present in the project but absent from the snapshot must be removed,
  // or a restored package.json would sit next to a lockfile it never matched.
  for (const file of TRACKED_FILES) {
    const inSnapshot = snapshot.files.includes(file)
    const target = join(projectPath, file)
    if (inSnapshot) {
      await copyFile(join(source, file), target)
    } else if (await exists(target)) {
      await rm(target, { force: true })
    }
  }

  return snapshot
}

async function pruneSnapshots(projectPath: string): Promise<void> {
  const snapshots = await listSnapshots(projectPath)
  for (const snapshot of snapshots.slice(KEEP_PER_PROJECT)) {
    await rm(snapshotDir(projectPath, snapshot.id), { recursive: true, force: true })
  }
}
