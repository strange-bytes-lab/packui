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

/** Mirrors src/server/core/compat.ts. */
export interface CompatReport {
  name: string
  version: string
  engines: {
    required: string | null
    runtime: string
    runtimeOk: boolean | null
    project: string | null
    narrows: boolean | null
  }
  peers: {
    name: string
    range: string
    optional: boolean
    installed: string | null
    satisfied: boolean | null
  }[]
  deprecated: string | null
  concerns: boolean
}

/** Mirrors src/server/core/changelog.ts plus the handler's from/to. */
export interface ChangelogPayload {
  from: string | null
  to: string
  source: 'releases' | 'changelog' | null
  entries: {
    version: string
    title: string | null
    date: string | null
    body: string
    url: string | null
  }[]
  truncated: boolean
  unavailable: 'not-github' | 'rate-limited' | 'unreachable' | 'none' | null
}

/** Mirrors src/server/core/health.ts. */
export interface PackageHealth {
  modified: string | null
  weeklyDownloads: number | null
  repository: {
    archived: boolean
    pushedAt: string | null
    stars: number | null
    openIssues: number | null
  } | null
  repositoryUnavailable: 'not-found' | 'rate-limited' | 'unreachable' | null
}
