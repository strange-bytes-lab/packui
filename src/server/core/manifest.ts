import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DependencyKind } from '../../shared/types.ts'

export interface DeclaredDependency {
  name: string
  kind: DependencyKind
  range: string
}

export interface Manifest {
  name: string
  version: string | null
  dependencies: DeclaredDependency[]
  raw: Record<string, unknown>
}

const DEPENDENCY_FIELDS: ReadonlyArray<readonly [string, DependencyKind]> = [
  ['dependencies', 'prod'],
  ['devDependencies', 'dev'],
  ['peerDependencies', 'peer'],
  ['optionalDependencies', 'optional'],
]

function readRecord(source: Record<string, unknown>, field: string): Record<string, string> {
  const value = source[field]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

export async function readManifest(projectPath: string): Promise<Manifest> {
  const raw = JSON.parse(await readFile(join(projectPath, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >

  const seen = new Set<string>()
  const dependencies: DeclaredDependency[] = []

  for (const [field, kind] of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries(readRecord(raw, field))) {
      // A package listed in several fields is reported once, under the first field
      // it appears in. The ordering above puts the most meaningful kind first.
      if (seen.has(name)) continue
      seen.add(name)
      dependencies.push({ name, kind, range })
    }
  }

  dependencies.sort((a, b) => a.name.localeCompare(b.name))

  return {
    name: typeof raw.name === 'string' ? raw.name : 'unnamed project',
    version: typeof raw.version === 'string' ? raw.version : null,
    dependencies,
    raw,
  }
}
