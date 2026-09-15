/**
 * Runs the whole dev loop from one command, without pulling in a process runner.
 * Vite serves the UI on 7332 and proxies /api to the Node server on 7331;
 * esbuild rebuilds the server bundle on change and `node --watch` restarts it.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { context } from 'esbuild'

// One token, shared by the API server and the Vite proxy that fronts it.
process.env.PACKUI_DEV = '1'
process.env.PACKUI_TOKEN = randomBytes(32).toString('base64url')

const children = []

function run(name, command, args) {
  const child = spawn(command, args, { stdio: 'inherit', shell: false })
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`  [${name}] exited with ${code}`)
  })
  children.push(child)
  return child
}

const serverBuild = await context({
  entryPoints: ['src/server/index.ts'],
  outfile: 'dist/server/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'bundle',
  sourcemap: true,
  logLevel: 'warning',
})

await serverBuild.rebuild()
await serverBuild.watch()

run('ui', 'node', ['node_modules/vite/bin/vite.js'])
run('server', 'node', ['--watch', 'bin/packui.mjs', '--no-open', '--port', '7331'])

console.log('\n  packui dev  http://127.0.0.1:7332\n')

const shutdown = async () => {
  for (const child of children) child.kill('SIGTERM')
  await serverBuild.dispose()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
