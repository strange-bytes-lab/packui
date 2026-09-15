import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { detectPackageManager } from '../src/server/core/detect.ts'
import { alignmentForDependency, worstAlignment } from '../src/server/core/lockfile.ts'
import { readManifest } from '../src/server/core/manifest.ts'
import { buildReport, outdatedSeverity } from '../src/server/core/report.ts'
import type { PackageManager } from '../src/shared/types.ts'

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

const PACKAGE_MANAGERS: PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun']

describe('package manager detection', () => {
  it.each(PACKAGE_MANAGERS)('detects %s from its fixture project', async (pm) => {
    const result = await detectPackageManager(fixture(`${pm}-project`))
    expect(result.packageManager).toBe(pm)
    expect(result.lockfile).not.toBeNull()
    expect(result.hasNodeModules).toBe(true)
  })

  it('reports a project with no node_modules', async () => {
    const result = await detectPackageManager(fixture('no-install-project'))
    expect(result.hasNodeModules).toBe(false)
  })
})

describe('manifest reading', () => {
  it('collects dependencies across every field, sorted, with their kind', async () => {
    const manifest = await readManifest(fixture('npm-project'))
    expect(manifest.dependencies.map((d) => d.name)).toEqual([
      '@scope/scoped-pkg',
      'absent-pkg',
      'aligned-pkg',
      'drifted-pkg',
      'linked-pkg',
    ])
    expect(manifest.dependencies.find((d) => d.name === 'absent-pkg')?.kind).toBe('dev')
    expect(manifest.dependencies.find((d) => d.name === 'aligned-pkg')?.kind).toBe('prod')
  })
})

describe('alignment', () => {
  it('accepts an installed version that satisfies the declared range', () => {
    expect(alignmentForDependency('^1.2.0', '1.2.5', true)).toBe('aligned')
  })

  it('flags an installed version that violates the declared range', () => {
    expect(alignmentForDependency('^2.0.0', '1.9.0', true)).toBe('unsatisfied')
  })

  it('flags a declared dependency that is not installed', () => {
    expect(alignmentForDependency('^4.0.0', null, true)).toBe('missing')
  })

  it('concludes nothing when node_modules is absent', () => {
    expect(alignmentForDependency('^1.0.0', null, false)).toBe('unknown')
  })

  it.each(['workspace:*', 'file:../local', 'link:../sibling', 'github:owner/repo', 'latest'])(
    'does not judge the unverifiable range %s',
    (range) => {
      expect(alignmentForDependency(range, '1.0.0', true)).toBe('aligned')
    },
  )

  it('reports the worst state across a project', () => {
    expect(worstAlignment(['aligned', 'stale', 'unsatisfied'])).toBe('unsatisfied')
    expect(worstAlignment(['aligned', 'missing', 'unsatisfied'])).toBe('missing')
    expect(worstAlignment(['aligned', 'aligned'])).toBe('aligned')
  })
})

describe('outdated severity', () => {
  it.each([
    ['1.2.3', '1.2.3', 'current'],
    ['1.2.3', '1.2.9', 'patch'],
    ['1.2.3', '1.5.0', 'minor'],
    ['1.2.3', '3.0.0', 'major'],
    ['2.0.0', '1.0.0', 'current'],
  ])('%s against %s is %s', (installed, latest, expected) => {
    expect(outdatedSeverity(installed, latest)).toBe(expected)
  })

  it('is unknown until the registry has been consulted', () => {
    expect(outdatedSeverity('1.2.3', null)).toBe('unknown')
    expect(outdatedSeverity(null, '1.2.3')).toBe('unknown')
  })
})

describe('report building', () => {
  it.each(PACKAGE_MANAGERS)('builds a consistent report for a %s project', async (pm) => {
    const report = await buildReport(fixture(`${pm}-project`))

    expect(report.project.packageManager).toBe(pm)
    expect(report.project.name).toBe(`${pm}-fixture`)

    const byName = new Map(report.dependencies.map((row) => [row.name, row]))
    expect(byName.get('aligned-pkg')).toMatchObject({ installed: '1.2.5', alignment: 'aligned' })
    expect(byName.get('drifted-pkg')).toMatchObject({
      installed: '1.9.0',
      alignment: 'unsatisfied',
    })
    expect(byName.get('absent-pkg')).toMatchObject({ installed: null, alignment: 'missing' })
    expect(byName.get('@scope/scoped-pkg')).toMatchObject({ installed: '3.1.4' })

    // Worst-case wins: a missing dependency outranks everything else here.
    expect(report.alignment).toBe('missing')
  })

  it('reports unknown alignment when nothing is installed', async () => {
    const report = await buildReport(fixture('no-install-project'))
    expect(report.alignment).toBe('unknown')
    expect(report.dependencies[0]?.alignment).toBe('unknown')
  })

  it('resolves scoped packages through their nested directory', async () => {
    const report = await buildReport(fixture('pnpm-project'))
    const scoped = report.dependencies.find((row) => row.name === '@scope/scoped-pkg')
    expect(scoped?.installed).toBe('3.1.4')
  })
})
