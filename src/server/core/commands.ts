import semver from 'semver'
import type { DependencyKind, PackageManager } from '../../shared/types.ts'

/**
 * Builds the package manager command for a mutation.
 *
 * packui never edits package.json or a lockfile itself. It runs the project's own
 * package manager and lets that tool remain the authority on its own lockfile
 * format, resolution and peer handling. Hand-editing a lockfile is how you corrupt
 * someone's project.
 *
 * Commands are built as argv arrays and spawned without a shell, so a package name
 * or version can never be interpreted as shell syntax. The validators below are a
 * second layer: nothing that fails them is passed to a subprocess at all.
 */

export type MutationAction = 'upgrade' | 'remove'

export interface MutationRequest {
  action: MutationAction
  name: string
  /** Required for upgrade; ignored for remove. */
  version?: string
  kind: DependencyKind
}

/**
 * npm's naming rules, deliberately stricter than the registry's legacy allowance.
 *
 * Note the first character class excludes `-`. A name like `-rf` is not obviously
 * dangerous as a name, but it is passed to a CLI as a positional argument, where a
 * leading hyphen makes it parse as a flag instead. Rejecting it here is simpler and
 * more portable than relying on each package manager's `--` handling.
 */
const PACKAGE_NAME = /^(@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*$/

export function isValidPackageName(name: string): boolean {
  return name.length > 0 && name.length <= 214 && PACKAGE_NAME.test(name)
}

/** An exact version, or one of the dist-tags it is reasonable to install by name. */
const ALLOWED_TAGS = new Set(['latest', 'next', 'beta', 'alpha', 'canary', 'rc'])

export function isValidVersion(version: string): boolean {
  return semver.valid(version) !== null || ALLOWED_TAGS.has(version)
}

/**
 * The flag that keeps a package in the dependency field it already lives in.
 * Without this, upgrading a devDependency can silently move it to dependencies.
 */
function saveFlags(packageManager: PackageManager, kind: DependencyKind): string[] {
  switch (kind) {
    case 'dev':
      return packageManager === 'npm' ? ['--save-dev'] : ['-D']
    case 'peer':
      return packageManager === 'yarn' ? ['-P'] : ['--save-peer']
    case 'optional':
      return packageManager === 'npm' ? ['--save-optional'] : ['-O']
    case 'prod':
      return []
  }
}

export interface BuiltCommand {
  command: string
  args: string[]
  /** The same command as a single string, shown to the user before it runs. */
  display: string
}

export function buildCommand(
  packageManager: PackageManager,
  request: MutationRequest,
): BuiltCommand {
  if (!isValidPackageName(request.name)) {
    throw new Error(`Invalid package name: ${request.name}`)
  }

  let args: string[]

  if (request.action === 'remove') {
    const verb = packageManager === 'npm' ? 'uninstall' : 'remove'
    args = [verb, request.name]
  } else {
    const version = request.version ?? 'latest'
    if (!isValidVersion(version)) throw new Error(`Invalid version: ${version}`)

    const verb = packageManager === 'npm' ? 'install' : 'add'
    // peerDependencies are not installed by `add` in every package manager, but the
    // save flag is what actually matters: it updates the right manifest field.
    args = [verb, `${request.name}@${version}`, ...saveFlags(packageManager, request.kind)]
  }

  return {
    command: packageManager,
    args,
    display: `${packageManager} ${args.join(' ')}`,
  }
}

/**
 * Builds the commands for upgrading several packages at once.
 *
 * Specs are grouped by dependency kind because the save flag differs per kind and
 * applies to the whole invocation — mixing a devDependency into a `--save-prod`
 * command would move it. Each group is one package manager invocation, which is far
 * faster than one per package and lets the package manager resolve them together.
 */
export function buildBatchCommands(
  packageManager: PackageManager,
  requests: readonly MutationRequest[],
): BuiltCommand[] {
  const byKind = new Map<DependencyKind, MutationRequest[]>()
  for (const request of requests) {
    if (!isValidPackageName(request.name)) {
      throw new Error(`Invalid package name: ${request.name}`)
    }
    const version = request.version ?? 'latest'
    if (!isValidVersion(version)) throw new Error(`Invalid version: ${version}`)

    const group = byKind.get(request.kind) ?? []
    group.push(request)
    byKind.set(request.kind, group)
  }

  const verb = packageManager === 'npm' ? 'install' : 'add'

  return [...byKind.entries()].map(([kind, group]) => {
    const specs = group.map((request) => `${request.name}@${request.version ?? 'latest'}`)
    const args = [verb, ...specs, ...saveFlags(packageManager, kind)]
    return { command: packageManager, args, display: `${packageManager} ${args.join(' ')}` }
  })
}

/** The plain install used to put a project back in sync after a rollback. */
export function buildInstallCommand(packageManager: PackageManager): BuiltCommand {
  const args = ['install']
  return { command: packageManager, args, display: `${packageManager} install` }
}
