# Schemas: manifest, session, event

This document describes the three core schemas: the workspace manifest, the
session document, and the basou event format.

## §4.1 `.basou/manifest.yaml` minimal schema

```yaml
schema_version: "0.1.0"
basou_version: "0.1.0"

workspace:
  id: "ws_01HXABCDEF1234567890ABCDE"
  name: "client-foo-lp"
  created_at: "2026-05-04T09:00:00+09:00"
  updated_at: "2026-05-04T15:30:00+09:00"

project:
  name: "Client Foo Landing Page"
  description: "Landing-page redesign for client foo"

capabilities:
  enabled:
    - core
    - claude-code-adapter
    - terminal-recording
    - git-capability
    - approval

approval:
  required_for:
    - destructive_command
    - external_send  # reserved; detection may be limited
  default_risk_level: medium

adapters:
  claude-code:
    enabled: true
    config_path: ".basou/adapters/claude-code.yaml"  # optional

git:
  events_log: ignore  # default. opt-in to commit.

channels:
  codex: false  # RETIRED — parsed for compatibility, has no effect (see §4.2)

policies:
  confidential: false  # default. a posture: this workspace's provenance must not
                       # persist where another workspace's tool reads it (see §4.2)
```

## §4.2 Notes

- `approval.required_for` includes `external_send` as reserved because
  detection is currently limited.
- `capabilities.enabled` is heterogeneous in granularity; it is kept as-is
  for now and may be normalized in a later release.
- The schema reserves room for `providers:` / `teams:` / `review_flows:` to
  extend in the future (currently unused). `policies:` was reserved for the
  same purpose and is now in use (below).
- `channels.codex` is **retired** and ignored. Until 0.39 it opted the
  workspace into rendering its orientation into a **user-global context face**
  — `~/.codex/AGENTS.md`, a file Codex auto-loads at startup for every project
  on the machine — so whatever one workspace wrote there sat in the context of
  every other workspace's next session. Nothing renders into that file any
  more. A Codex session receives the workspace's position from Codex's
  **SessionStart hook** (`basou hook install codex`, a one-time, user-global
  registration): Codex runs the hook when a session starts and passes the
  session's own `cwd`; basou resolves the workspace from that `cwd` and prints
  its position, which Codex adds to that session's context. The position is
  computed at that moment and stored nowhere, so one hook serves every
  workspace while no workspace's position is ever written where another
  workspace's session reads it. The key stays parsed so an existing manifest
  keeps loading, and `basou refresh` says once that it is ignored; `basou
  channel clear codex` removes a block an older basou left in the face.
- `policies.confidential` states a goal: this workspace's provenance must not
  persist where another workspace's tool reads it. The one writer it gated —
  the retired orientation render — is gone, so today it gates nothing; basou
  has no per-workspace path that writes a position anywhere another
  workspace's tool reads. The key is kept and honoured as a declaration: a
  future writer to a shared surface must consult it before it ships. It does
  not govern `basou protocol sync` (a global render of operator-authored
  protocols, not a per-workspace one). A top-level `confidential` is still
  **rejected**, not ignored: a safety key that is not honoured must fail loudly.

---

## §5.1 `session.yaml` minimal schema

```yaml
schema_version: "0.1.0"

session:
  id: "ses_01HXABCDEF1234567890ABCDE"
  label: "2026-05-04 morning claude-code"
  task_id: "task_01HXTASKID..."  # may be null
  workspace_id: "ws_01HXWS..."

  source:
    kind: "claude-code-adapter"  # or "claude-code-import", "codex-import", "human", "import", "terminal"
    version: "0.1.0"

  started_at: "2026-05-04T09:00:00+09:00"
  ended_at: "2026-05-04T11:30:00+09:00"

  status: "completed"  # see terminal-and-import.md for the lifecycle

  working_directory: "~/projects/client-foo"  # sanitized — see §5.2

  invocation:
    command: "claude-code"  # the executable name that was actually spawned
    args: []
    exit_code: 0

  related_files: []  # populated from git capability at session end; empty initially

  events_log: "events.jsonl"  # relative path

  summary: null  # optional; generated or hand-written later

  # optional model-usage rollup, computed at import from the source tool's
  # native token usage. All fields optional; reasoning_output_tokens is
  # Codex-only; absent for live run/exec and pre-feature imports.
  metrics:
    output_tokens: 5000
    input_tokens: 20000
    cached_input_tokens: 5504
    reasoning_output_tokens: 462

  # optional tamper-evidence head anchor, written only by the import paths
  # (fresh import and in-place re-import) together with the per-line hash
  # chain in events.jsonl — see "Event-log integrity" below. Absent on live /
  # ad-hoc / pre-feature sessions.
  integrity:
    head_hash: "9f2c...64 hex chars...ab10"  # sha-256 of the last event line
    event_count: 42
```

## §5.2 Notes

- `invocation.command` must record the **actual spawned executable name**.
  Claude Code may resolve to `claude-code` or `claude` depending on the
  environment, so the resolved command name is stored.
- `related_files` is populated from the git capability at session end. The
  initial value is an empty array.
- For an IMPORTED session, `related_files` has two sources, unioned: the file
  paths named by the transcript's own editing tool calls, and the files git
  reports as changed since the session started. The second source exists
  because a session that edits through the shell (a heredoc, a `sed -i`, a
  script) names no path anywhere in its transcript, and would otherwise be
  recorded as having touched nothing. The observation is accumulated by
  basou's SessionStart / Stop hooks into
  `.basou/tmp/observations/<external_id>.json` — working state, not a record,
  consumed by the import.
- The observed half joins `related_files` ONLY; it produces no `file_changed`
  event. An observation is a snapshot each pass recomputes (a file changed and
  then reverted leaves it), while the event stream is append-only and a
  re-import preserves every event it did not derive. `related_files` is rebuilt
  from the fresh derivation on every import, which is the same shape the
  observation has. A reader that needs to know a file was WITNESSED being
  edited, rather than observed as a difference, reads the `file_changed` events,
  which still come only from tool calls.
- `working_directory` and `related_files[]` are path-sanitized on write so
  no operator-private absolute prefix leaks into the workspace's persistent
  state. The sanitizer applies two rules in order:
    1. paths under the session's working_directory are rewritten relative
       to it (e.g. `<wd>/src/x.ts` → `src/x.ts`)
    2. paths under the operator's homedir are rewritten with a `~/` prefix
       (e.g. `/Users/<user>/projects/foo/x.ts` → `~/projects/foo/x.ts`)
  System paths outside both (e.g. `/etc/...`) are preserved as-is so an
  operator that deliberately recorded a system file path is not redacted
  by surprise. A null byte in the input is rejected with `Invalid path:
  contains null byte`. A backslash is kept as part of the name: basou
  targets macOS / Linux, where it is an ordinary filename character, so
  `back\slash.txt` is stored as `back\slash.txt` and not as
  `back/slash.txt` (a different file). A Windows-style path is not
  translated; full Windows support is a future task. Only POSIX paths are
  recognised against the two bases: a path written with backslash
  separators (`C:\Users\<user>\...`, `\Users\<user>\...`) is neither made
  relative nor shortened, so a producer that feeds such paths to
  `basou session import` persists them as given, prefix included.
- `working_directory` is sanitized via a sentinel-based variant that skips
  rule (1) when applied to the field's own value — feeding the live cwd
  through the general sanitizer with itself as the workingDirectory
  argument would collapse the result to `"."` and lose homedir context.
  In practice this means a session whose cwd is `/Users/<user>/projects/foo`
  writes `working_directory: "~/projects/foo"` rather than `"."`.
- `basou session import` applies the same sanitizer to the incoming JSON
  and emits a single-line `Imported session: N path(s) sanitized
  (related_files: K, working_directory: 0|1)` warning to stderr (via
  `console.error`) when at least one mutation occurred. The import itself
  succeeds; the warning is informational and fires for `--dry-run` too
  so the operator can preview a rewrite before committing.
- Backward compatibility: existing session.yaml files written before the
  path sanitizer was introduced are NOT retroactively rewritten. A future
  release may introduce `basou session migrate` to sanitize existing data
  on request. Records written while the sanitizer still folded backslashes
  may spell a name that contains one with `/` instead (`back/slash.txt`
  for `back\slash.txt`), and keep that spelling until they are rebuilt: a
  `basou run` session never is, and an imported one is rebuilt when it is
  re-imported. A reader must not treat two paths as the same file by
  replacing one separator with the other -- on macOS / Linux they can be
  two different files -- and an exact-string count across sessions is not
  a count of distinct files.

---

## §7.1 Common event fields

```json
{
  "schema_version": "0.2.0",
  "type": "<event_type>",
  "id": "evt_01HXEVTID...",
  "session_id": "ses_01HXSESSID...",
  "occurred_at": "2026-05-04T09:00:00+09:00",
  "source": "<source>"
}
```

Every event carries a `session_id` (see [Workspace, sessions, tasks, IDs
§2.2](workspace.md#22-every-event-is-bound-to-a-session)).

Events written by the import paths additionally carry an optional top-level
`prev_hash` (hex sha-256) — the tamper-evidence back-pointer described in
"Event-log integrity" below. Live / ad-hoc writers omit it.

## §7.2 Event catalog

| Category | event type | Description |
|---|---|---|
| Session | `session_started` | session start |
| Session | `session_ended` | session end |
| Session | `session_status_changed` | status transition |
| Approval | `approval_requested` | approval requested |
| Approval | `approval_approved` | approval granted |
| Approval | `approval_rejected` | approval rejected |
| Approval | `approval_expired` | approval expired |
| Command | `command_executed` | terminal command execution |
| Git | `git_snapshot` | git state at session start / end |
| File | `file_changed` | file change |
| Decision | `decision_recorded` | explicit decision record |
| Task | `task_created` | task created |
| Task | `task_status_changed` | task status transition |
| Task | `task_reconciled` | broken-reference repair record. Added in v0.2; emitted by `basou task reconcile --write`. |
| Task | `task_linkage_refreshed` | `linked_sessions[]` snapshot refresh from events.jsonl/session.yaml. Added in v0.2; emitted by `basou task refresh-linkage --write`; independent from `task_reconciled` (forward sync, not broken-ref repair). |
| Task | `task_deleted` | task.md hard-delete record. Added in v0.2; emitted by `basou task delete --yes`; no tombstone, so the event payload (`task_id` + final `title`) is the only persistent record. |
| Task | `task_archived` | task.md moved to `.basou/tasks/archive/<id>.md`. Added in v0.2; emitted by `basou task archive --yes`; the task survives at the new path, so the event session's `task_id` is pinned. |
| Note | `note_added` | human-added note |
| Review | `review_recorded` | self-reported record that an adversarial / second-opinion review ran. Emitted by `basou review record`. `reviewer` + `target` are required; `repos` (the repository paths reviewed) is what lets `basou review-gaps` bind the record to a unit of work, since the record itself lands in the planning repo. |
| Adapter | `adapter_output` | adapter output (summary only; raw kept separately) |

## §7.3 Extension rules (additive by default; breaking changes are gated)

- New event types may be added. For an existing type, adding a required field,
  removing one, or narrowing one's domain is forbidden. Two exceptions are
  gated rather than forbidden: widening a required field's domain (the third
  rule below), and narrowing one that no writer has ever exercised (the rule
  immediately after it).
- Adding optional fields to existing types is allowed.
- Widening a required field's domain (e.g. making it nullable) is a BREAKING
  change to the event format. From 0.2.0 onward it requires a `schema_version`
  bump and a stated read rule, because a reader cannot otherwise tell which
  convention a stored value follows.

  This rule postdates one widening it would have caught. 0.38.0 made
  `command_executed.command` and `cwd` nullable with no bump, so a `0.1.0`
  event does not say whether a `command` of `"bash"` was observed or was the
  fabricated default an earlier basou wrote. **Read rule for that one:** on a
  `0.1.0` event, a non-null `command` / `cwd` is only as trustworthy as the
  `source` field makes it — the `claude-code-import` adapter fabricated `bash`
  before 0.38.0. That ambiguity is on disk permanently and is the reason this
  rule exists.

- **Narrowing a required field's domain is allowed only when the set it starts
  refusing is EMPTY, and the bump still requires a `schema_version` move and a
  stated read rule.** Narrowing is otherwise forbidden for a concrete reason:
  every line read from disk is validated, and a violation is DROPPED with a
  `schema_violation` warning, so a narrowing that catches real documents
  destroys traces rather than reporting them.

  **"Empty" means empty BY CONSTRUCTION wherever basou is the writer**: no code
  path in this repository can emit the refused value, which is a property a
  test can assert and a reader can re-check years later. A count of what
  happens to be on one operator's disk is not that property — it is evidence
  about one store, and the store that matters may be someone else's.

  **Where basou is NOT the writer**, construction-emptiness is unavailable and
  a measurement is the only evidence there is. Then all of the following are
  required, and a narrowing that cannot supply them does not qualify:

  1. the population must be NAMED and its size stated in the read rule, so a
     later reader can judge what the measurement covered and what it did not;
  2. the measurement must be taken UPSTREAM of any normalizer, on raw producer
     input — measuring after a normalizer returns empty because of the
     normalizer, which is evidence about basou's own repair, not about what
     producers write;
  3. a normalizer must be installed at that boundary, so a producer that later
     starts writing the refused form is brought into the accepted set rather
     than dropped;
  4. and the refusal path at that boundary must be known and stated. A boundary
     that THROWS rather than dropping one line is worse than the case this rule
     was written for, and a narrowing must not land there until the throw is
     accounted for.

  A narrowing that is merely believed to be rare never qualifies under either
  branch.

  **Rebuildable caches are outside this rule**, because it is a rule about
  documents that outlive a change. A cache (`status.json`, `task-index.json`)
  carries a `CacheVersionSchema` version and is matched exactly or re-derived,
  so narrowing its shape refuses nothing that survives: the next read rebuilds
  it. Their `$id` therefore does not move when a shared constraint narrows, and
  their previous bytes are not archived. Everything durable is inside the rule.

  **Worked example — timestamps require seconds (event `0.3.0`, and `0.2.0` for
  every other durable document).** The accepted shape had made seconds
  optional, inherited from the expression zod emitted for
  `.datetime({ offset: true })` rather than chosen.

  *Where basou is the writer* — `event`, `session`, `task`, `manifest` — the
  refused set is empty by construction: every durable timestamp is either
  `Date.prototype.toISOString()` output, which always emits seconds, or a CLI
  option already validated to require them (`--completed-at`). No code path in
  this repository can emit a seconds-less value. The counts measured before the
  bump (39,070 timestamps across one store's `events.jsonl`, `session.yaml`,
  tasks and manifest, all carrying seconds) agree with that, and are recorded as
  corroboration rather than as the evidence.

  *Where basou is not the writer* there are two boundaries, and they are not
  alike:

  - **Adapter imports** (`claude-code`, `codex`) read a vendor's `timestamp`
    string. Population: the rollout and transcript logs both adapters read,
    226,077 values measured upstream of any normalizer — the normalizer was
    added in the same change and the measurement predates it. All carried
    seconds. Refusal path: an event line failing validation is dropped with a
    `schema_violation` warning. Normalizer: `normalizeIsoTimestamp`, at both
    read sites.
  - **Approvals** are placed by an outside orchestrator; basou only reads them.
    Population: **zero documents** in the measured store — which is not evidence
    that producers agree, only that this store has none, and the read rule says
    so rather than presenting an empty directory as a clean measurement.
    Refusal path: `loadApproval` THROWS rather than dropping, and neither the
    orientation nor the report renderer catches it, so one refused document
    takes both commands down. That is the case clause 4 above says a narrowing
    must not land on unaccounted-for; it is accounted for here by normalizing
    the three timestamp fields at the read boundary before the document is
    parsed, so the seconds axis cannot reach the throw.

  **Read rule:** a document at the earlier version means exactly what it meant.
  Nothing on disk is reinterpreted, and nothing is rewritten in place. The only
  change is what a writer may newly produce, and what an outside producer's
  value is repaired to before it is parsed.

- Redefining a value that already exists on disk is forbidden: it must keep
  meaning what it meant (introduce a new type or a new field instead). A bump
  may only ASSIGN a meaning to a value the field could not hold before. The
  0.2.0 bump below is the worked example: `null` is the newly possible value
  and gets the new meaning, while `0` keeps the "not observed" meaning it
  already had — which is why that bump needs no per-version read branch.
- When `schema_version` is bumped, the change must ship a **read rule** — how a
  reader interprets documents written under the previous version — implemented
  once in code, not only in prose. A migration script is the exception, not the
  rule, and is required only when a bump cannot be expressed as a read rule.

  Documents are never rewritten IN PLACE by a migration: that would break the
  tamper-evidence chain (§8). They are, however, re-derived — `reimportPreservingId`
  rewrites a session's `events.jsonl` and `session.yaml` atomically, with fresh
  content and a fresh chain, whenever its source log has grown. So a stored
  value can be replaced by re-derivation from the source, and cannot be
  replaced by editing what is on disk. Neither path can recover what a source
  never reported.
- `schema_version` is per document, not workspace-wide, and so is each
  published schema's `$id` version. Bumping one format must not move the `$id`
  of the formats that did not change, and a document's `$id` version always
  equals the `schema_version` its writers stamp.

  **The `$id` version tracks the format a document describes, not the byte
  revision of the artifact that describes it.** Within one version an artifact
  may be re-published with a more faithful description of the same format — an
  added `description`, a constraint the runtime already enforced, or the
  REMOVAL of a declaration the runtime never enforced — and that is not a
  format change, so it does not move the `$id`.

  **The test is two-directional, and both halves are required:** no document
  that validated before may now fail, AND no document that failed before may
  now validate. One half alone is useless for a removal — dropping a keyword
  can only widen what validates, so "everything that passed still passes" is
  satisfied by removing `pattern`, `required`, `enum` or `const`, and would
  license any of them. What actually gates a removal is the other half,
  together with "never enforced": the runtime must already have been answering
  as though the keyword were absent, so that nothing which the runtime refused
  now passes.

  A keyword the runtime never consulted but some CONSUMER might is the hard
  case, and it does not pass this test. `format` is the example: under a
  validator that asserts formats, removing it grows the accepted set by exactly
  the values the format excluded, so a third party gets a different answer than
  before even though basou's own reader does not. Such a removal is a format
  change and moves the `$id`. The carve-out covers a declaration that no
  validator could have been enforcing differently from the rest of the
  artifact — not one whose enforcement merely varies by validator. `session-import`
  pinning its `schema_version` to a `const` is such a case: the set of payloads
  the importer accepts is exactly what it always was.

  One consequence of that rule was accepted rather than resolved, and it has
  since expired. `session-import.schema.json` embeds the event union, so its
  published bytes changed with the 0.2.0 event while its own `$id` stayed at
  `0.1.0` — its envelope format had not changed, and moving the `$id` would
  have been dishonest. For that window a consumer holding the earlier bytes of
  that URL would reject a payload basou wrote, with no version signal that
  anything moved.

  The timestamp narrowing ended the window, because it reached the envelope's
  OWN fields — `session.started_at`, `session.ended_at`, and both
  `active_intervals` bounds — rather than only the union it embeds. So the
  envelope's accepted set did move, its `$id` is `0.2.0`, and its importer
  requires `schema_version: "0.2.0"`. The distinction is worth keeping: bytes
  changing because of an embedded format is not a reason to move a `$id`; the
  envelope's own accepted set changing is. Consumers that need the current
  bytes should still read the artifact from the installed `@basou/core` rather
  than caching the URL.

### Timestamps require seconds — event `0.3.0`, every other durable document `0.2.0`

The narrowing, its measurement and its read rule are stated as the worked
example in §7.3 above. What it moved: `event` to `0.3.0` (it had already moved
once, for `duration_ms`), and `manifest`, `session`, `task`, `approval` and
`session-import` to `0.2.0`. `status` and `task-index` did NOT move — they are
rebuildable caches, matched exactly or re-derived, so no stored document
outlives a change to their shape.

### Event `schema_version` 0.2.0 — `command_executed.duration_ms`

Events written between that release and the timestamp narrowing carry
`schema_version: "0.2.0"`, and every other `.basou/` document stayed at
`0.1.0`, because those formats had not changed yet.

`duration_ms` became nullable, joining `command`, `cwd` and `exit_code` under
one rule: **null means basou did not observe the value.** Widening a required
field's domain is a breaking change to the format, which is what the bump
records.

**The bump does not change what any value already on disk means.** `0` meant
"not observed" before it and still does. What changed is that a writer now says
so with `null` instead of storing the floor, and **a writer at 0.2.0 or above
never writes `0`**.

So the read rule carries no version branch:

> **Read `duration_ms` as unobserved when it is `null` or `0`, on any version.**

That rule has exactly one implementation, `readObservedDuration(event)` in
`@basou/core` (re-exported from `@basou/sdk`), and both readers of the field
inside basou go through it: the `basou stats` replay and `basou session show`.
`basou report` and `basou view` never touch the field — they consume the
duration total the stats replay produced, so they inherit the rule. Its writing
counterpart is
`writeObservedDuration(measuredMs)`, which turns a non-positive measurement
into `null`. A consumer outside this repository needs only the one-line rule
above.

`0` is not a duration a command can have had, whoever wrote it: a spawned
process cannot run in under half a millisecond (`fork` + `exec` alone costs
more), and the field is whole milliseconds, so anything faster rounds to `0`
regardless. Two sources were writing `0` for something else entirely:

- A Claude Code transcript carries no timing at all. Every command imported
  from one was written as `0` under 0.1.0 and is written as `null` now.
- Codex's `Wall time` banner on the per-command `exec_command` path reports the
  interval **codex** waited on the tool call, bounded by the caller-supplied
  `yield_time_ms` — not the child process's duration. Measured 2026-09-11 on one
  host's rollouts: **no banner from a process that EXITED exceeds the yield it
  was given, in any bucket** (yield 1000 → 1,498 exited calls, max 999 ms; 4000
  → 34, max 3,536 ms; 9000 → 11, max 7,911 ms; 30000 → 126, max 17,319 ms), and
  the control case is explicit — `sleep 8` reports 7.8757 s at
  `yield_time_ms: 9000` and 1.0018 s at 1000. Overshoot exists, but only in the
  other population: 1,366 of the 3,153 positive banners that declared a yield
  exceed it, and every one of them is a call that had NOT exited, overrunning
  the timeout by a few milliseconds of overhead. A positive banner from an
  unfinished call is therefore `min(duration, yield)` plus overhead:
  right-censored, not measured.

  basou records `null` for two shapes of that banner, and keeps the rest:

  - A banner rounding to **0 ms**, on 26,591 of 29,897 paired calls (88.9%).
    All 26,591 also carry `Process exited with code N`, so the process
    demonstrably ran, and four decimal places assert under 50 microseconds —
    less than a `fork` + `exec` costs — on commands including `curl` over TCP.
  - A **positive** banner whose output does not report that the process ENDED.
    The duration is gated on the same token as `exit_code`: an output reading
    `Process running with session ID N` means codex handed the turn back
    mid-command, and recording its wall time would assert "outcome unknown" and
    "duration observed" on the same event. 1,393 of the 3,232 positive
    `exec_command` banners are this case; tracing the session id through the
    follow-up polls, 1,237 of them demonstrably end later in the same log, and
    their own banners sum to 19,597,309 ms against the 1,672,329 ms reported at
    spawn — an 11.7x understatement, worst case 1,002 ms against 943,300 ms.

  What survives on this path is the 1,839 banners whose output reports an exit,
  and those are not censored: a process that exited did so inside the wait
  window, so its banner is the duration rather than the timeout. Measured, the
  contrast is sharp — of the positive banners that declared a yield, 1,392 of
  the 1,393 "still running" ones (99.9%) sit within 30 ms of it with a
  duration/yield ratio whose median is 1.002, while only 24 of the 1,760
  "exited" ones (1.4%) do, at a median ratio of 0.259. **Residual:** those 24
  exited within a whisker of the timeout, where the banner cannot be told apart
  from the clamp. basou records them as observed; they are 1.4% of the 1,760
  exited banners that declared a yield, 1.3% of the 1,839 retained on this path,
  and 0.07% of all derived commands.

- The SCRIPTED path is a different quantity and is NOT censored the same way.
  Its programs DO declare `yield_time_ms` — 1,960 of 4,661 such calls on this
  host (measured 2026-09-11) — but the banner is not bounded by it: **0** of the
  1,952 comparable banners land within 30 ms of the declared yield, the median
  banner is 1.0% of it, and 1.200x at the maximum. None of the 4,661 outputs
  ever reported a still-running process either — which is the decisive
  difference: on the `exec_command` path every overshoot belongs to a call that
  had not exited, and the scripted path has no such calls at all. So the scripted banner is the program's own elapsed time
  rather than a wait that was cut short. Its per-command `exit_code` is
  nonetheless always `null`, because the format never carries one — the program
  would have to print it. So a scripted command can legitimately hold a duration
  with an unknown outcome; the gate above is specific to the `exec_command`
  path, where a missing exit line means the process had not finished.

**A writer at 0.2.0 or above never emits `0`, and that is enforced rather than
promised.** The write boundary (`appendEvent`, `writeEventsBulk`,
`appendChainedEvent`) refuses such an event, scoped to the event's own version
so a genuine 0.1.0 event still round-trips through `basou session import`. The
read path does not drop one — the line is valid and is yielded, and a reader
treats the `0` as unobserved either way — but it emits an advisory
`retired_zero_duration` replay warning, so a value that should not exist is
visible instead of being silently reinterpreted. That matters for events
arriving from elsewhere: another host reached through the federation reader, or
a third party using this package's writers.

The schema still ACCEPTS `0`, because 0.1.0 events carrying it are on disk and
are not rewritten in place — that would break the tamper-evidence chain (§8).
(A session IS re-derived when its source log grows, and its events are then
restamped at the current version; a session whose source is gone, or that has
not grown, keeps its 0.1.0 lines indefinitely.) Every line read
from disk is validated against the event schema, and a violation is dropped with
a `schema_violation` warning, so narrowing the domain would silently discard
them (measured on one store: 19,592 such events). `schema_version` accepts any
`0.x.y`, so events already written keep validating.

The published JSON Schema `$id` moves with the version
(`https://basou.dev/schemas/0.2.0/event.schema.json`), so the URL that describes
the nullable field is not the URL that described the non-nullable one. The
artifact the old URL served is kept rather than replaced or removed: the bytes
it describes are still on disk everywhere, and that URL was published as the
canonical place to point a validator. Superseded artifacts live at
`@basou/core/schemas/retired/<version>/<name>.schema.json` and keep serving at
their own `$id`, and a retired version may never equal a live one.

Two limits on that archive are worth stating rather than leaving to be
discovered. **It is frozen by convention, not by construction, except where the
Zod source is genuinely gone** — that is true of `retired/0.1.0/event`, whose
non-nullable `duration_ms` shape no longer exists in the source, and not true of
an artifact a live constant would regenerate. A test asserts each retired file's
`$id` and its non-collision with a live one; nothing asserts its bytes.

**And it holds the LAST bytes an `$id` served, not every byte it served.** An
artifact may be re-published within one version under the carve-out above, so a
consumer that fetched a URL early and one that fetched it late can hold
different bytes for the same `$id`, and only the later set is archived. The
carve-out's two-directional test bounds how far they can differ — neither set
accepts a document the other refuses — but they are not identical, and the
archive does not record which was served when.

**Backward consequence, stated plainly.** A basou at 0.41.0 or earlier REJECTS a
`0.2.0` event whose `duration_ms` is null — its schema requires a number — and
`replayEvents` drops a rejected line. The whole command event disappears from
that reader's counts, not just its duration. This is reachable two ways: an
older global install reading a store a newer build wrote, and the federation
reader (`~/.basou/hosts.yaml`), where a peer host still on 0.41.0 replays this
host's sessions. `SchemaVersionSchema` accepts any `0.x.y`, so the
"upgrade basou" gate described in `compatibility.md` does not catch this — that
gate is major-only. Nothing shipped now can change how an already-released
reader behaves; the mitigation is to upgrade every host that shares a store.

Two neighbours deliberately did NOT change:

- `session.metrics.machine_active_time_ms` is optional and is **never written
  as 0**: an unrecorded model-compute time is an absent field, so absence
  already carries the meaning null carries elsewhere. A `0` a reader may see
  comes from the derived rollup (`basou stats`), which pairs it with
  `availability.machineActive: false`.
- A scripted program that made several tool calls records `null` for every
  command it ran, rather than a split or duplicated wall time. The program's
  single reported time belongs to the program; attributing it to one of the
  commands would put an inference inside the hash chain.

## §7.4 `adapter_output` constraint (important)

The `adapter_output` event **must not embed raw output** directly. Raw
content (`content`, `body`, `raw`, etc.) belongs in
`.basou/raw/<session_id>/` and is referenced via `raw_ref`:

```json
{
  "schema_version": "0.2.0",
  "type": "adapter_output",
  "id": "evt_01HX...",
  "session_id": "ses_01HX...",
  "occurred_at": "2026-05-04T09:01:00+09:00",
  "source": "claude-code-adapter",
  "stream": "stdout",
  "summary": "Claude Code produced 1247 chars of output",
  "raw_ref": ".basou/raw/ses_01HX.../stdout-001.log",
  "redacted": true
}
```

- Raw output is stored under `.basou/raw/<session_id>/` (**default ignore**).
- events.jsonl carries only the `summary` and `raw_ref`.
- This keeps the raw output out of the repository even when events.jsonl is
  opted in for commit.

## §7.5 Event-log integrity: hash chain + head anchor

`events.jsonl` is tamper-evident — both the **import paths** (`basou import`,
`basou refresh`, the in-place re-import of a grown source) and the **live
append paths** (`basou exec` / `run`, ad-hoc `decision` / `note` / `task`, the
attach and approval-resolution paths) hash-chain their event logs:

- **Per-line chain.** Every event line carries a top-level `prev_hash` — the
  hex sha-256 of the PREVIOUS line's literal written bytes (UTF-8, excluding
  the trailing `\n`). Line 1 carries the session-bound genesis hash
  `sha256("basou:event-chain:v1:" + session_id)`, so a chain copied verbatim
  from another session fails at line 1 even though its internal back-pointers
  are intact. Hashing covers the literal bytes on disk — there is no
  canonical-JSON step; verification re-hashes exactly what it reads.
- **Head anchor.** `session.yaml.integrity = { head_hash, event_count }`
  records the sha-256 of the last written line and the line count, so a tail
  truncation (which leaves a perfectly valid shorter chain) is detected
  independently of the chain itself.
- **Line discipline.** A chained file ends with `\n` and contains no blank
  lines; an unterminated tail can only come from out-of-band editing (or a
  crashed live append) and is reported as tampering on an at-rest log.

**Scope.** Imported and live sessions are both chained. Imported logs are
atomic whole-file bulk writes. Live `exec` / `run`, ad-hoc, attach and
approval-resolution lines go through ONE locked append primitive that derives
each `prev_hash` from the real on-disk tail (so concurrent writers — e.g. a
`decision record` attached to a running `exec` — stay consistent), and the head
anchor is stamped once, at the terminal-status finalize, from the final tail. A
session that began life UNCHAINED (created before this feature) keeps receiving
plain unchained lines — it is never half-chained — and verifies as `unchained`.

**Live sessions and the anchor.** A live session's `events.jsonl` is
legitimately still growing and its head anchor is not written until the session
reaches a terminal status. So verification of a non-terminal session
(`initialized` / `running` / `waiting_approval`) reports `in_progress`: the
internal back-pointer chain is fully checked, but the mutable tail and the
not-yet-written anchor are forgiven. A crashed live append (an unterminated
final line) is benign on a live session (`in_progress`) and the session is
treated as abandoned — a further append refuses rather than gluing a line onto
the torn fragment. Tamper-evidence for the tail + anchor activates once the
session is finalized (`completed` / `failed` / `interrupted`), after which the
strict rules apply.

**`basou verify [--session <id>] [--all] [--json]`** is the read-only checker.
Per-session verdicts:

| Verdict | Meaning | Exit |
|---|---|---|
| `verified` | chain, genesis, session ids, line discipline, and head anchor all consistent | 0 |
| `unchained` | no line carries `prev_hash` and no anchor exists (a pre-feature session created before chaining) | 0 |
| `empty` | zero events and no anchor | 0 |
| `incomplete` | chained log but `session.yaml` is entirely absent (an import crashed between the two writes); a re-import repairs it | 0 |
| `in_progress` | chained log on a still-live session (`initialized` / `running` / `waiting_approval`); the internal chain is verified, the mutable tail and not-yet-written anchor are forgiven | 0 |
| `tampered` | a real break: bad back-pointer or genesis, foreign `session_id`, torn tail (on an at-rest session), blank or malformed line, anchor missing / mismatching, or an anchor left behind with no chained log | non-zero |

`unchained` / `empty` / `incomplete` / `in_progress` exit 0; an I/O failure
while reading a log (e.g. permissions) aborts the command with a non-zero exit
as an operational error — distinct from a `tampered` verdict, but still
fail-closed. A still-live session being finalized concurrently can momentarily
present an old log with a new anchor; `verify` re-snapshots once before
returning a strict `anchor_mismatch`, so a finalize-in-flight is not reported as
tampering.

A legitimate basou rewrite (in-place re-import, `--force`) recomputes a valid
chain and anchor; `verify` proves on-disk internal consistency against the
anchor, not provenance against an external notary. The in-place re-import
additionally refuses to rebuild a session whose prior chain fails verification
(`prior_chain_broken`), so a broken chain cannot be laundered into a fresh
valid one — inspect it with `basou verify`, then decide (a `--force` rebuild
is the explicit override).

**Migrating pre-existing imported sessions.** Sessions imported before
chaining existed stay `unchained` until their source grows (in-place
re-import) — and a `--force` re-import mints new ids, breaking cross-session
references. `basou session rechain (--session <id> | --all) [--dry-run] [--json]`
migrates them in place: each original event line is re-emitted with ONLY the
`prev_hash` member appended (field sets, values, key order and ids are
preserved exactly — the migration never re-serializes through the schema
layer), and the existing `session.yaml` is rewritten with only the
`integrity` anchor added. Only sessions with status `imported` are eligible
(the closed, append-rejecting corpus); a `tampered` log is refused rather
than laundered into a fresh valid chain, and any line that cannot be
preserved byte-exactly (blank or padded lines, invalid UTF-8, malformed or
schema-invalid JSON, a foreign `session_id`) skips the session untouched.
Rechaining asserts tamper-evidence FROM NOW ON; it does not retroactively
prove the pre-existing content was never modified before the migration ran.

**Threat model (honest).** The chain and anchor are NOT cryptographic
signatures. `session.yaml` is as editable as the log itself; an attacker who
rewrites BOTH files consistently (recomputing every hash) is not detected.
This feature raises the bar from "edit one line" to "recompute and rewrite two
coordinated files", which is the right primitive for catching accidental and
casual mutation of the provenance corpus. Signing / external anchoring is a
named follow-up and out of scope here. One further boundary: the low-level
`appendEvent` export does not itself read the session status. The supported
append paths (attach, approval, the live `exec` / `run` orchestrators, ad-hoc)
prevent appending an unchained or out-of-place line, but a hypothetical direct
caller of the raw export is DETECTED by `verify` (`missing_prev_hash`) rather
than prevented; a writer-side gate on the raw export stays out of scope.
