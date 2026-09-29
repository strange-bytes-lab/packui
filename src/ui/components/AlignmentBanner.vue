<script setup lang="ts">
import { computed } from 'vue'
import type { AlignmentState, LockfileDrift } from '@shared/types'

const props = defineProps<{
  alignment: AlignmentState
  packageManager: string | null
  lockfile?: string | null
  drift?: readonly LockfileDrift[] | null
}>()

const install = computed(() => `${props.packageManager ?? 'npm'} install`)

/** Named rather than counted: "3 dependencies" sends you hunting, three names do not. */
const driftNames = computed(() => {
  const names = [...new Set((props.drift ?? []).map((entry) => entry.name))]
  if (names.length <= 3) return names.join(', ')
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
})

const message = computed(() => {
  switch (props.alignment) {
    case 'missing':
      return `Some dependencies are declared but not installed. Run \`${install.value}\`.`
    case 'unsatisfied':
      return `Some installed versions fall outside the ranges in package.json. Run \`${install.value}\`.`
    case 'stale':
      return `package.json and ${props.lockfile ?? 'the lockfile'} disagree about ${driftNames.value}. Run \`${install.value}\` to update the lockfile.`
    case 'unknown':
      return `No node_modules found, so nothing can be verified. Run \`${install.value}\`.`
    default:
      return null
  }
})

const tone = computed(() => (props.alignment === 'stale' ? 'warn' : 'alert'))

function describe(entry: LockfileDrift): string {
  if (entry.declared === null) return `${entry.name}: removed from package.json, still locked`
  if (entry.locked === null) return `${entry.name}: ${entry.declared} is not in the lockfile`
  return `${entry.name}: package.json says ${entry.declared}, lockfile says ${entry.locked}`
}
</script>

<template>
  <div v-if="message" class="banner" :data-tone="tone">
    <p class="message">{{ message }}</p>
    <details v-if="alignment === 'stale' && drift && drift.length > 0" class="detail">
      <summary>What differs</summary>
      <ul>
        <li v-for="entry in drift" :key="`${entry.field}:${entry.name}`" class="mono">
          {{ describe(entry) }}
        </li>
      </ul>
    </details>
  </div>
</template>

<style scoped>
.banner {
  margin: 0 0 var(--space-4);
  padding: var(--space-3) var(--space-4);
  border: 1px solid;
  border-radius: var(--radius-md);
  font-size: 13px;
}

.message {
  margin: 0;
}

.detail {
  margin-block-start: var(--space-2);
}

.detail summary {
  cursor: pointer;
}

.detail ul {
  margin: var(--space-2) 0 0;
  padding-inline-start: var(--space-4);
}

.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}

.banner[data-tone='alert'] {
  color: var(--major);
  border-color: color-mix(in oklab, var(--major) 35%, transparent);
  background: color-mix(in oklab, var(--major) 8%, var(--bg-raised));
}

.banner[data-tone='warn'] {
  color: var(--minor);
  border-color: color-mix(in oklab, var(--minor) 35%, transparent);
  background: color-mix(in oklab, var(--minor) 8%, var(--bg-raised));
}
</style>
