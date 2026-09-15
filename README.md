<p align="center">
  <img src="https://raw.githubusercontent.com/strange-bytes-lab/packui/main/docs/hero.jpg" alt="packui" width="720">
</p>

<p align="center">
  <b>A local GUI for your NPM dependencies.</b><br>
  See what you depend on, what's outdated, what's vulnerable — and fix it in place.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/packui"><img alt="npm" src="https://img.shields.io/npm/v/packui?color=%23cb3837&label=npm"></a>
  <a href="https://github.com/strange-bytes-lab/packui/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/strange-bytes-lab/packui/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="node" src="https://img.shields.io/node/v/packui">
  <img alt="dependencies" src="https://img.shields.io/badge/runtime%20deps-0-brightgreen">
  <img alt="license" src="https://img.shields.io/npm/l/packui">
</p>

---

## 🚀 Quick start

```sh
npx packui
```

That's it. No install, no config, no account.

packui reads the project in your current directory, starts a server on
`127.0.0.1:7225` and opens your browser.

```sh
npx packui ~/dev/some-other-project   # a project somewhere else
npx packui --port 8080                # a different port
npx packui --no-open                  # don't open a browser
```

> [!IMPORTANT]
> Use the URL printed in your terminal. It carries a session token that the API
> requires, and a fresh one is generated every time packui starts.

Works with **npm**, **pnpm**, **yarn** and **bun**. Needs **Node 22+**.
Tested on macOS and Linux.

---

## ✨ What it does

**📊 One row per dependency** — declared range, installed version, latest, how far
behind, vulnerability state and whether your lockfile still matches reality.

**⬆️ Upgrades that you can watch** — one package or everything outdated at once.
packui runs *your* project's package manager, shows you the exact command before it
runs, and streams the output live.

```
$ pnpm add vue@3.5.13 -D
```

**↩️ A way back** — `package.json` and your lockfile are snapshotted *before* every
change, not after it succeeds. One click restores them and reinstalls.

**🛑 Removal that makes you look first** — the one action that breaks a project at
runtime rather than at install time. packui shows every file that still imports the
package and every installed package that depends on it, then makes you type the name.

**📖 A drawer per package** — readme, full version history, advisory detail with the
versions that fix each one, links to the repository and its releases.

**🌍 Global CLIs too** — including the ones `npm root -g` cannot find. See below.

**🎨 Five themes**, light and dark, following your system preference by default.
`/` focuses the filter, `Escape` clears it.

---

## 🌍 Global packages

The sidebar lists your global installs next to your project. Finding them is
harder than it sounds, and `npm root -g` on its own gets it wrong:

- It answers only for the **currently active** Node version. Under nvm, fnm, asdf or
  volta, every installed version has its own global root — so a CLI you installed
  under a version you've since switched away from is still on disk, still on your
  PATH's memory, and invisible to every other tool.
- Under **volta** it's actively misleading. It points at volta's Node image, which
  holds npm and corepack and nothing else. Your actual tools live somewhere
  completely different.

So packui asks every package manager *and* probes the layouts that volta, nvm, fnm,
asdf, n and Homebrew actually use, then dedupes what it finds by real path.

> [!NOTE]
> Global packages can't be rolled back — there's no manifest or lockfile behind a
> global install, so there's nothing to restore. packui says so rather than offering
> a button that can't work.

---

## 🔒 Safety

packui runs package manager commands against real projects, so the API is treated
as a privileged surface. Binding to loopback is **not** a boundary on its own — any
page in your browser can reach `127.0.0.1`.

| | |
|---|---|
| 🔑 **Session token** | Every `/api` request needs it. Regenerated each boot, never written to disk. |
| 🚪 **Origin check** | Mutating requests must come from a loopback origin. This is what stops a random page in your browser reaching the API. |
| 🧱 **CSP** | The UI is served under a policy with no `unsafe-inline`, no remote anything, and no framing. |
| 🧼 **Validated input** | Package names and versions are checked before they reach a subprocess, and commands are spawned with an argv array and no shell. |
| 📄 **Untrusted readmes** | Rendered by a renderer that never emits a tag it did not construct itself. No remote images are fetched. |

---

## 📦 Zero runtime dependencies

Installing packui installs packui. Nothing else.

```jsonc
// package.json
"dependencies": {} // ← and it stays that way
```

The UI and server are bundled at build time, so the published package declares no
`dependencies`, `peerDependencies` or `optionalDependencies`. `pnpm verify:deps`
enforces it on every CI run and again before every publish.

Vulnerability data comes from [OSV.dev](https://osv.dev); version and deprecation
data from the npm registry. Both are cached under `~/.packui`. Offline, packui falls
back to cached data and then to *"not checked"* — it never reports a package as
clean because a lookup failed.

---

## 🛠️ Development

```sh
git clone git@github.com:strange-bytes-lab/packui.git
cd packui
pnpm install

pnpm dev            # Vite on :7332, API on :7331, both watching
pnpm test           # 220 tests
pnpm lint           # oxlint
pnpm format:check   # prettier
pnpm typecheck      # vue-tsc across both TS projects
pnpm build          # dist/ui + dist/server
pnpm verify:deps    # fails if a runtime dependency crept in
```

`CLAUDE.md` has the architecture, the security model, and the reasoning behind the
decisions that aren't obvious from the code.

---

## 🏷️ Versioning

Commit messages are load-bearing. [release-please](https://github.com/googleapis/release-please)
reads them, keeps a release PR open with the next version and its changelog, and
publishing happens when that PR is merged — with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements), so every
published tarball is traceable to the commit it was built from.

| Commit | Release |
|---|---|
| `fix:` | patch |
| `feat:` | minor |
| `feat!:` or `BREAKING CHANGE:` | major |

packui stays on `0.x` until the HTTP API and the mutation model settle.

---

## 📄 License

MIT © Antonis Panos
