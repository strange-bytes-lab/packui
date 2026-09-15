import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findDependents, findUsages } from '../src/server/core/usage.ts'

/**
 * The import scan is the gate that stops a removal from silently breaking a project,
 * so both directions matter: it must find real usages, and it must not invent them.
 */
describe('usage scanning', () => {
  let project: string

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'packui-usage-'))
    await mkdir(join(project, 'src'), { recursive: true })
  })

  afterEach(async () => {
    await rm(project, { recursive: true, force: true })
  })

  const write = (relativePath: string, contents: string) =>
    writeFile(join(project, relativePath), contents, 'utf8')

  it.each([
    ["import merge from 'lodash'", 'default import'],
    ['import { merge } from "lodash"', 'named import'],
    ["import 'lodash'", 'side-effect import'],
    ["const x = require('lodash')", 'require'],
    ["const x = await import('lodash')", 'dynamic import'],
    ["export { merge } from 'lodash'", 're-export'],
    ["import merge from 'lodash/merge'", 'subpath import'],
  ])('finds a %s', async (line) => {
    await write('src/app.js', `${line}\n`)
    const report = await findUsages(project, 'lodash')
    expect(report.usages).toHaveLength(1)
    expect(report.usages[0]?.file).toBe('src/app.js')
  })

  it('reports the line number and a snippet', async () => {
    await write('src/app.js', "// header\n\nimport merge from 'lodash'\n")
    const report = await findUsages(project, 'lodash')
    expect(report.usages[0]?.line).toBe(3)
    expect(report.usages[0]?.snippet).toBe("import merge from 'lodash'")
  })

  it('does not match a different package with the same prefix', async () => {
    await write('src/app.js', "import x from 'lodash-es'\nimport y from 'lodashery'\n")
    const report = await findUsages(project, 'lodash')
    expect(report.usages).toHaveLength(0)
  })

  it('does not match the name appearing in prose or a comment', async () => {
    await write('src/app.js', '// we should replace lodash one day\nconst lodash = 1\n')
    const report = await findUsages(project, 'lodash')
    expect(report.usages).toHaveLength(0)
  })

  it('handles package names containing regex metacharacters', async () => {
    await write('src/app.js', "import merge from 'lodash.merge'\n")
    const report = await findUsages(project, 'lodash.merge')
    expect(report.usages).toHaveLength(1)

    // The dot must not act as a wildcard matching "lodash-merge".
    await write('src/other.js', "import merge from 'lodashxmerge'\n")
    const second = await findUsages(project, 'lodash.merge')
    expect(second.usages).toHaveLength(1)
  })

  it('finds scoped packages', async () => {
    await write('src/app.ts', "import plugin from '@vitejs/plugin-vue'\n")
    const report = await findUsages(project, '@vitejs/plugin-vue')
    expect(report.usages).toHaveLength(1)
  })

  it('scans Vue single-file components', async () => {
    await write('src/App.vue', "<script setup>\nimport { ref } from 'vue'\n</script>\n")
    const report = await findUsages(project, 'vue')
    expect(report.usages).toHaveLength(1)
  })

  it('ignores node_modules and build output', async () => {
    await mkdir(join(project, 'node_modules', 'other'), { recursive: true })
    await mkdir(join(project, 'dist'), { recursive: true })
    await write('node_modules/other/index.js', "require('lodash')\n")
    await write('dist/bundle.js', "require('lodash')\n")

    const report = await findUsages(project, 'lodash')
    expect(report.usages).toHaveLength(0)
  })

  it('finds every usage across multiple files', async () => {
    await write('src/a.js', "import x from 'lodash'\n")
    await write('src/b.ts', "import y from 'lodash'\n")
    await write('src/c.js', "import z from 'lodash'\nimport w from 'lodash/merge'\n")

    const report = await findUsages(project, 'lodash')
    expect(report.usages).toHaveLength(4)
    expect(new Set(report.usages.map((usage) => usage.file)).size).toBe(3)
  })
})

describe('dependent scanning', () => {
  let project: string

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'packui-dependents-'))
  })

  afterEach(async () => {
    await rm(project, { recursive: true, force: true })
  })

  async function installStub(name: string, manifest: Record<string, unknown>): Promise<void> {
    const dir = join(project, 'node_modules', name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, ...manifest }), 'utf8')
  }

  it('finds packages that depend on the target', async () => {
    await installStub('needs-it', { dependencies: { target: '^1.0.0' } })
    await installStub('ignores-it', { dependencies: { other: '^1.0.0' } })
    await installStub('target', { version: '1.0.0' })

    expect(await findDependents(project, 'target')).toEqual(['needs-it'])
  })

  it('counts peer and optional dependencies too', async () => {
    await installStub('peer-user', { peerDependencies: { target: '*' } })
    await installStub('optional-user', { optionalDependencies: { target: '*' } })

    expect(await findDependents(project, 'target')).toEqual(['optional-user', 'peer-user'])
  })

  it('looks inside scoped package directories', async () => {
    await installStub('@scope/thing', { dependencies: { target: '^1.0.0' } })
    expect(await findDependents(project, 'target')).toEqual(['@scope/thing'])
  })

  it('never reports the package as its own dependent', async () => {
    await installStub('target', { dependencies: { target: '^1.0.0' } })
    expect(await findDependents(project, 'target')).toEqual([])
  })

  it('returns nothing when node_modules is absent', async () => {
    expect(await findDependents(project, 'target')).toEqual([])
  })
})
