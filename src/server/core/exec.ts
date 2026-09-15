import { spawn } from 'node:child_process'
import type { BuiltCommand } from './commands.ts'

/**
 * Runs a package manager command in a project and streams its output.
 *
 * `shell` is never enabled and arguments are always passed as an array, so a
 * package name or version cannot be interpreted as shell syntax no matter what
 * reaches this function. commands.ts validates those inputs as well; this is the
 * layer that makes a validation miss non-exploitable rather than merely unlikely.
 */

export interface ExecEvent {
  type: 'stdout' | 'stderr'
  text: string
}

export interface ExecResult {
  code: number | null
  /** Set when the process could not be started or was killed. */
  error: string | null
}

/** Long enough for a cold install on a large project, short enough to not hang forever. */
const TIMEOUT_MS = 10 * 60 * 1000

export function runCommand(
  projectPath: string,
  built: BuiltCommand,
  onEvent: (event: ExecEvent) => void,
  signal?: AbortSignal,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    const child = spawn(built.command, built.args, {
      cwd: projectPath,
      shell: false,
      env: {
        ...process.env,
        // Package managers emit progress spinners and colour codes when they think
        // a human is watching. Both render as noise in a streamed log.
        NO_COLOR: '1',
        CI: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let settled = false
    const finish = (result: ExecResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ code: null, error: `Timed out after ${TIMEOUT_MS / 1000}s` })
    }, TIMEOUT_MS)

    const abort = (): void => {
      child.kill('SIGTERM')
      finish({ code: null, error: 'Cancelled' })
    }
    signal?.addEventListener('abort', abort, { once: true })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (text: string) => onEvent({ type: 'stdout', text }))

    child.stderr.setEncoding('utf8')
    // Package managers routinely log progress to stderr, so this is not error output.
    child.stderr.on('data', (text: string) => onEvent({ type: 'stderr', text }))

    child.on('error', (error: NodeJS.ErrnoException) => {
      const message =
        error.code === 'ENOENT' ? `${built.command} is not installed or not on PATH` : error.message
      finish({ code: null, error: message })
    })

    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort)
      finish({ code, error: null })
    })
  })
}

/**
 * One mutation at a time per project.
 *
 * Two package manager processes writing the same lockfile concurrently is a
 * reliable way to corrupt it, and the UI can easily issue a second request while
 * the first is still running.
 */
const inFlight = new Set<string>()

export function isLocked(projectPath: string): boolean {
  return inFlight.has(projectPath)
}

export async function withProjectLock<T>(projectPath: string, work: () => Promise<T>): Promise<T> {
  if (inFlight.has(projectPath)) {
    throw new Error('Another change is already running for this project')
  }
  inFlight.add(projectPath)
  try {
    return await work()
  } finally {
    inFlight.delete(projectPath)
  }
}
