import type { ServerResponse } from 'node:http'
import { createSnapshot, listSnapshots, restoreSnapshot } from '../core/backup.ts'
import {
  buildCommand,
  buildInstallCommand,
  type MutationAction,
  type MutationRequest,
} from '../core/commands.ts'
import { detectPackageManager } from '../core/detect.ts'
import { runCommand, withProjectLock } from '../core/exec.ts'
import { sendError, sendJson, type RequestContext } from '../router.ts'
import { resolveAllowedProject, type ProjectAccess } from './access.ts'
import type { DependencyKind } from '../../shared/types.ts'

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

    const action = body.action
    if (action !== 'upgrade' && action !== 'remove') {
      sendError(res, 400, 'action must be "upgrade" or "remove"')
      return
    }
    if (typeof body.name !== 'string') {
      sendError(res, 400, 'name is required')
      return
    }
    const kind = KINDS.has(body.kind as DependencyKind) ? (body.kind as DependencyKind) : 'prod'

    const detection = await detectPackageManager(projectPath)
    if (detection.packageManager === null) {
      sendError(res, 422, 'Could not determine which package manager this project uses')
      return
    }

    const request: MutationRequest = {
      action: action satisfies MutationAction,
      name: body.name,
      version: typeof body.version === 'string' ? body.version : undefined,
      kind,
    }

    let built
    try {
      built = buildCommand(detection.packageManager, request)
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : 'Invalid request')
      return
    }

    const controller = new AbortController()
    ctx.req.on('close', () => controller.abort())

    try {
      await withProjectLock(projectPath, async () => {
        const send = openStream(res)
        send('command', { display: built.display })

        const snapshot = await createSnapshot(projectPath, built.display)
        send('snapshot', { id: snapshot.id, files: snapshot.files })

        const result = await runCommand(
          projectPath,
          built,
          (event) => send('output', event),
          controller.signal,
        )

        send('done', {
          ok: result.error === null && result.code === 0,
          code: result.code,
          error: result.error,
          snapshotId: snapshot.id,
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
