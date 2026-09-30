# Changelog

## [0.4.0](https://github.com/strange-bytes-lab/packui/compare/packui-v0.3.0...packui-v0.4.0) (2026-09-30)


### Features

* run anywhere and add project folders from the UI ([d27a718](https://github.com/strange-bytes-lab/packui/commit/d27a718bd875d34d842ea1173ea643ef11d9dc7b))
* show a quiet notice when a newer packui is published ([d27a718](https://github.com/strange-bytes-lab/packui/commit/d27a718bd875d34d842ea1173ea643ef11d9dc7b))

## [0.3.0](https://github.com/strange-bytes-lab/packui/compare/packui-v0.2.0...packui-v0.3.0) (2026-09-30)


### Features

* audit the whole installed tree, weigh it, and find unused dependencies ([f9863f1](https://github.com/strange-bytes-lab/packui/commit/f9863f16ec89abeff957733a16236ad1b7451306))
* check compatibility, show release notes and package health before upgrading ([9b19ea7](https://github.com/strange-bytes-lab/packui/commit/9b19ea732922c37576c6b4638f96b0a6d647a156))
* export the table as a self-contained HTML report ([1f14d97](https://github.com/strange-bytes-lab/packui/commit/1f14d972f9edf559ed61804b955d9c6eab552937))
* look packages up in the registry .npmrc maps them to ([5e8adb2](https://github.com/strange-bytes-lab/packui/commit/5e8adb27f68c9632a955ebb3c656f6583e890984))
* support npm, pnpm, yarn and bun workspaces ([472829b](https://github.com/strange-bytes-lab/packui/commit/472829bcba7147b47f2066b4aacbbf90ee50e89d))
* support Windows ([fb6c04a](https://github.com/strange-bytes-lab/packui/commit/fb6c04a0530a271dd59fcf87004816b07a0101a4))
* switch between recently opened projects ([dbc2042](https://github.com/strange-bytes-lab/packui/commit/dbc2042e1b96e18119ac8d8e977f57bbefb96fc0))


### Fixes

* compare lockfile contents instead of timestamps for the out-of-sync warning ([4c62617](https://github.com/strange-bytes-lab/packui/commit/4c62617872bfca0b61eda976904a3c8fc1a8e889))
* report source file paths with forward slashes on Windows ([cc8ff47](https://github.com/strange-bytes-lab/packui/commit/cc8ff47bdc35fbcdd311ead65aaa49688736f3e2))


### Documentation

* describe workspaces, insights, registries and Windows support ([46cda82](https://github.com/strange-bytes-lab/packui/commit/46cda82b7e5af4a432a3d7d4d7443e7eddf37fdf))

## [0.2.0](https://github.com/strange-bytes-lab/packui/compare/packui-v0.1.0...packui-v0.2.0) (2026-09-21)


### Features

* fuzzy-match the package filter ([92810ef](https://github.com/strange-bytes-lab/packui/commit/92810eff5c2d2df4eac410ab69f5edea3113dd9c))
* open the drawer from anywhere in the row ([fa6adab](https://github.com/strange-bytes-lab/packui/commit/fa6adab1cabf04bfc284aac894a27005dffa0dc5))
* search npmjs.com from the toolbar ([04d71a3](https://github.com/strange-bytes-lab/packui/commit/04d71a31356c10b2e4ccd4cc1502eb5fd23d193d))
* show that registry and advisory lookups are still running ([6cb3744](https://github.com/strange-bytes-lab/packui/commit/6cb374420b639ee380400fe4e9ae4e30aecc116a))
* sort the table by any column ([cc531a2](https://github.com/strange-bytes-lab/packui/commit/cc531a2732a03e37479dd3d86865ef52eb518bb3))
* widen the package drawer ([1cf2728](https://github.com/strange-bytes-lab/packui/commit/1cf272804c2a28639470adf90dbe8d35dbd487ef))


### Fixes

* keep the table header and toolbar in view while scrolling ([36d0cc7](https://github.com/strange-bytes-lab/packui/commit/36d0cc76448ab3f58b68ffd95e59e3c25262f0a0))


### Refactors

* lift the row status ranking out of StatusDot ([d499ecf](https://github.com/strange-bytes-lab/packui/commit/d499ecf97cae6f0b0f54c03b37532ee2cad6543d))


### Documentation

* point the readme at people installing packui, not building it ([962fa11](https://github.com/strange-bytes-lab/packui/commit/962fa11c4939bf426c4cec2508ed64aa75eb2c86))

## 0.1.0 (2026-09-15)


### Features

* batch upgrades, keyboard shortcuts and empty states ([a6cba1e](https://github.com/strange-bytes-lab/packui/commit/a6cba1e8a9a6a869d2eecc6404cd0d6159bbe0f6))
* dependency table UI ([caf4953](https://github.com/strange-bytes-lab/packui/commit/caf4953f2e3bae67ad1202ba3de297a159b459a9))
* enrich the table from the registry and OSV ([69df824](https://github.com/strange-bytes-lab/packui/commit/69df824395ae192bfe5eec67fe6b3e03c6cc7b78))
* gate package removal behind an impact check ([1a70dad](https://github.com/strange-bytes-lab/packui/commit/1a70dad97db9545e45883ba8f0d3694f6a4236cd))
* global packages, stable port, symlink-aware scanning ([517e6a5](https://github.com/strange-bytes-lab/packui/commit/517e6a51833fdfc64442541f6b7b984c88c02ab7))
* package detail drawer ([00de03b](https://github.com/strange-bytes-lab/packui/commit/00de03b7f350fd9d501d2a083d72c725694c0a93))
* read dependency state from the project on disk ([7eca5e0](https://github.com/strange-bytes-lab/packui/commit/7eca5e0648b90631baa3091ebab7d67c8f4892ab))
* run upgrades and removals, with rollback ([17904e5](https://github.com/strange-bytes-lab/packui/commit/17904e54979817dc9e8976dce5973d3a153b63f2))
* scaffold packui foundation ([5b42f37](https://github.com/strange-bytes-lab/packui/commit/5b42f379322f5018ebc6c4192c2c884f27c321f3))


### Fixes

* bind an ephemeral port in tests ([c331252](https://github.com/strange-bytes-lab/packui/commit/c33125220f33c24bf96e5c48c089de2766ac9d7a))
* close the gaps an attacker page in the browser could reach ([3d6ec62](https://github.com/strange-bytes-lab/packui/commit/3d6ec6240499dcc9fe79e95d786b5275ccb987e3))
* render readmes properly in the drawer ([a27621c](https://github.com/strange-bytes-lab/packui/commit/a27621cb5206445cb75b383b7ca26191b54f00cb))
* start the versioning at 0.1.0, not 1.0.0 ([ee5311d](https://github.com/strange-bytes-lab/packui/commit/ee5311d6368f9c17d7aa83e76321df8366331512))
* stop prettier fighting release-please over its own manifest ([f41c8c4](https://github.com/strange-bytes-lab/packui/commit/f41c8c4db2db92080de49b820de6eef3c27f106f))
* three correctness gaps in globals, enrichment and version comparison ([c1cdddd](https://github.com/strange-bytes-lab/packui/commit/c1cdddd64135af788115a25575d449095e277b97))


### Performance

* stop over-fetching from the registry and under-reusing the cache ([540ebc0](https://github.com/strange-bytes-lab/packui/commit/540ebc05cf2352c8bc7c68dbbc813bc374f68027))


### Documentation

* rewrite the readme for the first release, and record what changed ([34ef220](https://github.com/strange-bytes-lab/packui/commit/34ef220a27e8b3b66c4a9f7cf35447b3411ff296))


### Packaging

* go back to the [@strange-bytes](https://github.com/strange-bytes) scope ([f290931](https://github.com/strange-bytes-lab/packui/commit/f290931f9ea89330aa313a8189410b1a9a451ab2))
* make the package publishable ([bcc7883](https://github.com/strange-bytes-lab/packui/commit/bcc788345a8b2088d2e197987c28ff76bc5b4809))
* publish as packui, unscoped ([f43ce84](https://github.com/strange-bytes-lab/packui/commit/f43ce84ff101208cdc6b965b584929b7afc56e99))
* publish under the [@strange-bytes](https://github.com/strange-bytes) scope ([db95671](https://github.com/strange-bytes-lab/packui/commit/db956712166c4fc3cd13b1cabb458d38398a765f))
