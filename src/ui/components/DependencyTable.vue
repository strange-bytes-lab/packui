<script setup lang="ts">
import type { DependencyRow } from '@shared/types'
import StatusDot from './StatusDot.vue'
import VulnerabilityBadge from './VulnerabilityBadge.vue'

const props = defineProps<{ rows: readonly DependencyRow[]; global?: boolean }>()
const emit = defineEmits<{
  select: [name: string]
  upgrade: [row: DependencyRow]
  remove: [row: DependencyRow]
}>()

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
        <th v-if="!props.global" class="col-kind">Kind</th>
        <th v-if="!props.global" class="col-version">Declared</th>
        <th class="col-version">Installed</th>
        <th class="col-version">Latest</th>
        <th class="col-flags">Flags</th>
        <th class="col-actions"><span class="sr-only">Actions</span></th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="row in rows" :key="row.name" class="row">
        <td class="col-status">
          <StatusDot
            :outdated="row.outdated"
            :alignment="row.alignment"
            :vulnerabilities="row.vulnerabilities"
          />
        </td>
        <td class="col-name">
          <button type="button" class="name" @click="emit('select', row.name)">
            {{ row.name }}
          </button>
        </td>
        <td v-if="!props.global" class="col-kind">
          <span class="tag">{{ KIND_LABELS[row.kind] }}</span>
        </td>
        <td v-if="!props.global" class="col-version mono">{{ row.declared }}</td>
        <td class="col-version mono">
          <span v-if="row.installed">{{ row.installed }}</span>
          <span v-else class="absent">not installed</span>
        </td>
        <td class="col-version mono">
          <span v-if="row.latest" :data-severity="row.outdated">{{ row.latest }}</span>
          <span v-else class="absent">—</span>
        </td>
        <td class="col-flags">
          <VulnerabilityBadge :vulnerabilities="row.vulnerabilities" />
          <span v-if="row.deprecated" class="tag tag--danger" :title="row.deprecated">
            deprecated
          </span>
        </td>
        <td class="col-actions">
          <button
            v-if="row.latest && row.outdated !== 'current'"
            type="button"
            class="action"
            :title="`Upgrade to ${row.latest}`"
            @click="emit('upgrade', row)"
          >
            Upgrade
          </button>
          <button
            type="button"
            class="action action--danger"
            :title="`Remove ${row.name}`"
            @click="emit('remove', row)"
          >
            Remove
          </button>
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
  inline-size: 130px;
}

.col-actions {
  inline-size: 150px;
  text-align: end;
  white-space: nowrap;
}

.action {
  padding: 2px var(--space-2);
  font: inherit;
  font-size: 11px;
  color: var(--text-muted);
  background: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  /* Secondary actions stay quiet until the row is hovered or focused. */
  opacity: 0;
}

.row:hover .action,
.action:focus-visible {
  opacity: 1;
}

.action:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.action--danger:hover {
  color: var(--danger);
  border-color: var(--danger);
}

.col-flags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
  min-block-size: 37px;
}

.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}

.name {
  padding: 0;
  font: inherit;
  font-weight: 500;
  color: var(--text);
  background: none;
  border: none;
  cursor: pointer;
}

.name:hover {
  color: var(--accent);
  text-decoration: underline;
}

.absent {
  color: var(--text-faint);
}

[data-severity='major'] {
  color: var(--major);
}
[data-severity='minor'] {
  color: var(--minor);
}
[data-severity='patch'] {
  color: var(--patch);
}

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
