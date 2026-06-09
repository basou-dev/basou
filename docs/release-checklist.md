# Release checklist (maintainers)

This document is the maintainer-facing companion to
[CONTRIBUTING.md](../CONTRIBUTING.md) "Release flow". CONTRIBUTING.md
spells out the contributor-side steps that every release shares (land
`## Unreleased`, bump versions, tag); this file expands the publish
side that only maintainers run, plus the dry-run evidence that a
scoped `@basou/*` release is safe to push to the public registry.

Read this before running `pnpm -r publish --access public` on a new
release.

## Published releases

| Date       | Version | Packages                                  | Notes                                                                                                                            |
|------------|---------|-------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------|
| 2026-05-22 | 0.3.1   | `@basou/core`, `@basou/cli`, `@basou/sdk` | First public scoped release. Published in dependency order (core → cli → sdk); each `pnpm publish` re-authed via the npm web 2FA flow. Registry confirmed all three via `npm view @basou/<pkg> versions`. |
| 2026-05-27 | 0.4.0   | `@basou/core`, `@basou/cli`, `@basou/sdk` | Scoped release (no dedicated CHANGELOG section). |
| 2026-06-04 | 0.5.0   | `@basou/core`, `@basou/cli`, `@basou/sdk` | `basou stats` and the generated CLI command reference. |
| 2026-06-05 | 0.6.0   | `@basou/core`, `@basou/cli`, `@basou/sdk` | `@basou/sdk` read-only runtime API and shipped JSON Schema artifacts. |
| 2026-06-08 | 0.7.0   | `@basou/core`, `@basou/cli`, `@basou/sdk` | Multi-root capture and `basou refresh --watch`. |

## Pre-publish dry-run (verified 2026-05-22)

Run from `~/projects/basou` after a clean `pnpm -r build`. Each
command should exit 0 and print a `Tarball Contents` block. The file
set is no longer "five files for everyone": it grew as the packages
did, so compare against the most recent captured output below rather
than a fixed count. As of `0.6.0`:

- `@basou/sdk` — five files (`LICENSE`, `dist/index.{js,js.map,d.ts}`,
  `package.json`); now a real read-only runtime API rather than the
  `0.3.1` types-only placeholder.
- `@basou/cli` — eight files: the five above plus a second
  `dist/program.{js,js.map,d.ts}` entry point (the side-effect-free
  `@basou/cli/program` export added in `0.5.0`).
- `@basou/core` — thirteen files: the five above plus the eight
  `schemas/*.json` JSON Schema artifacts shipped under `./schemas/*`
  (added in `0.6.0`).

Since publishing is now done by the OIDC trusted-publisher workflow on
a `vX.Y.Z` tag push (`.github/workflows/release.yml`), this dry-run is
a pre-tag sanity check rather than the publish mechanism itself; the
manual `pnpm publish` procedure below remains the documented fallback.

```bash
pnpm -r build
pnpm --filter @basou/core publish --dry-run --access public --no-git-checks
pnpm --filter @basou/cli  publish --dry-run --access public --no-git-checks
pnpm --filter @basou/sdk  publish --dry-run --access public --no-git-checks
```

### Captured dry-run output (`0.3.1`)

| Package        | Tarball size | Unpacked size | Files | Notes                                  |
|----------------|--------------|---------------|-------|----------------------------------------|
| `@basou/core`  | 153.8 kB     | 659.5 kB      | 5     | dist/index.d.ts is 141 kB              |
| `@basou/cli`   |  87.3 kB     | 422.7 kB      | 5     | dist/index.d.ts is 13 B (re-export)    |
| `@basou/sdk`   |   4.8 kB     |  12.7 kB      | 5     | placeholder package, types-only        |

Per-file sizes (`npm notice` lines):

```
@basou/core@0.3.1
  LICENSE           11.4 kB
  dist/index.d.ts  141.1 kB
  dist/index.js    126.8 kB
  dist/index.js.map 379.1 kB
  package.json       1.1 kB

@basou/cli@0.3.1
  LICENSE           11.4 kB
  dist/index.d.ts    13 B
  dist/index.js    129.6 kB
  dist/index.js.map 280.7 kB
  package.json       1.1 kB

@basou/sdk@0.3.1
  LICENSE           11.4 kB
  dist/index.d.ts    74 B
  dist/index.js     114 B
  dist/index.js.map 153 B
  package.json     979 B
```

### Captured dry-run output (`0.6.0`, verified 2026-06-05)

| Package        | Package size | Unpacked size | Files | Notes                                            |
|----------------|--------------|---------------|-------|--------------------------------------------------|
| `@basou/core`  | 204.3 kB     | 930.6 kB      | 13    | dist (3) + 8 `schemas/*.json` + LICENSE + manifest |
| `@basou/cli`   | 266.7 kB     |   1.2 MB      | 8     | two entry points (`index` + `program`)           |
| `@basou/sdk`   |  12.5 kB     |  45.0 kB      | 5     | now a real runtime read API, not a placeholder   |

Per-file sizes (`npm notice` lines):

```
@basou/core@0.6.0
  LICENSE                          11.4 kB
  dist/index.d.ts                 165.0 kB
  dist/index.js                   161.5 kB
  dist/index.js.map               482.0 kB
  package.json                      1.5 kB
  schemas/approval.schema.json      3.4 kB
  schemas/event.schema.json        36.9 kB
  schemas/manifest.schema.json      3.7 kB
  schemas/session-import.schema.json 51.0 kB
  schemas/session.schema.json       7.1 kB
  schemas/status.schema.json        2.2 kB
  schemas/task-index.schema.json    2.1 kB
  schemas/task.schema.json          2.8 kB

@basou/cli@0.6.0
  LICENSE            11.4 kB
  dist/index.d.ts      13 B
  dist/index.js     194.7 kB
  dist/index.js.map 404.9 kB
  dist/program.d.ts   590 B
  dist/program.js   194.5 kB
  dist/program.js.map 403.6 kB
  package.json        1.3 kB

@basou/sdk@0.6.0
  LICENSE            11.4 kB
  dist/index.d.ts     7.9 kB
  dist/index.js       5.5 kB
  dist/index.js.map  19.0 kB
  package.json        1.2 kB
```

If any number diverges by more than ~10% on a future release without
an obvious reason (a new source file, a removed entry point), inspect
the tarball before publishing.

## Tarball content verification

`pnpm pack --pack-destination /tmp` produces the same tarball npm
would publish without uploading it. Use this for a final
unpack-and-grep before pushing the real publish:

```bash
cd packages/core && pnpm pack --pack-destination /tmp && cd ../..
cd packages/cli  && pnpm pack --pack-destination /tmp && cd ../..
cd packages/sdk  && pnpm pack --pack-destination /tmp && cd ../..

for pkg in core cli sdk; do
  echo "=== @basou/$pkg ==="
  tar -tzf /tmp/basou-$pkg-0.3.1.tgz
done
```

Expected output per package (file order varies):

```
package/dist/index.js
package/package.json
package/dist/index.js.map
package/dist/index.d.ts
package/LICENSE
```

### Leak scan

After packing, scan each tarball for absolute paths and any other
class of string that should never reach the public registry:

```bash
for pkg in core cli sdk; do
  echo "=== @basou/$pkg leak scan ==="
  tar -xzOf /tmp/basou-$pkg-0.3.1.tgz \
    | grep -oE '/Users/[a-zA-Z][a-zA-Z0-9_-]+' | sort -u
done
```

On the `0.3.1` verification run, the only matches were the deliberate
`/Users/u` (and `/Users/<u>`) placeholders inside the path-sanitizer
JSDoc — `u` is a fake username chosen so the example reads naturally,
not a real home directory. The sourcemaps use relative paths
(`../src/...`) for their `sources` array. There are no real absolute
paths embedded in any of the three tarballs.

If a future scan returns a match other than the `u` placeholder, the
relevant source comment or sourcemap is leaking a real path and the
publish should stop until that's fixed.

## Publish procedure

1. **Pre-checks (CONTRIBUTING.md Release flow Steps 1-7 must be
   green):** `## Unreleased` items merged, version bumped in all
   three `packages/*/package.json`, `pnpm install` updated the lock,
   `pnpm -r build && pnpm typecheck && pnpm test && pnpm lint` all
   green, release commit + annotated tag landed on `main`.
2. **Login to npm** as the `@basou` org publisher:
   ```bash
   npm whoami       # confirm the right account
   npm org ls basou # confirm publish permission
   ```
3. **Dry-run again from the tagged HEAD** (Pre-publish dry-run block
   above). This must succeed on the exact commit you intend to ship.
4. **Publish in dependency order** — `@basou/core` first because the
   other two import its types:
   ```bash
   pnpm --filter @basou/core publish --access public
   pnpm --filter @basou/cli  publish --access public
   pnpm --filter @basou/sdk  publish --access public
   ```
   `pnpm -r publish --access public` runs the three in parallel; that
   is fine once the dependency direction has stabilized, but the
   explicit ordering above is safer for a first publish or after any
   peerDependencies change.
5. **Verify on registry:**
   ```bash
   npm view @basou/core versions
   npm view @basou/cli  versions
   npm view @basou/sdk  versions
   ```
   Each should now list the just-published version as the latest.
6. **Push the annotated tag** to the GitHub remote *after* npm
   confirms the publish — that way a publish failure does not leave a
   dangling release tag on the public repo.

## Rollback procedure

npm allows unpublishing within 72 hours of the original publish; past
that window only `npm deprecate` is available.

- **Same-day, broken tarball:**
  ```bash
  npm unpublish @basou/<pkg>@<version>
  ```
  Then fix forward, bump to the next patch version, and re-publish.
  Do not re-use a published version number.
- **After the 72h window:**
  ```bash
  npm deprecate @basou/<pkg>@<version> "Use @basou/<pkg>@<newer> — <reason>"
  ```
  Add a hot-fix entry to `CHANGELOG.md` explaining the deprecation
  and the recommended upgrade path.
- **Tag cleanup:** if the corresponding `vX.Y.Z` tag was already
  pushed to GitHub, leave the tag in place and document the failed
  publish in `CHANGELOG.md`. Force-deleting a public tag breaks
  anyone who already fetched it.
