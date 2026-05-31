# Changelog

All notable changes to **basou** are recorded here. The project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) starting with v0.1.0.

## Unreleased

### Added

- `basou import claude-code` — derive Basou sessions from Claude Code native
  transcripts (`~/.claude/projects/<encoded-cwd>/*.jsonl`) after the fact,
  rather than wrapping a live process. Each transcript becomes one imported
  session carrying `session_started` / `session_ended`, `command_executed`
  (from `Bash` tool uses, recorded as `bash -c "<line>"`), and `file_changed`
  (from `Edit` / `Write` / `NotebookEdit` tool uses). `--all` imports every
  transcript for a project, `--session <id>` imports one, and `--dry-run`
  previews without writing. Transcripts with no observable command / file
  action are skipped. Imports reuse the existing `session import` pipeline,
  so path sanitization and id minting are unchanged. Re-running an import is
  idempotent: a transcript already imported is skipped rather than duplicated.
  Imported sessions are labelled with a human summary
  (`claude-code <date>: <n> commands, <m> files`) instead of the raw session
  id, so they read as content in `basou session list` and the handoff.
- `claude-code-import` session `source.kind` (additive enum value) to
  distinguish transcript-derived sessions from live `claude-code-adapter`
  runs and Basou-format `import`s.
- `session.source.external_id` (additive, optional) — records the originating
  session id in the source tool's namespace (e.g. the Claude Code session
  UUID), the key that makes re-imports idempotent.

## 0.3.1 — 2026-05-21

A small follow-up that picks two paper-cut issues out of the v0.3.0
post-release observation lane. No CLI surface or data-format changes;
upgrading from v0.3.0 is a `pnpm install && pnpm -r build` away.

### Fixed

- `basou --version` now reads from `packages/cli/package.json` at
  runtime instead of a hardcoded constant. The v0.2.0 and v0.3.0
  releases both shipped with `basou --version` still printing `0.1.0`
  because the constant was never bumped alongside the package version;
  the dynamic read closes that drift class permanently, and a new
  `src/index.test.ts` integration test now exec's the built CLI and
  asserts the printed version matches `package.json`.

### Changed

- `basou status` renames the human-readable label `Basou version:` to
  `Spec version:` so it no longer collides with the release-version
  semantics of `basou --version`. The underlying JSON field
  (`workspace.basou_version`) is unchanged, so JSON consumers are
  unaffected; only the text-mode label moves.

### Tests

Baseline grew from 1014 (v0.3.0 close) → 1015 (v0.3.1 close), +1 for
the version-drift guard test.

## 0.3.0 — 2026-05-21

This release focuses on the three workflow gaps surfaced during v0.2
dogfooding: handoff rendering rough edges, the lack of strict isolation
between concurrent writers, and the absolute paths v0.2 was happy to write
into `.basou/`. UX, concurrency, and security each ship as a self-contained
cluster so a downstream consumer can opt out of any one without breaking
the rest.

### Improved handoff rendering (UX)

- `handoff.md` "latest task" line is now driven by the most recent
  `task_status_changed` event rather than the most recent
  `task_created`. A `done` task that finished after a long-running
  `planned` task no longer disappears from the latest-activity slot;
  the fallback to `task_created` still applies when no status-change
  event exists yet.
- The latest task line gains a `(linked_sessions: N)` suffix when more
  than one session has touched the task, so the operator sees breadth
  at a glance.
- The footer's `Sessions: N` is split by status: `Sessions: N
  (completed K, failed M, running L, ...)` for any status with a
  non-zero count.
- Import sessions (`session.source.kind === "import"`) are now broken
  out into their own `### Imported sessions` table and excluded from
  the `## 直近の変更ファイル` union so live work is not buried under
  a back-fill.

### Concurrency

- Added an advisory lockfile helper at `packages/core/src/storage/
  lockfile.ts` (POSIX `link(2)` atomic create, PID-based stale
  detection with a 1h age fallback). Lockfiles live at
  `.basou/locks/<scope>_<ulid>.lock` and are gitignored.
- Per-task lock now guards the read-modify-write window of
  `updateTaskStatusWithEvent`, `reconcileTask`,
  `refreshTaskLinkedSessions`, `editTask`, `deleteTask`, and
  `archiveTask`. `createTaskWithEvent` is intentionally not locked
  (= a fresh task id is a fresh ULID; no two creates can race for the
  same id).
- Per-session lock now guards the events.jsonl append + surrounding
  session.yaml mutation at every caller of
  `appendEventToExistingSession` (= attach-flavoured task commands,
  `basou decision record --session`, `basou session note`). The lock
  is caller-owned to avoid re-entrant deadlock against
  `appendEventToExistingSession` itself.
- `task → session` is the fixed acquisition order whenever both locks
  are held (= attach-flavoured task paths). Cross-API deadlocks are
  thereby impossible by construction.
- Added a workspace-scoped task index at `.basou/tasks/index.json`
  (small JSON cache of id / status / label / updated_at). Maintained
  write-through on every task mutation; rebuilt from disk on missing,
  parse-broken, or version-mismatched index. `enumerateTaskIds` now
  reads the index on the hot path so `basou task list` no longer
  re-parses every front matter for the id list alone.
- Index updates are best-effort: a write failure (disk full, EACCES)
  surfaces as a single `Index update failed; rebuild on next read`
  warning and the task mutation still returns success. The next
  enumerate rebuilds from disk. Concurrent `createTask` calls can
  produce a stale-but-valid index (= the lazy-rebuild trigger does
  not fire on a structurally valid cache); `rm
  .basou/tasks/index.json && basou task list` force-rebuilds. See
  `docs/spec/workspace.md` §1.2 for the recovery procedure.

### Security

- Added a path sanitizer at `packages/core/src/lib/path-sanitizer.ts`
  with three exports: `sanitizePath`,
  `sanitizeWorkingDirectory` (sentinel-based variant for the field
  itself), and `sanitizeRelatedFiles`.
- The two-rule rewrite is: workingDirectory-internal paths become
  repo-relative; homedir-internal paths become tilde-prefixed
  (`/Users/<u>/projects/foo/x.ts` → `~/projects/foo/x.ts`). System
  paths outside both bases (e.g. `/etc/...`) are preserved verbatim
  so an operator that deliberately recorded a system file is not
  redacted by surprise.
- Hardening: null-byte input is rejected with `Invalid path:
  contains null byte`; backslashes are folded to forward slashes
  (v0.3 targets macOS / Linux; full Windows support is a v0.4+
  task). `..`-escapes are normalised purely before prefix matching
  so an input like `<wd>/../escape/x.ts` cannot masquerade as
  workspace-internal.
- Sanitization is applied on the write side at every caller —
  `basou run claude-code`, `basou exec`, every ad-hoc session path
  (task new / status / reconcile / refresh-linkage / delete /
  archive / decision / note), and `basou session import`.
- `basou session import` emits a single `Imported session: N
  path(s) sanitized (related_files: K, working_directory: 0|1)`
  warning to stderr when at least one field was rewritten. The
  import itself still succeeds; the warning fires for `--dry-run`
  too so the operator can preview the rewrite before committing.
- `basou session show` displays sanitized relative
  `working_directory` values verbatim instead of trying to make
  them relative against the repo root a second time, with the one
  literal `.` collapsing to `<repository_root>`.
- Backward compatibility: existing `session.yaml` files written
  before v0.3 are NOT retroactively rewritten. A future v0.4+
  release may introduce `basou session migrate` for that.

### New CLI surface

- (No new top-level commands; v0.3 is an internal hardening pass.
  The new behaviour is reachable through the existing CLI surface.)

### Spec updates

- `docs/spec/workspace.md` §1.2 — documents `tasks/index.json`
  semantics (write-through, lazy rebuild, source-of-truth invariant,
  concurrent-create caveat with the force-rebuild recovery procedure).
- `docs/spec/workspace.md` §1.3 — `.basou/locks/` added to the
  default ignore block.
- `docs/spec/workspace.md` §1.5 (new) — per-task and per-session
  lock scopes, PID-based stale detection with the 1h age fallback,
  the fixed task → session acquisition order, and the
  `createTask` exemption.
- `docs/spec/schemas.md` §5.1 / §5.2 — the `working_directory`
  example flips to a sanitized form; §5.2 documents the two-rule
  sanitizer, the working-directory-specific sentinel skip, the
  null-byte / backslash hardening, the session-import warning
  format, and the backward-compat invariant.

### Tests

Baseline grew from 923 (v0.2.0 close) → 1014 (v0.3.0 close), a
`+91` spread across the three clusters:

- UX: `+9` covering the four handoff renderer changes
  plus a `task_status_changed`-without-`task_created` fallback case.
- Concurrency: `+53` covering the lockfile helper
  (PID / age / EPERM / null / null-bytes), per-task and per-session
  lock contention, the task-index schema and helper, and the
  write-through integration with the existing task APIs.
- Security: `+29` covering each rewrite rule (with
  `..`-escape and prefix-preference cases), the sanitize-then-
  warn flow on import, `--dry-run` warning visibility, and the
  display-side `~/...` / `.` / repo-relative formatting.

`pnpm typecheck` / `pnpm -r build` / `pnpm -r test` / `pnpm lint`
are green at the tip of `main`.

### Notes

- v0.3.0 is OSS-publish ready as a standalone release. NDA case
  introduction is independently gated on out-of-tree feedback from
  external dogfood (5 sessions); release notes for downstream users
  should wait on that lane.
- Adapter UX (claude-code wrap, terminal-recording precmd hook,
  session pause/resume) was sized for this release but deferred
  pending further dogfood signal. It is a v0.3.x candidate rather
  than a v0.4 prerequisite.

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
  comments so the public repository stays independent of the private
  planning repository.

### Tests

Baseline grew from 720 → 923 (v0.2.0 close), a `+203`
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

This repository is intended to operate as a standalone codebase.
