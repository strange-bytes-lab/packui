import { ref, watchEffect } from 'vue'

export const THEMES = [
  { id: 'auto', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'paper', label: 'Paper' },
  { id: 'dark', label: 'Dark' },
  { id: 'midnight', label: 'Midnight' },
] as const

export type ThemeId = (typeof THEMES)[number]['id']

function readStoredTheme(): ThemeId {
  const stored = localStorage.getItem('packui:theme')
  return THEMES.some((theme) => theme.id === stored) ? (stored as ThemeId) : 'auto'
}

const theme = ref<ThemeId>(readStoredTheme())

watchEffect(() => {
  document.documentElement.dataset.theme = theme.value
  localStorage.setItem('packui:theme', theme.value)
})

export function useTheme() {
  return { theme, themes: THEMES }
}
