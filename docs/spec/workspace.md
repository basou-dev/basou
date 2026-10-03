# Workspace, sessions, tasks, IDs

This document covers the basic objects basou records and how they are laid
out on disk.

## §1.1 Confirmed invariants

- `.basou/` is placed at the **Git repository root**.
- The baseline is **one repository = one workspace**: a single `.basou/`
  owns the provenance.
- A single logical project may still span several sibling repositories;
  `basou import` aggregates their native logs into one workspace via the
  repeatable `--project` flag / `manifest.import.source_roots` (see
  terminal-and-import.md §14.3). Per-subproject workspaces inside a monorepo
  remain out of scope.
- A session is **bound to a single workspace**. Cross-repository work is
  split across separate sessions, which a multi-root import attributes to
  the aggregating workspace.
- `manifest.yaml` carries `workspace_id`, leaving room for multi-workspace
  configurations in a future release.

## §1.2 `.basou/` directory layout

```text
.basou/
├── manifest.yaml            # source of truth for the workspace
├── status.json              # current state (re-derivable from events.jsonl)
├── sessions/
│   └── <session_id>/
│       ├── session.yaml
│       ├── events.jsonl     # source of truth (all events within the session)
│       ├── transcript.md    # generated
│       ├── changed-files.json
│       └── artifacts/
├── tasks/
│   ├── <task_id>.md         # source of truth (YAML front matter + body)
│   └── index.json           # derived cache (id / status / label / updated_at)
├── approvals/
│   ├── pending/
│   │   └── <approval_id>.yaml
│   └── resolved/
│       └── <approval_id>.yaml
├── decisions.md             # generated + manually appendable
├── handoff.md               # generated + manually appendable
├── orientation.md           # generated current-position view (transient, gitignored)
├── locks/                   # gitignored (advisory lockfiles, see §1.5)
├── logs/                    # gitignored
├── raw/                     # gitignored (adapter raw output, etc.)
└── tmp/                     # gitignored
```

### The store's directories are not followed

basou creates `sessions/`, `tasks/`, `tasks/archive/`, `approvals/`,
`approvals/pending/`, `approvals/resolved/`, `locks/`, `tmp/` and
`tmp/observations/` as directories and never as anything else, and it creates
no symlink under `.basou/`, except in a view that `workspace.view` places
there. When one of them is a symlink, whatever it points to, or a file, the
commands that read or write what it holds stop with an error naming it,
except where the list below says otherwise: `<directory> is a symlink; refusing to operate` or `<directory> exists but
is not a directory`, where `<directory>` is the path from the repository root,
such as `.basou/tasks/archive`. They stop before they read anything from that
directory, and before they write anything, take a lock or record an event,
so nothing is read from or written to a place outside the store through it.
A command that also reads another store may read that one first (`orient`
reads the sessions before the tasks, for instance). An absent directory is
not refused: a stripped-down workspace may have none, and the commands that
write into one create it.

- `.basou/sessions` stops the commands that read or write the workspace's
  sessions; see [schemas](schemas.md) for `basou verify` and for an entry
  inside it that is not a directory. A federated mirror registered in
  `~/.basou/hosts.yaml` is read as before.
- `.basou/tasks` and `.basou/tasks/archive` stop every `basou task`
  subcommand, `orient`, `handoff generate`, `report generate`, `decision
  gaps`, and a `session import` of a session that names a task.
- `.basou/approvals`, `.basou/approvals/pending` and
  `.basou/approvals/resolved` stop every `basou approval` subcommand,
  `orient`, `handoff generate` and `report generate`. `.basou/approvals`
  also stops `init` and `project new --apply`, which create `pending/` and
  `resolved/` in it, before they create anything.
- Either store stops `refresh`, `orient --refresh` and each cycle of `refresh
  --watch` before they import anything, so a refresh that stops has imported
  nothing. The watcher's first catch-up fails; a later cycle is skipped and
  the refusal logged. `refresh --dry-run` imports and regenerates nothing and
  is not stopped.
- `.basou/locks` stops the commands that take a lock, before they write
  anything: `note`, `session note`, `decision record`, `capture` and `void`,
  `review record`, `task new`, `status`, `edit`, `archive`, `delete`,
  `reconcile` and `refresh-linkage` (the last two in their default dry-run
  mode too), `approval approve` and `reject`, `exec`, `run`, and `session
  rechain` (`--dry-run` too). A re-import takes a lock, so it also stops
  `basou import`, and `refresh`, `orient --refresh` and each cycle of
  `refresh --watch` as in the item above, before they import anything and
  whether or not there is anything to import. A `--dry-run` of `import`,
  `refresh`, `decision capture` or `review record` takes no lock and is not
  stopped, and neither is a `session import` of a new session.
- `.basou/tmp` and `.basou/tmp/observations` hold the hooks' observations of
  what a session changes. The `session-start` and `stop` hooks write none
  there, silently, as for any observation they cannot write, and an import
  reads none, as for a session that was not observed. An observation file in
  it that is not a regular file is not read either.

For the session, task and approval stores, `basou view` answers `500` with
the error on the pages that read the store; on the portfolio page the
workspace's card carries the error instead. The `session-start` hook, which
never fails a session, prints nothing for such a workspace. `basou status`
does not stop: it reports `sessions`, `tasks`, `approvals/pending` and
`approvals/resolved` that are themselves a symlink or a file as missing, and
reports both approval directories as missing when `approvals` itself is a
symlink or a file. Neither `basou view` nor the `session-start` hook's
orientation reads `.basou/locks` or `.basou/tmp`, so a symlink there leaves
them as usual. `basou status` reports a `tmp` that is a symlink or a file as
missing; it has no entry for `locks` or `tmp/observations`.

A task file that is itself a symlink is not covered by this rule. A live
task file (`tasks/<task_id>.md`) is read through it; an archived one
(`tasks/archive/<task_id>.md`) is left out of the listing and not found.

An approval file (`approvals/pending/<approval_id>.yaml` or
`approvals/resolved/<approval_id>.yaml`) that is a symlink, whatever it
points to, or anything other than a file is not followed, and nothing is read
through it:

- `basou approval list` leaves it out and names it on stderr: `Skipped <id>
  in <pending|resolved>: not a file (a symlink or a directory is not
  followed)`.
- `approval show`, `approve` and `reject` given its id stop with `Approval
  <approval_id> is not a file; a symlink or a directory there is not
  followed`. A prefix it shares with an approval is ambiguous.
- When the same id has a file on the other side, that file is the approval;
  `approval show` adds a warning naming the entry. `approve` and `reject`
  refuse an approval whose name in `approvals/resolved` such an entry takes,
  before they record anything, since the resolved file could not be written
  there.
- The SDK's `listApprovals` leaves it out and reports it to `onDiagnostic`,
  and `getApproval` looks it up as `null`.
- `orient`, `handoff generate`, `report generate` and `basou view` leave it
  out of what they show.

### tasks/ details

- Listing tasks reads `.basou/tasks/index.json` (a small JSON cache of
  id / status / optional label / updated_at). The index is updated
  write-through on every task mutation (`createTask`,
  `updateTaskStatus`, `editTask`, `deleteTask`, `archiveTask`,
  `reconcileTask`, `refreshTaskLinkedSessions`).
  `tasks/<task_id>.md` remains the sole source of truth — the index is
  a derived cache and never participates in `task reconcile` /
  `task refresh-linkage` invariants.
- **The index is reconciled against the directory before it is used.**
  `enumerateTaskIds` lists `tasks/` and compares the ids it finds with
  the ids the index names, as sets rather than counts. They agree in the
  ordinary case and the index is returned, so the listing costs one
  `readdir` and no task file is read. They disagree after a hand edit, a
  crash, a version bump or a concurrent create, and the disk scan wins.
  An id the index names with no file behind it is therefore not returned.
  If `tasks/` cannot be listed at all, a valid index is returned rather
  than failing the call.
- A disagreement also triggers a rebuild of the index from the files just
  scanned — **unless some file could not be parsed**, in which case the
  index is left exactly as it was. Writing one that omits the unreadable
  file is what used to make it disappear from later renders, and it would
  put a write on every read path. So a workspace holding a corrupt task
  file keeps scanning until the file is repaired or removed, and keeps
  reporting it.
- Write-through failures (disk full, permission etc.) emit a single
  `Index update failed; rebuild on next read` warning and the task
  mutation still returns success. The next read repopulates the index
  from disk.
- The index has its own `schema_version`; a version mismatch falls
  through to the rebuild path, so a future bump triggers a forced
  rebuild rather than a silent migration.
- **Concurrent-create caveat**: `createTask` does not hold a per-task
  lock (a new task id is a fresh ULID, so no two creates can race for
  the same id). Two concurrent `createTask` calls can therefore both
  observe the same starting index and overwrite each other's
  write-through update, leaving a structurally valid but
  partially-stale index. That index now disagrees with the directory, so
  the next read scans, returns the truth and rebuilds — the drift is
  self-correcting and needs no manual `rm`. The rebuild on that path
  takes no lock, so it can still overwrite a concurrent write-through
  update; the result disagrees with disk again and is repaired by the
  read after it. A workspace-wide index lock remains a candidate if
  dogfood surfaces a case this does not converge on.
- `basou task reconcile` detects and repairs broken references in
  `created_in_session` and `linked_sessions[]`. The default is dry-run;
  `--write` actually mutates state, and only the write path emits a
  `task_reconciled` event from an ad-hoc session.
- **Semantic shift on reconcile**: when a broken `created_in_session` is
  reconciled, the meaning of the field changes from "session that originally
  created the task" to "current task anchor (= the reconciled session)". The
  original broken `session_id` is preserved in the `task_reconciled` event
  as `removed_created_in_session` for audit purposes.

## §1.3 Recommended `.gitignore` entries

`basou init` appends the following to the workspace's `.gitignore`:

```gitignore
# Basou - default ignore
.basou/logs/
.basou/raw/
.basou/tmp/
.basou/locks/
.basou/status.json
.basou/orientation.md
.basou/sessions/*/events.jsonl
.basou/sessions/*/artifacts/
.basou/approvals/pending/
.basou/approvals/resolved/

# Basou - default commit
# .basou/manifest.yaml
# .basou/handoff.md
# .basou/decisions.md
# .basou/tasks/
# .basou/sessions/*/session.yaml
# .basou/sessions/*/transcript.md
# .basou/sessions/*/changed-files.json
```

**Design principle**: Markdown a human has reviewed is committed; raw logs,
approval originals, and adapter raw output are ignored.

**Local-only mode (`basou init --local-only`)**: writes a single `.basou/`
full-exclude block instead, so the whole trail stays out of version control —
personal/local state, regenerable by re-importing from the agents' own logs.
Use it for a workspace you keep private, and (the same idea) ensure any
**monitored** repo a workspace imports from carries a `.basou/` full-exclude so
basou leaves no committed footprint there. The default above (ignore + commit)
is unchanged; `--local-only` is opt-in. The append stays idempotent: a marker
line **or** a standalone `.basou/` line already present is left untouched.

## §1.4 task-events.log vs. events.jsonl

- **Conceptual name**: `task-events.log` (the legacy term from the original
  design notes).
- **Actual file**: `.basou/sessions/<session_id>/events.jsonl`.
- Separating concept from file name leaves room for a future
  workspace-aggregated log (`.basou/events/task-events.log`).
- basou does not produce an aggregated log.

## §1.5 Concurrency control

basou holds advisory locks at `.basou/locks/<scope>_<ulid>.lock` while
mutating per-task or per-session state. Two scopes exist:

- **per-task lock** (`<locks>/task_<ulid>.lock`): held during the
  read-modify-write window of every task.md mutation
  (`updateTaskStatus`, `editTask`, `deleteTask`, `archiveTask`,
  `reconcileTask`, `refreshTaskLinkedSessions`). This prevents two
  concurrent writers from clobbering each other's `task.md` snapshot
  and serialises the write-through update of `tasks/index.json` for
  the same task. `createTask` is intentionally NOT locked: a fresh
  task id is minted via a new ULID, so no two processes can construct
  the same id and race over it.
- **per-session lock** (`<locks>/session_<ulid>.lock`): held during a
  session.yaml read → events.jsonl append → optional session.yaml
  update window so two writers on the same session cannot duplicate
  events or race on the `task_id` field. The lock is the caller's
  responsibility (`createTask` attach mode, `updateTaskStatus` attach
  mode, `basou decision record --session`, `basou session note`);
  `appendEventToExistingSession` itself holds no lock so callers can
  compose larger critical sections without re-entrant deadlock.

When both locks are held the order is fixed `task → session`, which
keeps cross-API deadlocks impossible.

Locks are file-based (POSIX `link(2)` atomic create). The lockfile
body records the holder's pid and `acquired_at` timestamp so a
competitor can recover from a SIGINT'd CLI run that left the file
behind: if the holder pid is dead (`process.kill(pid, 0)` returns
ESRCH) or the lock is older than one hour, the competitor unlinks
the stale lockfile and retries once.

`.basou/locks/` is gitignored by default.

---

## §2.1 Confirmed invariants

- A **session** is a single uninterrupted unit of AI execution or human work,
  bounded by start and end times.
- A **task** is a goal unit and may bundle multiple sessions.
- 1 task : N sessions is allowed.
- 1 session : 1 task. (1 session : N tasks is **not** allowed.)
- A session may exist without a task (for ad-hoc work).
- A session is bound to a single workspace.

## §2.2 Every event is bound to a session

Every event must belong to some session and is written to
`.basou/sessions/<session_id>/events.jsonl`.

- `task_created` and `task_status_changed` are written to the events.jsonl of
  the session that executed them.
- Creating a task without going through a session is not allowed.
- CLI flows that create a task directly (e.g. `basou task new`)
  implicitly create an ad-hoc session.
- A workspace-aggregated event log is reconsidered in a future release.

## §2.3 Example relationship

```text
task: "Refactor a landing page's contact form"
├── session: 2026-05-04 morning  (requirements review, Claude Code)
├── session: 2026-05-04 midday   (implementation, Claude Code)
├── session: 2026-05-04 evening  (manual review, human)
└── session: 2026-05-05 morning  (revisions, Claude Code)
```

## §2.4 Future extension

If a task ever needs to span multiple workspaces, the task record will gain a
list of workspace IDs:

```yaml
linked_workspaces:
  - ws_xxx
  - ws_yyy
```

This is not implemented.

---

## §3.1 Confirmed invariants

All IDs follow the form **type prefix + ULID**:

```text
ws_01HX...        # workspace
task_01HX...      # task
ses_01HX...       # session
evt_01HX...       # event
appr_01HX...      # approval
decision_01HX...  # decision
```

## §3.2 Rationale

- ULIDs sort chronologically by construction.
- Collision-free in practice.
- The type prefix makes IDs trivially greppable.
- Creation order is recoverable by humans without consulting metadata.

## §3.3 Human-facing labels

A separate `label` field carries the human-facing display name. IDs remain
immutable; labels are user-editable.

```yaml
session:
  id: "ses_01HXABCDEF1234567890ABCDE"
  label: "2026-05-04 morning claude-code"
```
