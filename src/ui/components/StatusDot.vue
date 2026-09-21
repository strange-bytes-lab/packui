<script setup lang="ts">
import { computed } from 'vue'
import type { AlignmentState, OutdatedSeverity, VulnerabilitySummary } from '@shared/types'
import { rowStatus } from '@/composables/rowStatus'

const props = defineProps<{
  outdated: OutdatedSeverity
  alignment: AlignmentState
  vulnerabilities: VulnerabilitySummary | null
}>()

// Shared with the table's status sort; see composables/rowStatus.ts for the ranking.
const state = computed(() => rowStatus(props))
</script>

<template>
  <span
    class="dot"
    :data-tone="state.tone"
    :title="state.label"
    role="img"
    :aria-label="state.label"
  />
</template>

<style scoped>
.dot {
  display: inline-block;
  inline-size: 8px;
  block-size: 8px;
  border-radius: 50%;
  background: currentColor;
}

.dot[data-tone='ok'] {
  color: var(--ok);
}
.dot[data-tone='patch'] {
  color: var(--patch);
}
.dot[data-tone='minor'] {
  color: var(--minor);
}
.dot[data-tone='major'] {
  color: var(--major);
}
.dot[data-tone='unknown'] {
  color: var(--border-strong);
  background: none;
  box-shadow: inset 0 0 0 1.5px currentColor;
}
</style>
