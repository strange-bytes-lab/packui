/** Mirrors the payload built by src/server/api/usage.ts. */
export interface UsageAudit {
  filesScanned: number
  truncated: boolean
  unused: { name: string; kind: string; reason: string | null }[]
  undeclared: {
    name: string
    installed: string | null
    usages: { file: string; line: number }[]
  }[]
}
