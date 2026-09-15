<script setup lang="ts">
import { computed } from 'vue'
import type { AlignmentState, OutdatedSeverity } from '@shared/types'

const props = defineProps<{
  outdated: OutdatedSeverity
  alignment: AlignmentState
}>()

/**
 * One glyph carrying the row's headline state. Alignment problems outrank being
 * behind, because a project that will not install correctly is the more urgent fact.
 */
const state = computed(() => {
  if (props.alignment === 'missing') return { tone: 'major', label: 'Not installed' }
  if (props.alignment === 'unsatisfied') return { tone: 'major', label: 'Installed version is outside the declared range' }
  if (props.outdated === 'major') return { tone: 'major', label: 'Major version behind' }
  if (props.outdated === 'minor') return { tone: 'minor', label: 'Minor version behind' }
  if (props.outdated === 'patch') return { tone: 'patch', label: 'Patch version behind' }
  if (props.outdated === 'current') return { tone: 'ok', label: 'Up to date' }
  return { tone: 'unknown', label: 'Not checked yet' }
})
</script>

<template>
  <span class="dot" :data-tone="state.tone" :title="state.label" role="img" :aria-label="state.label" />
</template>

<style scoped>
.dot {
  display: inline-block;
  inline-size: 8px;
  block-size: 8px;
  border-radius: 50%;
  background: currentColor;
}

.dot[data-tone='ok'] { color: var(--ok); }
.dot[data-tone='patch'] { color: var(--patch); }
.dot[data-tone='minor'] { color: var(--minor); }
.dot[data-tone='major'] { color: var(--major); }
.dot[data-tone='unknown'] {
  color: var(--border-strong);
  background: none;
  box-shadow: inset 0 0 0 1.5px currentColor;
}
</style>
