<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { apiFetch } from '@/composables/useApi'
import { renderMarkdown } from '@/composables/markdown'
import type { AdvisoryDetail, PackageDrawerPayload } from '@/types/drawer'

const props = defineProps<{ packageName: string | null }>()
const emit = defineEmits<{ close: []; upgrade: [name: string, version: string] }>()

const dialog = ref<HTMLDialogElement | null>(null)
const payload = ref<PackageDrawerPayload | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

/**
 * The README is arbitrary third-party Markdown shipped inside the installed
 * package, so it goes through the restricted renderer in composables/markdown.ts,
 * which escapes everything and emits only tags it constructs itself.
 */
const readmeHtml = computed(() =>
  payload.value?.readme ? renderMarkdown(payload.value.readme) : null,
)

const severityRank: Record<string, number> = { critical: 4, high: 3, moderate: 2, low: 1 }
const sortedAdvisories = computed(() =>
  [...(payload.value?.advisories ?? [])].sort(
    (a, b) => (severityRank[b.severity ?? ''] ?? 0) - (severityRank[a.severity ?? ''] ?? 0),
  ),
)

/** Versions newer than what is installed — the only ones worth offering. */
const upgradeCandidates = computed(() => {
  const all = payload.value?.versions ?? []
  return all.slice(0, 40)
})

async function load(name: string): Promise<void> {
  loading.value = true
  error.value = null
  payload.value = null
  try {
    payload.value = await apiFetch<PackageDrawerPayload>(
      `/package?name=${encodeURIComponent(name)}`,
    )
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not load this package'
  } finally {
    loading.value = false
  }
}

watch(
  () => props.packageName,
  (name) => {
    if (name === null) {
      dialog.value?.close()
      return
    }
    void load(name)
    // showModal gives focus trapping, Escape-to-close and inert background for free.
    if (!dialog.value?.open) dialog.value?.showModal()
  },
)

function fixedVersionsFor(advisory: AdvisoryDetail): string {
  return advisory.fixedIn.length === 0 ? 'no fix published' : advisory.fixedIn.join(', ')
}
</script>

<template>
  <dialog ref="dialog" class="drawer" @close="emit('close')" @click.self="dialog?.close()">
    <article class="panel">
      <header class="header">
        <div>
          <h2 class="title">{{ packageName }}</h2>
          <p v-if="payload?.detail?.description" class="description">
            {{ payload.detail.description }}
          </p>
        </div>
        <button type="button" class="close" aria-label="Close" @click="dialog?.close()">×</button>
      </header>

      <p v-if="loading" class="muted">Loading…</p>
      <p v-else-if="error" class="error">{{ error }}</p>

      <template v-else-if="payload">
        <p v-if="payload.deprecated" class="deprecated">
          <strong>Deprecated.</strong> {{ payload.deprecated }}
        </p>

        <dl class="facts">
          <div><dt>Installed</dt><dd class="mono">{{ payload.installed ?? '—' }}</dd></div>
          <div><dt>Latest</dt><dd class="mono">{{ payload.latest ?? '—' }}</dd></div>
          <div><dt>License</dt><dd>{{ payload.detail?.license ?? '—' }}</dd></div>
        </dl>

        <div class="links">
          <a v-if="payload.repositoryUrl" :href="payload.repositoryUrl" target="_blank" rel="noopener noreferrer">
            Repository
          </a>
          <a v-if="payload.releasesUrl" :href="payload.releasesUrl" target="_blank" rel="noopener noreferrer">
            Releases &amp; changelog
          </a>
          <a v-if="payload.detail?.homepage" :href="payload.detail.homepage" target="_blank" rel="noopener noreferrer">
            Homepage
          </a>
        </div>

        <section v-if="sortedAdvisories.length > 0" class="section">
          <h3>Advisories</h3>
          <ul class="advisories">
            <li v-for="advisory in sortedAdvisories" :key="advisory.id">
              <div class="advisory-head">
                <span class="severity" :data-severity="advisory.severity ?? 'unknown'">
                  {{ advisory.severity ?? 'unrated' }}
                </span>
                <span class="advisory-id mono">{{ advisory.id }}</span>
              </div>
              <p class="advisory-summary">{{ advisory.summary ?? 'No summary published.' }}</p>
              <p class="advisory-fix">Fixed in: <span class="mono">{{ fixedVersionsFor(advisory) }}</span></p>
            </li>
          </ul>
        </section>

        <section class="section">
          <h3>Versions</h3>
          <ul class="versions">
            <li v-for="version in upgradeCandidates" :key="version">
              <span class="mono">{{ version }}</span>
              <span v-if="version === payload.installed" class="tag">installed</span>
              <span v-else-if="version === payload.latest" class="tag">latest</span>
              <button
                v-if="version !== payload.installed"
                type="button"
                class="pick"
                @click="emit('upgrade', payload.name, version)"
              >
                Use
              </button>
            </li>
          </ul>
        </section>

        <section class="section">
          <h3>Readme</h3>
          <p v-if="!readmeHtml" class="muted">
            {{ payload.installed === null
              ? 'Install this package to read its readme.'
              : 'This package does not ship a readme.' }}
          </p>
          <!-- eslint-disable-next-line vue/no-v-html -- see composables/markdown.ts -->
          <div class="readme" v-html="readmeHtml" />
        </section>
      </template>
    </article>
  </dialog>
</template>

<style scoped>
.drawer {
  margin: 0 0 0 auto;
  padding: 0;
  inline-size: min(560px, 100vw);
  block-size: 100%;
  max-block-size: 100%;
  color: var(--text);
  background: var(--bg-raised);
  border: none;
  border-inline-start: 1px solid var(--border);
  box-shadow: var(--shadow-overlay);
}

.drawer::backdrop {
  background: rgb(0 0 0 / 0.35);
}

.panel {
  block-size: 100%;
  padding: var(--space-5);
  overflow-y: auto;
}

.header {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
  margin-block-end: var(--space-4);
}

.title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  word-break: break-word;
}

.description {
  margin: var(--space-1) 0 0;
  color: var(--text-muted);
}

.close {
  margin-inline-start: auto;
  padding: 0 var(--space-2);
  font-size: 22px;
  line-height: 1;
  color: var(--text-muted);
  background: none;
  border: none;
  cursor: pointer;
}

.facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-5);
  margin: 0 0 var(--space-4);
}

.facts dt {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.facts dd {
  margin: var(--space-1) 0 0;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
  margin-block-end: var(--space-5);
  font-size: 13px;
}

.links a {
  color: var(--accent);
}

.section {
  margin-block-end: var(--space-5);
}

.section h3 {
  margin: 0 0 var(--space-3);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.deprecated {
  margin: 0 0 var(--space-4);
  padding: var(--space-3);
  font-size: 13px;
  color: var(--danger);
  border: 1px solid color-mix(in oklab, var(--danger) 35%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in oklab, var(--danger) 8%, transparent);
}

.advisories,
.versions {
  margin: 0;
  padding: 0;
  list-style: none;
}

.advisories li {
  padding: var(--space-3);
  margin-block-end: var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.advisory-head {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  margin-block-end: var(--space-2);
}

.severity {
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  border: 1px solid currentColor;
}

.severity[data-severity='critical'],
.severity[data-severity='high'] { color: var(--major); }
.severity[data-severity='moderate'] { color: var(--minor); }
.severity[data-severity='low'],
.severity[data-severity='unknown'] { color: var(--text-muted); }

.advisory-id { font-size: 11px; color: var(--text-muted); }

.advisory-summary { margin: 0 0 var(--space-2); font-size: 13px; }
.advisory-fix { margin: 0; font-size: 12px; color: var(--text-muted); }

.versions {
  max-block-size: 260px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.versions li {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  padding: var(--space-2) var(--space-3);
  border-block-end: 1px solid var(--border);
}

.versions li:last-child { border-block-end: none; }

.pick {
  margin-inline-start: auto;
  padding: 2px var(--space-2);
  font: inherit;
  font-size: 12px;
  color: var(--accent);
  background: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.pick:hover { border-color: var(--accent); }

.tag {
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-muted);
  background: var(--bg-sunken);
  border: 1px solid var(--border);
}

.mono { font-family: var(--font-mono); font-size: 12px; }
.muted { color: var(--text-muted); }
.error { color: var(--danger); }

.readme {
  font-size: 13px;
  line-height: 1.65;
  overflow-wrap: break-word;
}

.readme :deep(h2),
.readme :deep(h3),
.readme :deep(h4) {
  margin-block: var(--space-4) var(--space-2);
  font-size: 14px;
}

.readme :deep(pre) {
  padding: var(--space-3);
  overflow-x: auto;
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.readme :deep(code) {
  font-family: var(--font-mono);
  font-size: 12px;
}

.readme :deep(a) { color: var(--accent); }

.readme :deep(blockquote) {
  margin-inline: 0;
  padding-inline-start: var(--space-3);
  border-inline-start: 2px solid var(--border-strong);
  color: var(--text-muted);
}
</style>
