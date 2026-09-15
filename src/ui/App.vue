<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { apiFetch } from './composables/useApi'
import { useTheme } from './composables/useTheme'

const { theme, themes } = useTheme()

const projectPath = ref<string | null>(null)
const error = ref<string | null>(null)

onMounted(async () => {
  try {
    const health = await apiFetch<{ projectPath: string }>('/health')
    projectPath.value = health.projectPath
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not reach the packui server'
  }
})
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">packui</div>
      <nav class="projects">
        <span class="section-label">Projects</span>
      </nav>
      <label class="theme-picker">
        <span class="section-label">Theme</span>
        <select v-model="theme">
          <option v-for="option in themes" :key="option.id" :value="option.id">
            {{ option.label }}
          </option>
        </select>
      </label>
    </aside>

    <main class="content">
      <p v-if="error" class="status status--error">{{ error }}</p>
      <p v-else-if="projectPath" class="status">{{ projectPath }}</p>
      <p v-else class="status">Connecting…</p>
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: minmax(180px, 240px) 1fr;
  height: 100%;
}

.sidebar {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding: var(--space-4);
  background: var(--bg-sunken);
  border-inline-end: 1px solid var(--border);
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

.theme-picker {
  margin-block-start: auto;
}

.theme-picker select {
  width: 100%;
  padding: var(--space-1) var(--space-2);
  font: inherit;
  color: var(--text);
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.content {
  padding: var(--space-5);
  overflow: auto;
}

.status {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-muted);
}

.status--error {
  color: var(--danger);
}
</style>
