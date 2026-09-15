/** Mirrors the payload built by src/server/api/impact.ts. */

import type { DependencyKind } from '@shared/types'

export interface Usage {
  file: string
  line: number
  snippet: string
}

export interface RemovalImpact {
  name: string
  installed: string | null
  declared: string | null
  kind: DependencyKind | null
  usages: Usage[]
  usageFileCount: number
  filesScanned: number
  truncated: boolean
  dependents: string[]
  risk: 'safe' | 'caution' | 'breaking'
}
