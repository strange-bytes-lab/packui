<script setup lang="ts">
import { computed } from 'vue'
import type { AlignmentState } from '@shared/types'

const props = defineProps<{ alignment: AlignmentState; packageManager: string | null }>()

const install = computed(() => `${props.packageManager ?? 'npm'} install`)

const message = computed(() => {
  switch (props.alignment) {
    case 'missing':
      return `Some dependencies are declared but not installed. Run \`${install.value}\`.`
    case 'unsatisfied':
      return `Some installed versions fall outside the ranges in package.json. Run \`${install.value}\`.`
    case 'stale':
      return 'package.json has changed since the lockfile was written.'
    case 'unknown':
      return `No node_modules found, so nothing can be verified. Run \`${install.value}\`.`
    default:
      return null
  }
})

const tone = computed(() => (props.alignment === 'stale' ? 'warn' : 'alert'))
</script>

<template>
  <p v-if="message" class="banner" :data-tone="tone">{{ message }}</p>
</template>

<style scoped>
.banner {
  margin: 0 0 var(--space-4);
  padding: var(--space-3) var(--space-4);
  border: 1px solid;
  border-radius: var(--radius-md);
  font-size: 13px;
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
