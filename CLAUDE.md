# packui

A local GUI for inspecting and upgrading a project's NPM dependencies. `npx packui`
boots a loopback HTTP server and opens a browser SPA showing one row per dependency
with its declared range, installed version, latest version, vulnerability state and
lockfile alignment — and can run the upgrade for you.

## The one rule: zero runtime dependencies

The published package must declare **no** `dependencies`, `peerDependencies` or
`optionalDependencies`. Everything is a `devDependency` and gets bundled:

- The UI is compiled by Vite into static assets under `dist/ui`.
- The server is bundled by esbuild into `dist/server/index.js`, with `semver` inlined.

`pnpm verify:deps` enforces this and runs in CI. If you need a library, add it as a
`devDependency` and let the bundler inline it — never add a runtime dependency.

## Layout

```
bin/packui.mjs     CLI entry: arg parsing, project resolution, browser launch
src/server/        Node HTTP server (loopback only)
  core/            Package manager detection, manifest/lockfile reading, registry + OSV clients
  api/             Route handlers
src/shared/        Types shared across the server/UI boundary
src/ui/            Vue 3 SPA
scripts/           Build, dev and verification scripts
test/              Vitest suites; fixture projects under test/fixtures/
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Vite on :7332 proxying `/api` to the server on :7331, both watching |
| `node bin/packui.mjs` | Serves on :7225 ("PACK" on a keypad), walking upward if taken |
| `pnpm build` | Builds `dist/ui` and `dist/server` |
| `pnpm test` | Vitest |
| `pnpm typecheck` | `vue-tsc --build` across both TS projects |
| `pnpm lint` | oxlint. Narrow rule set — correctness and suspicious only |
| `pnpm format` / `format:check` | Prettier. Markdown is excluded on purpose |
| `pnpm verify:deps` | Fails if any runtime dependency has crept in |

CI (`.github/workflows/ci.yml`) has two jobs. `check` runs lint, format, typecheck and
verify:deps once each on ubuntu — none of those answers can depend on the platform.
`test` runs the suite and the build across Node 22 and 24 on ubuntu and macOS, which is
what `engines: >=22` claims. Both use `fail-fast: false` so one run reports every
failing stage.

A third job, `smoke`, boots the built server and asserts the UI serves, the shell
carries a CSP with no `unsafe-inline`, the API accepts a valid token, rejects a missing
one with 401, and rejects a cross-origin mutation — including one from the dev server's
port — with 403. Those are security regressions if they ever go green wrongly. Do not
relax them.

Windows is deliberately untested: `bin/packui.mjs` shells out to `start` and
`core/global.ts` assumes POSIX layouts. A green tick there would be a claim, not a fact.

## Security model

The API executes package manager commands against real projects, so it is treated as a
privileged surface. Loopback binding is **not** a boundary on its own — any page in the
user's browser can reach `127.0.0.1`.

- Bind `127.0.0.1` explicitly. Never `0.0.0.0`.
- Every `/api/*` request must carry the per-session token (`Authorization: Bearer`, or
  `?t=` on first load). The token is regenerated each boot and never written to disk.
- Mutating methods additionally require a loopback `Origin` (DNS-rebinding defense).
- Static serving must never resolve outside `dist/ui`.
- Project paths from the client are resolved and checked against an allowlist.
- Package names and versions are validated before reaching a subprocess, and commands
  are spawned with an argv array and `shell: false`. **There is one validator** —
  `isValidPackageName` in `core/commands.ts` — and every route that takes a name uses
  it. Names may not begin with `-` (a package manager would parse them as flags) or
  with `.` (they are joined into `node_modules/<name>` and into registry URLs, where a
  dot segment traverses). Uppercase is allowed: `JSONStream` and its generation are
  still published and still installable.
- The origin allowlist includes the Vite dev server's port **only when `PACKUI_DEV=1`**.
  In a released build that port is one any local process can bind.
- The app shell is served under a Content-Security-Policy with no `unsafe-inline`
  (`core/../static.ts`), which is why the theme bootstrap lives in
  `src/ui/public/theme-boot.js` rather than in a `<script>` tag. Every response also
  carries `nosniff` and `no-referrer`. The CSP is the second layer under the README
  renderer: it is what makes a future bug in the renderer non-exploitable.
- READMEs are untrusted third-party text. They go through the renderer in
  `src/ui/composables/markdown.ts`, which is safe by construction: raw HTML is
  translated to Markdown *before* escaping and any untranslated tag is dropped, so
  nothing from the source reaches the output as markup. `script`/`style`/`iframe`
  elements are removed with their contents, hrefs must be http/https/mailto, and
  images become alt text rather than being fetched.
  Do not "improve" this by passing HTML through — the visible-noise problem it solves
  has a safe fix, and rendering registry HTML directly does not.

`test/server.test.ts`, `test/static.test.ts`, `test/markdown.test.ts` and
`test/mutate.test.ts` cover these. Do not weaken them.

## Mutation model

Every write follows one path: take the project lock, snapshot `package.json` and the
lockfile, run the project's own package manager, stream its output, report the result.

- **Never edit `package.json` or a lockfile directly.** Shell out to the project's
  package manager and let it own its lockfile format and resolution.
- **Snapshot before running, not after succeeding** (`core/backup.ts`), so a failure
  part-way through is recoverable. Rollback snapshots the broken state first, so the
  rollback is itself undoable.
- **One mutation at a time per project** (`withProjectLock`). Concurrent package
  manager processes corrupt lockfiles.
- **Choose the save flag from the dependency's current kind**, or an upgrade will move
  a devDependency into `dependencies`. Batch upgrades group by kind for this reason.
- **Show the command before running it.**
- **Removal is gated, never one-click.** It is the only action that breaks a project
  at runtime rather than at install time — the uninstall succeeds, the lockfile
  updates cleanly, and the failure appears later in whatever imported the package.
  `GET /api/impact` scans source for real imports and finds installed packages that
  depend on it; the dialog shows that, then requires the package name to be typed.
  The server independently rejects a removal whose `confirm` field does not match the
  name exactly, so the gate is not only in the UI.

## Global packages

The sidebar lists global scopes alongside the project. Finding them is the hard part
and `npm root -g` alone is not enough:

- It answers only for the **currently active** Node version. Under nvm, fnm, asdf or
  volta, each installed Node version has its own global root, so packages installed
  under a version you have since switched away from are on disk and invisible.
- Under **volta** it is actively misleading: it points at volta's Node image, which
  holds only npm and corepack. Tools installed with `volta install` live in a separate
  store, one isolated `lib/node_modules` per tool. Trusting it on a volta machine
  reports almost nothing while looking like a legitimately empty result.

So `core/global.ts` asks each package manager *and* probes the known version-manager
layouts (volta, nvm, fnm, asdf, n, Homebrew, system), then dedupes by real path.

A volta root is one tool's private `lib/node_modules`, not a global root, so a
`GlobalRoot` carries the name of the tool that owns it and only that entry is read.
Anything else in there belongs to the tool, not to the user.

Global mutations go through whichever tool owns the package — volta tools are upgraded
with `volta install`, never `npm install -g`, which would install a second copy where
volta's shims never look. Globals have no manifest or lockfile, so there is nothing to
snapshot and **rollback is not available**; the UI says so rather than offering a
button that cannot work. Global mutations are one package at a time.

## Symlinks in node_modules

`Dirent.isDirectory()` is false for symlinks, and this bites in several places at once:
pnpm links every top-level entry into its store, `npm link` and `volta install` of a
local path link too. Use `isDirectoryLike` from `core/fsutil.ts` when walking
node_modules, never a bare `isDirectory()` — getting this wrong made the removal gate
report zero dependents for every pnpm project.

## Browser support policy

packui opens the user's default browser, so Chrome cannot be assumed.

- **Popover API** — Baseline since 2025-01-27. Use directly, no polyfill.
- **`<dialog>`, `color-scheme`, `light-dark()`** — Baseline. Use directly.
- **CSS anchor positioning** — *not* Baseline; Firefox lags. Use only as progressive
  enhancement behind `@supports (position-area: block-end)`, with an absolutely
  positioned fallback. Never add a JS positioning library.

Overlays use platform primitives: `<dialog>` for the drawer, the Popover API for
popovers and version dropdowns. There is no component library and should not be one.

## Versioning and releases

Commit messages are load-bearing, not a style preference. release-please reads them
from `main`, keeps a release PR open with the version they imply, and writes
`CHANGELOG.md`. Merging that PR tags the release; the tag triggers the publish job.

- `fix:` → patch, `feat:` → minor, `feat!:` or a `BREAKING CHANGE:` footer → major.
- Stay on `0.x` until the HTTP API and the mutation model settle. Under release-please's
  node strategy a breaking change in `0.x` bumps the minor, which is the intended signal.
- **Never publish by hand.** A hand-published version has no provenance attestation and
  no changelog entry, and nothing afterwards can say what it was built from.
- `prepack` builds and re-runs `verify:deps`. `dist/` is gitignored and `files` ships it,
  so publishing without building produces a package whose `bin` cannot start.

## Conventions

- TypeScript is pinned to 5.x because `vue-tsc` does not yet support the TypeScript 7
  native port. Revisit when it does.
- Theming is one layer of CSS custom properties switched by `data-theme` on `<html>`,
  with `color-scheme` set per theme so native controls follow. Add themes in
  `src/ui/styles/themes.css` and register them in `src/ui/composables/useTheme.ts`.
- Installed versions are read from `node_modules/<pkg>/package.json`, not from
  lockfiles — that field is identical across npm, pnpm, yarn and bun, whereas
  `bun.lockb` is binary and `pnpm-lock.yaml` would need a YAML parser we do not ship.
- READMEs come from `node_modules/<pkg>/README.md`, not the registry. The registry
  returns an empty `readme` field on the packument and none at all on per-version
  documents (verified against minimist and vue). Reading locally is also more accurate,
  since it is the readme for the version actually installed.
- Latest versions and deprecation come from the *abbreviated* packument
  (`Accept: application/vnd.npm.install-v1+json`); the full document is megabytes for
  popular packages. Drawer metadata comes from the per-version document at
  `/<pkg>/latest` for the same reason — never fetch the full packument. Both are
  ETag-aware and cached under `~/.packui`, which is pruned at boot.
- Advisories are cached per `name@version`, never per request. A version's advisories
  are the same in every project, so the entries are shared; keying on the whole
  dependency set meant one bump invalidated everything and no two projects shared
  anything. "No advisories" is cached too — it is the common answer.
- Vulnerabilities come from OSV.dev, not `npm audit`, so one code path covers all four
  package managers. Severity requires a per-advisory request, so only packages that
  actually have advisories pay for it.
- Every network path degrades to cached data, then to `null`, which the UI renders as
  "not checked" rather than "up to date". Never invent a clean bill of health.
