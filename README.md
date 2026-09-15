# packui

[![CI](https://github.com/strange-bytes-lab/packui/actions/workflows/ci.yml/badge.svg)](https://github.com/strange-bytes-lab/packui/actions/workflows/ci.yml)

A local GUI for your NPM dependencies.

Answering "what do I depend on, what's out of date, what's vulnerable, is my lockfile in
sync, and what breaks if I upgrade?" currently takes four commands and a dozen browser
tabs. packui puts it in one view and lets you act on it in place.

Works with **npm, pnpm, yarn and bun**. Requires **Node 22+**.

## Running it

Not published to npm yet, so run it from a clone:

```sh
git clone git@github.com:strange-bytes-lab/packui.git
cd packui
pnpm install
pnpm build

node bin/packui.mjs                  # inspect packui itself
node bin/packui.mjs ~/dev/my-project # or any other project
```

It serves on `127.0.0.1:7225` and walks upward if that port is taken, then opens your
browser. **Use the URL printed in the terminal** — it carries a session token that the
API requires.

Flags: `--port <n>`, `--no-open`, `--help`.

## What it does

- One row per dependency: declared range, installed version, latest, how far behind,
  vulnerability state and lockfile alignment
- Upgrade one package or everything outdated in one go — packui runs your project's own
  package manager and shows you the exact command before it runs
- Backs up `package.json` and the lockfile before every change, with one-click rollback
- Removing a package first shows every file that still imports it and every installed
  package that depends on it, then makes you type the name. Never one click
- A drawer per package: readme, full version history, advisory detail with the versions
  that fix each one, links to the repository and its releases
- **Globally installed CLIs too** — including the ones `npm root -g` cannot see, because
  volta, nvm, fnm and asdf each keep globals somewhere different, and packages stranded
  on a Node version you no longer use are invisible to every other tool
- Five themes, light and dark, following your system preference by default
- `/` focuses the filter, `Escape` clears it

Vulnerability data comes from [OSV.dev](https://osv.dev); version and deprecation data
from the npm registry. Both are cached under `~/.packui`. When offline, packui falls
back to cached data and then to "not checked" — it never reports a package as clean
because a lookup failed.

## Zero runtime dependencies

Installing packui installs packui. Nothing else. The UI and server are bundled at build
time, so the published package declares no `dependencies`, `peerDependencies` or
`optionalDependencies`. `pnpm verify:deps` enforces this in CI.

## Safety

The API can run package manager commands against real projects, so it is treated as a
privileged surface:

- Binds `127.0.0.1` only, and every `/api` request needs a per-session token that is
  regenerated each boot and never written to disk
- Mutating requests additionally require a loopback `Origin`, which is what stops a
  random page in your browser from reaching it
- Package names and versions are validated before reaching a subprocess, and commands
  are spawned with an argv array and no shell
- Readmes are third-party text, so they are rendered by a renderer that never emits a
  tag it did not construct itself

**Global packages cannot be rolled back.** There is no manifest or lockfile behind a
global install, so there is nothing to restore; the UI says so rather than offering a
button that cannot work.

## Development

```sh
pnpm install
pnpm dev          # Vite on :7332, API on :7331
pnpm test
pnpm typecheck
pnpm build
pnpm verify:deps
```

See `CLAUDE.md` for architecture, the security model and the conventions that matter
when changing this code.

## Status

Early, but the full loop works end to end. Publishing to npm is deliberately deferred.

## License

MIT
