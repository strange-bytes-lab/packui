import semver from 'semver'
import { buildChangelog } from '../core/changelog.ts'
import { isValidPackageName } from '../core/commands.ts'
import { checkCompatibility } from '../core/compat.ts'
import { projectContext } from '../core/context.ts'
import { githubRepoFromUrl } from '../core/github.ts'
import { fetchPackageHealth } from '../core/health.ts'
import { readInstalledVersion } from '../core/installed.ts'
import { readManifest } from '../core/manifest.ts'
import { isPrivatelyScoped, loadRegistryConfig } from '../core/npmrc.ts'
import { fetchPackageDetail, fetchPackageInfo, fetchVersionManifest } from '../core/registry.ts'
import { sendError, sendJson, type RequestContext } from '../router.ts'
import { resolveAllowedProject, type ProjectAccess } from './access.ts'
import { normalizeRepositoryUrl } from './package.ts'

/**
 * Per-package questions the drawer and the upgrade confirmation ask: will this version
 * work here, what changed on the way to it, and is the package still maintained.
 */

interface Target {
  projectPath: string
  root: string
  name: string
  config: Awaited<ReturnType<typeof loadRegistryConfig>>
  signal: AbortSignal
}

async function readTarget(ctx: RequestContext, access: ProjectAccess): Promise<Target | null> {
  const { req, res, url } = ctx
  const projectPath = resolveAllowedProject(url.searchParams.get('path'), access)
  if (projectPath === null) {
    sendError(res, 403, 'Unknown project')
    return null
  }
  const name = url.searchParams.get('name')
  // Joined into registry URLs and node_modules paths: the one validator applies.
  if (name === null || !isValidPackageName(name)) {
    sendError(res, 400, 'Invalid package name')
    return null
  }
  const controller = new AbortController()
  req.on('close', () => controller.abort())
  const { root } = await projectContext(projectPath)
  const config = await loadRegistryConfig(root === projectPath ? [root] : [root, projectPath])
  return { projectPath, root, name, config, signal: controller.signal }
}

function readVersion(url: URL, key: string): string | null {
  const value = url.searchParams.get(key)
  return value !== null && semver.valid(value) !== null ? value : null
}

export function createCompatHandler(access: ProjectAccess) {
  return async (ctx: RequestContext): Promise<void> => {
    const target = await readTarget(ctx, access)
    if (target === null) return
    const version = readVersion(ctx.url, 'version')
    if (version === null) {
      sendError(ctx.res, 400, 'version must be an exact version')
      return
    }
    try {
      const [manifest, project] = await Promise.all([
        fetchVersionManifest(target.name, version, target.signal, target.config),
        readManifest(target.projectPath),
      ])
      if (manifest === null) {
        // Not "compatible": unknown. The UI says it could not check.
        sendJson(ctx.res, 200, null)
        return
      }
      const engines = (project.raw.engines ?? {}) as { node?: unknown }
      sendJson(
        ctx.res,
        200,
        await checkCompatibility(
          manifest,
          target.name,
          target.projectPath,
          typeof engines.node === 'string' ? engines.node : null,
          target.root,
        ),
      )
    } catch (error) {
      if (target.signal.aborted) return
      sendError(ctx.res, 502, error instanceof Error ? error.message : 'Could not check')
    }
  }
}

export function createChangelogHandler(access: ProjectAccess) {
  return async (ctx: RequestContext): Promise<void> => {
    const target = await readTarget(ctx, access)
    if (target === null) return
    const to = readVersion(ctx.url, 'to')
    if (to === null) {
      sendError(ctx.res, 400, 'to must be an exact version')
      return
    }
    try {
      const from =
        readVersion(ctx.url, 'from') ??
        (await readInstalledVersion(target.projectPath, target.name, target.root))
      // The target's own manifest says where its source lives now, which is what
      // matters for a package that moved repositories.
      const manifest = await fetchVersionManifest(target.name, to, target.signal, target.config)
      const repositoryUrl = normalizeRepositoryUrl(manifest?.repository ?? null)
      const changelog = await buildChangelog(
        githubRepoFromUrl(repositoryUrl),
        target.name,
        manifest?.repositoryDirectory ?? null,
        from,
        to,
        target.signal,
      )
      sendJson(ctx.res, 200, { from, to, ...changelog })
    } catch (error) {
      if (target.signal.aborted) return
      sendError(ctx.res, 502, error instanceof Error ? error.message : 'Could not load changes')
    }
  }
}

export function createPackageHealthHandler(access: ProjectAccess) {
  return async (ctx: RequestContext): Promise<void> => {
    const target = await readTarget(ctx, access)
    if (target === null) return
    try {
      const [info, detail] = await Promise.all([
        fetchPackageInfo(target.name, target.signal, target.config),
        fetchPackageDetail(target.name, target.signal, target.config),
      ])
      const repo = githubRepoFromUrl(normalizeRepositoryUrl(detail?.repository ?? null))
      // A private package's name is not sent to the public download counter.
      const publicPackage = !isPrivatelyScoped(target.config, target.name)
      sendJson(
        ctx.res,
        200,
        await fetchPackageHealth(
          target.name,
          info?.modified ?? null,
          repo,
          publicPackage,
          target.signal,
        ),
      )
    } catch (error) {
      if (target.signal.aborted) return
      sendError(ctx.res, 502, error instanceof Error ? error.message : 'Could not load health')
    }
  }
}
