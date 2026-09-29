/** Human-readable byte counts, in the decimal units disk tools report. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  const units = ['kB', 'MB', 'GB']
  let value = bytes / 1000
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

/** "3 years ago", "5 months ago", "today". Coarse on purpose: this is for staleness. */
export function formatAge(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return 'unknown'
  const days = Math.floor((now - then) / 86_400_000)
  if (days < 1) return 'today'
  if (days < 45) return `${days} ${days === 1 ? 'day' : 'days'} ago`
  const months = Math.floor(days / 30.44)
  if (months < 18) return `${months} ${months === 1 ? 'month' : 'months'} ago`
  const years = Math.floor(days / 365.25)
  return `${years} ${years === 1 ? 'year' : 'years'} ago`
}

/** Whole years since `iso`, or null when it cannot be read. */
export function yearsSince(
  iso: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (iso === null || iso === undefined) return null
  const then = Date.parse(iso)
  return Number.isNaN(then) ? null : Math.floor((now - then) / (365.25 * 86_400_000))
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  )
}
