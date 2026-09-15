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

The API can execute package manager commands against real projects, so it is treated
as a privileged surface. Loopback binding is **not** a boundary on its own — any page
in the user's browser can reach `127.0.0.1`.

- Bind `127.0.0.1` explicitly. Never `0.0.0.0`.
- Every `/api/*` request must carry the per-session token (`Authorization: Bearer`, or
  `?t=` on first load). The token is regenerated each boot and never written to disk.
- Mutating methods additionally require a loopback `Origin` (DNS-rebinding defense).
- Static serving must never resolve outside `dist/ui`.

`test/server.test.ts` and `test/static.test.ts` cover these. Do not weaken them.

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
- Mutations run the project's own package manager rather than editing `package.json`
  or lockfiles directly, so the package manager stays the authority on its lockfile.
