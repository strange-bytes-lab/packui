<script setup lang="ts">
import type { ProjectSummary } from '@shared/types'
import { useTheme } from '@/composables/useTheme'
import type { GlobalScopeSummary, Selection } from '@/stores/useProject'

defineProps<{
  project: ProjectSummary | null
  scopes: readonly GlobalScopeSummary[]
  selection: Selection
}>()

const emit = defineEmits<{ select: [target: Selection] }>()

const { theme, themes } = useTheme()

/** Globals are per toolchain, so the Node version is the useful disambiguator. */
function scopeHint(scope: GlobalScopeSummary): string {
  if (scope.rootCount > 1) return `${scope.rootCount} tools`
  return scope.nodeVersion === null ? scope.installer : `node ${scope.nodeVersion}`
}
</script>

<template>
  <aside class="sidebar">
    <div class="brand">packui</div>

    <nav class="section">
      <span class="section-label">Project</span>
      <ul v-if="project" class="list">
        <li>
          <button
            type="button"
            class="entry"
            :aria-current="selection.kind === 'project'"
            @click="emit('select', { kind: 'project' })"
          >
            <span class="entry-name">{{
              selection.kind === 'project' ? project.name : 'Project'
            }}</span>
            <span v-if="project.packageManager && selection.kind === 'project'" class="pm">
              {{ project.packageManager }}
            </span>
          </button>
        </li>
      </ul>
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
