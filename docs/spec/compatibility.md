# Compatibility and stability

This document defines what basou commits to under [semantic
versioning](https://semver.org/), so that adopters know which surfaces they can
build on and which are still internal.

basou is **pre-1.0 today**. The `0.x` line is being driven toward a `1.0`
release aimed at broad adoption — the point at which the guarantees below are
formally committed. This document describes the policy that `1.0` freezes; it is
written before the freeze because parts of it (notably the on-disk format gate)
cannot be retrofitted onto an already-frozen contract.

## Guaranteed surfaces

At `1.0`, semantic versioning applies to exactly three surfaces:

1. **The `basou` CLI** — the set of commands and subcommands, their flags,
   exit codes, and the documented `--json` output shapes of the commands that
   offer one.
2. **The `@basou/sdk` package** — its exported read-only API for reading a
   workspace's provenance.
3. **The `.basou/` on-disk format** — the durable file schemas (manifest,
   session, event, approval, task) and the JSON Schemas published alongside
   them.

Within a `1.x` line these surfaces change **only additively** — a new command,
a new optional flag, a new optional field, a new SDK export, an added field in a
`--json` payload. Removing or changing the meaning of anything on a guaranteed
surface is a breaking change and requires a major bump (`2.0`).

## What is *not* guaranteed

- **`@basou/core` is published on npm but is not a semver-guaranteed API.**
  Core exists so the CLI and SDK can build on it and so advanced consumers can
  embed basou, but the bulk of its exports are CLI-internal planning helpers
  (for example the archive, gitignore, and retrofit planners) that would become
  a permanent constraint if frozen. Depend on **`@basou/sdk`** for a stable
  read API. A named subset of core may be promoted to the guaranteed surface in
  a future release; until then, treat core as internal.
- **The CLI's human-facing *prose* is presentation, not contract.** The
  orientation narrative, nudges, and other rendered prose may be refined at any
  time — do not scrape it. Machine consumers have two covered read paths
  instead: **`@basou/sdk`**, and the **`--json`** output of the commands that
  offer it (part of the guaranteed CLI surface above).

## On-disk format versioning

Each durable file carries a `schema_version` (the manifest additionally records
a `basou_version`). This tracks the **on-disk format major**, which is
**decoupled from the npm / product version**:

- Shipping product `1.0.0` does **not** bump the format major. The format major
  stays at `0` until the on-disk format itself changes incompatibly. Seeing
  `schema_version: 0.x` on a `1.0`+ install is therefore expected — it means the
  on-disk format has not changed incompatibly since `0.1`, not that the format
  is unstable.
- basou reads **format major 0**: it accepts any `0.x.y` `schema_version` and
  **gates** a higher / unknown major (`1.x.y`+) with an explicit "upgrade basou"
  error rather than a cryptic field-level parse failure. Most durable records are
  loose objects that preserve unknown fields, so a newer minor's additive fields
  survive a round-trip; a few event variants are intentionally strict (they
  reject unknown keys), so forward tolerance *within* major 0 is a design goal,
  not a blanket per-record guarantee.
- The published JSON Schemas for the durable formats carry the matching
  `pattern` (`^0\.\d+\.\d+$`) in place of an exact `const`, so a cross-language
  validator enforces the same major. (Cache schemas keep an exact `const` — see
  below.)

This gate behavior is itself part of the frozen format contract. It is defined
before the `1.0` freeze because a forward-compatible acceptor cannot be added
after the version is pinned to an exact literal — an old reader would already
reject anything it had not seen.

**Migration machinery is deliberately deferred.** Only the *gate* is frozen now;
the transform that would carry an old format major forward to a new one is
future work, to be introduced when the format first changes incompatibly.

**Caches are exempt.** Derived cache files are pinned to an exact literal version
and rebuilt on mismatch, so they are not part of the forward-compatible durable
contract.

## Deprecation policy

For the `0.x` line the CLI surface is already treated as frozen — commands and
flags are stable. When a flag becomes obsolete before `1.0`, it is **kept as a
deprecated no-op** (still accepted, prints a warning that it is now ignored)
rather than removed, so an existing script that passes the flag keeps working
instead of erroring on an unknown option. Deprecated no-op flags are removed at
`1.0`.

> Example: `basou init --repo-url` became a no-op when `project.repository_url`
> was removed from the manifest (a value nothing read and that drifted silently).
> The flag is accepted-and-ignored through `0.x` and dropped at `1.0`.

After `1.0`, removing or changing the meaning of any guaranteed-surface element
requires a major bump; additions within a line remain backward-compatible.

## Invariants that hold regardless of version

These are properties of the design, not of any particular release, and are not
expected to change across major versions:

- **Local-first and zero-network** — the workspace trail lives under `.basou/`
  next to your code; optional integrations may also write user-level files
  (`~/.claude/`, `~/.codex/`). Everything stays on-machine — nothing is sent
  off-machine.
- **Adopt, not rip** — adoption is non-destructive and reversible, and the
  adoption / wiring generators (`sync`, `adopt`, gitignore, symlinks) are
  dry-run-by-default.
- **Runtime does not depend on an LLM** — triggering and derivation use
  deterministic proxies only.
