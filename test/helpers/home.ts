/**
 * Redirects the home directory for a test, so nothing reads or writes the real
 * ~/.packui, ~/.npmrc or version-manager layouts.
 *
 * os.homedir() reads HOME on POSIX but USERPROFILE on Windows, so both are set.
 */
const original = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }

export function setHome(dir: string): void {
  process.env.HOME = dir
  process.env.USERPROFILE = dir
}

export function restoreHome(): void {
  for (const key of ['HOME', 'USERPROFILE'] as const) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
}

/**
 * The link type for a directory symlink. Windows needs administrator rights (or
 * developer mode) for real symlinks, but not for junctions, which is also what pnpm
 * itself creates there.
 */
export const DIR_LINK = process.platform === 'win32' ? 'junction' : 'dir'
