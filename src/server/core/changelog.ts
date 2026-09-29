import semver from 'semver'
import { fetchRawFile, fetchReleases, type GithubRelease, type GithubRepo } from './github.ts'

/**
 * What changed between the installed version and an upgrade target, before running it.
 *
 * GitHub releases first, because they are per version and usually the most readable.
 * A CHANGELOG.md from the repository second — in the package's own directory when the
 * registry says it lives in a monorepo. The text is untrusted third-party Markdown and
 * is returned as text; the UI renders it through the same restricted renderer as a
 * README.
 */

export interface ChangelogEntry {
  version: string
  title: string | null
  date: string | null
  body: string
  url: string | null
}

export interface Changelog {
  source: 'releases' | 'changelog' | null
  entries: ChangelogEntry[]
  /** True when more versions were in range than are returned. */
  truncated: boolean
  /** Why nothing was found, when that is known. */
  unavailable: 'not-github' | 'rate-limited' | 'unreachable' | 'none' | null
}

const MAX_ENTRIES = 30
const VERSION_IN_TEXT = /v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/

/**
 * The version a release tag names, if it names this package. `v1.2.3` and `1.2.3`
 * always do. In a monorepo a tag carries a prefix — `vue@3.5.0`, `@scope/pkg@1.0.0`,
 * `pkg-v1.2.3` — and only a prefix naming this package counts, so one package's
 * drawer never shows its siblings' notes.
 */
export function versionFromTag(tag: string, packageName: string): string | null {
  const match = VERSION_IN_TEXT.exec(tag)
  if (match?.[1] === undefined || semver.valid(match[1]) === null) return null
  const prefix = tag.slice(0, match.index).replace(/[@/_-]+$/, '')
  if (prefix === '') return match[1]
  const unscoped = packageName.includes('/')
    ? packageName.slice(packageName.indexOf('/') + 1)
    : packageName
  return prefix === packageName || prefix === unscoped ? match[1] : null
}

function inRange(version: string, from: string | null, to: string): boolean {
  if (semver.gt(version, to)) return false
  return from === null || semver.valid(from) === null || semver.gt(version, from)
}

export function entriesFromReleases(
  releases: readonly GithubRelease[],
  packageName: string,
  from: string | null,
  to: string,
): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  for (const release of releases) {
    const version = versionFromTag(release.tag, packageName)
    if (version === null || !inRange(version, from, to)) continue
    entries.push({
      version,
      title: release.name,
      date: release.publishedAt,
      body: release.body ?? '',
      url: release.url,
    })
  }
  return entries.sort((a, b) => semver.rcompare(a.version, b.version))
}

/**
 * Splits a CHANGELOG into per-version sections. A section starts at any heading that
 * contains a version and runs to the next such heading; the conventions in the wild
 * (`## 1.2.3`, `## [1.2.3] - 2024-01-01`, `### v1.2.3 (date)`) all fit.
 */
export function entriesFromChangelog(
  text: string,
  from: string | null,
  to: string,
): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  let current: { version: string; title: string; lines: string[] } | null = null

  const flush = (): void => {
    if (current !== null && inRange(current.version, from, to)) {
      entries.push({
        version: current.version,
        title: current.title,
        date: /\d{4}-\d{2}-\d{2}/.exec(current.title)?.[0] ?? null,
        body: current.lines.join('\n').trim(),
        url: null,
      })
    }
  }

  for (const line of text.split(/\r?\n/)) {
    const heading = /^#{1,4}\s+(.*)$/.exec(line)
    const version = heading?.[1] === undefined ? undefined : VERSION_IN_TEXT.exec(heading[1])?.[1]
    if (heading?.[1] !== undefined && version !== undefined && semver.valid(version) !== null) {
      flush()
      current = { version, title: heading[1].trim(), lines: [] }
      continue
    }
    current?.lines.push(line)
  }
  flush()

  // A changelog lists each version once; keep the first if it does not.
  const seen = new Set<string>()
  return entries
    .filter((entry) => !seen.has(entry.version) && seen.add(entry.version))
    .sort((a, b) => semver.rcompare(a.version, b.version))
}

export async function buildChangelog(
  repo: GithubRepo | null,
  packageName: string,
  directory: string | null,
  from: string | null,
  to: string,
  signal?: AbortSignal,
): Promise<Changelog> {
  if (repo === null)
    return { source: null, entries: [], truncated: false, unavailable: 'not-github' }

  const releases = await fetchReleases(repo, signal)
  if (releases.ok) {
    const entries = entriesFromReleases(releases.value, packageName, from, to)
    if (entries.length > 0) {
      return {
        source: 'releases',
        entries: entries.slice(0, MAX_ENTRIES),
        truncated: entries.length > MAX_ENTRIES,
        unavailable: null,
      }
    }
  }

  const candidates = [...(directory === null ? [] : [`${directory}/CHANGELOG.md`]), 'CHANGELOG.md']
  let unreachable = false
  for (const path of candidates) {
    const file = await fetchRawFile(repo, path, signal)
    if (!file.ok) {
      if (file.reason !== 'not-found') unreachable = true
      continue
    }
    const entries = entriesFromChangelog(file.value, from, to)
    if (entries.length > 0) {
      return {
        source: 'changelog',
        entries: entries.slice(0, MAX_ENTRIES),
        truncated: entries.length > MAX_ENTRIES,
        unavailable: null,
      }
    }
  }

  const reason =
    !releases.ok && releases.reason === 'rate-limited'
      ? 'rate-limited'
      : unreachable
        ? 'unreachable'
        : 'none'
  return { source: null, entries: [], truncated: false, unavailable: reason }
}
