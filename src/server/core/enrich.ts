import type { DependencyReport, VulnerabilitySummary } from '../../shared/types.ts'
import { mapWithConcurrency } from './cache.ts'
import { fetchAdvisory, queryVulnerabilities, worstSeverity } from './osv.ts'
import { fetchManyPackageInfos } from './registry.ts'
import { outdatedSeverity } from './report.ts'

export interface EnrichedRow {
  name: string
  latest: string | null
  versions: string[]
  deprecated: string | null
  outdated: DependencyReport['dependencies'][number]['outdated']
  vulnerabilities: VulnerabilitySummary | null
}

/**
 * Network half of the dependency table. Kept separate from buildReport so the UI
 * can render local state immediately and fill this in as it arrives — a cold
 * registry cache on a large project takes seconds.
 */
export async function enrichReport(
  report: DependencyReport,
  signal?: AbortSignal,
): Promise<EnrichedRow[]> {
  const names = report.dependencies.map((row) => row.name)

  const installedQueries = report.dependencies
    .filter((row): row is typeof row & { installed: string } => row.installed !== null)
    .map((row) => ({ name: row.name, version: row.installed }))

  const [infos, advisoryIds] = await Promise.all([
    fetchManyPackageInfos(names, signal),
    queryVulnerabilities(installedQueries, signal),
  ])

  // Severity lives on the advisory, not on the batch response, so it costs one
  // request per advisory. Only packages that actually have advisories pay it.
  const severityByName = new Map<string, VulnerabilitySummary['worst']>()
  await mapWithConcurrency([...advisoryIds.entries()], 4, async ([name, ids]) => {
    const advisories = await Promise.all(ids.map((id) => fetchAdvisory(id, signal)))
    severityByName.set(
      name,
      worstSeverity(advisories.map((advisory) => advisory?.severity ?? null)),
    )
  })

  return report.dependencies.map((row) => {
    const info = infos.get(row.name) ?? null
    const ids = advisoryIds.get(row.name) ?? []

    return {
      name: row.name,
      latest: info?.latest ?? null,
      versions: info?.versions ?? [],
      deprecated: info?.deprecated ?? null,
      outdated: outdatedSeverity(row.installed, info?.latest ?? null),
      vulnerabilities:
        ids.length === 0
          ? null
          : { count: ids.length, worst: severityByName.get(row.name) ?? null, ids },
    }
  })
}
