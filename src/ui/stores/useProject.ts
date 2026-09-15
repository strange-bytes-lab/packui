import { computed, ref } from 'vue'
import type { DependencyReport } from '@shared/types'
import { apiFetch } from '@/composables/useApi'

/**
 * A single shared report, kept module-level so the sidebar and the table read the
 * same state without prop drilling. Vue's reactivity is sufficient here; a store
 * library would be another dependency for no benefit.
 */
const report = ref<DependencyReport | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

export async function loadProject(path?: string): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const query = path === undefined ? '' : `?path=${encodeURIComponent(path)}`
    report.value = await apiFetch<DependencyReport>(`/deps${query}`)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not read this project'
    report.value = null
  } finally {
    loading.value = false
  }
}

export function useProject() {
  return {
    report,
    loading,
    error,
    project: computed(() => report.value?.project ?? null),
    dependencies: computed(() => report.value?.dependencies ?? []),
  }
}
