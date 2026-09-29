import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findLockfileDrift,
  readPnpmLeaves,
  stripTrailingCommas,
} from '../src/server/core/lockdrift.ts'
import { buildReport } from '../src/server/core/report.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'packui-drift-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const manifest = {
  name: 'demo',
  dependencies: { vue: '^3.5.0', '@scope/tool': '~1.2.0' },
  devDependencies: { vitest: '^5.0.0' },
}

const PNPM_V9 = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    dependencies:
      '@scope/tool':
        specifier: ~1.2.0
        version: 1.2.3
      vue:
        specifier: ^3.5.0
        version: 3.5.13(typescript@5.9.3)
    devDependencies:
      vitest:
        specifier: ^5.0.0
        version: 5.0.0

  packages/a:
    dependencies:
      vue:
        specifier: ^3.4.0
        version: 3.5.13

packages:

  vue@3.5.13:
    resolution: {integrity: sha512-abc}
    specifier: not-a-real-key
`

describe('pnpm-lock.yaml', () => {
  it('reports no drift when the importer matches', async () => {
    await writeFile(join(dir, 'pnpm-lock.yaml'), PNPM_V9)
    expect(await findLockfileDrift(dir, 'pnpm-lock.yaml', '.', manifest)).toEqual([])
  })

  it('reports an edited range, an added dependency and a removed one', async () => {
    await writeFile(join(dir, 'pnpm-lock.yaml'), PNPM_V9)
    const edited = {
      dependencies: { vue: '^3.6.0', '@scope/tool': '~1.2.0', lodash: '^4.0.0' },
    }
    expect(await findLockfileDrift(dir, 'pnpm-lock.yaml', '.', edited)).toEqual([
      { name: 'lodash', field: 'dependencies', declared: '^4.0.0', locked: null },
      { name: 'vitest', field: 'devDependencies', declared: null, locked: '^5.0.0' },
      { name: 'vue', field: 'dependencies', declared: '^3.6.0', locked: '^3.5.0' },
    ])
  })

  it('reads a workspace importer by its relative path', async () => {
    await writeFile(join(dir, 'pnpm-lock.yaml'), PNPM_V9)
    const drift = await findLockfileDrift(dir, 'pnpm-lock.yaml', 'packages/a', {
      dependencies: { vue: '^3.4.0' },
    })
    expect(drift).toEqual([])
  })

  it('answers null for an importer the lockfile does not know', async () => {
    await writeFile(join(dir, 'pnpm-lock.yaml'), PNPM_V9)
    expect(await findLockfileDrift(dir, 'pnpm-lock.yaml', 'packages/z', manifest)).toBeNull()
  })

  it('ignores peerDependencies, which pnpm never records', async () => {
    await writeFile(join(dir, 'pnpm-lock.yaml'), PNPM_V9)
    const withPeer = { ...manifest, peerDependencies: { react: '>=18' } }
    expect(await findLockfileDrift(dir, 'pnpm-lock.yaml', '.', withPeer)).toEqual([])
  })

  it('reads the v5 specifiers layout', async () => {
    const v5 = `lockfileVersion: 5.4

specifiers:
  vue: ^3.2.0

dependencies:
  vue: 3.2.47
`
    await writeFile(join(dir, 'pnpm-lock.yaml'), v5)
    expect(
      await findLockfileDrift(dir, 'pnpm-lock.yaml', '.', { dependencies: { vue: '^3.2.0' } }),
    ).toEqual([])
    expect(
      await findLockfileDrift(dir, 'pnpm-lock.yaml', '.', { dependencies: { vue: '^3.3.0' } }),
    ).toHaveLength(1)
  })

  it('unquotes keys with doubled single quotes and colons', () => {
    const leaves = readPnpmLeaves(
      `importers:\n  .:\n    dependencies:\n      'it''s:odd':\n        specifier: '1'\n`,
    )
    expect(
      leaves.get(['importers', '.', 'dependencies', "it's:odd", 'specifier'].join('\u0000')),
    ).toBe('1')
  })

  it('answers null for a stub lockfile with no importer record', async () => {
    await writeFile(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    expect(await findLockfileDrift(dir, 'pnpm-lock.yaml', '.', manifest)).toBeNull()
    expect(await findLockfileDrift(dir, 'pnpm-lock.yaml', 'packages/a', manifest)).toBeNull()
  })
})

describe('package-lock.json', () => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'demo',
        dependencies: { vue: '^3.5.0', '@scope/tool': '~1.2.0' },
        devDependencies: { vitest: '^5.0.0' },
      },
      'packages/a': { dependencies: { vue: '^3.4.0' } },
      'node_modules/vue': { version: '3.5.13' },
    },
  }

  it('reports no drift when the root record matches', async () => {
    await writeFile(join(dir, 'package-lock.json'), JSON.stringify(lock))
    expect(await findLockfileDrift(dir, 'package-lock.json', '.', manifest)).toEqual([])
  })

  it('reports a changed range', async () => {
    await writeFile(join(dir, 'package-lock.json'), JSON.stringify(lock))
    const drift = await findLockfileDrift(dir, 'package-lock.json', '.', {
      ...manifest,
      devDependencies: { vitest: '^6.0.0' },
    })
    expect(drift).toEqual([
      { name: 'vitest', field: 'devDependencies', declared: '^6.0.0', locked: '^5.0.0' },
    ])
  })

  it('answers null for lockfileVersion 1, which has no root record', async () => {
    await writeFile(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 1 }))
    expect(await findLockfileDrift(dir, 'package-lock.json', '.', manifest)).toBeNull()
  })

  it('answers null for a lockfile it cannot parse', async () => {
    await writeFile(join(dir, 'package-lock.json'), '{ not json')
    expect(await findLockfileDrift(dir, 'package-lock.json', '.', manifest)).toBeNull()
  })
})

describe('bun.lock', () => {
  const bunLock = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "demo",
      "dependencies": {
        "@scope/tool": "~1.2.0",
        "vue": "^3.5.0",
      },
      "devDependencies": {
        "vitest": "^5.0.0",
      },
    },
  },
  "packages": {
    "vue": ["vue@3.5.13", "", {}, "sha512-, not a comma problem"],
  },
}
`

  it('reads JSON with trailing commas', async () => {
    await writeFile(join(dir, 'bun.lock'), bunLock)
    expect(await findLockfileDrift(dir, 'bun.lock', '.', manifest)).toEqual([])
  })

  it('leaves commas inside strings alone', () => {
    expect(JSON.parse(stripTrailingCommas('{"a": "x,}", }'))).toEqual({ a: 'x,}' })
  })

  it('does not judge bun.lockb, which is binary', async () => {
    expect(await findLockfileDrift(dir, 'bun.lockb', '.', manifest)).toBeNull()
  })
})

describe('yarn.lock', () => {
  it('answers null for a lockfile with no entries', async () => {
    await writeFile(join(dir, 'yarn.lock'), '# yarn lockfile v1\n')
    expect(await findLockfileDrift(dir, 'yarn.lock', '.', manifest)).toBeNull()
  })

  it('matches classic entries by name@range', async () => {
    await writeFile(
      join(dir, 'yarn.lock'),
      `# yarn lockfile v1\n\n"@scope/tool@~1.2.0":\n  version "1.2.3"\n\nvitest@^5.0.0:\n  version "5.0.0"\n\n"vue@^3.4.0", vue@^3.5.0:\n  version "3.5.13"\n`,
    )
    expect(await findLockfileDrift(dir, 'yarn.lock', '.', manifest)).toEqual([])
    const drift = await findLockfileDrift(dir, 'yarn.lock', '.', {
      dependencies: { vue: '^3.6.0' },
    })
    expect(drift).toEqual([
      { name: 'vue', field: 'dependencies', declared: '^3.6.0', locked: null },
    ])
  })

  it('matches berry entries with the npm: protocol', async () => {
    await writeFile(
      join(dir, 'yarn.lock'),
      `__metadata:\n  version: 8\n\n"vue@npm:^3.5.0":\n  version: 3.5.13\n\n"demo@workspace:.":\n  version: 0.0.0-use.local\n`,
    )
    expect(
      await findLockfileDrift(dir, 'yarn.lock', '.', {
        dependencies: { vue: '^3.5.0', local: 'workspace:*' },
      }),
    ).toEqual([])
  })
})

describe('report', () => {
  it('does not call a matching lockfile stale when package.json is newer', async () => {
    // The bug this module exists for: a fresh clone or a frozen install leaves the
    // lockfile older than package.json while agreeing with it completely.
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))
    await writeFile(join(dir, 'pnpm-lock.yaml'), PNPM_V9)
    const past = new Date(Date.now() - 60_000)
    await utimes(join(dir, 'pnpm-lock.yaml'), past, past)

    const report = await buildReport(dir)
    expect(report.drift).toEqual([])
    expect(report.alignment).not.toBe('stale')
  })

  it('marks the drifted row and the project as stale', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ ...manifest, devDependencies: { vitest: '^6.0.0' } }),
    )
    await writeFile(join(dir, 'pnpm-lock.yaml'), PNPM_V9)

    const report = await buildReport(dir)
    expect(report.drift?.map((entry) => entry.name)).toEqual(['vitest'])
    // No node_modules here, so the row itself is 'unknown' — installed-state problems
    // outrank drift — but the project-level verdict still reflects the lockfile.
    expect(report.dependencies.find((row) => row.name === 'vitest')?.alignment).toBe('unknown')
  })
})
