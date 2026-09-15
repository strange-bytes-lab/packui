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
| `pnpm build` | Builds `dist/ui` and `dist/server` |
| `pnpm test` | Vitest |
| `pnpm typecheck` | `vue-tsc --build` across both TS projects |
| `pnpm verify:deps` | Fails if any runtime dependency has crept in |

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
  are spawned with an argv array and `shell: false`. Package names may not begin with
  `-`, or a package manager would parse them as flags.
- READMEs are untrusted third-party text. They go through the restricted renderer in
  `src/ui/composables/markdown.ts`, which escapes everything, emits only tags it builds
  itself, allows only http/https/mailto hrefs, and renders images as alt text rather
  than fetching them.

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

## Browser support policy

packui opens the user's default browser, so Chrome cannot be assumed.

- **Popover API** — Baseline since 2025-01-27. Use directly, no polyfill.
- **`<dialog>`, `color-scheme`, `light-dark()`** — Baseline. Use directly.
- **CSS anchor positioning** — *not* Baseline; Firefox lags. Use only as progressive
  enhancement behind `@supports (position-area: block-end)`, with an absolutely
  positioned fallback. Never add a JS positioning library.

Overlays use platform primitives: `<dialog>` for the drawer, the Popover API for
popovers and version dropdowns. There is no component library and should not be one.

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
  popular packages. Requests are ETag-aware and cached under `~/.packui`.
- Vulnerabilities come from OSV.dev, not `npm audit`, so one code path covers all four
  package managers. Severity requires a per-advisory request, so only packages that
  actually have advisories pay for it.
- Every network path degrades to cached data, then to `null`, which the UI renders as
  "not checked" rather than "up to date". Never invent a clean bill of health.
