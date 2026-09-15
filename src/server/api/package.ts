import semver from 'semver'
import { isValidPackageName } from '../core/commands.ts'
import { fetchAdvisory, queryVulnerabilities, type AdvisoryDetail } from '../core/osv.ts'
import { fetchPackageDetail, fetchPackageInfo, type PackageDetail } from '../core/registry.ts'
import { readInstalledVersion } from '../core/installed.ts'
import { readLocalReadme } from '../core/readme.ts'
import { sendError, sendJson, type RequestContext } from '../router.ts'
import { resolveAllowedProject, type ProjectAccess } from './access.ts'

export interface PackageDrawerPayload {
  name: string
  installed: string | null
  latest: string | null
  versions: string[]
  deprecated: string | null
  detail: PackageDetail | null
  /** Read from the installed package, not the registry. See core/readme.ts. */
  readme: string | null
  advisories: AdvisoryDetail[]
  /** Normalized https URL for the source repository, when one can be derived. */
  repositoryUrl: string | null
  releasesUrl: string | null
}

/**
 * Registry `repository.url` fields come in many shapes: git+ssh://, git://,
 * git+https://, shorthand, with or without a .git suffix. Normalize to a browsable
 * https URL, and refuse anything that is not http(s) once normalized so a malicious
 * manifest cannot inject a javascript: or data: link into the UI.
 */
export function normalizeRepositoryUrl(raw: string | null): string | null {
  if (raw === null || raw.trim() === '') return null

  let candidate = raw.trim()
  candidate = candidate.replace(/^git\+/, '').replace(/^git:\/\//, 'https://')
  candidate = candidate.replace(/^ssh:\/\/git@/, 'https://').replace(/^git@([^:]+):/, 'https://$1/')
  candidate = candidate.replace(/\.git$/, '')

  // Shorthand like "owner/repo" or "github:owner/repo".
  if (/^[\w.-]+\/[\w.-]+$/.test(candidate)) candidate = `https://github.com/${candidate}`
  if (/^github:/.test(candidate))
    candidate = `https://github.com/${candidate.slice('github:'.length)}`

  try {
    const url = new URL(candidate)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

function releasesUrlFor(repositoryUrl: string | null): string | null {
  if (repositoryUrl === null) return null
  try {
    const url = new URL(repositoryUrl)
    return url.hostname === 'github.com' ? `${url.toString().replace(/\/$/, '')}/releases` : null
  } catch {
    return null
  }
}

export function createPackageHandler(access: ProjectAccess) {
  return async ({ req, res, url }: RequestContext): Promise<void> => {
    const projectPath = resolveAllowedProject(
      url.searchParams.get('path'),
      access.allowedProjects(),
    )
    if (projectPath === null) {
      sendError(res, 403, 'Unknown project')
      return
    }

    const name = url.searchParams.get('name')
    // The name is joined into a filesystem path and into a registry URL, so it goes
    // through the same validator as the one that reaches a subprocess.
    if (name === null || !isValidPackageName(name)) {
      sendError(res, 400, 'Invalid package name')
      return
    }

    const controller = new AbortController()
    req.on('close', () => controller.abort())

    try {
      const installed = await readInstalledVersion(projectPath, name)

      const [info, detail, readme, advisoryIds] = await Promise.all([
        fetchPackageInfo(name, controller.signal),
        fetchPackageDetail(name, controller.signal),
        readLocalReadme(projectPath, name),
        installed === null
          ? Promise.resolve(new Map<string, string[]>())
          : queryVulnerabilities([{ name, version: installed }], controller.signal),
      ])

      const advisories = (
        await Promise.all(
          (advisoryIds.get(name) ?? []).map((id) => fetchAdvisory(id, controller.signal)),
        )
      ).filter((advisory): advisory is AdvisoryDetail => advisory !== null)

      const repositoryUrl = normalizeRepositoryUrl(detail?.repository ?? null)

      const payload: PackageDrawerPayload = {
        name,
        installed,
        latest: info?.latest ?? null,
        // Newest first; the version picker renders this list directly.
        versions: semver.rsort([...(info?.versions ?? [])]),
        deprecated: info?.deprecated ?? null,
        detail,
        readme,
        advisories,
        repositoryUrl,
        releasesUrl: releasesUrlFor(repositoryUrl),
      }

      sendJson(res, 200, payload)
    } catch (error) {
      if (controller.signal.aborted) return
      sendError(res, 502, error instanceof Error ? error.message : 'Could not load package')
    }
  }
}
