import { builtinModules } from 'node:module'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { projectContext } from '../core/context.ts'
import { readInstalledVersion, resolvePackageDir } from '../core/installed.ts'
import { readManifest } from '../core/manifest.ts'
import { scanImports, type Usage } from '../core/usage.ts'
import { sendError, sendJson, type RequestContext } from '../router.ts'
import { resolveAllowedProject, type ProjectAccess } from './access.ts'

/**
 * Declared-but-never-imported and imported-but-undeclared dependencies.
 *
 * Both are heuristics and are labelled as such in the UI. The work here goes into
 * keeping them quiet when they would be wrong:
 *
 * - A declared package counts as used if it is imported, if its name or one of its
 *   binaries appears in a script, or if its name appears in a config file at the
 *   project root — where eslint plugins, babel presets and the like are named.
 * - `@types/x` counts as used while `x` is declared, imported, or a Node builtin.
 * - An undeclared import is reported only if it actually resolves in node_modules.
 *   One that does not is a path alias (`@components/…`) or already a broken import —
 *   neither is a phantom dependency.
 */

export interface UsageAudit {
  filesScanned: number
  truncated: boolean
  unused: { name: string; kind: string; reason: string | null }[]
  undeclared: { name: string; installed: string | null; usages: Pick<Usage, 'file' | 'line'>[] }[]
}

const BUILTINS = new Set(builtinModules.map((name) => name.split('/')[0]))

/** Root-level files where tools name the packages they load. */
const CONFIG_FILE =
  /^(\..*rc(\.(json|js|cjs|mjs|ya?ml))?|.*\.config\.[cm]?[jt]s|tsconfig.*\.json|\.babelrc|babel\.config\.json)$/

async function configText(projectPath: string): Promise<string> {
  const names = await readdir(projectPath).catch(() => [] as string[])
  const texts = await Promise.all(
    names
      .filter((name) => CONFIG_FILE.test(name))
      .map((name) => readFile(join(projectPath, name), 'utf8').catch(() => '')),
  )
  return texts.join('\n')
}

async function binNames(dir: string | null, name: string): Promise<string[]> {
  if (dir === null) return []
  try {
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
      bin?: unknown
    }
    if (typeof manifest.bin === 'string') return [name.split('/').pop() ?? name]
    if (typeof manifest.bin === 'object' && manifest.bin !== null) return Object.keys(manifest.bin)
    return []
  } catch {
    return []
  }
}

function mentions(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\w@/.-])${escaped}($|[^\\w/.-])`).test(text)
}

export function createUsageHandler(access: ProjectAccess) {
  return async ({ res, url }: RequestContext): Promise<void> => {
    const projectPath = resolveAllowedProject(
      url.searchParams.get('path'),
      access.allowedProjects(),
    )
    if (projectPath === null) {
      sendError(res, 403, 'Unknown project')
      return
    }

    try {
      const context = await projectContext(projectPath)
      // At a workspace root, member packages are skipped: their imports are theirs.
      const members = new Set(
        (context.workspace?.packages ?? [])
          .map((member) => member.path)
          .filter((path) => path !== projectPath),
      )
      const [manifest, scan, config] = await Promise.all([
        readManifest(projectPath),
        scanImports(projectPath, members),
        configText(projectPath),
      ])

      const scripts = Object.values((manifest.raw.scripts ?? {}) as Record<string, unknown>).filter(
        (value): value is string => typeof value === 'string',
      )
      const scriptText = scripts.join('\n')
      // package.json itself configures tools too: "prettier", "eslintConfig", "babel".
      const configuration = { ...manifest.raw }
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        delete configuration[field]
      }
      const manifestText = JSON.stringify(configuration)

      const declared = new Map(
        manifest.dependencies.map((dependency) => [dependency.name, dependency]),
      )

      const unused: UsageAudit['unused'] = []
      for (const dependency of manifest.dependencies) {
        // A peer is declared for consumers to provide, not for this package to import.
        if (dependency.kind === 'peer') continue
        const { name } = dependency
        if (scan.imports.has(name) || scan.loaded.has(name)) continue

        if (name.startsWith('@types/')) {
          const target = name.slice('@types/'.length)
          const typed = target.includes('__') ? `@${target.replace('__', '/')}` : target
          if (
            declared.has(typed) ||
            scan.imports.has(typed) ||
            BUILTINS.has(typed) ||
            typed === 'node'
          ) {
            continue
          }
          unused.push({
            name,
            kind: dependency.kind,
            reason: `types for ${typed}, which is neither declared nor imported`,
          })
          continue
        }

        const dir = await resolvePackageDir(projectPath, name, context.root)
        const bins = await binNames(dir, name)
        const inScripts =
          mentions(scriptText, name) || bins.some((bin) => mentions(scriptText, bin))
        if (inScripts) continue
        if (config.includes(name) || manifestText.includes(`"${name}`)) continue

        unused.push({ name, kind: dependency.kind, reason: null })
      }

      const undeclared: UsageAudit['undeclared'] = []
      for (const [name, usages] of scan.imports) {
        if (declared.has(name) || name === manifest.name || BUILTINS.has(name)) continue
        const dir = await resolvePackageDir(projectPath, name, context.root)
        if (dir === null) continue
        undeclared.push({
          name,
          installed: await readInstalledVersion(projectPath, name, context.root),
          usages: usages.slice(0, 5).map(({ file, line }) => ({ file, line })),
        })
      }
      undeclared.sort((a, b) => a.name.localeCompare(b.name))

      const audit: UsageAudit = {
        filesScanned: scan.filesScanned,
        truncated: scan.truncated,
        // An incomplete scan cannot claim anything is unused.
        unused: scan.truncated ? [] : unused,
        undeclared,
      }
      sendJson(res, 200, audit)
    } catch (error) {
      sendError(res, 422, error instanceof Error ? error.message : 'Could not scan the source')
    }
  }
}
