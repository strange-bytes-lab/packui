import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Does the lockfile record the same dependency specifiers as package.json?
 *
 * This replaced a comparison of modification times, which was wrong often enough to
 * train people to ignore the warning:
 *
 * - `git clone` writes files in index order, and `package-lock.json` and `bun.lock`
 *   sort before `package.json`. On a fresh checkout the manifest is always the newer
 *   file, so every npm and bun project warned before anyone had touched it.
 * - A frozen install (`npm ci`, `pnpm install --frozen-lockfile`) never rewrites the
 *   lockfile, so it could not clear a warning the checkout had caused.
 * - Editing `scripts` or `version` touches package.json without changing anything
 *   the lockfile records.
 *
 * Every package manager copies the specifiers it resolved into the lockfile, so
 * comparing those is the actual question. It needs to read four formats, but only
 * the part that lists each importer's declared ranges — never the resolution graph —
 * and a format that cannot be read answers `null`, which claims nothing either way.
 */

export type DependencyField =
  'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies'

export const DEPENDENCY_FIELDS: readonly DependencyField[] = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]

export interface DriftEntry {
  name: string
  field: DependencyField
  /** The range in package.json, or null when only the lockfile still lists it. */
  declared: string | null
  /** The range the lockfile recorded, or null when it has no entry for it. */
  locked: string | null
}

type Specifiers = Partial<Record<DependencyField, Record<string, string>>>

function readRecord(source: Record<string, unknown>, field: string): Record<string, string> {
  const value = source[field]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

/**
 * Compares one importer's declared fields against what a lockfile recorded for it.
 * Only `fields` are compared: pnpm, for one, never records peerDependencies, and
 * comparing a field the format does not carry would report drift that is not there.
 */
function compare(
  manifest: Record<string, unknown>,
  recorded: Specifiers,
  fields: readonly DependencyField[],
): DriftEntry[] {
  const drift: DriftEntry[] = []
  for (const field of fields) {
    const declared = readRecord(manifest, field)
    const locked = recorded[field] ?? {}
    for (const [name, range] of Object.entries(declared)) {
      const lockedRange = locked[name]
      if (lockedRange !== range) {
        drift.push({ name, field, declared: range, locked: lockedRange ?? null })
      }
    }
    for (const [name, range] of Object.entries(locked)) {
      if (declared[name] === undefined) drift.push({ name, field, declared: null, locked: range })
    }
  }
  return drift.sort((a, b) => a.name.localeCompare(b.name))
}

/* ------------------------------------------------------------------ *
 * npm: package-lock.json and npm-shrinkwrap.json (lockfileVersion 2+)
 * ------------------------------------------------------------------ */

function npmSpecifiers(text: string, importer: string): Specifiers | null {
  const parsed = JSON.parse(text) as { packages?: Record<string, Record<string, unknown>> }
  // lockfileVersion 1 has no record of the root's own declarations.
  const record = parsed.packages?.[importer === '.' ? '' : importer]
  if (record === undefined) return null
  return Object.fromEntries(DEPENDENCY_FIELDS.map((field) => [field, readRecord(record, field)]))
}

/* ------------------------------------------------------------------ *
 * pnpm: pnpm-lock.yaml
 * ------------------------------------------------------------------ */

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'")
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value) as string
  }
  return value
}

/** Splits `key: value` / `key:` where the key may be quoted and contain colons. */
function splitKey(content: string): [string, string] | null {
  let end: number
  if (content.startsWith("'") || content.startsWith('"')) {
    const quote = content[0] as string
    end = 1
    while (end < content.length) {
      if (content[end] === quote) {
        // YAML escapes a single quote inside single quotes by doubling it.
        if (quote === "'" && content[end + 1] === "'") {
          end += 2
          continue
        }
        break
      }
      if (quote === '"' && content[end] === '\\') end += 1
      end += 1
    }
    end += 1
    if (content[end] !== ':') return null
  } else {
    const spaced = content.indexOf(': ')
    end = spaced === -1 ? (content.endsWith(':') ? content.length - 1 : -1) : spaced
    if (end === -1) return null
  }
  return [unquote(content.slice(0, end).trim()), content.slice(end + 1).trim()]
}

/** Top-level sections that can hold declared specifiers. Everything else is skipped. */
const PNPM_SECTIONS = new Set([
  'importers',
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'specifiers',
])

/**
 * Reads the block mappings pnpm writes, which is all a pnpm lockfile is. This is not
 * a YAML parser and does not try to be: it understands indentation, `key: value` and
 * quoted keys, which is exactly the subset pnpm emits for importers, and it skips the
 * `packages` and `snapshots` sections without looking at them.
 */
export function readPnpmLeaves(text: string): Map<string, string> {
  const leaves = new Map<string, string>()
  const stack: { indent: number; key: string }[] = []
  let inSection = false

  for (const line of text.split(/\r?\n/)) {
    const content = line.trim()
    if (content === '' || content.startsWith('#')) continue
    const indent = line.length - line.trimStart().length

    if (indent === 0) {
      const split = splitKey(content)
      stack.length = 0
      inSection = split !== null && PNPM_SECTIONS.has(split[0])
      if (split === null) continue
      if (split[1] === '') stack.push({ indent, key: split[0] })
      else leaves.set(split[0], unquote(split[1]))
      continue
    }
    if (!inSection) continue

    const split = splitKey(content)
    if (split === null) continue
    while (stack.length > 0 && (stack.at(-1) as { indent: number }).indent >= indent) stack.pop()
    const path = [...stack.map((entry) => entry.key), split[0]]
    if (split[1] === '') stack.push({ indent, key: split[0] })
    else leaves.set(path.join('\u0000'), unquote(split[1]))
  }

  return leaves
}

const PNPM_FIELDS: readonly DependencyField[] = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
]

function pnpmSpecifiers(text: string, importer: string): Specifiers | null {
  const leaves = readPnpmLeaves(text)
  const version = Number.parseFloat(leaves.get('lockfileVersion') ?? '')
  if (!Number.isFinite(version)) return null

  const keys = [...leaves.keys()].map((key) => key.split('\u0000'))
  const hasImporters = keys.some((path) => path[0] === 'importers')
  // Without an importers section the lockfile describes a single project, not this one.
  if (!hasImporters && importer !== '.') return null
  // A lockfile that records no dependency sections at all is a stub, not an answer.
  if (!keys.some((path) => PNPM_SECTIONS.has(path[0] as string))) return null
  const prefix = hasImporters ? ['importers', importer] : []
  const matches = (path: string[]): boolean => prefix.every((part, index) => path[index] === part)

  const scoped = keys.filter(matches).map((path) => path.slice(prefix.length))
  // A workspace lockfile with no entry for this importer says nothing about it — but
  // `.: {}` (a project with no dependencies) is an entry, and an empty one.
  if (hasImporters && scoped.length === 0 && !leaves.has(['importers', importer].join('\u0000'))) {
    return null
  }

  const specifiers: Specifiers = {}
  if (version >= 6) {
    // v6 and later: `<field>: <name>: { specifier, version }`.
    for (const path of scoped) {
      const [field, name, leaf] = path
      if (leaf !== 'specifier' || name === undefined) continue
      if (!PNPM_FIELDS.includes(field as DependencyField)) continue
      const value = leaves.get([...prefix, ...path].join('\u0000'))
      if (value === undefined) continue
      ;(specifiers[field as DependencyField] ??= {})[name] = value
    }
  } else {
    // v5: one `specifiers` map, with each field listing only resolved versions.
    const ranges = new Map<string, string>()
    for (const path of scoped) {
      if (path[0] !== 'specifiers' || path[1] === undefined) continue
      ranges.set(path[1], leaves.get([...prefix, ...path].join('\u0000')) ?? '')
    }
    for (const path of scoped) {
      const [field, name] = path
      if (name === undefined || path.length !== 2) continue
      if (!PNPM_FIELDS.includes(field as DependencyField)) continue
      const range = ranges.get(name)
      if (range !== undefined) (specifiers[field as DependencyField] ??= {})[name] = range
    }
  }
  return specifiers
}

/* ------------------------------------------------------------------ *
 * bun: bun.lock (text; bun.lockb is binary and answers null)
 * ------------------------------------------------------------------ */

/** bun.lock is JSON with trailing commas. Drops those, leaving strings untouched. */
export function stripTrailingCommas(text: string): string {
  let result = ''
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string
    if (inString) {
      result += char
      if (char === '\\') {
        result += text[index + 1] ?? ''
        index += 1
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      result += char
      continue
    }
    if (char === ',') {
      let next = index + 1
      while (next < text.length && /\s/.test(text[next] as string)) next += 1
      if (text[next] === '}' || text[next] === ']') continue
    }
    result += char
  }
  return result
}

function bunSpecifiers(text: string, importer: string): Specifiers | null {
  const parsed = JSON.parse(stripTrailingCommas(text)) as {
    workspaces?: Record<string, Record<string, unknown>>
  }
  const record = parsed.workspaces?.[importer === '.' ? '' : importer]
  if (record === undefined) return null
  return Object.fromEntries(
    DEPENDENCY_FIELDS.filter((field) => field !== 'peerDependencies' || field in record).map(
      (field) => [field, readRecord(record, field)],
    ),
  )
}

/* ------------------------------------------------------------------ *
 * yarn: yarn.lock, classic (v1) and berry (v2+)
 * ------------------------------------------------------------------ */

/**
 * yarn keys entries by every `name@range` that resolved to them, and shares one
 * lockfile across a workspace. So the question it can answer is "has this exact
 * request been resolved?", not "what did this importer declare?" — which means it
 * can report a range that was edited or added, but not one that was removed.
 */
function yarnDrift(text: string, manifest: Record<string, unknown>): DriftEntry[] | null {
  const berry = /^__metadata:/m.test(text)
  if (!berry && !text.includes('# yarn lockfile v1')) return null

  const requests = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    if (line === '' || /^\s/.test(line) || line.startsWith('#') || !line.endsWith(':')) continue
    for (const part of line.slice(0, -1).split(/,\s*/)) requests.add(unquote(part.trim()))
  }
  requests.delete('__metadata')
  // yarn writes an entry for every dependency; one with none is a stub, not an answer.
  if (requests.size === 0) return null

  const drift: DriftEntry[] = []
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    for (const [name, range] of Object.entries(readRecord(manifest, field))) {
      let request: string
      if (berry) {
        // berry prefixes a bare range with its protocol. Anything that already has a
        // protocol (workspace:, patch:, git URLs, github shorthand) is recorded in a
        // normalised form packui cannot reproduce, so it is not judged.
        if (/[:/]/.test(range)) continue
        request = `${name}@npm:${range}`
      } else {
        // Classic yarn does not lock workspace or link protocols at all.
        if (/^(workspace|link|portal):/.test(range)) continue
        request = `${name}@${range}`
      }
      if (!requests.has(request)) drift.push({ name, field, declared: range, locked: null })
    }
  }
  return drift.sort((a, b) => a.name.localeCompare(b.name))
}

/* ------------------------------------------------------------------ */

/**
 * Entries where package.json and the lockfile disagree for one importer, or null when
 * the lockfile cannot say. `importer` is the package's path relative to the directory
 * holding the lockfile, in POSIX form, `.` for the root — the key every workspace
 * lockfile format uses.
 */
export async function findLockfileDrift(
  lockfileDir: string,
  lockfile: string | null,
  importer: string,
  manifest: Record<string, unknown>,
): Promise<DriftEntry[] | null> {
  if (lockfile === null || lockfile === 'bun.lockb') return null

  let text: string
  try {
    text = await readFile(join(lockfileDir, lockfile), 'utf8')
  } catch {
    return null
  }

  try {
    switch (lockfile) {
      case 'package-lock.json':
      case 'npm-shrinkwrap.json': {
        const recorded = npmSpecifiers(text, importer)
        return recorded === null ? null : compare(manifest, recorded, DEPENDENCY_FIELDS)
      }
      case 'pnpm-lock.yaml': {
        const recorded = pnpmSpecifiers(text, importer)
        return recorded === null ? null : compare(manifest, recorded, PNPM_FIELDS)
      }
      case 'bun.lock': {
        const recorded = bunSpecifiers(text, importer)
        if (recorded === null) return null
        return compare(manifest, recorded, Object.keys(recorded) as DependencyField[])
      }
      case 'yarn.lock':
        return yarnDrift(text, manifest)
      default:
        return null
    }
  } catch {
    // A lockfile packui cannot parse is not evidence of drift.
    return null
  }
}
