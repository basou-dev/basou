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
  observation has. A reader that needs to know a tool call NAMED a file, rather
  than that git observed a difference, reads the `file_changed` events, which
  still come only from tool calls. They record the call, not its outcome (see
  [`file_changed.change_type`](#file_changedchange_type)).
- What this section says of git -- which reflog entries it writes, what
  `git replay` and an orphan checkout do, what `git status` names -- was
  checked with git 2.53. Another version may record some operations
  differently, and what is observed may then differ.
- What the observed half claims, per repository the workspace declares: the
  net change of tracked files since the session started (against the commit
  HEAD was on then), limited to paths the repository's OWN activity touched in
  that time, plus every untracked file git does not ignore, which is not
  limited -- leaving out of both the `.basou/` store and every path already
  dirty when the session started (an untracked file that was already there is
  one). An untracked nested repository is not a file, and is not recorded. Of
  everything this section says about the observed half, only the six
  properties listed under "What is guaranteed" below are the contract; the
  rest describes how the current release decides what the repository's own
  activity is. A path counts as touched when a commit CREATED in that
  repository since the start changed it, or when it differs from HEAD in the
  working tree now. A commit counts as created when the reflog of HEAD or of a
  local branch records its creation in the words git itself writes: a commit
  (including an amend, and one that concludes a merge or a cherry-pick), a
  cherry-pick, a revert, a patch applied by `git am`, a pick replayed by a
  rebase or by `git pull --rebase`, a merge git committed itself, or a commit
  `git replay` made when it updated the refs itself (its default). A merge
  commit counts only for the paths where it differs
  from every one of its parents: what it resolved, and also a file git joined
  cleanly from changes made on both sides. So a commit that only arrived by a
  pull, a fast-forward merge or `cherry-pick --ff` -- a bot's pull request,
  someone else's work -- is not charged to the session unless its paths were
  also touched (see the limits below), while the session's own commits still
  are after they come back through a squash merge, because they were created
  there first. Branch reflogs are shared by every worktree of a repository, so
  a commit made on a branch in another worktree counts too.
- Renames are not paired in the observed half: a renamed file appears as its
  old name deleted and its new name added, and each name counts on its own,
  whatever the repository's `diff.renames` says. Otherwise a file the session
  deleted could be paired with a similar file that arrived by a pull, and bring
  that file's name in.
- The own-activity limit is not applied in exactly two cases: HEAD does not
  resolve (the repository is still unborn, HEAD is on an orphan branch, or the
  current branch's ref is empty or does not hold an object name), or HEAD
  moved while no reflog recorded anything (reflogs off or expired), so an own
  commit and a pulled one cannot be told apart. Files dirty at the start and
  the `.basou/` store are still left out. After `git checkout --orphan` a file
  that arrived earlier by a pull therefore counts; after `git switch --orphan`
  every file tracked at the start counts as deleted. When observing a
  repository fails -- git fails, the start time cannot be read, or HEAD
  resolves to a commit that is missing -- the repository keeps the files its
  previous observation recorded.
- Limits of the observed half, by construction:
    - It observes a repository, not an actor. Uncommitted edits and local
      commits made in the same repository by anyone else while the session
      runs (the operator, another session) are counted too.
    - The evidence is gathered per path from the whole repository and applied
      to the observed worktree's net change. A path that a commit created
      since the start on any local branch changed counts, even when that
      commit never reaches the observed worktree -- so a change to the same
      path that only arrived by a pull counts too.
    - Untracked files are not limited, so files a pull makes visible -- by
      changing `.gitignore`, for instance -- count too.
    - Only what is still in the net change counts. Work committed on a branch
      the session then switched away from, or undone by a later commit or a
      reset, is not observed.
    - A commit is seen only through a reflog entry that is read. One made on a
      detached HEAD in another worktree, or rebased there (a rebase replays
      its picks on that worktree's HEAD), is not seen. One made on a branch in
      another worktree stops counting at the next pass once that branch is
      deleted (as when the worktree is cleaned up after a squash merge); one
      made in the observed worktree is still seen through HEAD's reflog. One
      made on a branch whose ref is broken is not seen, since that branch's
      reflog is skipped. A commit recorded under a message git does not write
      itself (a tool calling `update-ref -m`, or ref updates `git replay`
      printed and `git update-ref --stdin` applied) is not seen either, nor is
      a real cherry-pick of a commit whose subject is exactly "fast-forward",
      which git records the same way as `cherry-pick --ff`. When `git replay`
      moves a branch that had no reflog before, only the commit it ends at is
      seen, since where it started is recorded nowhere.
    - The window is drawn by the time a reflog entry carries, which git takes
      from the committer date: an operation given an earlier date
      (`GIT_COMMITTER_DATE`, or a commit that `rebase --continue` concludes
      under `--committer-date-is-author-date`) can place a commit before the
      start, and one made before the start but given a later date can place
      it inside. A reflog that has partly expired (unreachable entries after
      30 days by default, so only a session resumed that much later meets it)
      loses the commits whose entries expired.
    - A merge still in progress, such as a pull that stopped on a conflict, is
      not a commit yet: every path it brought in differs from HEAD and counts
      until it is concluded.
    - A session is measured from its first start. A resumed session's
      observation includes what happened in the repository while it was not
      running.
    - A file already dirty when the session started is not observed for that
      session at all, even if the session goes on to change it. Dirty means
      every path `git status` names at the start -- which covers a change
      staged while its working copy was put back, a type change, an untracked
      nested repository, and a file with a conflict, which stays out even when
      the session resolves it -- together with every path the session's own
      reading of changes would name then, so the two can never name one file
      differently (both names of a staged rename, a name with leading or
      trailing spaces). What is dirty is read once, at the start: if git fails
      to read part of it then, what it could not read is not left out for the
      rest of the session. A change in the working copy of a file git is told
      to leave alone (`assume-unchanged`, `skip-worktree`) is hidden from
      every reading, so it counts once that flag is cleared; a change already
      staged is named, and stays out.
    - Observations are keyed by the vendor's session id as given (a UUID for
      both Claude Code and Codex); ids from different vendors are not
      namespaced. Codex's SessionStart hook writes a baseline too, but only the
      Claude Code import reads observations today.
- What is guaranteed about the observed half, per observed repository, across
  a `1.x` line -- everything else this section says about the observed half
  may change there (see
  [Observed files](compatibility.md#observed-files-six-properties-are-guaranteed-the-attribution-may-improve)):
    1. **Real names.** Every path is spelled as git reports it with `-z`:
       unquoted and unescaped whatever `core.quotePath` says, including a name
       that holds a space (leading or trailing too), a tab, a newline, a quote,
       or a non-ASCII character in valid UTF-8. It is stored joined to the
       repository's path and then shortened by the path sanitizer below.
    2. **Not the store.** No path whose first component is exactly `.basou` is
       recorded. (On a case-insensitive file system, a store tracked under
       another spelling, such as `.Basou`, is not recognised.)
    3. **Not what was dirty at the start.** No path that the start's reading of
       dirty files named is recorded. A path that reading could not name,
       because git failed on part of it, may be.
    4. **Only a net change.** Every path recorded is either a tracked path that
       differed between the commit HEAD was on at the start (the empty tree,
       when there was none) and the working tree, or an untracked file git did
       not ignore, when the last observation that succeeded was taken.
    5. **A failure keeps the previous list.** When observing the repository
       fails, it keeps the files its previous observation recorded, rather
       than an empty or a partly read list. This holds while the observation
       itself can be read: when the file under `.basou/tmp/observations/` is
       missing or cannot be read, the next import builds `related_files`
       without the observed half.
    6. **The working tree is complete.** An observation that succeeds records
       every change git reports in the working tree that is a net change since
       the start -- an uncommitted change to a tracked file, and an untracked
       file git does not ignore -- apart from what 2 and 3 leave out. The
       own-activity limit never removes one of these. What git does not report
       is not covered: a change to a file git is told to leave alone
       (`assume-unchanged`, `skip-worktree`), and an untracked nested
       repository.

  Properties 1 to 5 say what the list never holds, which a list that is always
  empty would satisfy; 6 is what rules that out. The session's commits are not
  covered by 6: which of them count rests on the reflog entries git writes,
  and that is the attribution that may change.

  The six describe the observed half. `related_files` in `session.yaml` is the
  union of that half and the paths the transcript's tool calls named, and does
  not say which half a path came from, so a path a tool call named can be one
  the six would leave out (a file dirty at the start, a file in `.basou/`).
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

### `file_changed.change_type`

`change_type` is one of `added`, `modified`, `deleted` and `renamed`. It says
what happened at the path. It does not say whether the path holds a regular
file, a symlink or a submodule. What a value means depends on who wrote the
event, which its `source` names:

- **From git** (`source: "git-capability"`), written by `basou run` from the
  diff between the commit HEAD was on when the run started and the one it is on
  when it ends — every path that differs between those two commits, whether it
  was committed during the run or HEAD only moved across it (a checkout, a
  pull, a reset). Nothing uncommitted is included:
    - `added`: the path is new (`A`).
    - `modified`: the path exists on both sides and what it holds changed — its
      content, its mode, or the kind of object at it (`M`, and a typechange
      `T`).
    - `deleted`: the path is gone (`D`).
    - `renamed`: git paired a deletion with an addition (`R`), and `old_path`
      holds the previous name. Whether git pairs them follows the repository's
      `diff.renames`.
    - Today a copy (`C`), an unmerged path (`U`) and an unknown change (`X`)
      are not recorded.
- **From a Claude Code transcript** (`source: "claude-code-import"`), from the
  tool calls that write or edit a file and name its path:
    - `added`: a call that writes the whole file named the path — today,
      `Write`. The file may already have existed: an overwrite is `added` too.
    - `modified`: a call that changes part of a file named the path — today,
      `Edit` and `NotebookEdit`.
    - Today `deleted` and `renamed` are not derived from a transcript. A file
      removed or renamed through the shell appears only in the session's
      observed `related_files` (§5.2).
    - The event says that a call named the path, not that the call succeeded.
      Today a call whose result reported an error produces one too.
- A Codex rollout produces no `file_changed` events.
- `basou session import` stores the events a producer supplies, with the
  values it gave.

Each value keeps the meaning it has here. A new value can be added only under
the gate in §7.3 below, which a `1.x` line may use (see
[compatibility](compatibility.md#the-on-disk-format-may-make-its-gated-changes-at-a-minor)),
so a consumer should keep a branch for a value it does not know.

## §7.3 Extension rules (additive by default; breaking changes are gated)

These rules hold within a `1.x` line of the product as well. Its compatibility
policy states the bounds under which the two gated exceptions below may be used
there ([The on-disk format may make its gated changes at a
minor](compatibility.md#the-on-disk-format-may-make-its-gated-changes-at-a-minor)).

- New event types may be added. For an existing type, adding a required field,
  removing one, or narrowing one's domain is forbidden. Two exceptions are
  gated rather than forbidden: widening a required field's domain (the third
  rule below), and narrowing one that no writer has ever exercised (the rule
  immediately after it).
- Adding optional fields to existing types is allowed. The one exception is
  what `basou verify` reads from `session.yaml`: a change to the keys of
  `integrity`, to the values `status` may take, or to what the anchor means
  moves the session's `schema_version`, even when it would otherwise be
  additive — an optional key added to `integrity`, for instance. `integrity`
  rejects a key it does not know, so without the move an older verify could
  not tell a newer writer's document from a damaged one; with it, a verify
  from `0.57.0` on reports the session `unsupported` rather than `tampered`
  (§7.5). `0.56.0` and earlier report it `tampered` on a chained log.
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

  Who the writer is is decided per value, not per file. A value basou computes
  — an id it mints, a status it sets, a timestamp from
  `Date.prototype.toISOString()` — is basou's. A value it copies from its
  input — a vendor transcript, a producer's payload — is the source's, even
  inside a document basou built: `basou session import` writes the
  `session.yaml` itself (it mints the id, sets the status, replaces the
  workspace id, sanitizes paths) but copies the producer's timestamps, and
  stores the producer's events with the timestamps they gave (the event ids it
  mints itself).

  "No code path" covers every release whose documents may still be on disk,
  not only the current tree: a writer removed today still wrote what it wrote,
  and nothing migrates a store, so in practice that is every release. A test in
  today's tree cannot check that half. It takes reading how each release
  produced the value — its code, and what its dependency ranges resolved to at
  install time (the accepted timestamp shape once came from zod's own
  expression). Where that history cannot be established,
  construction-emptiness is unavailable for the value, and it goes by the
  branch below.

  **Where basou is NOT the writer**, construction-emptiness is unavailable, and
  a narrowing qualifies by one of two routes.

  **By repair:** a normalizer, applied at every boundary where the value is
  read, brings the WHOLE refused set back into the accepted set, so that
  nothing which validated before fails after. That is shown by comparing the
  two accepted sets, not by counting documents, and it needs no population.
  Clause 4 below still applies to whatever the normalizer does not cover.

  **By measurement:** all of the following are required, and a narrowing that
  cannot supply them does not qualify by this route:

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
     was written for, and so is one that makes `basou verify` report tampering
     that did not happen. Verify reads three fields of `session.yaml`, the
     `schema_version`, the `integrity` anchor and the `status`, each against
     its own schema; when any of them fails validation at a version this
     basou knows, the anchor is unreadable, and when the session's log is
     chained, verify reports that as `tampered`. A failure in any other field
     is reported beside the verdict and does not change it. A narrowing must
     not land on either path until it is accounted for.

  A narrowing that is merely believed to be rare never qualifies by any route.

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

  *Where basou is the writer* — the timestamps of `task` and `manifest`, and
  those basou stamps itself on the sessions and events it records — the
  refused set is empty by construction: every such timestamp is either
  `Date.prototype.toISOString()` output, which always emits seconds, or a CLI
  option already validated to require them (`--completed-at`). No code path in
  this repository can emit a seconds-less value there. The counts measured
  before the bump (39,070 timestamps across one store's `events.jsonl`,
  `session.yaml`, tasks and manifest, all carrying seconds) agree with that,
  and are recorded as corroboration rather than as the evidence.

  When the bump landed, this example counted all of `event` and `session` on
  that side, and that was wrong in two places. The adapters copied a vendor's
  timestamp string into `occurred_at`, `started_at` and `ended_at` as given
  (they still copy it, through the normalizer), so those values are the
  vendor's. And `basou session import` had accepted seconds-less values from a
  producer and stored them as given. From `0.45.0` through `0.54.0` such an
  imported session was skipped by every listing, refused by `basou session
  show`, and reported by `basou verify` as tampered (its anchor unreadable),
  and its seconds-less events were dropped. `0.55.0` added the third boundary
  below.

  *Where basou is not the writer* there are three boundaries, and they are not
  alike:

  - **Adapter imports** (`claude-code`, `codex`) read a vendor's `timestamp`
    string. Population: the rollout and transcript logs both adapters read,
    226,077 values measured upstream of any normalizer — the normalizer was
    added in the same change and the measurement predates it. All carried
    seconds. Refusal path: an event line failing validation is dropped with a
    `schema_violation` warning. Normalizer: `normalizeIsoTimestamp`, at both
    read sites.
  - **Sessions a producer imported**, read back. Population: not measurable
    from here — the producers are third parties and the stores are theirs.
    One operator's store held no imported session and no seconds-less value
    (40,191 event lines), which says nothing about anyone else's. Refusal path:
    a `session.yaml` that fails validation makes the whole session unreadable
    to the commands that read the whole document, as above — `basou verify`
    now reads only the format version, the anchor and the status (clause 4),
    none of which holds a timestamp — and an event line that fails is
    dropped. Normalizer:
    `normalizeSessionTimestamps` and `normalizeEventTimestamps`, applied where
    `session.yaml` is read, where events are replayed, and in the gate that
    decides whether a session can be rechained. This boundary qualifies by
    repair: the only difference between the pattern `0.44.0` accepted and the
    one after the bump is the optional seconds, so the normalizer brings the
    whole refused set back. Since `0.45.0` the import itself refuses a
    seconds-less payload as an invalid payload.
  - **Approvals** are placed by an outside orchestrator. basou never writes a
    pending one; the resolved copy it writes on approve or reject carries the
    values it read, seconds restored.
    Population: **zero documents** in the measured store — which is not evidence
    that producers agree, only that this store has none, and the read rule says
    so rather than presenting an empty directory as a clean measurement.
    Refusal path: `loadApproval` THROWS rather than dropping, and neither the
    orientation nor the report renderer catches it, so one refused document
    takes both commands down. That is the case clause 4 above says a narrowing
    must not land on unaccounted-for; it is accounted for here by normalizing
    the three timestamp fields at every read boundary before the document is
    parsed — `loadApproval`, `approval list`, and `approval approve` / `reject`
    — so the seconds axis cannot reach the throw. Like the one above, this
    boundary qualifies by repair, not by its measurement.

  **Read rule:** a document at the earlier version means exactly what it meant,
  and a timestamp stored without seconds is read as the same minute with `:00`,
  its offset kept. The rule applies at every `schema_version`: the version
  stamped on a document basou stores for a producer is the producer's claim,
  not evidence of the rules it was written under. It covers these fields:

  - an event's `occurred_at`, and `expires_at` on `approval_requested`;
  - a session's `started_at` and `ended_at`, and the `start` and `end` of each
    `metrics.active_intervals` entry;
  - an approval's `created_at`, `expires_at` and `resolved_at`.

  The seconds rule has one implementation, `normalizeIsoTimestamp`, exported
  from `@basou/core` and re-exported from `@basou/sdk`; `@basou/core` also
  exports `normalizeEventTimestamps`, `normalizeSessionTimestamps` and
  `normalizeApprovalTimestamps`, which apply it to those fields. basou applies
  them before parsing wherever it reads a stored `session.yaml`, event or
  approval (a running `basou exec` or `basou run` rereads only the session it
  is writing), and a reader of the files cannot tell which documents a
  producer wrote, so it should apply them to every document. The published
  JSON Schemas describe the shape after this repair: a stored line validated
  against them without it is refused, whereas basou reads it. A stored value
  that basou prints, `basou session show --json` included, is printed as read
  through this rule. Reading rewrites nothing, so the bytes the hash chain
  covers are unchanged. A record basou later rewrites from what it read — a
  re-import, a rechained `session.yaml` — is written with the seconds restored.

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

  A read rule may be revised at a minor, without moving any version, when the
  revision only turns a refusal into a read: every value that already read
  keeps its meaning, and a value that was refused is now read. The changelog
  states the revision and what older readers still do with those documents.
  The seconds rule above is one: until `0.55.0` it was applied only by the
  adapters and `loadApproval`.

  Documents are never rewritten IN PLACE by a migration: that would break the
  tamper-evidence chain (§7.5). They are, however, re-derived — `reimportPreservingId`
  rewrites a session's `events.jsonl` and `session.yaml` atomically, with fresh
  content and a fresh chain, whenever its source log has grown. So a stored
  value can be replaced by re-derivation from the source, and cannot be
  replaced by editing what is on disk. Neither path can recover what a source
  never reported. The one exception that edits in place is rechaining (§7.5),
  which appends `prev_hash` to each event line and writes `session.yaml` back
  as read: that keeps every stored value, except that a timestamp stored
  without seconds is written with the `:00` the read rule restores, and it
  writes out the defaults the schema supplies for fields the file left out.
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
are not rewritten in place — that would break the tamper-evidence chain (§7.5).
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
| `unchained` | no line carries `prev_hash` and `session.yaml` has no `integrity` key (a pre-feature session created before chaining) | 0 |
| `empty` | zero events and no `integrity` key | 0 |
| `incomplete` | chained log but `session.yaml` is entirely absent (an import crashed between the two writes); a re-import repairs it | 0 |
| `in_progress` | chained log on a still-live session (`initialized` / `running` / `waiting_approval`); the internal chain is verified, the mutable tail and not-yet-written anchor are forgiven | 0 |
| `unsupported` | `session.yaml` was written by a newer basou, whose rules verify does not know: its format major is not 0 (nothing is judged, the log included), or it is a `0.x.y` newer than the one this basou writes and the verdict would otherwise be `tampered`; upgrade basou to verify it | non-zero |
| `tampered` | a real break: bad back-pointer or genesis, foreign `session_id`, torn tail (on an at-rest session), blank or malformed line, anchor missing / mismatching, an `integrity` key left behind with no chained log, on a chained log a `session.yaml` that verify cannot read what it needs from (`yaml_unreadable`, below), or a symlink or file where the session's directory should be (`symlink`, `not_a_directory`) | non-zero |

**What verify reads from `session.yaml`.** Three fields, each against its own
schema: the `schema_version` format gate, the `integrity` anchor, and the
`status` that decides whether the anchor is due yet. A validation failure in
any other field says nothing about the log, so it does not change the verdict
or the exit code. The version decides how the rest is read:

- **A format major other than 0** is `unsupported` before anything is judged,
  the log included — that basou's rules are unknown here.
- **A newer `0.x.y`** — above the one this basou writes, with no leading
  zeros — is judged as usual, but a result that would be `tampered` is
  reported `unsupported`: §7.3 requires a change to what verify reads to move
  the version, so under a newer version something that looks like tampering
  may be the newer rules — an anchor or status verify cannot read, an anchor
  that no longer matches, a chain it cannot follow. `verified`, `unchained`,
  `empty` and `in_progress` stand.
- **Any other version** — the one this basou writes, an older one, or a
  `schema_version` that is not a version at all — on a chained log is
  `tampered` / `yaml_unreadable` when the file does not parse as YAML, its top
  level is not a mapping or it has no `session` mapping, or one of the three
  fields fails validation.
- **Under an unchained or empty log**, only the presence of an `integrity` key
  matters: a key left behind, whatever its value, is `anchor_without_chain`
  (`unsupported` at a newer version, as above). A file that does not parse, or
  whose top level is not a mapping, has no key to find, and gives `unchained` /
  `empty` with exit 0.

Whether the whole document loads is reported beside the verdict:
`"session_yaml_invalid": true` on the row of `basou verify --json`, and a note
on the human-readable line, whenever `session.yaml` exists but does not parse
or fails the full session schema — on `unsupported` and `yaml_unreadable` rows
as well as beside a verdict decided on the three fields. The commands that
read the whole document skip such a session with the same code; they also skip
an I/O failure under it, which makes verify abort instead.

`unchained` / `empty` / `incomplete` / `in_progress` exit 0; an I/O failure
while reading a session's directory entry, its log or its `session.yaml` (e.g. permissions) aborts the command with a non-zero exit
as an operational error — distinct from a `tampered` verdict, but still
fail-closed. A still-live session being finalized concurrently can momentarily
present an old log with a new anchor; `verify` re-snapshots once before
returning a strict `anchor_mismatch`, so a finalize-in-flight is not reported as
tampering.

**The `--json` output.** `basou verify --json` prints one JSON array on stdout,
with one row per entry directly under `.basou/sessions/` whose name is a
session id, sorted by name in code-unit order, or the one session `--session`
names. A workspace with no
sessions prints `[]`. The top level stays an array within `1.x`, so the output
has no place for anything about the run as a whole; a count by status is taken
from the rows. Any error that stops the command before every session has been
read — for instance the I/O failure above, a `--session` that matches no
session or more than one, or a workspace that is not initialized — prints no
array and reports the error on stderr, so an array that is printed is
complete. Whitespace, and the order of the keys in a row, are not part of the
shape.

Only an entry whose name is a session id is a session. A session id is `ses_`
followed by 26 uppercase Crockford base32 characters, the first of them `0` to
`7` (`^ses_[0-7][0-9A-HJKMNP-TV-Z]{25}$`), the form basou gives every session.
Any other entry, such as a `notes/` directory or a `ses_<id>.bak` copy, is not
a session: no command lists, counts, verifies, resolves or serves it as one,
and it gets no row here.

An entry with a session id's name that is not a directory — a symlink, whatever
it points to, or a file — is not followed by `basou verify`, by the commands
that list sessions, or by `--session`. (A command handed such an id from
elsewhere, such as a recorded approval or `basou view`'s session page, is not
guarded the same way.) Here it
is reported rather than left out: its row is `tampered` with `reason` `symlink`
or `not_a_directory` and `event_count` `0`, since nothing is read. Such a row
judges the store's layout, not the log: the log behind a symlink may be intact,
and moving the session's directory back into the store repairs it. `--session`
naming such an entry gives its row here and, on every other command, stops
with an error saying the entry is not a directory; a prefix it shares with a
session is ambiguous. The commands that load sessions to list or summarize
them skip it with a warning naming its full id — `session list`, `orient`,
`stats`, `handoff generate`, `decisions generate`, `report generate`,
`review-gaps` and `decision gaps` (which counts it among the sessions it could
not read in full) — and `task reconcile` and `task refresh-linkage` leave a
reference to it as it is.

Each row is an object with these fields:

| Field | Value | Present | Meaning |
|---|---|---|---|
| `session_id` | string | always | the session's full id (the entry's name), also when `--session` was given a prefix |
| `status` | string | always | the verdict, from the table above |
| `event_count` | non-negative integer | always | the complete (newline-terminated) lines of `events.jsonl`, as this basou splits the file; an unterminated tail is not counted, and a missing or empty file counts `0`. On an `unsupported` row it counts lines, not necessarily the newer writer's events; on a `symlink` or `not_a_directory` row it is `0`, as nothing is read |
| `reason` | string | always on `tampered` and `incomplete`; today on no other status | what broke, from the table below; read it together with `status`, never instead of it |
| `line` | positive integer | when one line of the log broke | the 1-based number of the first line that broke; for `torn_tail`, the number the unterminated tail would have |
| `session_yaml_invalid` | `true` | when `session.yaml` exists but does not load as a whole document | described above; the field is left out rather than set to `false` |

`reason` takes these values today. `unsupported` carries neither `reason` nor
`line` today, also where it stands in for a `tampered` result at a newer
version: under the newer rules, what broke may not be a break. Within `1.x` a
`reason` may be added to any status, a new one included: it refines its status
and never changes whether that status fails the command.

| `reason` | `status` | `line` | Meaning |
|---|---|---|---|
| `torn_tail` | `tampered` | yes | a chained log does not end with `\n` (on a live session this is `in_progress`) |
| `blank_line` | `tampered` | yes | a chained log has an empty line, with nothing between two `\n`; a line of only whitespace is `malformed_line` |
| `malformed_line` | `tampered` | yes | a line of a chained log is not valid JSON |
| `missing_prev_hash` | `tampered` | yes | a line of a chained log carries no string `prev_hash` |
| `genesis_mismatch` | `tampered` | yes (`1`) | line 1's `prev_hash` is not this session's genesis hash |
| `broken_link` | `tampered` | yes | a line's `prev_hash` is not the hash of the line before it |
| `session_id_mismatch` | `tampered` | yes | a line's `session_id` is not this session's id |
| `anchor_missing` | `tampered` | no | an at-rest chained log's `session.yaml` has no `integrity` anchor |
| `anchor_mismatch` | `tampered` | no | the anchor's `head_hash` or `event_count` does not match the log |
| `anchor_without_chain` | `tampered` | no | `session.yaml` has an `integrity` key, but the log is unchained, empty or missing |
| `yaml_unreadable` | `tampered` | no | verify cannot read what it needs from a chained log's `session.yaml` (above) |
| `yaml_missing` | `incomplete` | no | a chained log has no `session.yaml` |
| `symlink` | `tampered` | no | the entry named as the session is a symlink, whatever it points to; it is not followed |
| `not_a_directory` | `tampered` | no | the entry named as the session is neither a directory nor a symlink (a file, for instance) |

**Reading the output.** The shape changes only as
[compatibility](compatibility.md#basou-verify-verdicts-may-gain-values-on-the-failing-side)
allows, so a consumer:

- ignores a field it does not know. A row may gain fields within `1.x`, and a
  field added never changes what `status`, `reason`, `line` or `event_count`
  mean, nor whether a row passes, so a consumer that ignores it still reads
  the row correctly;
- reads a `status` or a `reason` it does not know as not verified. An unknown
  `status` fails the command — a new `status` is only ever added on the
  failing side — and an unknown `reason` leaves its status passing or failing
  as it would without it;
- decides whether the command passed from its exit code, or from the rows when
  it has only the array: the command passes exactly when every row's `status`
  exits `0` in the verdict table and nothing stopped it. That says no session
  failed, not that every session was verified: an `unchained` or `empty` log
  has no chain to check, an `incomplete` one has no anchor to check it against,
  and an `in_progress` one is checked up to its still-growing tail. A consumer
  that needs every session verified checks that every `status` is `verified`.

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
layer), and the existing `session.yaml` is rewritten as read with the
`integrity` anchor added — so a timestamp it stored without seconds is written
with `:00` (§7.3), and a field the file left out is written with the default
the schema supplies. The event lines keep their timestamps as stored. Only
sessions with status `imported` are eligible
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
named follow-up and out of scope here. For the same reason, whoever edits
`session.yaml` can raise its `schema_version` and have a broken session
reported `unsupported` instead of `tampered` — which still fails `verify`, and
still says the session was not verified. One further boundary: the low-level
`appendEvent` export does not itself read the session status. The supported
append paths (attach, approval, the live `exec` / `run` orchestrators, ad-hoc)
prevent appending an unchained or out-of-place line, but a hypothetical direct
caller of the raw export is DETECTED by `verify` (`missing_prev_hash`) rather
than prevented; a writer-side gate on the raw export stays out of scope.
