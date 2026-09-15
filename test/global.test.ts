import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Global discovery is the most platform-specific code in packui and the easiest to
 * get quietly wrong: every failure mode here looks like an empty list rather than an
 * error. These tests build the real directory layouts under a temp HOME.
 *
 * The package managers are never actually asked — `npm root -g` on the machine
 * running the tests would answer about that machine, not about the fixture.
 */
vi.mock('node:child_process', () => ({
  execFile: (
    _command: string,
    _args: string[],
    _options: unknown,
    callback?: (error: Error | null) => void,
  ) => {
    callback?.(new Error('not installed'))
  },
}))

let home: string
const originalHome = process.env.HOME

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'packui-globals-'))
  process.env.HOME = home
  // The layout tables are built from homedir() at import time, and detection is
  // cached for the process lifetime, so the module is re-imported per test.
  vi.resetModules()
})

afterEach(async () => {
  process.env.HOME = originalHome
  await rm(home, { recursive: true, force: true })
})

async function writePackage(dir: string, name: string, version: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version }), 'utf8')
}

/** ~/.volta/tools/image/packages/<tool>/lib/node_modules/<tool> */
async function writeVoltaTool(tool: string, version: string): Promise<string> {
  const root = join(home, '.volta', 'tools', 'image', 'packages', tool, 'lib', 'node_modules')
  await writePackage(join(root, tool), tool, version)
  return root
}

async function loadGlobals() {
  return import('../src/server/core/global.ts')
}

describe('global scope discovery', () => {
  it('finds volta tools, which npm root -g cannot see', async () => {
    await writeVoltaTool('sheets-cli', '1.0.0')
    await writeVoltaTool('@scope/scoped-tool', '2.3.4')

    const { detectGlobalScopes, listGlobalPackages } = await loadGlobals()
    const scopes = await detectGlobalScopes()

    const volta = scopes.find((scope) => scope.id === 'volta')
    expect(volta).toBeDefined()
    expect(volta?.installer).toBe('volta')
    // One root per tool: volta gives each its own isolated tree.
    expect(volta?.roots).toHaveLength(2)

    const packages = await listGlobalPackages(volta!)
    expect(packages.map((row) => row.name).sort()).toEqual(['@scope/scoped-tool', 'sheets-cli'])
    expect(packages.find((row) => row.name === 'sheets-cli')?.installed).toBe('1.0.0')
  })

  it('does not report a volta tool’s dependencies as globally installed', async () => {
    const root = await writeVoltaTool('sheets-cli', '1.0.0')
    // A tool's own tree is not a global root. Whatever else lives in it — today npm
    // nests dependencies, but it has not always — belongs to the tool, not the user.
    await writePackage(join(root, 'left-pad'), 'left-pad', '1.3.0')

    const { detectGlobalScopes, listGlobalPackages } = await loadGlobals()
    const volta = (await detectGlobalScopes()).find((scope) => scope.id === 'volta')

    const packages = await listGlobalPackages(volta!)
    expect(packages.map((row) => row.name)).toEqual(['sheets-cli'])
  })

  it('reads the active node version volta records', async () => {
    await writeVoltaTool('sheets-cli', '1.0.0')
    const platform = join(home, '.volta', 'tools', 'user')
    await mkdir(platform, { recursive: true })
    await writeFile(
      join(platform, 'platform.json'),
      JSON.stringify({ node: { runtime: '22.16.0' } }),
      'utf8',
    )

    const { detectGlobalScopes } = await loadGlobals()
    const volta = (await detectGlobalScopes()).find((scope) => scope.id === 'volta')
    expect(volta?.nodeVersion).toBe('22.16.0')
  })

  it('finds globals stranded on a node version you have switched away from', async () => {
    const nvm = join(home, '.nvm', 'versions', 'node')
    await writePackage(join(nvm, 'v20.0.0', 'lib', 'node_modules', 'old-cli'), 'old-cli', '1.0.0')
    await writePackage(join(nvm, 'v22.0.0', 'lib', 'node_modules', 'new-cli'), 'new-cli', '2.0.0')

    const { detectGlobalScopes, listGlobalPackages } = await loadGlobals()
    const scopes = await detectGlobalScopes()

    const twenty = scopes.find((scope) => scope.id === 'nvm:20.0.0')
    const twentyTwo = scopes.find((scope) => scope.id === 'nvm:22.0.0')
    expect(twenty).toBeDefined()
    expect(twentyTwo).toBeDefined()
    // The `v` prefix is a directory-naming detail, not part of the version.
    expect(twenty?.nodeVersion).toBe('20.0.0')

    expect((await listGlobalPackages(twenty!)).map((row) => row.name)).toEqual(['old-cli'])
    expect((await listGlobalPackages(twentyTwo!)).map((row) => row.name)).toEqual(['new-cli'])
  })

  it('lists a linked package rather than skipping it', async () => {
    const root = join(home, '.nvm', 'versions', 'node', 'v20.0.0', 'lib', 'node_modules')
    const real = join(home, 'dev', 'linked-cli')
    await writePackage(real, 'linked-cli', '0.1.0')
    await mkdir(root, { recursive: true })
    // What `npm link` and `volta install <path>` leave behind. Dirent.isDirectory()
    // is false for these, which is how they used to disappear.
    await symlink(real, join(root, 'linked-cli'))

    const { detectGlobalScopes, listGlobalPackages } = await loadGlobals()
    const scope = (await detectGlobalScopes()).find((candidate) => candidate.id === 'nvm:20.0.0')

    expect((await listGlobalPackages(scope!)).map((row) => row.name)).toEqual(['linked-cli'])
  })

  it('reports a directory reachable under two managers once', async () => {
    const shared = join(home, '.nvm', 'versions', 'node', 'v20.0.0')
    await writePackage(join(shared, 'lib', 'node_modules', 'cli'), 'cli', '1.0.0')

    const asdf = join(home, '.asdf', 'installs', 'nodejs')
    await mkdir(asdf, { recursive: true })
    // Same install, two names for it. Deduping by real path is what stops the sidebar
    // listing it twice.
    await symlink(shared, join(asdf, '20.0.0'))

    const { detectGlobalScopes } = await loadGlobals()
    const scopes = await detectGlobalScopes()

    const matching = scopes.filter((scope) => scope.id.endsWith(':20.0.0'))
    expect(matching).toHaveLength(1)
  })

  it('leaves out what ships with the toolchain', async () => {
    const root = join(home, '.nvm', 'versions', 'node', 'v20.0.0', 'lib', 'node_modules')
    await writePackage(join(root, 'npm'), 'npm', '10.0.0')
    await writePackage(join(root, 'corepack'), 'corepack', '0.30.0')
    await writePackage(join(root, 'real-cli'), 'real-cli', '1.0.0')

    const { detectGlobalScopes, listGlobalPackages } = await loadGlobals()
    const scope = (await detectGlobalScopes()).find((candidate) => candidate.id === 'nvm:20.0.0')

    // npm and corepack are there because Node put them there, not because anyone
    // chose to install them.
    expect((await listGlobalPackages(scope!)).map((row) => row.name)).toEqual(['real-cli'])
  })

  it('marks globals with no manifest behind them as aligned, with no declared range', async () => {
    const root = join(home, '.nvm', 'versions', 'node', 'v20.0.0', 'lib', 'node_modules')
    await writePackage(join(root, 'cli'), 'cli', '3.2.1')

    const { detectGlobalScopes, listGlobalPackages } = await loadGlobals()
    const scope = (await detectGlobalScopes()).find((candidate) => candidate.id === 'nvm:20.0.0')
    const [row] = await listGlobalPackages(scope!)

    // There is no package.json declaring a range, so the installed version is the
    // whole truth and there is nothing for alignment to mean.
    expect(row?.declared).toBe('3.2.1')
    expect(row?.alignment).toBe('aligned')
    expect(row?.kind).toBe('prod')
  })

  it('finds nothing rather than failing on a machine with no globals at all', async () => {
    const { detectGlobalScopes } = await loadGlobals()
    const scopes = await detectGlobalScopes()

    // Fixed system roots may exist on the machine running this; nothing under the
    // temp HOME should have been found.
    expect(scopes.every((scope) => !scope.roots.some((root) => root.path.startsWith(home)))).toBe(
      true,
    )
  })
})
