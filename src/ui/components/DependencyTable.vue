<script setup lang="ts">
import type { DependencyRow } from '@shared/types'
import { fuzzyMatch, highlight, type Segment } from '@/composables/fuzzy'
import StatusDot from './StatusDot.vue'
import VulnerabilityBadge from './VulnerabilityBadge.vue'

const props = defineProps<{
  rows: readonly DependencyRow[]
  global?: boolean
  /** Registry data is in flight. Declared and Installed come from disk and stay real. */
  pending?: boolean
  /** The active filter, so the matched characters can be marked in the name. */
  query?: string
}>()
const emit = defineEmits<{
  select: [name: string]
  upgrade: [row: DependencyRow]
  remove: [row: DependencyRow]
}>()

/**
 * Which characters of the name the filter matched. A scattered subsequence match is
 * hard to read as a match at all unless it is shown.
 */
function nameSegments(name: string): Segment[] {
  const match = fuzzyMatch(name, props.query?.trim() ?? '')
  return highlight(name, match?.indices ?? [])
}

/**
 * The whole row opens the drawer. This is a pointer convenience layered on top of the
 * name button, which stays the keyboard path — a focusable <tr> would add a tab stop
 * per dependency and put a button role on a table row.
 */
function onRowClick(row: DependencyRow): void {
  // A click that ended a drag-selection is a selection, not a navigation. Without this
  // the version strings could not be copied.
  if ((window.getSelection()?.toString() ?? '') !== '') return
  emit('select', row.name)
}

const KIND_LABELS: Record<DependencyRow['kind'], string> = {
  prod: 'dep',
  dev: 'dev',
  peer: 'peer',
  optional: 'opt',
}
</script>

<template>
  <table class="table" :aria-busy="props.pending">
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
      <tr v-for="row in rows" :key="row.name" class="row" @click="onRowClick(row)">
        <td class="col-status">
          <StatusDot
            :outdated="row.outdated"
            :alignment="row.alignment"
            :vulnerabilities="row.vulnerabilities"
          />
        </td>
        <td class="col-name">
          <!-- prettier-ignore -->
          <button type="button" class="name" @click.stop="emit('select', row.name)"><span
            v-for="(segment, index) in nameSegments(row.name)"
            :key="index"
            :class="{ hit: segment.matched }"
          >{{ segment.text }}</span></button>
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
          <span v-if="props.pending" class="skeleton skeleton--version" aria-hidden="true" />
          <span v-else-if="row.latest" :data-severity="row.outdated">{{ row.latest }}</span>
          <span v-else class="absent">—</span>
        </td>
        <td class="col-flags">
          <div class="flags">
            <span v-if="props.pending" class="skeleton skeleton--flag" aria-hidden="true" />
            <template v-else>
              <VulnerabilityBadge :vulnerabilities="row.vulnerabilities" />
              <span v-if="row.deprecated" class="tag tag--danger" :title="row.deprecated">
                deprecated
              </span>
            </template>
          </div>
        </td>
        <td class="col-actions">
          <button
            v-if="row.latest && row.outdated !== 'current'"
            type="button"
            class="action"
            :title="`Upgrade to ${row.latest}`"
            @click.stop="emit('upgrade', row)"
          >
            Upgrade
          </button>
          <button
            type="button"
            class="action action--danger"
            :title="`Remove ${row.name}`"
            @click.stop="emit('remove', row)"
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
/*
 * `separate`, not `collapse`. Under `collapse` the borders belong to the table rather
 * than to the cells, so a sticky header loses its bottom border the moment it detaches.
 * The trade is that a border on a <tr> is then never painted, so the row rule lives on
 * the cells.
 */
.table {
  inline-size: 100%;
  border-collapse: separate;
  border-spacing: 0;
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

[data-scrolled='true'] thead th {
  box-shadow: 0 4px 8px -6px light-dark(rgb(0 0 0 / 0.3), rgb(0 0 0 / 0.7));
}

.row {
  cursor: pointer;
  /* Keeps offscreen rows out of layout and paint on large dependency lists. */
  content-visibility: auto;
  contain-intrinsic-size: auto 37px;
}

.row:hover {
  background: var(--bg-hover);
}

td {
  padding: var(--space-2) var(--space-3);
  vertical-align: middle;
  border-block-end: 1px solid var(--border);
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

/* A touch pointer never hovers, so hidden-until-hover means unreachable. */
@media (hover: none) {
  .action {
    opacity: 1;
  }
}

.action:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.action--danger:hover {
  color: var(--danger);
  border-color: var(--danger);
}

.flags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
  min-block-size: 21px;
}

.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}

/*
 * Only the registry-derived cells skeleton. An em dash in Latest means "checked, no
 * answer", and showing that before the lookup has run would be a claim about the
 * package rather than a description of the request.
 */
.skeleton {
  display: inline-block;
  border-radius: var(--radius-sm);
  background: linear-gradient(
    90deg,
    var(--bg-sunken) 0%,
    var(--bg-hover) 50%,
    var(--bg-sunken) 100%
  );
  background-size: 200% 100%;
  animation: skeleton-sweep 1.4s ease-in-out infinite;
}

.skeleton--version {
  inline-size: 64px;
  block-size: 10px;
}

.skeleton--flag {
  inline-size: 44px;
  block-size: 14px;
}

@keyframes skeleton-sweep {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: -100% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .skeleton {
    background: var(--bg-sunken);
    animation: none;
  }
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

.hit {
  font-weight: 700;
  color: var(--accent);
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
