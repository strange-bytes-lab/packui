<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { apiFetch } from '@/composables/useApi'

interface VersionStatus {
  current: string | null
  latest: string | null
  updateAvailable: boolean
}

/**
 * The running version, and a quiet pill when a newer one is published. Dismissing it
 * hides that version only, so the next release is announced again. Nothing here
 * updates anything: npx fetches whatever version it is asked for, so the notice is
 * the command to run.
 */
const DISMISSED_KEY = 'packui:dismissed-update'
const COMMAND = 'npx @strange-bytes/packui@latest'
const RELEASES_URL = 'https://github.com/strange-bytes-lab/packui/releases'

const status = ref<VersionStatus | null>(null)
const dismissed = ref<string | null>(readDismissed())
const expanded = ref(false)
const copied = ref(false)

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY)
  } catch {
    return null
  }
}

const showPill = computed(
  () =>
    status.value?.updateAvailable === true &&
    status.value.latest !== null &&
    status.value.latest !== dismissed.value,
)

function dismiss(): void {
  const latest = status.value?.latest ?? null
  if (latest === null) return
  try {
    localStorage.setItem(DISMISSED_KEY, latest)
  } catch {
    // Without storage it simply comes back next time.
  }
  dismissed.value = latest
  expanded.value = false
}

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(COMMAND)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    // The command is on screen to select by hand.
  }
}

onMounted(async () => {
  try {
    status.value = await apiFetch<VersionStatus>('/version')
  } catch {
    status.value = null
  }
})
</script>

<template>
  <div class="update">
    <div class="line">
      <span v-if="status?.current" class="version">v{{ status.current }}</span>
      <button
        v-if="showPill"
        type="button"
        class="pill"
        :aria-expanded="expanded"
        aria-controls="update-panel"
        @click="expanded = !expanded"
      >
        {{ status?.latest }} available
      </button>
    </div>

    <div v-if="showPill && expanded" id="update-panel" class="panel">
      <p class="text">packui {{ status?.latest }} is out. Restart it with:</p>
      <div class="command">
        <code>{{ COMMAND }}</code>
        <button type="button" class="copy" @click="copy">{{ copied ? 'Copied' : 'Copy' }}</button>
      </div>
      <div class="links">
        <a :href="RELEASES_URL" target="_blank" rel="noopener noreferrer">What's new</a>
        <button type="button" class="link" @click="dismiss">Not now</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.line {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  min-block-size: 20px;
}

.version {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-faint);
}

.pill {
  padding: 1px var(--space-2);
  font: inherit;
  font-size: 10px;
  font-weight: 600;
  color: var(--accent);
  background: color-mix(in oklab, var(--accent) 10%, transparent);
  border: 1px solid color-mix(in oklab, var(--accent) 35%, transparent);
  border-radius: 999px;
  cursor: pointer;
}

.panel {
  margin-block-start: var(--space-2);
  padding: var(--space-3);
  font-size: 12px;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.text {
  margin: 0 0 var(--space-2);
  color: var(--text-muted);
}

.command {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  padding: var(--space-1) var(--space-2);
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.command code {
  flex: 1;
  min-inline-size: 0;
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: 11px;
}

.copy,
.link {
  padding: 0;
  font: inherit;
  font-size: 11px;
  color: var(--accent);
  background: none;
  border: none;
  cursor: pointer;
}

.links {
  display: flex;
  gap: var(--space-3);
  margin-block-start: var(--space-2);
}

.links a {
  font-size: 11px;
  color: var(--accent);
}

.link {
  color: var(--text-muted);
}
</style>
