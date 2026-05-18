# Changelog

All notable changes to **basou** are recorded here. The project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) starting with v0.1.0.

## 0.2.0 — 2026-05-18

This release strengthens the v0.1 task-lifecycle foundation with broken-ref
recovery, snapshot-vs-events sync, full task-lifecycle CLI surface, audit-rich
decisions, and the validation needed to safely import sessions across
workspaces. Two small internal-API renames are flagged as breaking.

### Breaking changes

- `FailedToFinalizeError.decisionEventId` was renamed to `targetEventId` in
  v0.2 development, then further generalised to `targetEventIds` (a
  non-empty `ReadonlyArray<EventId>`) so a single ad-hoc session that fires
  multiple target events (e.g. `task new --status done`) carries every
  minted id on the error. CLI callers that read the first anchor should use
  `targetEventIds[0]`.
- `createAdHocSessionWithEvent`'s `targetEventBuilder: (sessionId, eventId)
  => Event` is replaced by `targetEventBuilders:
  ReadonlyArray<(sessionId, eventId) => Event>`. Existing single-target
  callers wrap their builder in a one-element array (`[builder]`).
  `CreateAdHocSessionResult.targetEventId` is similarly renamed to
  `targetEventIds: PrefixedId<"evt">[]`.

Both renames are observable only on direct programmatic users of
`@basou/core`; CLI users are unaffected.

### New CLI surface

- **Broken-ref recovery**: `basou task reconcile [--task <id>] [--write]
  [--json] [-v]` — dry-run audit of `task.md.created_in_session` and
  `linked_sessions[]` against the live session directory; `--write` mints
  an ad-hoc reconcile session, fires `task_reconciled`, and repairs the
  task.md snapshot. `--task` limits the scan to one task; the default
  scans every task and exits 1 on any per-task failure.
- **Forward sync (events → task.md)**: `basou task refresh-linkage
  <task_id> [--write]` re-derives `linked_sessions[]` from
  `session.yaml.task_id` matches across the workspace plus the
  `created_in_session` anchor, fires `task_linkage_refreshed`, and
  overwrites the snapshot. Distinct from reconcile so each audit event
  carries a single, focused story.
- **Lifecycle CLI**: `basou task edit <task_id> [--title <text>] [--status
  <status>]` (title rewrite without an event; status routed through
  `task_status_changed`), `basou task delete <task_id> [--yes]` (hard
  delete with `task_deleted` audit event), `basou task archive <task_id>
  [--yes]` (move to `.basou/tasks/archive/` with `task_archived` audit
  event). Both destructive subcommands prompt for confirmation by default
  and refuse to run on a non-TTY stdin without `--yes`.
- **Retroactive task creation**: `basou task new --status done|cancelled
  [--completed-at <iso>]` records terminal-status tasks in one call. The
  orchestrator emits `task_created` plus a follow-up
  `task_status_changed (planned → terminal)` in the same ad-hoc session
  so the audit trail captures the implicit transition. `--completed-at`
  affects only `task.md.updated_at`; event timestamps stay at recording
  time so the lifecycle ordering invariant holds.
- **Status transition shortcuts**: `basou task status <id> done` and
  `basou task status <id> cancelled` now succeed directly from
  `planned`. The 1 transition = 1 event invariant is preserved.
- **Read-only archive surface**: `basou task list --include-archived`
  scans `<paths.tasks>/archive/` in addition to the main directory and
  prefixes rows with `[archived]`. `basou task show <task_id>` falls
  back to the archive directory and tags the header with `[archived]`.
- **Decision rich fields**: `basou decision record --rationale <text>
  --alternatives <text>... --rejected-reason <text> --linked-events
  <id>... --linked-files <path>...` (all optional) persist into the
  `decision_recorded` event and render into `.basou/decisions.md`.
  Linked-events / linked-files are treated as opaque references —
  missing targets surface inline as `(missing)` so cross-workspace
  round-trips never reject parse-time.

### New events

- `task_reconciled` (`.strict()`) — fired by `task reconcile --write`,
  carries `task_id`, optional `removed_created_in_session`,
  `created_in_session_replacement`, `removed_linked_sessions`.
- `task_linkage_refreshed` (`.strict()`) — fired by `task
  refresh-linkage --write`, carries `task_id`, optional
  `added_linked_sessions`, `removed_linked_sessions`, `final_count`.
- `task_deleted` (`.strict()`) — fired by `task delete --yes`, carries
  `task_id` + last-known `title`. No tombstone; this event is the only
  persistent record after the unlink succeeds.
- `task_archived` (`.strict()`) — fired by `task archive --yes`,
  carries `task_id` + last-known `title`. Session.yaml's `task_id` is
  pinned because the task continues to exist at the new path.
- `decision_recorded` schema gains five optional rich fields described
  above; v0.1-shape payloads (= core 4 fields only) round-trip
  unchanged.

### Stricter validation

- `basou session import` now refuses any payload whose `task_id` carrier
  events (`task_created` / `task_status_changed` / `task_reconciled` /
  `task_linkage_refreshed` / `task_deleted` / `task_archived`) — and the
  effective `session.task_id` override-wins value — reference a task
  that does not exist in the target workspace. Pathless rejection
  message: `Imported session references unknown task_id`.
- Direct programmatic callers of `createTaskWithEvent` get a boundary
  parse on `completedAt` (ISO-8601 shape) before any event is written,
  so a malformed timestamp cannot leave durable events with no valid
  task.md.

### Internal refactor

- Atomic file helpers `atomicCreate` / `atomicReplace` extracted into
  `packages/core/src/storage/atomic.ts` and reused across the storage
  layer (tasks, manifest, status, markdown).
- CLI `render*Error` wrappers consolidated into
  `packages/cli/src/lib/error-render.ts`, dedup-ing the pathless-contract
  surface across `task` / `session` / `approval` / `decision` / `exec` /
  `run` / `handoff` / `decisions` / `init` / `status`.
- ad-hoc label cap raised from 40 to 80 characters so long task and
  reconcile titles retain their core information; the cap applies
  consistently across `Ad-hoc task:`, `Ad-hoc task status:`, `Ad-hoc
  task reconcile:`, `Ad-hoc task refresh-linkage:`, `Ad-hoc task
  delete:`, `Ad-hoc task archive:`, and `Ad-hoc decision:` labels.
- Multi-target event support inside `createAdHocSessionWithEvent` (= the
  one-pass atomic write now accepts N target events between the lifecycle
  status-change pair).
- Planning-document identifiers removed from public source / tests /
  comments per the repo's AGENTS.md rule that the public repository stay
  independent of basou-planning.

### Tests

Baseline grew from 720 (Y-3t close) → 923 (v0.2.0 close), a `+203`
spread across the new events, the new CLI subcommands, the validation
strengthening, and the refactors above. `pnpm typecheck` / `pnpm -r
build` / `pnpm -r test` / `pnpm lint` are green at the tip of `main`.

## 0.1.0 — 2026-05-13

Initial release covering the v0.1 MVP scope:

- `basou init` workspace bootstrap (`.basou/` directory layout,
  `manifest.yaml`).
- Session lifecycle CLI (`basou session start` / `session list` /
  `session show` / `session note`).
- Task lifecycle CLI (`basou task new` / `task list` / `task show` /
  `task status`).
- Decision recording CLI (`basou decision record`) with the v0.1
  4-field shape.
- Approval CLI (`basou approval list` / `approval show` /
  `approval approve` / `approval reject`).
- Command execution recording (`basou exec`) and adapter passthrough
  (`basou run claude-code`).
- Markdown handoff and decisions auto-generation (`basou handoff
  generate`, `basou decisions generate`).
- Session import (`basou session import --format json`).
- Status snapshot (`basou status`).

Specification source of truth lives in the planning repository; the public
repo stays standalone per the AGENTS.md regulations.
