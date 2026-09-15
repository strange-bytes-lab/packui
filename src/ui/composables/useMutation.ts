import { ref } from 'vue'
import type { DependencyKind } from '@shared/types'

/**
 * Drives a mutation and its streamed output.
 *
 * EventSource only issues GET requests and cannot carry a body or an Authorization
 * header, so the SSE stream is read from a POST response manually. The wire format
 * is still server-sent events, so the server side stays conventional.
 */

export interface PendingMutation {
  action: 'upgrade' | 'remove'
  name: string
  version?: string
  kind: DependencyKind
  /** Filled in by the server before anything runs, so the user sees the real command. */
  display?: string
}

export type MutationPhase = 'idle' | 'confirming' | 'running' | 'succeeded' | 'failed'

const phase = ref<MutationPhase>('idle')
const pending = ref<PendingMutation | null>(null)
const command = ref<string | null>(null)
const output = ref<string>('')
const failure = ref<string | null>(null)
const snapshotId = ref<string | null>(null)

const token = (): string => sessionStorage.getItem('packui:token') ?? ''

export function requestMutation(mutation: PendingMutation): void {
  pending.value = mutation
  command.value = null
  output.value = ''
  failure.value = null
  snapshotId.value = null
  phase.value = 'confirming'
}

export function cancelMutation(): void {
  if (phase.value === 'running') return
  phase.value = 'idle'
  pending.value = null
}

interface DoneEvent {
  ok?: boolean
  code?: number | null
  error?: string | null
  snapshotId?: string
  note?: string
}

/** Minimal SSE parser: events are separated by a blank line. */
async function readEventStream(
  response: Response,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('No response stream')

  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let separator = buffer.indexOf('\n\n')
    while (separator !== -1) {
      const raw = buffer.slice(0, separator)
      buffer = buffer.slice(separator + 2)

      let name = 'message'
      let data = ''
      for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) name = line.slice(7)
        else if (line.startsWith('data: ')) data += line.slice(6)
      }
      if (data !== '') {
        try {
          onEvent(name, JSON.parse(data))
        } catch {
          // A malformed frame should not tear down a running install.
        }
      }

      separator = buffer.indexOf('\n\n')
    }
  }
}

async function stream(path: string, body: unknown, onDone: (done: DoneEvent) => void) {
  phase.value = 'running'

  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null
    failure.value = detail?.error ?? response.statusText
    phase.value = 'failed'
    return
  }

  let done: DoneEvent = {}

  await readEventStream(response, (event, data) => {
    if (event === 'command') command.value = (data as { display: string }).display
    else if (event === 'snapshot') snapshotId.value = (data as { id: string }).id
    else if (event === 'output') output.value += (data as { text: string }).text
    else if (event === 'restored') output.value += 'Restored package.json and lockfile.\n'
    else if (event === 'done') done = data as DoneEvent
  })

  onDone(done)
}

export async function confirmMutation(): Promise<void> {
  const mutation = pending.value
  if (mutation === null) return

  try {
    await stream('/mutate', mutation, (done) => {
      if (done.ok === true) {
        phase.value = 'succeeded'
      } else {
        failure.value = done.error ?? `Exited with code ${done.code ?? 'unknown'}`
        phase.value = 'failed'
      }
      if (typeof done.snapshotId === 'string') snapshotId.value = done.snapshotId
    })
  } catch (cause) {
    failure.value = cause instanceof Error ? cause.message : 'The change could not be run'
    phase.value = 'failed'
  }
}

export async function rollback(): Promise<void> {
  const id = snapshotId.value
  if (id === null) return

  output.value += '\n--- rolling back ---\n'
  try {
    await stream('/rollback', { snapshotId: id }, (done) => {
      if (done.ok === true) {
        phase.value = 'succeeded'
        failure.value = null
        if (done.note) output.value += `${done.note}\n`
      } else {
        failure.value = done.error ?? 'Rollback failed'
        phase.value = 'failed'
      }
    })
  } catch (cause) {
    failure.value = cause instanceof Error ? cause.message : 'Rollback failed'
    phase.value = 'failed'
  }
}

export function useMutation() {
  return { phase, pending, command, output, failure, snapshotId }
}
