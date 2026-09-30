<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { apiFetch } from '@/composables/useApi'
import { addProject, type RecentProjectSummary } from '@/stores/useProject'

const props = defineProps<{ open: boolean; startDir: string | null }>()
const emit = defineEmits<{ close: []; added: [project: RecentProjectSummary] }>()

interface Listing {
  path: string
  displayPath: string
  parent: string | null
  isProject: boolean
  insideNodeModules: boolean
  entries: { name: string; path: string; isProject: boolean }[]
  truncated: boolean
}

const dialog = ref<HTMLDialogElement | null>(null)
const pathInput = ref<HTMLInputElement | null>(null)
const listing = ref<Listing | null>(null)
const typed = ref('')
const loading = ref(false)
const adding = ref(false)
const error = ref<string | null>(null)

/**
 * A browser cannot hand a page the real path of a folder it picked, so the picker is
 * served by packui itself: one level at a time, directory names only. Folders with a
 * package.json are marked, since those are the only ones that can be added.
 */
async function browse(path?: string): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const query = path === undefined ? '' : `?path=${encodeURIComponent(path)}`
    listing.value = await apiFetch<Listing>(`/browse${query}`)
    typed.value = listing.value.path
    // Long paths are clipped; the end is the part that says where you are.
    await nextTick()
    if (pathInput.value !== null) pathInput.value.scrollLeft = pathInput.value.scrollWidth
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not read that folder'
  } finally {
    loading.value = false
  }
}

const canAddCurrent = computed(
  () => listing.value !== null && listing.value.isProject && !listing.value.insideNodeModules,
)

const projectCount = computed(
  () => listing.value?.entries.filter((entry) => entry.isProject).length ?? 0,
)

async function add(path: string): Promise<void> {
  adding.value = true
  error.value = null
  try {
    const project = await addProject(path)
    emit('added', project)
    dialog.value?.close()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not add that folder'
  } finally {
    adding.value = false
  }
}

/** Enter in the path field goes to that folder; it never adds without a second step. */
function submitPath(): void {
  const value = typed.value.trim()
  if (value !== '') void browse(value)
}

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      dialog.value?.close()
      return
    }
    if (!dialog.value?.open) dialog.value?.showModal()
    await browse(listing.value?.path ?? props.startDir ?? undefined)
    await nextTick()
    pathInput.value?.focus()
  },
)
</script>

<template>
  <dialog ref="dialog" class="add" aria-labelledby="add-project-title" @close="emit('close')">
    <div class="body">
      <h2 id="add-project-title" class="heading">Add a project</h2>
      <p class="lede">
        Pick a folder with a <code>package.json</code>. It stays in the sidebar under Recent.
      </p>

      <form class="path-row" @submit.prevent="submitPath">
        <button
          type="button"
          class="ghost up"
          :disabled="!listing?.parent || loading"
          title="Parent folder"
          aria-label="Parent folder"
          @click="browse(listing?.parent ?? undefined)"
        >
          ↑
        </button>
        <input
          ref="pathInput"
          v-model="typed"
          type="text"
          class="path"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          aria-label="Folder path"
          placeholder="~/code/my-app"
        />
        <button type="submit" class="ghost" :disabled="loading">Go</button>
      </form>

      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <ul v-if="listing" class="entries" :aria-busy="loading">
        <li v-if="listing.entries.length === 0" class="empty">No folders here.</li>
        <li v-for="entry in listing.entries" :key="entry.path" class="entry">
          <button type="button" class="open" :title="entry.path" @click="browse(entry.path)">
            <span class="folder" aria-hidden="true">{{ entry.isProject ? '◆' : '▸' }}</span>
            <span class="name">{{ entry.name }}</span>
          </button>
          <button
            v-if="entry.isProject"
            type="button"
            class="ghost small"
            :disabled="adding"
            @click="add(entry.path)"
          >
            Add
          </button>
        </li>
        <li v-if="listing.truncated" class="empty">Only the first 1000 folders are shown.</li>
      </ul>

      <footer class="actions">
        <span class="hint">
          <template v-if="listing?.insideNodeModules">
            This is inside node_modules, so it is a dependency, not a project.
          </template>
          <template v-else-if="listing?.isProject">This folder is a project.</template>
          <template v-else-if="projectCount > 0">
            {{ projectCount }} {{ projectCount === 1 ? 'project' : 'projects' }} in this folder.
          </template>
          <template v-else-if="listing">No package.json in this folder.</template>
        </span>
        <button type="button" class="ghost" @click="dialog?.close()">Cancel</button>
        <button
          type="button"
          class="cta"
          :disabled="!canAddCurrent || adding"
          @click="listing && add(listing.path)"
        >
          {{ adding ? 'Adding…' : 'Add this folder' }}
        </button>
      </footer>
    </div>
  </dialog>
</template>

<style scoped>
.add {
  padding: 0;
  inline-size: min(620px, 92vw);
  color: var(--text);
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-overlay);
}

.add::backdrop {
  background: rgb(0 0 0 / 0.4);
}

.body {
  padding: var(--space-5);
}

.heading {
  margin: 0 0 var(--space-1);
  font-size: 15px;
  font-weight: 600;
}

.lede {
  margin: 0 0 var(--space-4);
  font-size: 12px;
  color: var(--text-muted);
}

code {
  font-family: var(--font-mono);
}

.path-row {
  display: flex;
  gap: var(--space-2);
  margin-block-end: var(--space-3);
}

.path {
  flex: 1;
  min-inline-size: 0;
  padding: var(--space-2) var(--space-3);
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text);
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.entries {
  block-size: min(320px, 45vh);
  margin: 0 0 var(--space-4);
  padding: var(--space-1);
  overflow-y: auto;
  list-style: none;
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.entries[aria-busy='true'] {
  opacity: 0.6;
}

.entry {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.open {
  display: flex;
  flex: 1;
  gap: var(--space-2);
  align-items: center;
  min-inline-size: 0;
  padding: var(--space-1) var(--space-2);
  font-size: 13px;
  text-align: start;
  color: var(--text);
  background: none;
  border: 1px solid transparent;
}

.open:hover {
  background: var(--bg-raised);
  border-color: var(--border);
}

.folder {
  inline-size: 1em;
  font-size: 10px;
  color: var(--text-faint);
}

.entry:has(.small) .folder {
  color: var(--accent);
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  padding: var(--space-2);
  font-size: 12px;
  color: var(--text-faint);
}

.actions {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  justify-content: flex-end;
}

.hint {
  flex: 1;
  font-size: 12px;
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

.up {
  padding-inline: var(--space-3);
}

.small {
  padding: 2px var(--space-3);
  font-size: 12px;
}

.cta {
  color: var(--accent-contrast);
  background: var(--accent);
  border: 1px solid var(--accent);
}

button:disabled {
  color: var(--text-faint);
  background: var(--bg-sunken);
  border-color: var(--border);
  cursor: not-allowed;
}

.error {
  margin: 0 0 var(--space-3);
  font-size: 12px;
  color: var(--danger);
}
</style>
