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
   exit codes, the documented `--json` output shapes of the commands that offer
   one, and the documented JSON **input** shapes of the commands that read one
   from stdin or `--file` (today: `basou decision capture`). An input shape is a
   contract for the same reason an output shape is — something else produces it,
   and tightening what is accepted breaks that producer exactly as surely as
   dropping a field breaks a consumer. Accepting MORE is additive; accepting
   less is not.
2. **The `@basou/sdk` package** — its exported read-only API for reading a
   workspace's provenance.
3. **The `.basou/` on-disk format** — the durable file schemas (manifest,
   session, event, approval, task) and the JSON Schemas published alongside
   them.

Within a `1.x` line these surfaces change **only additively** — a new command,
a new optional flag, a new optional field, a new SDK export, an added field in a
`--json` payload. Removing or changing the meaning of anything on a guaranteed
surface is a breaking change and requires a major bump (`2.0`).

### `--version`: the first token is the contract, the rest is build identity

`basou --version` prints the semver version as its **first whitespace-delimited
token**, and that token is guaranteed. Everything after it identifies the build
— the commit it was compiled from, and that commit's date — and **may change at
any minor**, including gaining or losing fields.

The distinction is worth stating because the output is scraped: a release check
that reads the first token keeps working across `1.x`, and one that compares the
whole line to a bare version string does not. Compare the first token.

The build identity is there because a version number cannot answer the question
people actually ask when something behaves unexpectedly — *which* build is this.
Two builds of one version differ only by commit, and that is the case that has
actually gone unnoticed in practice.

### One carve-out: the import envelope version may move at a minor

`basou session import` and `basou import` require the envelope's
`schema_version` to equal exactly one value, published as the `const` in
`session-import.schema.json`. **That value may move within a `1.x` line**, and a
producer holding the previous one is refused.

This is stated rather than left to the general rule, because the general rule
would freeze it until `2.0` and that is not the intent. The envelope describes a
payload basou accepts at a boundary it does not write; when the durable formats
it carries narrow, the envelope narrows with them, and pinning the envelope's
version until a major would mean either a stale envelope accepting payloads the
importer can no longer store, or a major bump for a change nothing on disk
notices.

The carve-out is bounded by three things, and it is only defensible with all
three:

1. **The refusal is loud.** A wrong version is an immediate error naming the
   value received, the value expected and the artifact to read — never a
   silently dropped or partially imported payload.
2. **The version is discoverable at runtime.** `@basou/core` ships the artifact,
   so a producer can read the `const` from the installed package instead of
   hard-coding it. A producer that pins the value by hand has opted out of this.
3. **It applies to the envelope's own version only** — not to the CLI's flags,
   its exit codes, or any `--json` output shape, which stay under the additive
   rule above.

### Advisory surfacers: the command is guaranteed, the payload evolves

`basou review-gaps`, `basou decision gaps` and the opt-in review reminder of
`basou hook stop --require-review` are **advisory surfacers**: they answer "what
looks like it was missed", they write nothing, and they enforce nothing. They sit on the guaranteed CLI surface — the commands and their flags
stay under the additive rule — with one carve-out for the `--json` payload:

1. **The payload's field set and the meaning of its counts may change within a
   `1.x` line.** What a surfacer looks at is an ongoing judgement about what
   reads as a gap — a population boundary, a ground for excluding an entry, a
   caveat about what could not be read — and freezing today's answer to `2.0`
   would mean either never improving it or bumping the major to do so.
1b. **The same applies to `hook stop --require-review`'s firing condition.**
   What reads as "shipped without a review that covered it" is the same ongoing
   judgement — it has already moved once, from "a review record exists anywhere
   in the session" to "the last ship act was covered by one", because the first
   reading accepted a review recorded after the merge. The flag itself, its
   name, and its opt-in nature stay under the additive rule; what it looks at
   does not. It emits prose only, which §What is not guaranteed already exempts,
   so the self-describing requirement below does not reach it.
2. **What is guaranteed is that the payload stays self-describing.** Every
   boundary the run applied is reported in the payload itself (for instance
   `scope`), so a consumer reads the run's own account of what it checked rather
   than assuming last release's rule. A count never silently changes meaning
   while keeping its name: a ground that changes gets a new name.
3. **It applies to these commands' `--json` payloads only** — not to their
   existence, their flags, or their exit codes, which stay under the additive
   rule above.

A consumer that needs a frozen shape should read the store through
**`@basou/sdk`** and apply its own rule.

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
  stays at `0`. Seeing `schema_version: 0.x` on a `1.0`+ install is therefore
  expected and does not mean the format is unstable.
- A MINOR bump within format major 0 can still be breaking, and one has
  happened: `0.2.0` made `command_executed.duration_ms` nullable (see
  [schemas §7.3](schemas.md#73-extension-rules-additive-by-default-breaking-changes-are-gated)).
  So `0.x` does **not** by itself mean "nothing incompatible has changed since
  `0.1`". Read the minor.
- basou reads **format major 0**: it accepts any `0.x.y` `schema_version` and
  **gates** a higher / unknown major (`1.x.y`+) with an explicit "upgrade basou"
  error rather than a cryptic field-level parse failure. That gate is
  major-only, so it does not catch a breaking MINOR: a basou at 0.41.0 or
  earlier rejects a `0.2.0` event with a null `duration_ms` and drops the line,
  losing the whole event rather than reporting an upgrade. Hosts that share a
  store through `~/.basou/hosts.yaml` should therefore be upgraded together. Most durable records are
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

The same policy covers a field that becomes **required** on a documented JSON
input shape. It is warned about for at least one release first — the item is
still accepted and still written, and the full text of the eventual error goes
to stderr — before omitting it becomes an error. The warning release is not a
courtesy: it is what lets the eventual error be introduced without discarding
work that a caller has no cheap way to reproduce.

> Example: `"kind"` on `basou decision capture`. It was optional, and omitting
> it filed an unfinished direction as a settled decision that never resurfaced —
> a failure with no symptom. `0.47` warns on every omission and still writes the
> item; a later release makes it an error. Through the warning release an
> explicit `"kind"` is carried onto the event, so an item written WITHOUT a
> declared vessel stays distinguishable from one written with it. Events
> recorded before `0.47` predate that distinction: an absent `kind` there means
> only that nothing was recorded, not that nothing was declared.

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
