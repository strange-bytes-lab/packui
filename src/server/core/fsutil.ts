import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'

/**
 * Treats a symlink as a directory.
 *
 * `Dirent.isDirectory()` reflects an lstat, so it is false for symlinks. That matters
 * everywhere packui walks node_modules:
 *
 * - pnpm's layout makes every top-level entry a symlink into its content-addressed
 *   store, so a plain isDirectory() filter sees an empty node_modules on every single
 *   pnpm project;
 * - `npm link` and `volta install` of a local path produce linked packages;
 * - yarn's nohoist and workspace setups link too.
 *
 * Reading through the link is what we want in all of these — the target is a real
 * package directory. Callers that recurse should still skip links to avoid cycles.
 */
export function isDirectoryLike(entry: Dirent): boolean {
  return entry.isDirectory() || entry.isSymbolicLink()
}

/** Directory names inside `path`, following symlinks. Returns [] if unreadable. */
export async function listDirectoryNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter(isDirectoryLike).map((entry) => entry.name)
  } catch {
    return []
  }
}
