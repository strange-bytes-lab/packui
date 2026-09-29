/** Mirrors src/server/core/audit.ts, weight.ts and usage.ts's unused/undeclared scan. */
import type { VulnerabilitySummary } from '@shared/types'

export interface IndirectAdvisory {
  name: string
  version: string
  advisories: VulnerabilitySummary
  fixedIn: string[]
  suggested: string | null
  chain: string[]
  via: string[]
}

export interface TreeAudit {
  packages: number
  truncated: boolean
  vulnerable: IndirectAdvisory[]
  byDirect: Record<string, { count: number; worst: VulnerabilitySummary['worst'] }>
  unchecked: number
  privateSkipped: number
}

export interface DirectWeight {
  name: string
  version: string
  own: number
  withDependencies: number
  exclusive: number
  packages: number
}

export interface Duplicate {
  name: string
  versions: { version: string; copies: number; requiredBy: string[]; bytes: number }[]
}

export interface WeightReport {
  packages: number
  totalBytes: number
  truncated: boolean
  direct: DirectWeight[]
  duplicates: Duplicate[]
}
