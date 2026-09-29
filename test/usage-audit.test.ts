import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packageNameOf } from '../src/server/core/usage.ts'
import { startServer, type RunningServer } from '../src/server/index.ts'
import { sessionToken } from '../src/server/security.ts'

describe('specifiers', () => {
  it.each([
    ['lodash', 'lodash'],
    ['lodash/merge', 'lodash'],
    ['@scope/pkg', '@scope/pkg'],
    ['@scope/pkg/sub/path', '@scope/pkg'],
    ['./local', null],
    ['../up', null],
    ['/abs', null],
    ['node:fs', null],
    ['#internal', null],
    ['@/components/x', null],
    ['~/utils', null],
    ['virtual:pwa', null],
  ])('%s names %s', (specifier, expected) => {
    expect(packageNameOf(specifier)).toBe(expected)
  })
})

describe('GET /api/usage', () => {
  let dir: string
  let server: RunningServer

  async function pkg(name: string, extra: Record<string, unknown> = {}) {
    const at = join(dir, 'node_modules', name)
    await mkdir(at, { recursive: true })
    await writeFile(join(at, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...extra }))
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'packui-usage-'))
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'usage-fixture',
        scripts: { lint: 'lint-bin src', build: 'bundler' },
        prettier: 'prettier-config-house',
        dependencies: { used: '^1', 'never-used': '^1' },
        devDependencies: {
          'has-bin': '^1',
          bundler: '^1',
          'eslint-plugin-thing': '^1',
          'prettier-config-house': '^1',
          jsdom: '^1',
          '@types/used': '^1',
          '@types/gone': '^1',
          '@types/node': '^1',
        },
      }),
    )
    await writeFile(
      join(dir, '.eslintrc.json'),
      JSON.stringify({ plugins: ['eslint-plugin-thing'] }),
    )
    await mkdir(join(dir, 'src'))
    await writeFile(
      join(dir, 'src', 'index.ts'),
      [
        "import used from 'used'",
        "import { x } from 'phantom/sub'",
        "import alias from '@components/button'",
        "import fs from 'node:fs'",
        "import path from 'path'",
        "const later = await import('./local.js')",
      ].join('\n'),
    )
    // Split so vitest does not read the pragma as one for this file.
    await writeFile(join(dir, 'src', 'dom.test.ts'), `// @vitest-${'environment'} jsdom\n`)

    for (const name of ['used', 'never-used', 'bundler', 'phantom', 'jsdom']) await pkg(name)
    await pkg('has-bin', { bin: { 'lint-bin': 'cli.js' } })

    server = await startServer({ projectPath: dir, port: 0 })
  })

  afterAll(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  })

  async function audit() {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/usage`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    })
    expect(response.status).toBe(200)
    return (await response.json()) as {
      unused: { name: string; reason: string | null }[]
      undeclared: { name: string; installed: string | null; usages: { file: string }[] }[]
    }
  }

  it('reports declared packages with no evidence of use, and only those', async () => {
    const { unused } = await audit()
    // Used by import, by a binary in a script, by name in a script, in a config file,
    // in package.json's own config, by a test-environment pragma, or as types for a
    // declared package or Node — none of those are reported.
    expect(unused.map((entry) => entry.name).sort()).toEqual(['@types/gone', 'never-used'])
    expect(unused.find((entry) => entry.name === '@types/gone')?.reason).toMatch(/gone/)
  })

  it('reports imports that resolve without being declared, and ignores aliases', async () => {
    const { undeclared } = await audit()
    expect(undeclared.map((entry) => entry.name)).toEqual(['phantom'])
    expect(undeclared[0]?.installed).toBe('1.0.0')
    expect(undeclared[0]?.usages[0]?.file).toBe(join('src', 'index.ts'))
  })
})
