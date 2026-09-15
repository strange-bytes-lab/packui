<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { cancelMutation, confirmMutation, rollback, useMutation } from '@/composables/useMutation'

const emit = defineEmits<{ finished: [] }>()

const { phase, pending, command, output, failure, snapshotId, noSnapshotReason } = useMutation()

const dialog = ref<HTMLDialogElement | null>(null)
const log = ref<HTMLPreElement | null>(null)

/**
 * The command is shown before it runs. packui is about to change someone's project;
 * they should be able to see exactly what it will do, and to run it themselves
 * instead if they would rather.
 */
const preview = computed(() => {
  if (command.value !== null) return command.value
  const mutation = pending.value
  if (mutation === null) return ''
  return mutation.action === 'remove'
    ? `remove ${mutation.name}`
    : `install ${mutation.name}@${mutation.version ?? 'latest'}`
})

const busy = computed(() => phase.value === 'running')

watch(phase, async (value) => {
  if (value === 'idle') {
    dialog.value?.close()
    return
  }
  if (!dialog.value?.open) dialog.value?.showModal()
  await nextTick()
  if (log.value) log.value.scrollTop = log.value.scrollHeight
})

watch(output, async () => {
  await nextTick()
  if (log.value) log.value.scrollTop = log.value.scrollHeight
})

function close(): void {
  if (busy.value) return
  const succeeded = phase.value === 'succeeded'
  cancelMutation()
  dialog.value?.close()
  if (succeeded) emit('finished')
}
</script>

<template>
  <dialog ref="dialog" class="console" @cancel.prevent="close">
    <div class="body">
      <h2 class="heading">
        {{ phase === 'confirming' ? 'Run this command?' : 'Running' }}
      </h2>

      <pre class="command">{{ preview }}</pre>

      <p v-if="phase === 'confirming'" class="note">
        packui runs your project's own package manager, so it stays in charge of the lockfile.
        package.json and the lockfile are backed up first.
      </p>

      <pre v-if="output" ref="log" class="log">{{ output }}</pre>

      <p v-if="noSnapshotReason && phase !== 'confirming'" class="note note--warn">
        {{ noSnapshotReason }}
      </p>

      <p v-if="failure" class="failure">{{ failure }}</p>
      <p v-else-if="phase === 'succeeded'" class="success">Done.</p>

      <footer class="actions">
        <button v-if="phase === 'confirming'" type="button" class="ghost" @click="close">
          Cancel
        </button>
        <button
          v-if="phase === 'confirming'"
          type="button"
          class="primary"
          @click="confirmMutation()"
        >
          Run it
        </button>

        <span v-if="busy" class="running">Working…</span>

        <button
          v-if="phase === 'failed' && snapshotId"
          type="button"
          class="ghost"
          @click="rollback()"
        >
          Roll back
        </button>
        <button v-if="!busy && phase !== 'confirming'" type="button" class="primary" @click="close">
          Close
        </button>
      </footer>
    </div>
  </dialog>
</template>

<style scoped>
.console {
  padding: 0;
  inline-size: min(680px, 92vw);
  color: var(--text);
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-overlay);
}

.console::backdrop {
  background: rgb(0 0 0 / 0.4);
}

.body {
  padding: var(--space-5);
}

.heading {
  margin: 0 0 var(--space-3);
  font-size: 15px;
  font-weight: 600;
}

.command {
  margin: 0 0 var(--space-3);
  padding: var(--space-3);
  font-family: var(--font-mono);
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.note {
  margin: 0 0 var(--space-4);
  font-size: 12px;
  color: var(--text-muted);
}

.note--warn {
  color: var(--minor);
}

.log {
  max-block-size: 320px;
  margin: 0 0 var(--space-3);
  padding: var(--space-3);
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-muted);
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.failure {
  margin: 0 0 var(--space-3);
  font-size: 13px;
  color: var(--danger);
}

.success {
  margin: 0 0 var(--space-3);
  font-size: 13px;
  color: var(--ok);
}

.actions {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  justify-content: flex-end;
}

.running {
  margin-inline-end: auto;
  font-size: 13px;
  color: var(--text-muted);
}

button {
  padding: var(--space-2) var(--space-4);
  font: inherit;
  font-size: 13px;
  border-radius: var(--radius-md);
  cursor: pointer;
}

.ghost {
  color: var(--text);
  background: var(--bg-raised);
  border: 1px solid var(--border);
}

.primary {
  color: var(--accent-contrast);
  background: var(--accent);
  border: 1px solid var(--accent);
}
</style>
