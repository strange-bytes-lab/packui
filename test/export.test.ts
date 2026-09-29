import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { buildReportHtml, escapeHtml } from '../src/ui/composables/exportReport.ts'
import type { DependencyReport, DependencyRow } from '../src/shared/types.ts'

const EVIL = '<img src=x onerror=alert(1)><script>alert(2)</script>'

function row(overrides: Partial<DependencyRow> = {}): DependencyRow {
  return {
    name: 'vue',
    kind: 'prod',
    declared: '^3.5.0',
    installed: '3.5.13',
    latest: '3.5.13',
    outdated: 'current',
    alignment: 'aligned',
    deprecated: null,
    vulnerabilities: null,
    vulnerabilityCheck: 'checked',
    ...overrides,
  }
}

const report: DependencyReport = {
  project: {
    scope: 'project',
    path: '/p',
    displayPath: '~/p',
    name: EVIL,
    packageManager: 'pnpm',
    lockfile: 'pnpm-lock.yaml',
    hasNodeModules: true,
  },
  dependencies: [],
  drift: [{ name: EVIL, field: 'dependencies', declared: '^2', locked: '^1' }],
  alignment: 'stale',
  generatedAt: '',
}

describe('HTML export', () => {
  it('escapes every value, so nothing from a manifest becomes markup', () => {
    const html = buildReportHtml(
      report,
      [row({ name: EVIL, declared: EVIL, deprecated: EVIL, latest: EVIL })],
      {
        packages: 1,
        truncated: false,
        vulnerable: [
          {
            name: EVIL,
            version: '1.0.0',
            advisories: { count: 1, worst: 'high', ids: ['x'] },
            fixedIn: [],
            suggested: EVIL,
            chain: [EVIL],
            via: [],
          },
        ],
        byDirect: {},
        unchecked: 0,
        privateSkipped: 0,
      },
    )
    const { document } = new JSDOM(html).window
    expect(document.querySelectorAll('script, img')).toHaveLength(0)
    expect(document.body.textContent).toContain(EVIL)
  })

  it('carries its own policy forbidding script, as a second layer', () => {
    const html = buildReportHtml(report, [row()], null)
    const { document } = new JSDOM(html).window
    const policy = document.querySelector('meta[http-equiv="Content-Security-Policy"]')
    expect(policy?.getAttribute('content')).toBe("default-src 'none'; style-src 'unsafe-inline'")
  })

  it('distinguishes "no advisories" from "not checked"', () => {
    const html = buildReportHtml(
      report,
      [
        row({ name: 'clean' }),
        row({ name: 'unknown', vulnerabilityCheck: 'unavailable' }),
        row({ name: 'corp', vulnerabilityCheck: 'private' }),
      ],
      null,
    )
    expect(html).toContain('>none<')
    expect(html).toContain('not checked')
    expect(html).toContain('private · not audited')
  })

  it('escapes quotes for attribute contexts', () => {
    expect(escapeHtml(`"'<>&`)).toBe('&quot;&#39;&lt;&gt;&amp;')
  })
})
