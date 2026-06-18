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

### tasks/ details

- Listing tasks reads `.basou/tasks/index.json` (a small JSON cache of
  id / status / optional label / updated_at). The index is updated
  write-through on every task mutation (`createTask`,
  `updateTaskStatus`, `editTask`, `deleteTask`, `archiveTask`,
  `reconcileTask`, `refreshTaskLinkedSessions`); a missing or
  unparsable index is rebuilt on the next `enumerateTaskIds` call by
  scanning `tasks/` and re-parsing each front matter.
  `tasks/<task_id>.md` remains the sole source of truth — the index is
  a derived cache and never participates in `task reconcile` /
  `task refresh-linkage` invariants.
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
  partially-stale index. The lazy-rebuild path is gated on missing /
  parse / version-mismatch failures, so a stale-but-valid index is not
  auto-recovered. To force a clean rebuild, remove the index
  (`rm .basou/tasks/index.json`) and run any command that calls
  `enumerateTaskIds` (e.g. `basou task list`); a workspace-wide index
  lock remains a candidate if dogfood surfaces this drift.
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
