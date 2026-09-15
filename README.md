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

## Status

Early. See `CLAUDE.md` for architecture, the security model and contribution
conventions.

## Development

```sh
pnpm install
pnpm dev      # Vite on :7332, API on :7331
pnpm test
pnpm build
```

## License

MIT
