#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const HELP = `
  packui — a local GUI for your NPM dependencies

  Usage
    $ packui [project-path]

  Options
    --port <number>   Port to listen on (default: an open port)
    --no-open         Do not open a browser automatically
    --help            Show this message
`

function openBrowser(url) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  // Detached so closing the browser never takes the server with it.
  spawn(command, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
    .on('error', () => {
      console.log('  Could not open a browser automatically. Open the URL above manually.')
    })
    .unref()
}

const { values, positionals } = parseArgs({
  options: {
    port: { type: 'string' },
    'no-open': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
})

if (values.help) {
  console.log(HELP)
  process.exit(0)
}

const projectPath = resolve(process.cwd(), positionals[0] ?? '.')

try {
  await access(resolve(projectPath, 'package.json'))
} catch {
  console.error(`\n  No package.json found in ${projectPath}\n`)
  process.exit(1)
}

const serverEntry = fileURLToPath(new URL('../dist/server/index.js', import.meta.url))

let startServer
try {
  ;({ startServer } = await import(serverEntry))
} catch {
  console.error('\n  packui is not built. Run `pnpm build` first.\n')
  process.exit(1)
}

const port = values.port === undefined ? undefined : Number(values.port)
if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
  console.error(`\n  Invalid port: ${values.port}\n`)
  process.exit(1)
}

const server = await startServer({ projectPath, port })

console.log(`\n  packui  ${server.url}`)
console.log(`  project ${projectPath}\n`)

if (!values['no-open']) openBrowser(server.url)

const shutdown = () => {
  void server.close().then(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
