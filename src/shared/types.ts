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
  | 'stale' // the lockfile records a different range than package.json declares
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
  /**
   * Whether `vulnerabilities: null` means anything. Absent until enrichment lands.
   * 'unavailable': OSV could not be reached and nothing was cached.
   * 'private': the package comes from a registry its scope is mapped to in .npmrc,
   * which OSV cannot know about — so its name is never sent there either.
   */
  vulnerabilityCheck?: VulnerabilityCheck
}

export type VulnerabilityCheck = 'checked' | 'unavailable' | 'private'

/**
 * A project has a manifest and a lockfile; a global scope has neither, only whatever
 * is installed. The UI hides alignment and declared ranges for global scopes because
 * there is nothing for them to mean.
 */
export type Scope = 'project' | 'global'

export interface ProjectSummary {
  scope: Scope
  /** Absolute path to the project root. */
  path: string
  /** The same path with the home directory collapsed to `~`, for display. */
  displayPath: string
  name: string
  packageManager: PackageManager | null
  lockfile: string | null
  hasNodeModules: boolean
}

/** One dependency where package.json and the lockfile disagree. */
export interface LockfileDrift {
  name: string
  field: 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies'
  /** The range in package.json, or null when only the lockfile still lists it. */
  declared: string | null
  /** The range the lockfile recorded, or null when it has no entry for it. */
  locked: string | null
}

export interface DependencyReport {
  project: ProjectSummary
  dependencies: DependencyRow[]
  /**
   * Where package.json and the lockfile disagree. Null when the lockfile could not
   * answer (none, binary, or an unreadable format) — which claims nothing either way.
   */
  drift: LockfileDrift[] | null
  /** Project-wide alignment verdict, worst-case across all rows. */
  alignment: AlignmentState
  generatedAt: string
}
