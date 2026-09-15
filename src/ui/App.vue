<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import AlignmentBanner from '@/components/AlignmentBanner.vue'
import DependencyTable from '@/components/DependencyTable.vue'
import MutationConsole from '@/components/MutationConsole.vue'
import PackageDrawer from '@/components/PackageDrawer.vue'
import RemoveDialog from '@/components/RemoveDialog.vue'
import Sidebar from '@/components/Sidebar.vue'
import { useFilters } from '@/composables/useFilters'
import { requestMutation, type BatchPackage } from '@/composables/useMutation'
import { loadProject, useProject } from '@/stores/useProject'
import type { DependencyKind, DependencyRow } from '@shared/types'

const { report, loading, enriching, error, enrichError, project, dependencies } = useProject()
const { query, kind, problemsOnly, filtered } = useFilters(dependencies)

const selectedPackage = ref<string | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)

/**
 * Keyboard shortcuts, deliberately few: "/" to jump to the filter and Escape to
 * clear it. Both are ignored while typing in a field, so they never swallow input.
 */
function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  const typing =
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement

  if (event.key === '/' && !typing) {
    event.preventDefault()
    searchInput.value?.focus()
    return
  }

  if (event.key === 'Escape' && target === searchInput.value && query.value !== '') {
    // Let Escape clear the filter first; a second press can close anything above it.
    event.stopPropagation()
    query.value = ''
  }
}

/** Everything with a known newer version. Vulnerable packages sort to the front. */
const outdated = computed<BatchPackage[]>(() =>
  dependencies.value
    .filter((row) => row.latest !== null && row.outdated !== 'current' && row.outdated !== 'unknown')
    .map((row) => ({ name: row.name, version: row.latest as string, kind: row.kind })),
)

function upgradeAll(): void {
  if (outdated.value.length === 0) return
  requestMutation({ action: 'upgrade', packages: outdated.value })
}

function upgradeRow(row: DependencyRow): void {
  if (row.latest === null) return
  requestMutation({ action: 'upgrade', name: row.name, version: row.latest, kind: row.kind })
}

/** Removals go through the impact dialog first; nothing is removed on one click. */
const removalCandidate = ref<string | null>(null)

function removeRow(row: DependencyRow): void {
  removalCandidate.value = row.name
}

function confirmRemoval(name: string, kind: DependencyKind): void {
  removalCandidate.value = null
  // The server rejects a removal whose `confirm` does not match the name exactly.
  requestMutation({ action: 'remove', name, kind, confirm: name })
}

/** Picking a specific version in the drawer routes through the same confirmation. */
function upgradeToVersion(name: string, version: string): void {
  const row = dependencies.value.find((candidate) => candidate.name === name)
  requestMutation({ action: 'upgrade', name, version, kind: row?.kind ?? 'prod' })
  selectedPackage.value = null
}

onMounted(() => {
  void loadProject()
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="shell">
    <Sidebar :project="project" />

    <main class="content">
      <header class="toolbar">
        <input
          ref="searchInput"
          v-model="query"
          type="search"
          class="search"
          placeholder="Filter packages…  /"
          aria-label="Filter packages by name"
        />
        <div class="toolbar-group">
          <select v-model="kind" aria-label="Dependency kind">
            <option value="all">All kinds</option>
            <option value="prod">Dependencies</option>
            <option value="dev">Dev only</option>
          </select>
          <label class="checkbox">
            <input v-model="problemsOnly" type="checkbox" />
            Needs attention
          </label>
          <button type="button" :disabled="loading" @click="loadProject()">
            {{ loading ? 'Refreshing…' : 'Refresh' }}
          </button>
          <button
            v-if="outdated.length > 0"
            type="button"
            class="cta"
            @click="upgradeAll"
          >
            Upgrade all ({{ outdated.length }})
          </button>
        </div>
      </header>

      <p v-if="error" class="status status--error">{{ error }}</p>
      <p v-else-if="loading && !report" class="status">Reading project…</p>

      <template v-else-if="report">
        <AlignmentBanner
          :alignment="report.alignment"
          :package-manager="report.project.packageManager"
        />
        <p v-if="enrichError" class="status status--warn">
          {{ enrichError }} — showing local data only.
        </p>
        <p class="summary">
          {{ filtered.length }} of {{ dependencies.length }} dependencies
          <span v-if="enriching" class="summary-note">· checking the registry…</span>
        </p>

        <div v-if="dependencies.length === 0" class="empty-state">
          <p class="empty-title">This project has no dependencies.</p>
          <p class="empty-body">
            Nothing to audit yet. Add a package and refresh.
          </p>
        </div>

        <DependencyTable
          v-else
          :rows="filtered"
          @select="selectedPackage = $event"
          @upgrade="upgradeRow"
          @remove="removeRow"
        />
      </template>
    </main>

    <PackageDrawer
      :package-name="selectedPackage"
      @close="selectedPackage = null"
      @upgrade="upgradeToVersion"
    />
    <RemoveDialog
      :package-name="removalCandidate"
      @close="removalCandidate = null"
      @confirm="confirmRemoval"
    />
    <MutationConsole @finished="loadProject()" />
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: minmax(200px, 260px) 1fr;
  block-size: 100%;
}

.content {
  display: flex;
  flex-direction: column;
  padding: var(--space-5);
  overflow: auto;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: center;
  margin-block-end: var(--space-4);
}

.toolbar-group {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  margin-inline-start: auto;
}

.search {
  flex: 1;
  min-inline-size: 180px;
  max-inline-size: 320px;
  padding: var(--space-2) var(--space-3);
  font: inherit;
  color: var(--text);
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

select,
button {
  padding: var(--space-2) var(--space-3);
  font: inherit;
  font-size: 13px;
  color: var(--text);
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  cursor: pointer;
}

button:disabled {
  color: var(--text-faint);
  cursor: progress;
}

.cta {
  color: var(--accent-contrast);
  background: var(--accent);
  border-color: var(--accent);
}

.checkbox {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  font-size: 13px;
  color: var(--text-muted);
  white-space: nowrap;
  cursor: pointer;
}

.checkbox input {
  accent-color: var(--accent);
}

.summary {
  margin: 0 0 var(--space-2);
  font-size: 12px;
  color: var(--text-faint);
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

.status--warn {
  margin-block-end: var(--space-3);
  color: var(--minor);
}

.summary-note {
  color: var(--text-muted);
}

.empty-state {
  padding: var(--space-6);
  text-align: center;
  border: 1px dashed var(--border);
  border-radius: var(--radius-lg);
}

.empty-title {
  margin: 0 0 var(--space-2);
  font-weight: 600;
}

.empty-body {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
}
</style>
