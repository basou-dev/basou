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
surface is a breaking change and requires a major bump (`2.0`). The sections
below, and the extension rules of [schemas
§7.3](schemas.md#73-extension-rules-additive-by-default-breaking-changes-are-gated)
for the on-disk format, state the exceptions to that rule and what bounds each
of them.

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

### Exit codes: zero is success, and a failure's value may be refined

What an exit code guarantees is exactly this: **`0` means the command
succeeded, and any other value means it failed** — except for the two kinds of
command below, which follow their own rule. Every other command exits `1` on a
failure it reports, and a signal that ends it is reported the way a shell
reports any process a signal ends (`128` plus the signal's number) — except
that `basou view` and `basou refresh --watch` take `SIGINT` and `SIGTERM` as
the request to stop, and exit `0` on them. The `1` is not promised: a caller
that tests for exactly `1` may see another non-zero value within `1.x`.

**The hook handlers exit `0` once their command line parses.** `basou hook
stop` and `basou hook session-start` are run by an agent's hook runner, and a
hook that fails must not stop the agent, so once their arguments parse they
exit `0` whatever the payload, the transcript or the workspace, including when
they fail. Their outcome is not reported by their exit code. A command line
that does not parse (an unknown option, a missing value) exits `1` as on any
command, and a signal ends them as it ends any other process.

**`basou exec` and `basou run <adapter>` pass their child's exit code
through,** because a wrapper that changed it would break a script that
branches on the child's own values (`grep` exits `1` for no match and `2` for
an error, for instance).

- When the child exits with a code, basou exits with that code.
- When the child is ended by a signal, basou exits with `128` plus a signal's
  number: the signal basou itself received while the child ran, when one
  reached it, and otherwise the signal that ended the child. `basou exec
  --timeout` ends the child with `SIGTERM`, then `SIGKILL`. The number is
  exact for `SIGHUP`, `SIGINT`, `SIGQUIT`, `SIGKILL` and `SIGTERM`; any other
  signal gives a value above `128` that does not identify it.
- When basou itself fails, it exits `1` — including when it fails after the
  child has exited, so a child that exited `0` is then reported as `1`. A
  caller cannot tell a basou failure apart from a child that exited `1`, and
  should not read `1` as "the child ran and failed".

The non-zero values of every command except these four may be split within a
`1.x` line, so that a failure can say more than that it failed — for instance,
that a command refused its input before writing anything, so resending a
corrected input is safe. The carve-out is bounded by four things:

1. **A split never moves an invocation across zero.** It changes which non-zero
   value a failure exits with, never whether it exits `0`.
2. **A new value only divides a failure that already exists,** and is
   documented with the write state it leaves behind: whether the command had
   written anything, to the `.basou/` store or to any other file, before it
   stopped.
3. **Values are allocated once for the whole CLI.** A new value is between `2`
   and `125` — `126`, `127` and everything above `128` keep the meanings a
   shell gives them — and one value means the same thing on every command that
   uses it.
4. **It applies to the values of the exit code only** — not to the CLI's
   flags or to any `--json` output shape, which stay under the additive rule
   above.

One thing about stdout is left open: a failed command is not promised to print
nothing. A documented `--json` shape that a command prints when it exits
non-zero — `basou verify --json` reporting a tampered session, for instance —
stays under the additive rule like any other. Decide whether a command
succeeded from its exit code, not from whether it printed anything.

### `basou verify` verdicts may gain values on the failing side

The `status` and `reason` of a `basou verify --json` row may gain values within
a `1.x` line. The additive rule above names added fields, not added values, and
verify's set of verdicts has to grow as its checks do — signing will need one.
The carve-out is bounded by three things:

1. **A new `status` value always fails the command.** It exits non-zero and
   never means a session passed; `verified`, `unchained`, `empty`,
   `incomplete` and `in_progress` remain the only values that exit `0`.
2. **A new `reason` only refines an existing `status`,** and never changes
   whether that status fails the command.
3. **A consumer reads a value it does not know as not verified.** A consumer
   that switches exhaustively on `status` or `reason` should keep a branch for
   that.

`unsupported`, for a session a newer basou wrote, was added this way before
`1.0`. The row, its fields and today's values of both are listed in [schemas
§7.5](schemas.md#75-event-log-integrity-hash-chain--head-anchor).

### The import envelope version may move at a minor

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
   its exit codes, or any `--json` output shape, which stay under the rules
   above.

### The on-disk format may make its gated changes at a minor

[Schemas §7.3](schemas.md#73-extension-rules-additive-by-default-breaking-changes-are-gated)
allows two changes to a durable format only behind a version gate: widening a
required field's domain (making it nullable, or giving an enumerated field a
new value), and narrowing one to refuse a set that is empty. **Both may be made
within a `1.x` line,** under that gate.

This is stated rather than left to the general rule, because the general rule
would read "additive" from the side of a consumer of a shape, and what the
format guarantees is a different thing. Across `1.x`, a newer basou reads every
document an older one wrote, with the meaning it was written with. The reverse
is not guaranteed — forward tolerance is a design goal (see [On-disk format
versioning](#on-disk-format-versioning)) — and changes the extension rules
already allow without a gate lose lines in an older reader just as a widened
value does: a new event type, and a new optional field on an event variant
that rejects unknown keys, are both dropped by a basou that does not know them.
Forbidding only the gated changes would therefore not protect an older reader.
It would close the one route that ships a read rule.

The carve-out is bounded by five things, and it is only defensible with all
five:

1. **The format's version moves.** Its `schema_version` is bumped, its
   published `$id` moves with it, and the artifact the previous `$id` served is
   kept under `schemas/retired/`.
2. **A read rule that interprets a value is code, not only prose.** When the
   rule says how to read a stored value, rather than that nothing already
   stored changes, it has one implementation, exported from `@basou/core` and
   re-exported from `@basou/sdk`, as `readObservedDuration` is for
   `command_executed.duration_ms`.
3. **No value already on disk changes meaning.** A bump may only assign a
   meaning to a value the field could not hold before.
4. **The changelog says what an older reader does.** The change is listed as
   breaking to that format, and names the releases of basou that cannot read
   what it newly writes and what they do instead: skip the line or the
   document, or fail the command that reads it.
5. **It applies to the on-disk format, to the types `@basou/sdk` re-exports
   from it, and to a `--json` payload that prints stored values as they are
   stored** (`basou session show --json` prints a session's events, for
   instance) — not to the CLI's flags, its exit codes, the rest of any `--json`
   output shape, or the SDK's functions. A function whose signature names a
   format type (`readEvents` returns `Event[]`) carries the change through that
   type and is otherwise unchanged.

The consequences are accepted rather than avoided. A union type the SDK
re-exports from the format (the `change_type` of `FileChangedEvent`, for
instance) can gain a member at a minor, and a field can become nullable; a
consumer that checks such a type exhaustively should keep a branch for a value
it does not know. And a reader older than the basou that wrote a store skips or
fails on what it cannot read: keep `@basou/sdk` at least as new as the CLI that
writes the store it reads, and upgrade together every host that shares a store
through `~/.basou/hosts.yaml`.

### Advisory surfacers: the command is guaranteed, the payload evolves

`basou review-gaps` and `basou decision gaps` are **advisory surfacers**: they
answer "what looks like it was missed", they write nothing, and they enforce
nothing. They sit on the guaranteed CLI surface — the commands and their flags
stay under the additive rule — with one carve-out for the `--json` payload:

1. **The payload's field set and the meaning of its counts may change within a
   `1.x` line.** What a surfacer looks at is an ongoing judgement about what
   reads as a gap — a population boundary, a ground for excluding an entry, a
   caveat about what could not be read — and freezing today's answer to `2.0`
   would mean either never improving it or bumping the major to do so.
2. **What is guaranteed is that the payload stays self-describing.** Every
   boundary the run applied is reported in the payload itself (for instance
   `scope`), so a consumer reads the run's own account of what it checked rather
   than assuming last release's rule. A count never silently changes meaning
   while keeping its name: a ground that changes gets a new name.
3. **It applies to these commands' `--json` payloads only** — not to their
   existence, their flags, or their exit codes, which stay under the rules
   above.

A consumer that needs a frozen shape should read the store through
**`@basou/sdk`** and apply its own rule.

### Observed files: six properties are guaranteed, the attribution may improve

For an imported session, part of `session.yaml`'s `related_files` is observed
from git rather than read from the transcript ([schemas
§5.2](schemas.md#52-notes)). Deciding which of a repository's commits are the
session's own is an ongoing judgement that rests on how git records its
operations: which reflogs are read, which of git's reflog messages count as a
commit being created, the cases in which no limit is applied, and the limits
§5.2 lists. **That attribution may change within a `1.x` line.**

1. **What is guaranteed is the six properties §5.2 lists** — five things the
   observed files never contain and one thing they always do — and a change to
   the attribution keeps all six.
2. **A change to the attribution is listed in the changelog.** The stored list
   does not record which release derived it, so the changelog is the only
   place that says a list may differ because the rule changed rather than the
   work.
3. **It applies to the observed half of `related_files` only** — not to the
   paths taken from the transcript's own tool calls, not to `file_changed`
   events, and not to any other field of `session.yaml`.

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
  `0.1`". Read the minor. More such minors may follow within a `1.x` line of
  the product, under the bounds in [The on-disk format may make its gated
  changes at a minor](#the-on-disk-format-may-make-its-gated-changes-at-a-minor).
- basou reads **format major 0**: it accepts any `0.x.y` `schema_version` and
  **gates** a higher / unknown major (`1.x.y`+) with an explicit "upgrade basou"
  error rather than a cryptic field-level parse failure. That gate is
  major-only, so it does not catch a breaking MINOR: a basou at 0.41.0 or
  earlier rejects a `0.2.0` event with a null `duration_ms` and drops the line,
  losing the whole event rather than reporting an upgrade. Hosts that share a
  store through `~/.basou/hosts.yaml` should therefore be upgraded together.
  The manifest, task and approval records are loose objects that keep unknown
  fields when basou rewrites them, so a newer minor's additive fields survive
  that (`basou init --force` replaces the manifest rather than rewriting it).
  `session.yaml` is a loose object too, except `integrity`, which rejects a key
  it does not know and so makes the whole session unreadable. Adding a key to
  it therefore moves the session's `schema_version` (schemas §7.3), and a
  `basou verify` from `0.57.0` on reports such a session `unsupported` rather
  than tampered (`0.56.0` and earlier report it tampered). An imported
  session's `session.yaml` is rebuilt from its source whenever the source
  grows, keeping only `task_id` and `summary`, so a field a newer minor added
  does not survive a re-import.
  Events keep an unknown field only inside `approval_requested.action`, which
  passes it through. At the top level, a few event variants are intentionally
  strict and reject a line carrying a key they do not know, and every other
  variant accepts the line but drops the unknown field from what it reads —
  and a re-import writes the events it keeps from what it read. So forward
  tolerance *within* major 0 is a design goal, not a per-record guarantee.
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
input shape. Within a `1.x` line that is a breaking change and waits for
`2.0`; the path below is how it is introduced, at a major or before `1.0`. It
is warned about for at least one release first — the item is
still accepted and still written, and the full text of the eventual error goes
to stderr — before omitting it becomes an error. The warning release is a
chance to be told, not a guarantee of being told: a producer that upgrades
straight past it, or that never reads stderr, meets the error without having
seen the warning. So a producer should keep its input until the command exits
`0`. That rule rests only on the exit-code guarantee above, and so it holds
whether or not a warning ever reached the producer. A non-zero exit does not by
itself say that nothing was written.

> Example: `"kind"` on `basou decision capture`. It was optional, and omitting
> it filed an unfinished direction as a settled decision, which never enters the
> open-track list: the next decision takes its place, instead of it being held
> until closed — a failure with no symptom. `0.47.0` warned on every omission
> and still wrote the item; from `0.48.0`, released the next day, it is an
> error, and omitting it on ANY item refuses the whole batch. Through the
> warning release an explicit `"kind"` was carried onto the event, so an item
> written WITHOUT a declared vessel stays
> distinguishable from one written with it. Events recorded before `0.47`
> predate that distinction: an absent `kind` there means only that nothing was
> recorded, not that nothing was declared.

Refusing the whole batch, rather than writing the valid items and reporting the
rejected indices, is what keeps the success line honest: a partial write reports
success while holding fewer items than the caller handed over, which is the same
shape of silent miscount the requirement was introduced to remove. It also keeps
the rule consistent with every other validation this command performs — a
malformed field has always refused the batch. Every refusal ends by naming the
number of items NOT written, so it can never be read as a partial success, and a
missing `"kind"` names the offending indices — up to ten, with any remainder
collapsed into a stated count.

A field that becomes required on one command does not oblige every command that
writes the same event to grow the same requirement. `decision_recorded` has
three writers — the transcript importer, `basou decision capture` and `basou
decision record` — and only `capture` reads a JSON input shape. `record`'s
vessel is the `--track` flag, which has no way to state "explicitly not a
track"; the importer declares no vessel at all and cannot be given one. The
requirement therefore lands on the input shape. `record` instead names the
vessel it used on its receipt, which needs no new flag on a surface this line
treats as frozen.

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
