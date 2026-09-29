<script setup lang="ts">
import { ref, watch } from 'vue'
import { apiFetch } from '@/composables/useApi'
import { withSelection } from '@/stores/useProject'
import type { CompatReport } from '@/types/drawer'

/**
 * Whether a target version fits this project: its Node requirement against the
 * running Node and the project's own `engines`, and its peers against what is
 * installed. Shown where the upgrade decision is made, not after it.
 */
const props = defineProps<{ name: string; version: string }>()

const report = ref<CompatReport | null>(null)
const state = ref<'loading' | 'ready' | 'unknown'>('loading')

watch(
  () => [props.name, props.version] as const,
  async ([name, version]) => {
    state.value = 'loading'
    report.value = null
    try {
      const result = await apiFetch<CompatReport | null>(
        withSelection(
          `/compat?name=${encodeURIComponent(name)}&version=${encodeURIComponent(version)}`,
        ),
      )
      // A dist-tag or a registry miss: nothing to judge, and nothing is claimed.
      if (props.name !== name || props.version !== version) return
      report.value = result
      state.value = result === null ? 'unknown' : 'ready'
    } catch {
      if (props.name === name && props.version === version) state.value = 'unknown'
    }
  },
  { immediate: true },
)
</script>

<template>
  <div class="compat" :data-concerns="report?.concerns ?? false">
    <p v-if="state === 'loading'" class="line muted">
      Checking {{ version }} against this project…
    </p>
    <p v-else-if="state === 'unknown'" class="line muted">
      Could not read {{ version }}'s requirements, so compatibility was not checked.
    </p>
    <template v-else-if="report">
      <p v-if="report.deprecated" class="line bad">
        {{ version }} is deprecated: {{ report.deprecated }}
      </p>

      <p v-if="report.engines.required === null" class="line muted">
        {{ version }} declares no Node requirement.
      </p>
      <template v-else>
        <p class="line" :class="report.engines.runtimeOk === false ? 'bad' : 'ok'">
          Needs Node <span class="mono">{{ report.engines.required }}</span
          >; you are running <span class="mono">{{ report.engines.runtime }}</span
          >.
        </p>
        <p v-if="report.engines.narrows" class="line warn">
          That is narrower than this project's own
          <span class="mono">engines.node: {{ report.engines.project }}</span> — the project would
          promise support its dependency no longer has.
        </p>
      </template>

      <ul v-if="report.peers.length > 0" class="peers">
        <li
          v-for="peer in report.peers"
          :key="peer.name"
          :class="peer.satisfied === false ? 'bad' : peer.satisfied ? 'ok' : 'muted'"
        >
          Peer <span class="mono">{{ peer.name }} {{ peer.range }}</span>
          <template v-if="peer.optional"> (optional)</template>
          —
          <template v-if="peer.installed === null">not installed</template>
          <template v-else>
            installed <span class="mono">{{ peer.installed }}</span>
            <template v-if="peer.satisfied === false">, which does not satisfy it</template>
          </template>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.compat {
  padding: var(--space-3);
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.compat[data-concerns='true'] {
  border-color: color-mix(in oklab, var(--major) 45%, transparent);
}

.line {
  margin: 0 0 var(--space-1);
}

.line:last-child {
  margin-block-end: 0;
}

.peers {
  margin: var(--space-2) 0 0;
  padding-inline-start: var(--space-4);
}

.ok::marker,
.ok {
  color: var(--text);
}

.warn {
  color: var(--minor);
}

.bad {
  color: var(--major);
}

.muted {
  color: var(--text-muted);
}

.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}
</style>
