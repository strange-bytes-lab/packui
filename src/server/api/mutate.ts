import type { ServerResponse } from 'node:http'
import { createSnapshot, listSnapshots, restoreSnapshot } from '../core/backup.ts'
import {
  buildBatchCommands,
  buildCommand,
  buildGlobalCommand,
  buildInstallCommand,
  type MutationAction,
  type MutationRequest,
} from '../core/commands.ts'
import { detectGlobalScopes } from '../core/global.ts'
import { findScope } from './globals.ts'
import { detectPackageManager } from '../core/detect.ts'
import { runCommand, withProjectLock } from '../core/exec.ts'
import { sendError, sendJson, type RequestContext } from '../router.ts'
import { resolveAllowedProject, type ProjectAccess } from './access.ts'
import { homedir } from 'node:os'
import type { DependencyKind, PackageManager } from '../../shared/types.ts'

/**
 * The write half of the API. Every mutation follows the same shape:
 *
 *   take the project lock -> snapshot package.json and the lockfile ->
 *   run the project's own package manager -> stream its output -> report the result
 *
 * The snapshot happens before the package manager runs, so a failure part-way
 * through is still recoverable. Output is streamed rather than buffered because a
 * slow or stuck install should be visible, not hidden behind a spinner.
 */

const KINDS = new Set<DependencyKind>(['prod', 'dev', 'peer', 'optional'])

interface MutateBody {
  action?: unknown
  name?: unknown
  version?: unknown
  kind?: unknown
  snapshotId?: unknown
  /** Present instead of name/version when upgrading several packages at once. */
  packages?: unknown
  /**
   * Required for removals: must equal the package name exactly. The gate lives on
   * the server, not only in the confirmation dialog, so a stray or scripted call
   * cannot delete a dependency by accident.
   */
  confirm?: unknown
}

interface BatchEntry {
  name: string
  version: string
  kind: DependencyKind
}

function readBatch(value: unknown): BatchEntry[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const entries: BatchEntry[] = []
  for (const item of value) {
    const entry = item as Record<string, unknown>
    if (typeof entry.name !== 'string' || typeof entry.version !== 'string') return null
    entries.push({
      name: entry.name,
      version: entry.version,
      kind: KINDS.has(entry.kind as DependencyKind) ? (entry.kind as DependencyKind) : 'prod',
    })
  }
  return entries
}

async function readJsonBody(ctx: RequestContext): Promise<MutateBody> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of ctx.req) {
    size += (chunk as Buffer).length
    // A mutation request is a few hundred bytes; anything larger is not one.
    if (size > 64 * 1024) throw new Error('Request body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as MutateBody
}

/** Server-sent events, so the browser reconnect and parsing logic is the platform's. */
function openStream(res: ServerResponse): (event: string, data: unknown) => void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    // Without this a proxy can buffer the whole stream and defeat the point.
    'x-accel-buffering': 'no',
  })

  return (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
}

export function createMutateHandler(access: ProjectAccess) {
  return async (ctx: RequestContext): Promise<void> => {
    const { res, url } = ctx

    const isGlobal = url.searchParams.get('scope') === 'global'

    const globalScope = isGlobal
      ? findScope(await detectGlobalScopes(), url.searchParams.get('id'))
      : undefined

    if (isGlobal && globalScope === undefined) {
      sendError(res, 404, 'No such global scope')
      return
    }

    const projectPath = isGlobal
      ? // Global commands do not act on a project directory; run them from the user's
        // home so the package manager cannot pick up a stray local manifest.
        homedir()
      : resolveAllowedProject(url.searchParams.get('path'), access.allowedProjects())

    if (projectPath === null) {
      sendError(res, 403, 'Unknown project')
      return
    }

    let body: MutateBody
    try {
      body = await readJsonBody(ctx)
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : 'Invalid request body')
      return
    }

    const action = body.action
    if (action !== 'upgrade' && action !== 'remove') {
      sendError(res, 400, 'action must be "upgrade" or "remove"')
      return
    }

    const batch = readBatch(body.packages)
    if (batch === null && typeof body.name !== 'string') {
      sendError(res, 400, 'name or packages is required')
      return
    }

    // Removal is the only action here that breaks a project at runtime rather than
    // at install time, and the only one an upgrade cannot undo by moving forward.
    if (action === 'remove' && body.confirm !== body.name) {
      sendError(
        res,
        400,
        'Removal requires a "confirm" field exactly matching the package name',
      )
      return
    }

    const detection = isGlobal
      ? { packageManager: globalScope?.packageManager ?? null }
      : await detectPackageManager(projectPath)

    if (!isGlobal && detection.packageManager === null) {
      sendError(res, 422, 'Could not determine which package manager this project uses')
      return
    }

    let commands: ReturnType<typeof buildCommand>[]
    try {
      if (globalScope !== undefined) {
        if (typeof body.name !== 'string') {
          sendError(res, 400, 'Global mutations act on one package at a time')
          return
        }
        commands = [
          buildGlobalCommand(globalScope.installer, {
            action,
            name: body.name,
            version: typeof body.version === 'string' ? body.version : undefined,
            kind: 'prod',
          }),
        ]
      } else if (batch !== null) {
        if (action !== 'upgrade') {
          sendError(res, 400, 'Batch requests support upgrade only')
          return
        }
        commands = buildBatchCommands(
          detection.packageManager as PackageManager,
          batch.map((entry) => ({ action: 'upgrade' as const, ...entry })),
        )
      } else {
        const request: MutationRequest = {
          action: action satisfies MutationAction,
          name: body.name as string,
          version: typeof body.version === 'string' ? body.version : undefined,
          kind: KINDS.has(body.kind as DependencyKind) ? (body.kind as DependencyKind) : 'prod',
        }
        commands = [buildCommand(detection.packageManager as PackageManager, request)]
      }
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : 'Invalid request')
      return
    }

    const controller = new AbortController()
    ctx.req.on('close', () => controller.abort())

    try {
      await withProjectLock(projectPath, async () => {
        const send = openStream(res)
        send('command', { display: commands.map((c) => c.display).join('\n') })

        // Globals have no manifest or lockfile to snapshot, so there is nothing to
        // roll back to. Saying so is better than offering a button that cannot work.
        let snapshotId: string | null = null
        if (isGlobal) {
          send('no-snapshot', {
            reason: 'Global packages have no manifest or lockfile, so this cannot be rolled back.',
          })
        } else {
          // One snapshot covers the whole batch, so a partial failure part-way
          // through rolls back to the state before any of it ran.
          const snapshot = await createSnapshot(projectPath, commands[0]?.display ?? 'mutation')
          snapshotId = snapshot.id
          send('snapshot', { id: snapshot.id, files: snapshot.files })
        }

        let failure: { code: number | null; error: string | null } | null = null

        for (const built of commands) {
          if (commands.length > 1) send('output', { type: 'stdout', text: `\n$ ${built.display}\n` })
          const result = await runCommand(
            projectPath,
            built,
            (event) => send('output', event),
            controller.signal,
          )
          if (result.error !== null || result.code !== 0) {
            failure = { code: result.code, error: result.error }
            break
          }
        }

        send('done', {
          ok: failure === null,
          code: failure?.code ?? 0,
          error: failure?.error ?? null,
          snapshotId,
        })
        res.end()
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Mutation failed'
      // The lock rejection happens before the stream is opened, so a plain JSON
      // error is still possible here.
      if (res.headersSent) {
        res.write(`event: done\ndata: ${JSON.stringify({ ok: false, error: message })}\n\n`)
        res.end()
      } else {
        sendError(res, 409, message)
      }
    }
  }
}

/** Restores a snapshot, then reinstalls so node_modules matches it again. */
export function createRollbackHandler(access: ProjectAccess) {
  return async (ctx: RequestContext): Promise<void> => {
    const { res, url } = ctx

    const projectPath = resolveAllowedProject(url.searchParams.get('path'), access.allowedProjects())
    if (projectPath === null) {
      sendError(res, 403, 'Unknown project')
      return
    }

    let body: MutateBody
    try {
      body = await readJsonBody(ctx)
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : 'Invalid request body')
      return
    }

    if (typeof body.snapshotId !== 'string') {
      sendError(res, 400, 'snapshotId is required')
      return
    }
    const snapshotId = body.snapshotId

    const detection = await detectPackageManager(projectPath)
    const controller = new AbortController()
    ctx.req.on('close', () => controller.abort())

    try {
      await withProjectLock(projectPath, async () => {
        const send = openStream(res)

        // Snapshot the broken state too, so a rollback is itself undoable.
        await createSnapshot(projectPath, 'before rollback').catch(() => null)

        const restored = await restoreSnapshot(projectPath, snapshotId)
        send('restored', { id: restored.id, files: restored.files })

        if (detection.packageManager === null) {
          send('done', { ok: true, code: 0, error: null, note: 'Files restored; run an install manually.' })
          res.end()
          return
        }

        const install = buildInstallCommand(detection.packageManager)
        send('command', { display: install.display })

        const result = await runCommand(
          projectPath,
          install,
          (event) => send('output', event),
          controller.signal,
        )

        send('done', {
          ok: result.error === null && result.code === 0,
          code: result.code,
          error: result.error,
        })
        res.end()
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Rollback failed'
      if (res.headersSent) {
        res.write(`event: done\ndata: ${JSON.stringify({ ok: false, error: message })}\n\n`)
        res.end()
      } else {
        sendError(res, 409, message)
      }
    }
  }
}

export function createSnapshotsHandler(access: ProjectAccess) {
  return async ({ res, url }: RequestContext): Promise<void> => {
    const projectPath = resolveAllowedProject(url.searchParams.get('path'), access.allowedProjects())
    if (projectPath === null) {
      sendError(res, 403, 'Unknown project')
      return
    }
    sendJson(res, 200, { snapshots: await listSnapshots(projectPath) })
  }
}
