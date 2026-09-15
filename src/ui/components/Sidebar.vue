<script setup lang="ts">
import type { ProjectSummary } from '@shared/types'
import { useTheme } from '@/composables/useTheme'

defineProps<{ project: ProjectSummary | null }>()

const { theme, themes } = useTheme()
</script>

<template>
  <aside class="sidebar">
    <div class="brand">packui</div>

    <nav class="section">
      <span class="section-label">Projects</span>
      <ul v-if="project" class="project-list">
        <li>
          <button type="button" class="project" aria-current="true">
            <span class="project-name">{{ project.name }}</span>
            <span v-if="project.packageManager" class="pm">{{ project.packageManager }}</span>
          </button>
          <span class="project-path" :title="project.path">{{ project.displayPath }}</span>
        </li>
      </ul>
      <p v-else class="muted">No project loaded.</p>
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
  overflow: hidden;
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

.project-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.project {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  inline-size: 100%;
  padding: var(--space-2);
  font: inherit;
  text-align: start;
  color: var(--text);
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.project[aria-current='true'] {
  border-color: var(--accent);
}

.project-name {
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

.project-path {
  display: block;
  margin-block-start: var(--space-1);
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.muted {
  margin: 0;
  color: var(--text-muted);
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
