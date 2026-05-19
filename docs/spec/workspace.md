# Workspace, sessions, tasks, IDs

This document covers the basic objects basou records and how they are laid
out on disk.

## §1.1 Confirmed invariants

- `.basou/` is placed at the **Git repository root**.
- The v0.1 baseline is **one repository = one workspace**.
- monorepo / subproject support is out of scope for v0.1.
- A session is **bound to a single workspace**. Cross-repository work is
  split across separate sessions.
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
│   └── <task_id>.md         # source of truth (YAML front matter + body)
├── approvals/
│   ├── pending/
│   │   └── <approval_id>.yaml
│   └── resolved/
│       └── <approval_id>.yaml
├── decisions.md             # generated + manually appendable
├── handoff.md               # generated + manually appendable
├── logs/                    # gitignored
├── raw/                     # gitignored (adapter raw output, etc.)
└── tmp/                     # gitignored
```

### tasks/ details

- v0.1 does not implement `tasks/index.json`. Listing tasks scans `tasks/`
  and parses each front matter; index.json is reconsidered in a future
  release as a performance optimization.
- In v0.2, `basou task reconcile` detects and repairs broken references in
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
.basou/status.json
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

## §1.4 task-events.log vs. events.jsonl

- **Conceptual name**: `task-events.log` (the legacy term from the original
  design notes).
- **v0.1 actual file**: `.basou/sessions/<session_id>/events.jsonl`.
- Separating concept from file name leaves room for a future
  workspace-aggregated log (`.basou/events/task-events.log`).
- v0.1 does not produce an aggregated log.

---

## §2.1 Confirmed invariants

- A **session** is a single uninterrupted unit of AI execution or human work,
  bounded by start and end times.
- A **task** is a goal unit and may bundle multiple sessions.
- 1 task : N sessions is allowed.
- 1 session : 1 task. (1 session : N tasks is **not** allowed in v0.1.)
- A session may exist without a task (for ad-hoc work).
- A session is bound to a single workspace.

## §2.2 Every event is bound to a session

In v0.1, every event must belong to some session and is written to
`.basou/sessions/<session_id>/events.jsonl`.

- `task_created` and `task_status_changed` are written to the events.jsonl of
  the session that executed them.
- Creating a task without going through a session is not allowed in v0.1.
- CLI flows that create a task directly (e.g. `basou task create`)
  implicitly create an ad-hoc session.
- A workspace-aggregated event log is reconsidered in v0.2 or later.

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

This is not implemented in v0.1.

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
