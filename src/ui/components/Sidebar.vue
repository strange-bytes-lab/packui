<script setup lang="ts">
import type { ProjectSummary } from '@shared/types'
import UpdateNotice from '@/components/UpdateNotice.vue'
import { useTheme } from '@/composables/useTheme'
import { computed } from 'vue'
import type {
  GlobalScopeSummary,
  RecentProjectSummary,
  Selection,
  WorkspaceSummary,
} from '@/stores/useProject'

const props = defineProps<{
  project: ProjectSummary | null
  scopes: readonly GlobalScopeSummary[]
  selection: Selection
  workspace?: WorkspaceSummary | null
  recent?: readonly RecentProjectSummary[]
  /** The launched project; null when packui was started outside one. */
  launched?: string | null
}>()

/** Recent projects not already listed above, as the workspace or the project entry. */
const otherRecent = computed(() => {
  const listed = new Set(props.workspace?.packages.map((member) => member.path) ?? [])
  if (props.project?.scope === 'project') listed.add(props.project.path)
  return (props.recent ?? []).filter((entry) => !listed.has(entry.path))
})

/** The package the table shows, when it shows one — matched by path, not by name. */
function isCurrent(path: string): boolean {
  return props.selection.kind === 'project' && props.project?.path === path
}

const emit = defineEmits<{ select: [target: Selection]; add: []; forget: [path: string] }>()

/**
 * The single-project entry. It names the project on screen; while a global scope is
 * shown it leads back to the launched project, and outside any project there is
 * nothing to lead back to, so it is not shown.
 */
const projectEntry = computed(() => {
  if (props.selection.kind === 'project' && props.project?.scope === 'project') {
    return { name: props.project.name, path: props.project.path, pm: props.project.packageManager }
  }
  if (props.launched === null || props.launched === undefined) return null
  return { name: 'Project', path: props.launched, pm: null }
})

const { theme, themes } = useTheme()

/** Globals are per toolchain, so the Node version is the useful disambiguator. */
function scopeHint(scope: GlobalScopeSummary): string {
  if (scope.rootCount > 1) return `${scope.rootCount} tools`
  return scope.nodeVersion === null ? scope.installer : `node ${scope.nodeVersion}`
}
</script>

<template>
  <aside class="sidebar">
    <header class="brand-block">
      <div class="brand">packui</div>
      <UpdateNotice />
    </header>

    <!--
      A workspace replaces the single project entry: the launched project is one of its
      packages, and listing it twice would make the highlight ambiguous.
    -->
    <nav v-if="workspace" class="section">
      <span class="section-label">Workspace</span>
      <ul class="list">
        <li v-for="member in workspace.packages" :key="member.path">
          <button
            type="button"
            class="entry"
            :aria-current="isCurrent(member.path)"
            @click="emit('select', { kind: 'project', path: member.path })"
          >
            <span class="entry-name">{{ member.name }}</span>
            <span v-if="member.relative === '.'" class="pm">root</span>
          </button>
          <span v-if="member.relative !== '.'" class="entry-hint">{{ member.relative }}</span>
        </li>
      </ul>
    </nav>

    <nav v-else-if="projectEntry" class="section">
      <span class="section-label">Project</span>
      <ul class="list">
        <li>
          <button
            type="button"
            class="entry"
            :aria-current="selection.kind === 'project'"
            @click="emit('select', { kind: 'project', path: projectEntry.path })"
          >
            <span class="entry-name">{{ projectEntry.name }}</span>
            <span v-if="projectEntry.pm" class="pm">{{ projectEntry.pm }}</span>
          </button>
        </li>
      </ul>
    </nav>

    <nav class="section" aria-label="Recent projects">
      <div class="section-head">
        <span class="section-label">Recent</span>
        <button
          type="button"
          class="add"
          title="Add a project folder"
          aria-label="Add a project folder"
          @click="emit('add')"
        >
          + Add
        </button>
      </div>
      <ul v-if="otherRecent.length > 0" class="list">
        <li v-for="entry in otherRecent" :key="entry.path" class="recent">
          <button
            type="button"
            class="entry"
            :title="entry.path"
            @click="emit('select', { kind: 'project', path: entry.path })"
          >
            <span class="entry-name">{{ entry.name }}</span>
          </button>
          <button
            type="button"
            class="forget"
            :title="`Remove ${entry.name} from this list (its files are untouched)`"
            :aria-label="`Remove ${entry.name} from recent projects`"
            @click="emit('forget', entry.path)"
          >
            ×
          </button>
          <span class="entry-hint">{{ entry.displayPath }}</span>
        </li>
      </ul>
      <button v-else type="button" class="add-empty" @click="emit('add')">
        Add a project folder
      </button>
    </nav>

    <nav v-if="scopes.length > 0" class="section">
      <span class="section-label">Global</span>
      <ul class="list">
        <li v-for="scope in scopes" :key="scope.id">
          <button
            type="button"
            class="entry"
            :aria-current="selection.kind === 'global' && selection.id === scope.id"
            @click="emit('select', { kind: 'global', id: scope.id })"
          >
            <span class="entry-name">{{ scope.label }}</span>
            <span v-if="scope.active" class="dot" title="Active toolchain" />
          </button>
          <span class="entry-hint">{{ scopeHint(scope) }}</span>
        </li>
      </ul>
    </nav>

    <label class="section theme-picker">
      <span class="section-label">Theme</span>
      <select v-model="theme">
        <option v-for="option in themes" :key="option.id" :value="option.id">
          {{ option.label }}
        </option>
      </select>
    </label>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding: var(--space-4);
  background: var(--bg-sunken);
  border-inline-end: 1px solid var(--border);
  overflow-y: auto;
}

.brand {
  font-weight: 600;
  letter-spacing: -0.01em;
}

.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.add {
  padding: 0;
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  background: none;
  border: none;
  cursor: pointer;
}

.add:hover {
  color: var(--accent);
}

.add-empty {
  inline-size: 100%;
  padding: var(--space-2);
  font: inherit;
  font-size: 12px;
  color: var(--text-muted);
  background: none;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.add-empty:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.recent {
  position: relative;
}

.recent .entry {
  padding-inline-end: var(--space-5);
}

/* Always reachable by keyboard; shown on hover or focus so the list stays quiet. */
.forget {
  position: absolute;
  inset-block-start: 4px;
  inset-inline-end: 4px;
  padding: 0 var(--space-1);
  font: inherit;
  font-size: 13px;
  line-height: 1.4;
  color: var(--text-faint);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  opacity: 0;
}

.recent:hover .forget,
.forget:focus-visible {
  opacity: 1;
}

.forget:hover {
  color: var(--danger);
}

.section-label {
  display: block;
  margin-block-end: var(--space-2);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.list li + li {
  margin-block-start: var(--space-2);
}

.entry {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  inline-size: 100%;
  padding: var(--space-2);
  font: inherit;
  font-size: 13px;
  text-align: start;
  color: var(--text);
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.entry[aria-current='true'] {
  border-color: var(--accent);
}

.entry-name {
  flex: 1;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pm {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-muted);
}

.dot {
  inline-size: 6px;
  block-size: 6px;
  border-radius: 50%;
  background: var(--ok);
}

.entry-hint {
  display: block;
  margin-block-start: 2px;
  padding-inline-start: var(--space-2);
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-faint);
}

.theme-picker {
  margin-block-start: auto;
}

.theme-picker select {
  inline-size: 100%;
  padding: var(--space-1) var(--space-2);
  font: inherit;
  color: var(--text);
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
</style>
