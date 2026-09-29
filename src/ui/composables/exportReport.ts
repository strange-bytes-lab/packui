import type { DependencyReport, DependencyRow } from '@shared/types'
import { rowStatus } from '@/composables/rowStatus'
import type { TreeAudit } from '@/types/insights'

/**
 * A self-contained, read-only HTML snapshot of the current table, for attaching to an
 * issue or a pull request. It has no script and no API: just the rows as they were.
 *
 * Every value in it came from package.json, node_modules or the registry, so every
 * value is escaped. The file also carries its own policy forbidding script and remote
 * loads, so a mistake in the escaping would still render inert — the same two layers
 * the app shell uses for READMEs.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)
}

const KIND: Record<DependencyRow['kind'], string> = {
  prod: 'dep',
  dev: 'dev',
  peer: 'peer',
  optional: 'opt',
}

function advisoryCell(row: DependencyRow): string {
  if (row.vulnerabilities !== null) {
    const worst = row.vulnerabilities.worst
    return `<span class="sev" data-sev="${escapeHtml(worst ?? 'unknown')}">${row.vulnerabilities.count}${
      worst === null ? '' : ` · ${escapeHtml(worst)}`
    }</span>`
  }
  if (row.vulnerabilityCheck === 'checked') return '<span class="muted">none</span>'
  if (row.vulnerabilityCheck === 'private')
    return '<span class="muted">private · not audited</span>'
  return '<span class="muted">not checked</span>'
}

export function buildReportHtml(
  report: DependencyReport,
  rows: readonly DependencyRow[],
  audit: TreeAudit | null,
  exportedAt: Date = new Date(),
): string {
  const project = report.project
  const global = project.scope === 'global'
  const title = `${project.name} — packui report`

  const body = rows
    .map((row) => {
      const status = rowStatus(row)
      return `<tr>
<td><span class="dot" data-tone="${status.tone}" title="${escapeHtml(status.label)}"></span></td>
<td class="mono">${escapeHtml(row.name)}</td>
${global ? '' : `<td>${KIND[row.kind]}</td><td class="mono">${escapeHtml(row.declared)}</td>`}
<td class="mono">${row.installed === null ? '<span class="muted">not installed</span>' : escapeHtml(row.installed)}</td>
<td class="mono">${row.latest === null ? '<span class="muted">—</span>' : escapeHtml(row.latest)}</td>
<td>${escapeHtml(status.label)}</td>
<td>${advisoryCell(row)}</td>
<td>${row.deprecated === null ? '' : `<span class="sev" data-sev="high">deprecated</span> ${escapeHtml(row.deprecated)}`}</td>
</tr>`
    })
    .join('\n')

  const drift =
    report.drift !== null && report.drift.length > 0
      ? `<p class="warn">package.json and ${escapeHtml(project.lockfile ?? 'the lockfile')} disagree about: ${report.drift
          .map((entry) => `<code>${escapeHtml(entry.name)}</code>`)
          .join(', ')}.</p>`
      : ''

  const indirect =
    audit === null
      ? ''
      : `<h2>Indirect advisories</h2>
<p>${audit.packages} installed packages checked${
          audit.unchecked > 0 ? `; ${audit.unchecked} could not be checked` : ''
        }.</p>
${
  audit.vulnerable.length === 0
    ? '<p class="muted">None found.</p>'
    : `<table><thead><tr><th>Package</th><th>Severity</th><th>Via</th><th>Fixed in</th></tr></thead><tbody>
${audit.vulnerable
  .map(
    (entry) => `<tr><td class="mono">${escapeHtml(`${entry.name}@${entry.version}`)}</td>
<td><span class="sev" data-sev="${escapeHtml(entry.advisories.worst ?? 'unknown')}">${escapeHtml(entry.advisories.worst ?? 'unrated')}</span></td>
<td class="mono">${escapeHtml(entry.chain.join(' → '))}</td>
<td class="mono">${entry.suggested === null ? '<span class="muted">no fix</span>' : escapeHtml(entry.suggested)}</td></tr>`,
  )
  .join('\n')}
</tbody></table>`
}`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; --muted: light-dark(#666, #999); --border: light-dark(#ddd, #333);
  --major: light-dark(#c62828, #ef5350); --minor: light-dark(#b26a00, #ffb74d); --patch: light-dark(#1565c0, #64b5f6); --ok: light-dark(#2e7d32, #81c784); }
body { margin: 0 auto; padding: 24px 16px; max-width: 1200px; font: 14px/1.5 system-ui, sans-serif; background: light-dark(#fff, #111); color: light-dark(#111, #eee); }
h1 { margin: 0 0 4px; font-size: 20px; } h2 { margin: 32px 0 8px; font-size: 16px; }
.meta, .muted { color: var(--muted); } .warn { color: var(--minor); }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 6px 8px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--border); }
th { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
.mono, code { font-family: ui-monospace, monospace; font-size: 12px; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.dot[data-tone=major] { background: var(--major); } .dot[data-tone=minor] { background: var(--minor); }
.dot[data-tone=patch] { background: var(--patch); } .dot[data-tone=ok] { background: var(--ok); }
.sev { padding: 0 6px; border: 1px solid currentColor; border-radius: 4px; font-size: 11px; text-transform: uppercase; }
.sev[data-sev=critical], .sev[data-sev=high] { color: var(--major); } .sev[data-sev=moderate] { color: var(--minor); }
.sev[data-sev=low], .sev[data-sev=unknown] { color: var(--muted); }
</style>
</head>
<body>
<h1>${escapeHtml(project.name)}</h1>
<p class="meta">${escapeHtml(project.displayPath)}${
    project.packageManager === null ? '' : ` · ${escapeHtml(project.packageManager)}`
  }${project.lockfile === null ? '' : ` · ${escapeHtml(project.lockfile)}`} · exported ${escapeHtml(
    exportedAt.toISOString().slice(0, 16).replace('T', ' '),
  )} UTC by packui</p>
${drift}
<h2>${global ? 'Global packages' : 'Dependencies'} (${rows.length})</h2>
<div class="scroll"><table>
<thead><tr><th></th><th>Package</th>${global ? '' : '<th>Kind</th><th>Declared</th>'}<th>Installed</th><th>Latest</th><th>Status</th><th>Advisories</th><th>Notes</th></tr></thead>
<tbody>
${body}
</tbody>
</table></div>
${indirect}
</body>
</html>
`
}

/** Hands the file to the browser as a download. */
export function downloadReport(html: string, projectName: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${projectName.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'}-packui.html`
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
