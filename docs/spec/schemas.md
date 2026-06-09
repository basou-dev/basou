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
  repository_url: null  # optional

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
```

## §4.2 Notes

- `approval.required_for` includes `external_send` as reserved because
  detection is currently limited.
- `capabilities.enabled` is heterogeneous in granularity; it is kept as-is
  for now and may be normalized in a later release.
- The schema reserves room for `providers:` / `policies:` / `teams:` /
  `review_flows:` to extend in the future (currently unused).

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
```

## §5.2 Notes

- `invocation.command` must record the **actual spawned executable name**.
  Claude Code may resolve to `claude-code` or `claude` depending on the
  environment, so the resolved command name is stored.
- `related_files` is populated from the git capability at session end. The
  initial value is an empty array.
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
  contains null byte`; Windows-style backslashes are folded to forward
  slashes (basou targets macOS / Linux; full Windows support is a future
  task).
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
  on request.

---

## §7.1 Common event fields

```json
{
  "schema_version": "0.1.0",
  "type": "<event_type>",
  "id": "evt_01HXEVTID...",
  "session_id": "ses_01HXSESSID...",
  "occurred_at": "2026-05-04T09:00:00+09:00",
  "source": "<source>"
}
```

Every event carries a `session_id` (see [Workspace, sessions, tasks, IDs
§2.2](workspace.md#22-every-event-is-bound-to-a-session)).

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
| Adapter | `adapter_output` | adapter output (summary only; raw kept separately) |

## §7.3 Extension rules (no breaking changes)

- New event types may be added; required-field changes to existing types are
  forbidden.
- Adding optional fields to existing types is allowed.
- Changing a field's meaning is forbidden (introduce a new type instead).
- When `schema_version` is bumped, a migration script must be provided.

## §7.4 `adapter_output` constraint (important)

The `adapter_output` event **must not embed raw output** directly. Raw
content (`content`, `body`, `raw`, etc.) belongs in
`.basou/raw/<session_id>/` and is referenced via `raw_ref`:

```json
{
  "schema_version": "0.1.0",
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
