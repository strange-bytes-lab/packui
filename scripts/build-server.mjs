import { build } from 'esbuild'
import { rm } from 'node:fs/promises'

await rm('dist/server', { recursive: true, force: true })

const result = await build({
  entryPoints: ['src/server/index.ts'],
  outfile: 'dist/server/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Bundling is what lets packui declare zero runtime dependencies while still
  // using a battle-tested semver implementation instead of hand-rolling one.
  // Node builtins are external automatically under platform: 'node'.
  packages: 'bundle',
  minify: false,
  // 'external' rather than 'linked': the map is written for debugging a report
  // against this build, but it is not published, so a sourceMappingURL pointing at
  // a file that will not be in the tarball would be a dangling reference.
  sourcemap: 'external',
  metafile: true,
  logLevel: 'info',
})

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0)
console.log(`  server bundle: ${(bytes / 1024).toFixed(1)} kB`)
