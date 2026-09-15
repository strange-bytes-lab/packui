/** Mirrors the payload built by src/server/api/package.ts. */

export interface AdvisoryDetail {
  id: string
  summary: string | null
  details: string | null
  severity: 'low' | 'moderate' | 'high' | 'critical' | null
  fixedIn: string[]
  references: string[]
}

export interface PackageDetail {
  homepage: string | null
  repository: string | null
  license: string | null
  description: string | null
}

export interface PackageDrawerPayload {
  name: string
  installed: string | null
  latest: string | null
  versions: string[]
  deprecated: string | null
  detail: PackageDetail | null
  readme: string | null
  advisories: AdvisoryDetail[]
  repositoryUrl: string | null
  releasesUrl: string | null
}
