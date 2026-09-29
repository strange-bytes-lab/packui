<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { apiFetch } from '@/composables/useApi'
import { formatBytes } from '@/composables/format'
import { withSelection } from '@/stores/useProject'
import type { IndirectAdvisory, TreeAudit, WeightReport } from '@/types/insights'
import type { UsageAudit } from '@/types/usage'

/**
 * Whole-tree views that no single row can show. Each tab loads when first opened —
 * the weight walk reads every file in node_modules, and nobody should pay for that
 * just by loading the table.
 */
export type InsightsTab = 'advisories' | 'weight' | 'usage'

const props = defineProps<{
  open: InsightsTab | null
  audit: TreeAudit | null
  auditing: boolean
  auditError: string | null
  packageManager: string | null
}>()
const emit = defineEmits<{ close: []; select: [name: string] }>()

const dialog = ref<HTMLDialogElement | null>(null)
const tab = ref<InsightsTab>('advisories')

const weight = ref<WeightReport | null>(null)
const weightError = ref<string | null>(null)
const weightLoading = ref(false)

const usage = ref<UsageAudit | null>(null)
const usageError = ref<string | null>(null)
const usageLoading = ref(false)

async function loadWeight(): Promise<void> {
  if (weight.value !== null || weightLoading.value) return
  weightLoading.value = true
  weightError.value = null
  try {
    weight.value = await apiFetch<WeightReport>(withSelection('/weight'))
  } catch (cause) {
    weightError.value = cause instanceof Error ? cause.message : 'Could not measure the tree'
  } finally {
    weightLoading.value = false
  }
}

async function loadUsage(): Promise<void> {
  if (usage.value !== null || usageLoading.value) return
  usageLoading.value = true
  usageError.value = null
  try {
    usage.value = await apiFetch<UsageAudit>(withSelection('/usage'))
  } catch (cause) {
    usageError.value = cause instanceof Error ? cause.message : 'Could not scan the source'
  } finally {
    usageLoading.value = false
  }
}

function show(next: InsightsTab): void {
  tab.value = next
  if (next === 'weight') void loadWeight()
  if (next === 'usage') void loadUsage()
}

watch(
  () => props.open,
  (next) => {
    if (next === null) {
      dialog.value?.close()
      return
    }
    // A fresh open is a fresh look: the tree may have changed since the last one.
    weight.value = null
    usage.value = null
    show(next)
    if (!dialog.value?.open) dialog.value?.showModal()
  },
)

/**
 * The override block for this project's package manager. Shown, never applied: packui
 * does not edit package.json, and an override is a decision to make with the diff in
 * front of you. Pinned exactly, because a range could resolve back to a vulnerable
 * version on the next install.
 */
function overrideSnippet(entry: IndirectAdvisory): string {
  const pin = JSON.stringify({ [entry.name]: entry.suggested })
  switch (props.packageManager) {
    case 'pnpm':
      return `"pnpm": { "overrides": ${pin} }`
    case 'yarn':
      return `"resolutions": ${pin}`
    default:
      return `"overrides": ${pin}`
  }
}

const copied = ref<string | null>(null)
async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = text
    setTimeout(() => {
      if (copied.value === text) copied.value = null
    }, 1500)
  } catch {
    // Clipboard access can be refused; the text is still selectable.
  }
}

const advisoryCount = computed(() => props.audit?.vulnerable.length ?? 0)

/** `@scope/name@1.2.3` → `@scope/name`. The first `@` of a scoped name is not the separator. */
function nameOf(label: string): string {
  const at = label.lastIndexOf('@')
  return at > 0 ? label.slice(0, at) : label
}

function pick(name: string): void {
  dialog.value?.close()
  emit('select', name)
}
</script>

<template>
  <dialog ref="dialog" class="insights" @close="emit('close')" @click.self="dialog?.close()">
    <article class="panel">
      <header class="header">
        <div class="tabs" role="tablist" aria-label="Insights">
          <button
            type="button"
            role="tab"
            :aria-selected="tab === 'advisories'"
            @click="show('advisories')"
          >
            Indirect advisories
            <span v-if="advisoryCount > 0" class="count">{{ advisoryCount }}</span>
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="tab === 'weight'"
            @click="show('weight')"
          >
            Weight &amp; duplicates
          </button>
          <button type="button" role="tab" :aria-selected="tab === 'usage'" @click="show('usage')">
            Unused &amp; undeclared
          </button>
        </div>
        <button type="button" class="close" aria-label="Close" @click="dialog?.close()">×</button>
      </header>

      <!-- Indirect advisories -->
      <section v-if="tab === 'advisories'" role="tabpanel">
        <p v-if="auditing && !audit" class="muted">Walking the installed tree and asking OSV…</p>
        <p v-else-if="auditError" class="error">{{ auditError }}</p>
        <template v-else-if="audit">
          <p class="lede">
            Checked {{ audit.packages }} installed packages.
            <template v-if="audit.vulnerable.length === 0 && audit.unchecked === 0">
              No advisories in anything your dependencies depend on.
            </template>
            <template v-else-if="audit.vulnerable.length > 0">
              {{ audit.vulnerable.length }} indirect
              {{ audit.vulnerable.length === 1 ? 'package has' : 'packages have' }} advisories.
            </template>
          </p>
          <p v-if="audit.unchecked > 0" class="note">
            {{ audit.unchecked }} could not be checked — OSV was unreachable and nothing was cached.
            They are not counted as clean.
          </p>
          <p v-if="audit.privateSkipped > 0" class="note">
            {{ audit.privateSkipped }} from privately scoped registries were not sent to OSV.
          </p>
          <p v-if="audit.truncated" class="note">
            The tree was too large to walk completely; this list may be missing entries.
          </p>

          <ul class="cards">
            <li
              v-for="entry in audit.vulnerable"
              :key="`${entry.name}@${entry.version}:${entry.chain.join('>')}`"
            >
              <div class="card-head">
                <span class="severity" :data-severity="entry.advisories.worst ?? 'unknown'">
                  {{ entry.advisories.worst ?? 'unrated' }}
                </span>
                <span class="mono strong">{{ entry.name }}@{{ entry.version }}</span>
                <span class="muted small">
                  {{ entry.advisories.count }}
                  {{ entry.advisories.count === 1 ? 'advisory' : 'advisories' }}
                </span>
              </div>
              <p class="chain mono">
                <template v-for="(link, index) in entry.chain" :key="index">
                  <span v-if="index > 0" class="arrow" aria-hidden="true">→</span>
                  <button
                    v-if="index === 0"
                    type="button"
                    class="link"
                    :title="`Open ${nameOf(link)}`"
                    @click="pick(nameOf(link))"
                  >
                    {{ link }}
                  </button>
                  <span v-else>{{ link }}</span>
                </template>
              </p>
              <p v-if="entry.via.length > 1" class="small muted">
                Also pulled in by {{ entry.via.length - 1 }} other direct
                {{ entry.via.length === 2 ? 'dependency' : 'dependencies' }}:
                {{ entry.via.slice(1).join(', ') }}
              </p>
              <p class="small">
                <template v-if="entry.suggested">
                  Fixed in <span class="mono">{{ entry.suggested }}</span
                  >. Upgrading <strong>{{ entry.via.join(', ') }}</strong> may bring it in; if not,
                  an override pins it:
                </template>
                <template v-else>No fixed version is published for every advisory.</template>
              </p>
              <div v-if="entry.suggested" class="snippet">
                <code class="mono">{{ overrideSnippet(entry) }}</code>
                <button type="button" class="copy" @click="copy(overrideSnippet(entry))">
                  {{ copied === overrideSnippet(entry) ? 'Copied' : 'Copy' }}
                </button>
              </div>
            </li>
          </ul>
        </template>
      </section>

      <!-- Weight -->
      <section v-else-if="tab === 'weight'" role="tabpanel">
        <p v-if="weightLoading" class="muted">Measuring node_modules…</p>
        <p v-else-if="weightError" class="error">{{ weightError }}</p>
        <template v-else-if="weight">
          <p class="lede">
            {{ weight.packages }} installed packages, {{ formatBytes(weight.totalBytes) }} on disk.
          </p>
          <p v-if="weight.truncated" class="note">
            The tree was too large to measure completely; sizes are lower bounds.
          </p>
          <table class="grid">
            <thead>
              <tr>
                <th scope="col">Dependency</th>
                <th scope="col" class="num">Own</th>
                <th scope="col" class="num" title="Everything it pulls in, itself included">
                  With deps
                </th>
                <th
                  scope="col"
                  class="num"
                  title="What removing it would free: the part of its tree nothing else needs"
                >
                  Frees
                </th>
                <th scope="col" class="num">Packages</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in weight.direct" :key="entry.name">
                <th scope="row">
                  <button type="button" class="link mono" @click="pick(entry.name)">
                    {{ entry.name }}
                  </button>
                </th>
                <td class="num mono">{{ formatBytes(entry.own) }}</td>
                <td class="num mono">{{ formatBytes(entry.withDependencies) }}</td>
                <td class="num mono">{{ formatBytes(entry.exclusive) }}</td>
                <td class="num mono">{{ entry.packages }}</td>
              </tr>
            </tbody>
          </table>

          <h3 class="subhead">Installed at more than one version</h3>
          <p v-if="weight.duplicates.length === 0" class="muted">None.</p>
          <ul v-else class="cards">
            <li v-for="duplicate in weight.duplicates" :key="duplicate.name">
              <div class="card-head">
                <span class="mono strong">{{ duplicate.name }}</span>
                <span class="muted small">{{ duplicate.versions.length }} versions</span>
              </div>
              <ul class="versions">
                <li v-for="version in duplicate.versions" :key="version.version">
                  <span class="mono">{{ version.version }}</span>
                  <span class="muted small">
                    {{ formatBytes(version.bytes) }}
                    <template v-if="version.copies > 1">· {{ version.copies }} copies</template>
                    · wanted by {{ version.requiredBy.join(', ') || '—' }}
                  </span>
                </li>
              </ul>
            </li>
          </ul>
        </template>
      </section>

      <!-- Unused & undeclared -->
      <section v-else role="tabpanel">
        <p v-if="usageLoading" class="muted">Scanning source for imports…</p>
        <p v-else-if="usageError" class="error">{{ usageError }}</p>
        <template v-else-if="usage">
          <p class="lede">Scanned {{ usage.filesScanned }} source files.</p>
          <p v-if="usage.truncated" class="note">
            The scan stopped at its file limit, so "no imports found" is not conclusive here.
          </p>

          <h3 class="subhead">Declared, but never imported</h3>
          <p class="small muted">
            Candidates for removal — check first. Tools run from scripts or config files, and
            packages loaded by name at runtime, do not show up as imports.
          </p>
          <p v-if="usage.unused.length === 0" class="muted">None.</p>
          <ul v-else class="plain">
            <li v-for="entry in usage.unused" :key="entry.name">
              <button type="button" class="link mono" @click="pick(entry.name)">
                {{ entry.name }}
              </button>
              <span class="tag">{{ entry.kind }}</span>
              <span v-if="entry.reason" class="small muted">{{ entry.reason }}</span>
            </li>
          </ul>

          <h3 class="subhead">Imported, but not declared</h3>
          <p class="small muted">
            These work only because something else installs them. A dependency upgrade that drops
            them breaks this project without touching its package.json.
          </p>
          <p v-if="usage.undeclared.length === 0" class="muted">None.</p>
          <ul v-else class="cards">
            <li v-for="entry in usage.undeclared" :key="entry.name">
              <div class="card-head">
                <span class="mono strong">{{ entry.name }}</span>
                <span v-if="entry.installed" class="muted small"
                  >installed {{ entry.installed }}</span
                >
              </div>
              <ul class="plain small">
                <li v-for="site in entry.usages" :key="`${site.file}:${site.line}`" class="mono">
                  {{ site.file }}:{{ site.line }}
                </li>
              </ul>
            </li>
          </ul>
        </template>
      </section>
    </article>
  </dialog>
</template>

<style scoped>
.insights {
  padding: 0;
  inline-size: min(860px, 94vw);
  max-block-size: 88vh;
  color: var(--text);
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-overlay);
}

.insights::backdrop {
  background: rgb(0 0 0 / 0.4);
}

.panel {
  max-block-size: 88vh;
  padding: var(--space-5);
  overflow-y: auto;
}

.header {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  margin-block-end: var(--space-4);
}

.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.tabs button {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  padding: var(--space-2) var(--space-3);
  font: inherit;
  font-size: 13px;
  color: var(--text-muted);
  background: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  cursor: pointer;
}

.tabs button[aria-selected='true'] {
  color: var(--text);
  border-color: var(--accent);
}

.count {
  padding: 0 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--accent-contrast);
  background: var(--major);
  border-radius: 999px;
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

.lede {
  margin: 0 0 var(--space-3);
}

.note {
  margin: 0 0 var(--space-3);
  font-size: 13px;
  color: var(--minor);
}

.subhead {
  margin: var(--space-5) 0 var(--space-2);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.cards,
.plain,
.versions {
  margin: 0;
  padding: 0;
  list-style: none;
}

.cards > li {
  padding: var(--space-3);
  margin-block-end: var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.plain > li {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: baseline;
  padding-block: 2px;
}

.versions li {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: baseline;
}

.card-head {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
  margin-block-end: var(--space-2);
}

.chain {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  align-items: center;
  margin: 0 0 var(--space-2);
}

.arrow {
  color: var(--text-faint);
}

.snippet {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  padding: var(--space-2) var(--space-3);
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.snippet code {
  flex: 1;
  overflow-x: auto;
  white-space: nowrap;
}

.copy,
.link {
  padding: 0;
  font: inherit;
  color: var(--accent);
  background: none;
  border: none;
  cursor: pointer;
}

.copy {
  font-size: 12px;
}

.link:hover {
  text-decoration: underline;
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
.severity[data-severity='high'] {
  color: var(--major);
}
.severity[data-severity='moderate'] {
  color: var(--minor);
}
.severity[data-severity='low'],
.severity[data-severity='unknown'] {
  color: var(--text-muted);
}

.grid {
  inline-size: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.grid th,
.grid td {
  padding: var(--space-2) var(--space-3);
  text-align: start;
  border-block-end: 1px solid var(--border);
}

.grid thead th {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.grid tbody th {
  font-weight: 400;
}

.num {
  text-align: end !important;
  white-space: nowrap;
}

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

.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}
.strong {
  font-weight: 600;
}
.small {
  margin: 0 0 var(--space-2);
  font-size: 12px;
}
.muted {
  color: var(--text-muted);
}
.error {
  color: var(--danger);
}
</style>
