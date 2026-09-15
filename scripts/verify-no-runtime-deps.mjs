/**
 * Guards the core promise of the project: whatever a user installs pulls in nothing else.
 * Runs in CI and before publish.
 */
import { readFile } from 'node:fs/promises'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

const runtimeFields = ['dependencies', 'peerDependencies', 'optionalDependencies']
const offenders = runtimeFields.flatMap((field) =>
  Object.keys(pkg[field] ?? {}).map((name) => `${field}.${name}`),
)

if (offenders.length > 0) {
  console.error('\n  packui must ship zero runtime dependencies. Found:')
  for (const offender of offenders) console.error(`    - ${offender}`)
  console.error('\n  Move it to devDependencies and bundle it, or drop it.\n')
  process.exit(1)
}

console.log('  ✓ zero runtime dependencies')
