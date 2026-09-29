import { statSync } from 'node:fs'
import { extname, join } from 'node:path'

/**
 * Turns `npm install x@1.2.3` into something `spawn` can run with `shell: false` on
 * every platform.
 *
 * POSIX needs nothing: the command is looked up on PATH and the arguments arrive as an
 * argv array. Windows is harder. npm, pnpm, yarn and corepack install `.cmd` shims, and
 * since the fix for CVE-2024-27980 Node refuses to spawn a `.cmd` or `.bat` without a
 * shell — because cmd.exe re-parses its command line, and that is exactly the
 * injection the argv array exists to prevent.
 *
 * So on Windows a `.exe` (bun, volta, a standalone pnpm) is spawned directly, and a
 * shim is run through `cmd.exe /d /s /c` only after every argument has passed a strict
 * allowlist that contains no character cmd.exe treats specially — no spaces, quotes,
 * `%`, `!`, `^`, `&`, `|`, `<`, `>` or parentheses. Package names and versions are
 * already validated to far less than that; this is the layer that makes a miss there
 * non-exploitable here too.
 */

export interface Invocation {
  file: string
  args: string[]
  /** Set only for the cmd.exe route, whose command line is built here, already quoted. */
  windowsVerbatimArguments?: boolean
}

/** Characters cmd.exe gives no special meaning to, inside or outside quotes. */
const CMD_SAFE_ARGUMENT = /^[A-Za-z0-9@/._~:=+,\\-]+$/

/** A resolved shim path is quoted, so spaces and parentheses are fine; these are not. */
const CMD_UNSAFE_PATH = /["%!^&|<>\r\n]/

/** Windows PATH lookup, honouring PATHEXT as cmd.exe does. Only called on win32. */
export function findOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = isFile,
): string | null {
  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map((extension) => extension.toLowerCase())
  const candidates =
    extname(command) === '' ? extensions.map((extension) => `${command}${extension}`) : [command]
  for (const dir of (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)) {
    for (const candidate of candidates) {
      const full = join(dir, candidate)
      if (exists(full)) return full
    }
  }
  return null
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function toInvocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  lookup: (command: string) => string | null = (name) => findOnPath(name),
  env: NodeJS.ProcessEnv = process.env,
): Invocation {
  if (platform !== 'win32') return { file: command, args: [...args] }

  const resolved = lookup(command)
  // Not found: spawn it as named and let ENOENT say "not installed".
  if (resolved === null) return { file: command, args: [...args] }

  const extension = extname(resolved).toLowerCase()
  if (extension !== '.cmd' && extension !== '.bat') return { file: resolved, args: [...args] }

  for (const arg of args) {
    if (!CMD_SAFE_ARGUMENT.test(arg)) {
      throw new Error(`Refusing to pass ${JSON.stringify(arg)} through cmd.exe`)
    }
  }
  if (CMD_UNSAFE_PATH.test(resolved)) {
    throw new Error(`Refusing to run ${JSON.stringify(resolved)} through cmd.exe`)
  }

  const line = [`"${resolved}"`, ...args.map((arg) => `"${arg}"`)].join(' ')
  return {
    file: env.ComSpec ?? 'cmd.exe',
    // /d skips AutoRun, /s strips exactly the outer quotes and runs the rest verbatim.
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  }
}
