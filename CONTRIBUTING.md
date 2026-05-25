# Contributing to Basou

Thanks for your interest in Basou! Basou is in early pre-OSS stage —
the v0.3.x line is dogfood-ready, the public APIs are still in flux,
and we're collecting feedback from a small set of trial users before
opening contributions broadly. This document describes how to set up
the project, the change conventions we follow, and the easiest way to
report problems while we're in this state.

## Reporting issues / friction

The fastest path right now is to open an issue on
[github.com/basou-dev/basou/issues](https://github.com/basou-dev/basou/issues)
using one of the templates:

- **Bug report** — when the CLI errors out, prints something
  surprising, or `pnpm test` fails on a fresh checkout. Please run
  through the
  [Quickstart sanity-check checklist](https://basou.dev/quickstart/#sanity-check-checklist)
  first — if any of those four lines fails, mention which one in
  the issue title.
- **Feature request / UX friction** — when something *works* but is
  unintuitive (e.g. `basou status` printed a confusing label, a
  spec section is missing, a command spelling surprised you).

Security-sensitive issues should *not* go through the public tracker
— see [Security policy](#security-policy) below.

## Development setup

```bash
git clone https://github.com/basou-dev/basou.git
cd basou
pnpm install
pnpm -r build
pnpm test       # all green at HEAD; baseline noted in CHANGELOG.md
```

Prerequisites:

- Node.js **>= 20.10.0** (`engines.node` in the root `package.json`)
- pnpm **>= 8.15.0**
- Git

After the first build, `pnpm --filter @basou/cli link --global`
exposes a `basou` binary on your `$PATH`. The
[quickstart](https://basou.dev/quickstart/) walks through the rest
end-to-end.

## Coding conventions

- **TypeScript with `strict: true`**. We use `unknown` + type
  guards rather than `any`; `enum` is avoided in favour of union
  literals; `interface` is avoided in favour of `type` for
  consistency.
- **ESM throughout**. Relative imports end in `.js` (per the
  TypeScript ESM contract); external packages are imported without
  an extension.
- **Named exports only** (the CLI entry point is the only
  default-export exception).
- **`pnpm lint`** (= biome) is the source of truth for formatting
  and lint; `pnpm typecheck` for types. Both must pass on every
  pull request.
- **`pnpm test`** (= vitest) runs each package's suite; new
  features land with tests in the same commit.
- **Error messages stay pathless on the CLI surface.** v0.1
  established a "no absolute paths in stderr" contract; v0.3
  added a workspace-write-time path sanitizer that follows the same
  principle. See [docs/spec/](docs/spec/) for the full rules.

## Commits and pull requests

- **English-only convention**: Commit messages (subject + body), pull
  request titles and descriptions, issue text, GitHub Discussions, and
  the bundled `.github/` issue / PR templates are all written in
  English. This follows the project's OSS global accessibility stance —
  English as a lingua franca for global contributors and users — and is
  not exclusion of any specific language. The same convention applies
  to comments inside `.github/workflows/*`. The one exception is the
  `AGENTS.md` symlink at the repository root: its target lives in the
  internal planning repository, is git-ignored from this repository, so
  it follows that repository's language conventions (Japanese) rather
  than this one.
- **Commit prefix**: `basou:` for source / behaviour changes, `docs:`
  for documentation. Body explains the *why*, not just the *what*.
- **One commit, one topic**. Avoid bundling unrelated fixes.
- **CHANGELOG.md** entries live in the `## Unreleased` section;
  promote to a versioned section as part of the release commit.
- **Pull request titles** should be a single declarative sentence
  ("Fix Lock-is-held message wording" rather than "WIP"). The PR
  body uses the template that auto-populates from
  `.github/PULL_REQUEST_TEMPLATE.md`.
- We do **not** sign commits in this repo today. AGENTS.md tooling
  may attach a Co-Authored-By trailer; that's expected and stays.

### Branching

- `main` is the only long-lived branch.
- Topic branches use `<area>/<short-slug>` (e.g.
  `cli/session-start-label`, `docs/quickstart-sanitize-note`).
- Force-push is allowed on your own topic branch before review;
  never on `main`.

### Tests for new code

- **CLI subcommands**: add an integration test in
  `packages/cli/src/commands/<name>.test.ts` that exercises the
  happy path plus at least one failure mode.
- **Core APIs**: unit-test in
  `packages/core/src/.../*.test.ts` next to the implementation. The
  storage layer in particular has a per-file test fixture pattern
  we ask new code to follow.
- **Schema changes**: round-trip the new shape through its
  `*.schema.test.ts` file with a positive and a strict-mode
  rejection case.

If you're unsure what tests to write, open a draft PR — we'd rather
discuss the test plan than have you guess.

## Release flow (for maintainers)

1. Land all `## Unreleased` items on `main`.
2. Promote the section header (`## Unreleased` → `## X.Y.Z —
   YYYY-MM-DD`).
3. Bump `version` in `packages/cli/package.json`,
   `packages/core/package.json`, `packages/sdk/package.json`.
4. `pnpm install` (refreshes `pnpm-lock.yaml`), then `pnpm -r
   build && pnpm typecheck && pnpm test && pnpm lint`.
5. Commit as `basou: Release vX.Y.Z (<headline>)`.
6. `git tag -a vX.Y.Z -m "..."` with a short summary.
7. Push the branch and the tag.
8. (Once npm publish is enabled:) `pnpm -r publish --access public`.
   See [docs/release-checklist.md](docs/release-checklist.md) for the
   dry-run + tarball verification step that should run before this.

## Security policy

If you find an issue that allows leaking machine-private paths,
secrets, or local-file contents into `.basou/` — or any other
class of issue that has security implications — please *do not*
open a public issue. Instead, report it privately via GitHub
Security Advisories
(<https://github.com/basou-dev/basou/security/advisories/new>) or
by mailing hello@basou.dev. Acknowledgement within 3 business
days is the goal.

## Code of Conduct

This project adopts the
[Contributor Covenant 2.1](CODE_OF_CONDUCT.md). By participating
you agree to abide by its terms.

## License

By contributing you agree that your contributions will be licensed
under the [Apache 2.0 license](LICENSE) that covers this project.
