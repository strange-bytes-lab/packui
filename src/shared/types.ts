/** Types shared between the server and the UI. */

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export type DependencyKind = 'prod' | 'dev' | 'peer' | 'optional'

/** How far behind the installed version is, by semver precedence. */
export type OutdatedSeverity = 'current' | 'patch' | 'minor' | 'major' | 'unknown'

/**
 * Whether what is declared in package.json matches what is actually installed.
 * Deliberately does not require parsing lockfiles — see docs in core/lockfile.ts.
 */
export type AlignmentState =
  | 'aligned'
  | 'missing' // declared but not present in node_modules
  | 'unsatisfied' // installed, but the installed version does not satisfy the declared range
  | 'stale' // package.json modified more recently than the lockfile
  | 'unknown' // no node_modules at all; nothing can be concluded

export interface VulnerabilitySummary {
  count: number
  /** Highest severity across all matching advisories. */
  worst: 'low' | 'moderate' | 'high' | 'critical' | null
  ids: string[]
}

export interface DependencyRow {
  name: string
  kind: DependencyKind
  /** The range as written in package.json, e.g. "^3.4.1". */
  declared: string
  /** The version actually present in node_modules, if any. */
  installed: string | null
  /** Latest version on the registry. Null until enrichment lands. */
  latest: string | null
  outdated: OutdatedSeverity
  alignment: AlignmentState
  deprecated: string | null
  vulnerabilities: VulnerabilitySummary | null
}

export interface ProjectSummary {
  /** Absolute path to the project root. */
  path: string
  name: string
  packageManager: PackageManager | null
  lockfile: string | null
  hasNodeModules: boolean
}

export interface DependencyReport {
  project: ProjectSummary
  dependencies: DependencyRow[]
  /** Project-wide alignment verdict, worst-case across all rows. */
  alignment: AlignmentState
  generatedAt: string
}
