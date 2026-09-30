#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const HELP = `
  packui — a local GUI for your NPM dependencies

  Usage
    $ packui [path]

  Run it inside a project to open that project, or anywhere else (your dev
  folder, say) to pick one of your recent projects or add a folder.

  Options
    --port <number>   Port to listen on (default: an open port)
    --no-open         Do not open a browser automatically
    --help            Show this message
`

/**
 * `start` is a cmd.exe builtin, so it needs a shell, and cmd.exe would read an `&` in
 * the URL as a command separator. rundll32's URL handler opens the default browser
 * with the URL as a plain argument, no shell involved.
 */
function browserCommand(url) {
  if (process.platform === 'darwin') return ['open', [url]]
  if (process.platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]]
  return ['xdg-open', [url]]
}

function openBrowser(url) {
  const [command, args] = browserCommand(url)
  // Detached so closing the browser never takes the server with it.
  spawn(command, args, { stdio: 'ignore', detached: true, shell: false })
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

const target = resolve(process.cwd(), positionals[0] ?? '.')

const targetInfo = await stat(target).catch(() => null)
if (targetInfo === null || !targetInfo.isDirectory()) {
  console.error(`\n  No folder at ${target}\n`)
  process.exit(1)
}

// A folder with no package.json is not an error: packui opens on its project picker,
// starting there.
const manifest = await stat(resolve(target, 'package.json')).catch(() => null)
const projectPath = manifest?.isFile() === true ? target : null

const serverEntry = fileURLToPath(new URL('../dist/server/index.js', import.meta.url))

let startServer
let checkForUpdate
try {
  ;({ startServer, checkForUpdate } = await import(serverEntry))
} catch {
  console.error('\n  packui is not built. Run `pnpm build` first.\n')
  process.exit(1)
}

const port = values.port === undefined ? undefined : Number(values.port)
if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
  console.error(`\n  Invalid port: ${values.port}\n`)
  process.exit(1)
}

const server = await startServer({ projectPath, startDir: target, port, rememberProjects: true })

console.log(`\n  packui  ${server.url}`)
console.log(
  projectPath === null
    ? `  folder  ${target} (no package.json; pick a project in the browser)\n`
    : `  project ${projectPath}\n`,
)

if (!values['no-open']) openBrowser(server.url)

// One quiet line if a newer packui is out. Never waited on, and never an error.
const updateTimeout = AbortSignal.timeout(5000)
void checkForUpdate?.(updateTimeout)
  .then((status) => {
    if (!status.updateAvailable) return
    console.log(`  update  ${status.latest} is available (running ${status.current})`)
    console.log('          npx @strange-bytes/packui@latest\n')
  })
  .catch(() => {})

const shutdown = () => {
  void server.close().then(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
