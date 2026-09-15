<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { apiFetch } from '@/composables/useApi'
import type { RemovalImpact } from '@/types/impact'
import type { DependencyKind } from '@shared/types'

const props = defineProps<{ packageName: string | null; global?: boolean }>()
const emit = defineEmits<{
  close: []
  confirm: [name: string, kind: DependencyKind]
}>()

const dialog = ref<HTMLDialogElement | null>(null)
const confirmInput = ref<HTMLInputElement | null>(null)

const impact = ref<RemovalImpact | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const typed = ref('')

/**
 * Removal is gated rather than one-click because it is the only action here that
 * breaks a project at runtime instead of at install time: the uninstall succeeds,
 * the lockfile updates cleanly, and the failure only appears later in whatever
 * imported the package. The gate is the impact report; typing the name is what
 * stops a mis-click from acting on it.
 */
const matches = computed(() => typed.value.trim() === props.packageName)

const headline = computed(() => {
  const current = impact.value
  if (current === null) return ''
  if (current.risk === 'breaking') {
    const files = current.usageFileCount
    return `Still imported in ${files} ${files === 1 ? 'file' : 'files'}`
  }
  if (current.dependents.length > 0) {
    const count = current.dependents.length
    return `${count} installed ${count === 1 ? 'package depends' : 'packages depend'} on it`
  }
  if (current.truncated) return 'Project too large to scan completely'
  return 'Nothing in this project imports it'
})

/*
 * The switch below is exhaustive over RemovalImpact['risk'] and TypeScript enforces
 * that. A default case would be unreachable code, and would stop the compiler from
 * catching the day a new risk level is added — which is the check that matters here.
 */
// oxlint-disable-next-line vue/return-in-computed-property
const explanation = computed(() => {
  const current = impact.value
  if (current === null) return ''
  switch (current.risk) {
    case 'breaking':
      return 'Removing it will break these files at runtime. The install itself will succeed.'
    case 'caution':
      return current.dependents.length > 0
        ? 'Those packages will be left with an unmet dependency.'
        : 'The scan stopped early, so no imports found is not a guarantee here.'
    case 'safe':
      return `Scanned ${current.filesScanned} source files and found no imports.`
  }
})

async function load(name: string): Promise<void> {
  loading.value = true
  error.value = null
  impact.value = null
  typed.value = ''

  // A global CLI is not imported by the project, so scanning project source for it
  // would answer a question nobody asked and could produce a misleading match.
  if (props.global === true) {
    loading.value = false
    return
  }

  try {
    impact.value = await apiFetch<RemovalImpact>(`/impact?name=${encodeURIComponent(name)}`)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not analyse this removal'
  } finally {
    loading.value = false
  }
}

watch(
  () => props.packageName,
  async (name) => {
    if (name === null) {
      dialog.value?.close()
      return
    }
    void load(name)
    if (!dialog.value?.open) dialog.value?.showModal()
    await nextTick()
    confirmInput.value?.focus()
  },
)

function close(): void {
  dialog.value?.close()
}

function submit(): void {
  const name = props.packageName
  if (name === null || !matches.value) return
  emit('confirm', name, impact.value?.kind ?? 'prod')
  close()
}
</script>

<template>
  <dialog ref="dialog" class="remove" @close="emit('close')">
    <form class="body" @submit.prevent="submit">
      <h2 class="heading">Remove <code>{{ packageName }}</code>?</h2>

      <p v-if="loading" class="muted">Checking what uses it…</p>
      <p v-else-if="error" class="error">{{ error }}</p>

      <template v-else-if="global">
        <div class="verdict" data-risk="caution">
          <p class="verdict-title">This is a globally installed tool</p>
          <p class="verdict-body">
            Anything on your machine that runs it will stop working. There is no
            manifest or lockfile behind a global install, so this cannot be rolled back.
          </p>
        </div>

        <label class="confirm">
          <span class="confirm-label">
            Type <strong>{{ packageName }}</strong> to confirm
          </span>
          <input
            ref="confirmInput"
            v-model="typed"
            type="text"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            :placeholder="packageName ?? ''"
          />
        </label>
      </template>

      <template v-else-if="impact">
        <div class="verdict" :data-risk="impact.risk">
          <p class="verdict-title">{{ headline }}</p>
          <p class="verdict-body">{{ explanation }}</p>
        </div>

        <ul v-if="impact.usages.length > 0" class="usages">
          <li v-for="usage in impact.usages.slice(0, 8)" :key="`${usage.file}:${usage.line}`">
            <span class="where">{{ usage.file }}:{{ usage.line }}</span>
            <code class="snippet">{{ usage.snippet }}</code>
          </li>
          <li v-if="impact.usages.length > 8" class="more">
            and {{ impact.usages.length - 8 }} more
          </li>
        </ul>

        <p v-if="impact.dependents.length > 0" class="dependents">
          Depended on by:
          <code v-for="name in impact.dependents.slice(0, 10)" :key="name">{{ name }}</code>
          <span v-if="impact.dependents.length > 10">
            and {{ impact.dependents.length - 10 }} more
          </span>
        </p>

        <label class="confirm">
          <span class="confirm-label">
            Type <strong>{{ packageName }}</strong> to confirm
          </span>
          <input
            ref="confirmInput"
            v-model="typed"
            type="text"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            :placeholder="packageName ?? ''"
          />
        </label>
      </template>

      <footer class="actions">
        <button type="button" class="ghost" @click="close">Cancel</button>
        <button type="submit" class="danger" :disabled="!matches">
          Remove it
        </button>
      </footer>
    </form>
  </dialog>
</template>

<style scoped>
.remove {
  padding: 0;
  inline-size: min(620px, 92vw);
  color: var(--text);
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-overlay);
}

.remove::backdrop {
  background: rgb(0 0 0 / 0.4);
}

.body {
  padding: var(--space-5);
}

.heading {
  margin: 0 0 var(--space-4);
  font-size: 15px;
  font-weight: 600;
}

.heading code {
  font-family: var(--font-mono);
}

.verdict {
  padding: var(--space-3);
  margin-block-end: var(--space-3);
  border: 1px solid;
  border-radius: var(--radius-md);
}

.verdict[data-risk='breaking'] {
  color: var(--major);
  border-color: color-mix(in oklab, var(--major) 40%, transparent);
  background: color-mix(in oklab, var(--major) 8%, transparent);
}

.verdict[data-risk='caution'] {
  color: var(--minor);
  border-color: color-mix(in oklab, var(--minor) 40%, transparent);
  background: color-mix(in oklab, var(--minor) 8%, transparent);
}

.verdict[data-risk='safe'] {
  color: var(--ok);
  border-color: color-mix(in oklab, var(--ok) 35%, transparent);
  background: color-mix(in oklab, var(--ok) 8%, transparent);
}

.verdict-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.verdict-body {
  margin: var(--space-1) 0 0;
  font-size: 12px;
  opacity: 0.85;
}

.usages {
  max-block-size: 190px;
  margin: 0 0 var(--space-3);
  padding: var(--space-2);
  overflow-y: auto;
  list-style: none;
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.usages li {
  padding: var(--space-1) 0;
}

.where {
  display: block;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
}

.snippet {
  display: block;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.more {
  font-size: 11px;
  color: var(--text-faint);
}

.dependents {
  margin: 0 0 var(--space-3);
  font-size: 12px;
  color: var(--text-muted);
}

.dependents code {
  margin-inline-end: var(--space-2);
  font-family: var(--font-mono);
  font-size: 11px;
}

.confirm {
  display: block;
  margin-block-end: var(--space-4);
}

.confirm-label {
  display: block;
  margin-block-end: var(--space-2);
  font-size: 12px;
  color: var(--text-muted);
}

.confirm-label strong {
  font-family: var(--font-mono);
  color: var(--text);
}

.confirm input {
  inline-size: 100%;
  padding: var(--space-2) var(--space-3);
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text);
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.actions {
  display: flex;
  gap: var(--space-3);
  justify-content: flex-end;
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

.danger {
  color: var(--accent-contrast);
  background: var(--danger);
  border: 1px solid var(--danger);
}

.danger:disabled {
  color: var(--text-faint);
  background: var(--bg-sunken);
  border-color: var(--border);
  cursor: not-allowed;
}

.muted { color: var(--text-muted); }
.error { color: var(--danger); }
</style>
