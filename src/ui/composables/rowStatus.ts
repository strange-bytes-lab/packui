import type { AlignmentState, OutdatedSeverity, VulnerabilitySummary } from '@shared/types'

/**
 * One glyph carrying the row's headline state, ranked by what should worry you most.
 *
 * A serious advisory outranks everything: a package that is one patch behind but
 * carries a critical CVE is not a mild problem, and colouring it as one would be
 * actively misleading. Below that, alignment problems outrank being behind, because
 * a project that will not install correctly is the more immediate obstacle.
 *
 * This lives outside StatusDot because sorting the table by status has to agree with
 * the dot exactly. Two rankings that drift apart would be worse than none.
 */

export type StatusTone = 'major' | 'minor' | 'patch' | 'ok' | 'unknown'

export interface RowStatus {
  tone: StatusTone
  label: string
}

export interface StatusInput {
  outdated: OutdatedSeverity
  alignment: AlignmentState
  vulnerabilities: VulnerabilitySummary | null
}

/** Severity order, worst last, so a larger number is a louder row. */
export const STATUS_RANK: Readonly<Record<StatusTone, number>> = {
  unknown: 0,
  ok: 1,
  patch: 2,
  minor: 3,
  major: 4,
}

export function rowStatus(input: StatusInput): RowStatus {
  const worst = input.vulnerabilities?.worst

  if (worst === 'critical' || worst === 'high') {
    return { tone: 'major', label: `Vulnerable — ${worst} severity advisory` }
  }

  if (input.alignment === 'missing') return { tone: 'major', label: 'Not installed' }
  if (input.alignment === 'unsatisfied') {
    return { tone: 'major', label: 'Installed version is outside the declared range' }
  }

  if (worst === 'moderate' || worst === 'low') {
    return { tone: 'minor', label: `Vulnerable — ${worst} severity advisory` }
  }

  if (input.outdated === 'major') return { tone: 'major', label: 'Major version behind' }
  if (input.outdated === 'minor') return { tone: 'minor', label: 'Minor version behind' }
  if (input.outdated === 'patch') return { tone: 'patch', label: 'Patch version behind' }
  if (input.outdated === 'current') return { tone: 'ok', label: 'Up to date' }

  return { tone: 'unknown', label: 'Not checked yet' }
}
