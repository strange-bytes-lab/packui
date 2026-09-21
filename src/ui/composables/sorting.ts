import type { DependencyRow } from '@shared/types'
import { rowStatus, STATUS_RANK } from '@/composables/rowStatus'

/**
 * Column sorting for the dependency table.
 *
 * Versions are compared by semver precedence rather than as strings, because a
 * string sort puts 1.10.0 before 1.9.0 and puts a prerelease after the release it
 * precedes. Anything that does not parse falls back to a numeric-aware collator,
 * which is wrong less often than a plain string compare for things like `1.0.0b`.
 */

export type SortKey = 'status' | 'name' | 'kind' | 'declared' | 'installed' | 'latest' | 'flags'
export type SortDirection = 'asc' | 'desc'

/**
 * Which way a column sorts on its first click. For the columns that describe a
 * problem, the first thing anyone wants is the worst rows, not the quietest.
 */
export const FIRST_DIRECTION: Readonly<Record<SortKey, SortDirection>> = {
  status: 'desc',
  name: 'asc',
  kind: 'asc',
  declared: 'asc',
  installed: 'asc',
  latest: 'asc',
  flags: 'desc',
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

const KIND_ORDER: Readonly<Record<DependencyRow['kind'], number>> = {
  prod: 0,
  dev: 1,
  peer: 2,
  optional: 3,
}

const SEVERITY_RANK: Readonly<Record<string, number>> = {
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
}

interface ParsedVersion {
  numbers: [number, number, number]
  prerelease: string[]
}

function parseVersion(value: string): ParsedVersion | null {
  const match = /^[v=\s]*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value)
  if (match === null) return null

  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** Semver precedence for the prerelease field: numeric identifiers sort below alphanumeric. */
function comparePrerelease(a: string[], b: string[]): number {
  // An absent prerelease outranks any present one: 1.0.0 comes after 1.0.0-rc.1.
  if (a.length === 0 || b.length === 0) return b.length - a.length

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue

    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) return Number(left) - Number(right)
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return left < right ? -1 : 1
  }

  return 0
}

/** Ascending semver precedence. Null sorts last in either direction; see compareRows. */
export function compareVersions(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1

  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return collator.compare(a, b)

  for (let index = 0; index < 3; index += 1) {
    const difference = (left.numbers[index] as number) - (right.numbers[index] as number)
    if (difference !== 0) return difference
  }

  return comparePrerelease(left.prerelease, right.prerelease)
}

/** How loud a row's flags are: severity first, then how many, then deprecation. */
function flagsRank(row: DependencyRow): [number, number, number] {
  const summary = row.vulnerabilities
  return [
    summary?.worst === undefined || summary.worst === null
      ? 0
      : (SEVERITY_RANK[summary.worst] ?? 0),
    summary?.count ?? 0,
    row.deprecated === null ? 0 : 1,
  ]
}

function ascending(a: DependencyRow, b: DependencyRow, key: SortKey): number {
  switch (key) {
    case 'status':
      return STATUS_RANK[rowStatus(a).tone] - STATUS_RANK[rowStatus(b).tone]
    case 'kind':
      return KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    case 'declared':
      return collator.compare(a.declared, b.declared)
    case 'installed':
      return compareVersions(a.installed, b.installed)
    case 'latest':
      return compareVersions(a.latest, b.latest)
    case 'flags': {
      const left = flagsRank(a)
      const right = flagsRank(b)
      return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
    }
    case 'name':
      return collator.compare(a.name, b.name)
  }
}

/**
 * A missing version sorts last whichever way the column is pointing. Reversing the
 * order should not promote the rows that have nothing to show to the top.
 */
function nullsLast(a: DependencyRow, b: DependencyRow, key: SortKey): number | null {
  if (key !== 'installed' && key !== 'latest') return null

  const left = a[key]
  const right = b[key]
  if (left === null && right !== null) return 1
  if (right === null && left !== null) return -1
  return null
}

export function compareRows(
  a: DependencyRow,
  b: DependencyRow,
  key: SortKey,
  direction: SortDirection,
): number {
  const missing = nullsLast(a, b, key)
  if (missing !== null) return missing

  const order = ascending(a, b, key)
  if (order !== 0) return direction === 'asc' ? order : -order

  // Ties fall back to the name, so the order is total and a re-sort never shuffles.
  return collator.compare(a.name, b.name)
}
