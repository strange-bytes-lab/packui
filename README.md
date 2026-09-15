# packui

A local GUI for your NPM dependencies.

Answering "what do I depend on, what's out of date, what's vulnerable, is my lockfile
in sync, and what breaks if I upgrade?" currently takes four commands and a dozen
browser tabs. packui puts it in one view and lets you act on it in place.

```sh
npx packui
```

It reads the project in your current directory, opens a browser, and shows one row
per dependency — declared range, installed version, latest version, how far behind
you are, vulnerability state and lockfile alignment. READMEs and CVE detail open in
a drawer so the table stays dense.

Works with **npm, pnpm, yarn and bun**.

## Zero runtime dependencies

Installing packui installs packui. Nothing else. The UI and server are bundled at
build time, so the published package declares no dependencies at all.

## What it does

- One row per dependency: declared range, installed version, latest, how far behind,
  vulnerability state and lockfile alignment
- Upgrade a package, or upgrade everything outdated in one go — packui runs your
  project's own package manager and shows you the command first
- Removing a package first shows you every file that still imports it and every
  installed package that depends on it, then asks you to type the name
- Backs up `package.json` and the lockfile before every change, with one-click rollback
- A drawer per package: readme, full version history, advisory detail with the versions
  that fix each one, and links to the repository and its releases
- Five themes, light and dark, following your system preference by default

Vulnerability data comes from [OSV.dev](https://osv.dev); version and deprecation data
from the npm registry. Both are cached under `~/.packui`, and packui degrades to cached
or local data when offline rather than claiming everything is fine.

## Status

Early, but the full loop works. See `CLAUDE.md` for architecture, the security model
and contribution conventions.

## Development

```sh
pnpm install
pnpm dev      # Vite on :7332, API on :7331
pnpm test
pnpm build
```

## License

MIT
