<script setup lang="ts">
import type { DependencyRow } from '@shared/types'
import StatusDot from './StatusDot.vue'

defineProps<{ rows: readonly DependencyRow[] }>()

const KIND_LABELS: Record<DependencyRow['kind'], string> = {
  prod: 'dep',
  dev: 'dev',
  peer: 'peer',
  optional: 'opt',
}
</script>

<template>
  <table class="table">
    <thead>
      <tr>
        <th class="col-status"><span class="sr-only">Status</span></th>
        <th class="col-name">Package</th>
        <th class="col-kind">Kind</th>
        <th class="col-version">Declared</th>
        <th class="col-version">Installed</th>
        <th class="col-version">Latest</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="row in rows" :key="row.name" class="row">
        <td class="col-status">
          <StatusDot :outdated="row.outdated" :alignment="row.alignment" />
        </td>
        <td class="col-name">
          <span class="name">{{ row.name }}</span>
          <span v-if="row.deprecated" class="tag tag--danger" :title="row.deprecated">
            deprecated
          </span>
        </td>
        <td class="col-kind">
          <span class="tag">{{ KIND_LABELS[row.kind] }}</span>
        </td>
        <td class="col-version mono">{{ row.declared }}</td>
        <td class="col-version mono">
          <span v-if="row.installed">{{ row.installed }}</span>
          <span v-else class="absent">not installed</span>
        </td>
        <td class="col-version mono">
          <span v-if="row.latest" :data-severity="row.outdated">{{ row.latest }}</span>
          <span v-else class="absent">—</span>
        </td>
      </tr>
    </tbody>
  </table>

  <p v-if="rows.length === 0" class="empty">No dependencies match.</p>
</template>

<style scoped>
.table {
  inline-size: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

thead th {
  position: sticky;
  inset-block-start: 0;
  z-index: 1;
  padding: var(--space-2) var(--space-3);
  text-align: start;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-faint);
  background: var(--bg);
  border-block-end: 1px solid var(--border);
}

.row {
  /* Keeps offscreen rows out of layout and paint on large dependency lists. */
  content-visibility: auto;
  contain-intrinsic-size: auto 37px;
  border-block-end: 1px solid var(--border);
}

.row:hover {
  background: var(--bg-hover);
}

td {
  padding: var(--space-2) var(--space-3);
  vertical-align: middle;
}

.col-status {
  inline-size: 28px;
  text-align: center;
}

.col-kind {
  inline-size: 60px;
}

.col-version {
  inline-size: 140px;
}

.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}

.name {
  font-weight: 500;
}

.absent {
  color: var(--text-faint);
}

[data-severity='major'] { color: var(--major); }
[data-severity='minor'] { color: var(--minor); }
[data-severity='patch'] { color: var(--patch); }

.tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  background: var(--bg-sunken);
  border: 1px solid var(--border);
}

.tag--danger {
  margin-inline-start: var(--space-2);
  color: var(--danger);
  border-color: color-mix(in oklab, var(--danger) 35%, transparent);
  background: color-mix(in oklab, var(--danger) 10%, transparent);
}

.empty {
  padding: var(--space-6);
  text-align: center;
  color: var(--text-muted);
}

.sr-only {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
