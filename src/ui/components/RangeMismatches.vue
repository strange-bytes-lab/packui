<script setup lang="ts">
import { computed } from 'vue'
import type { RangeMismatch } from '@/stores/useProject'

/**
 * The same dependency declared with different ranges in different workspace packages.
 * No single package's table can show this — each looks fine on its own — and it is how
 * a monorepo ends up shipping two copies of a framework.
 */
const props = defineProps<{
  mismatches: readonly RangeMismatch[]
  /** The package being viewed; at the root, every mismatch is relevant. */
  relative: string
}>()

const relevant = computed(() =>
  props.relative === '.'
    ? props.mismatches
    : props.mismatches.filter((mismatch) =>
        mismatch.declarations.some((entry) => entry.relative === props.relative),
      ),
)

const summary = computed(() => {
  const count = relevant.value.length
  if (props.relative === '.') {
    return count === 1
      ? '1 dependency is declared with different ranges across workspace packages.'
      : `${count} dependencies are declared with different ranges across workspace packages.`
  }
  return count === 1
    ? "1 of this package's dependencies is declared differently elsewhere in the workspace."
    : `${count} of this package's dependencies are declared differently elsewhere in the workspace.`
})
</script>

<template>
  <details v-if="relevant.length > 0" class="mismatches">
    <summary>{{ summary }}</summary>
    <table class="grid">
      <tbody>
        <tr v-for="mismatch in relevant" :key="mismatch.name">
          <th scope="row" class="mono">{{ mismatch.name }}</th>
          <td>
            <span
              v-for="entry in mismatch.declarations"
              :key="`${entry.relative}:${entry.field}`"
              class="declaration"
              :data-current="entry.relative === relative"
            >
              <span class="mono">{{ entry.range }}</span>
              <span class="where">{{ entry.package }}</span>
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  </details>
</template>

<style scoped>
.mismatches {
  margin: 0 0 var(--space-4);
  padding: var(--space-3) var(--space-4);
  font-size: 13px;
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
}

.mismatches summary {
  cursor: pointer;
}

.grid {
  margin-block-start: var(--space-3);
  border-collapse: collapse;
}

.grid th,
.grid td {
  padding: var(--space-1) var(--space-3) var(--space-1) 0;
  text-align: start;
  vertical-align: top;
}

.grid th {
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
}

.declaration {
  display: inline-flex;
  gap: var(--space-1);
  margin-inline-end: var(--space-3);
}

.declaration[data-current='true'] .mono {
  color: var(--accent);
}

.where {
  font-size: 11px;
  color: var(--text-faint);
}

.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}
</style>
