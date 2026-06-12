# Changelog

All notable changes to **basou** are recorded here. The project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) starting with v0.1.0.

## 0.11.0 — 2026-06-12

### Added

- `basou report generate` — a neutral, point-in-time **work report**: a
  human-readable export explaining the work captured in a workspace (volume and
  active time, decisions, approvals, tasks, changed files, and per-session
  integrity verdicts). It composes the existing read primitives only and
  introduces no new persisted schema. Markdown to stdout by default; `--out
  <path>` writes a file (confirmation on stderr); `--json` emits a curated,
  pipe-safe structured shape; `--title <text>` sets a subject line. A successful
  render always exits 0 — integrity verdicts inside it are informational and
  never fail the command (unlike `basou verify`). The report is an
  "explain your own work" export, not an audit or billing product: the word
  "billable" never appears and the integrity section states internal hash-chain
  consistency only, not a third-party cryptographic proof.
- `@basou/sdk` exposes `Workspace.renderReport(options?)` (returning the report
  markdown), alongside the existing `renderHandoff` / `renderDecisions`
  (`BASOU_SDK_VERSION` → `0.3.0`).

## 0.10.0 — 2026-06-12

### Changed

- **Live event logs are now tamper-evident.** Sessions written through the
  append path — `basou exec` / `run`, ad-hoc `decision` / `note` / `task`, and
  the attach and approval-resolution paths — now hash-chain their
  `events.jsonl` like imported logs do. Each append derives its `prev_hash`
  from the real on-disk tail under a short-lived session lock, and the
  `integrity` head anchor is stamped once, at the terminal-status finalize.
  Sessions created before this change keep their plain unchained logs (never
  half-chained) and still verify as `unchained`. No schema-version bump — the
  `prev_hash` and `integrity` fields already existed.

### Added

- `basou verify` gains the `in_progress` verdict for a still-live (non-terminal)
  session: its internal chain is fully verified while the legitimately growing
  tail and not-yet-written anchor are forgiven (exit 0). A crashed live append
  (an unterminated final line) is benign on a live session and abandons it; a
  later append refuses rather than corrupting the chain.

### Notes

- `verify` stays read-only and lock-free; it re-snapshots once before returning
  a strict `anchor_mismatch`, so verifying a session that is being finalized
  concurrently is not mistaken for tampering.
- Resolving an approval now holds the session lock across the duplicate-check
  fence and the resolution append, closing a pre-existing double-resolution
  race in addition to chaining the resolution line. It also refuses a session
  that is not active (any non-attachable status, not just `imported`), matching
  every other attach path, so a resolution line is never chained onto a
  finalized log.

## 0.9.0 — 2026-06-11

### Added

- **Tamper-evident imported event logs.** `events.jsonl` written by the import
  paths (`basou import`, `basou refresh`, in-place re-import of a grown
  source) now carries a per-line hash chain: each event records `prev_hash`,
  the sha-256 of the previous line's written bytes, with a session-bound
  genesis hash on the first line. `session.yaml` gains an `integrity` head
  anchor (`head_hash` + `event_count`) so tail truncation is detected
  independently. Both fields are additive optional — no schema-version bump;
  existing sessions are unaffected until their next re-import.
- `basou verify [--session <id>] [--all] [--json]` — read-only integrity
  checker. Reports `verified` / `unchained` / `empty` / `incomplete` /
  `tampered` per session and exits non-zero only when something is
  `tampered`. Live / ad-hoc and pre-feature sessions are `unchained`
  (informational).
- The in-place re-import refuses to rebuild a session whose prior chain fails
  verification (skip reason `prior_chain_broken`), so a broken chain cannot be
  laundered into a freshly valid one. `--force` remains the explicit override.
- `basou session rechain (--session <id> | --all) [--dry-run] [--json]` — migrate
  imported sessions created **before** chaining existed: adds the hash chain
  and head anchor **in place**, preserving event ids, order, field sets and
  key order exactly (each original line is re-emitted with only `prev_hash`
  appended), so cross-session references survive — unlike a `--force`
  re-import. Only `imported` sessions are eligible; a `tampered` log is
  refused (no laundering), and any line that cannot be preserved byte-exactly
  skips the session untouched. Rechaining asserts tamper-evidence from now
  on; it does not retroactively prove the prior history.

### Notes

- The chain is **non-cryptographic** tamper-evidence, not a signature: an
  attacker rewriting both `events.jsonl` and `session.yaml` consistently is
  not detected. It raises the bar from "edit one line" to "recompute and
  rewrite two coordinated files". Signing / external anchoring is a possible
  follow-up.
- v1 scope is import-only: live `exec` / `run` / ad-hoc sessions stay
  unchained for now; chaining the live append path is a planned follow-up.

## 0.8.0 — 2026-06-10

### Changed

- Import now keeps an already-imported source **current** instead of skipping it
  unconditionally. When a native log has **grown** since it was imported (an
  append-only transcript the AI resumed), `basou import` / `basou refresh` /
  `basou refresh --watch` re-import it **in place**: the Basou session id is
  preserved, the adapter's events are re-derived, and any human-authored or
  other-source events are kept and merged back in chronological order. Prior
  derived event ids are reused for unchanged derivations, so cross-session
  references (a decision's `linked_events`) stay valid across the re-import.
  Previously a grown source stayed stale until a global `basou refresh --force`.

### Added

- `session.source.source_size_bytes` — the byte size of the source native log at
  import time (additive optional field; no schema-version bump). It is the
  baseline that detects a grown source for in-place re-import.

### Notes

- Change detection is by source byte size: a source that **shrank** (truncated /
  rotated) is not auto-replaced (use `--force`), and a rewrite that leaves the
  size unchanged is not detected. Sessions imported before `source_size_bytes`
  existed carry no baseline and are left untouched until the next `--force`. An
  external id mapped to more than one session (anomalous) is skipped for in-place
  re-import rather than replaced. `--force` is unchanged (full delete + recreate
  under a fresh id).

## 0.7.0 — 2026-06-08

### Added

- `basou refresh --watch [--interval <seconds>]` — keep the workspace current
  automatically instead of re-running `basou refresh` by hand. It does one
  catch-up refresh on start, then polls the native-log stores (`~/.codex/sessions`,
  `~/.claude/projects`) and re-imports + regenerates only when they have settled
  (unchanged since the previous poll, so no session is captured mid-write) AND
  changed since the last import. Handoff / decisions are regenerated only when
  something was actually imported, so unrelated AI work elsewhere never rewrites
  this workspace's files. Polling (default 30s, min 5s) is dependency-free and
  cross-platform; latency is the interval, not real-time. Ctrl-C / SIGTERM stops
  after the in-flight cycle. `--watch` cannot be combined with `--dry-run`,
  `--json`, or `--force`. Because import is idempotent, a session that was
  already imported is not re-imported in watch mode — so a session still active
  when the watcher starts (caught by the start-up catch-up) or one that resumes
  after it settled is captured only up to that point; run `basou refresh --force`
  to rebuild those from the latest logs.
- Multi-root capture — one `.basou/` workspace can now aggregate the native
  logs of several sibling repositories. This matters when a single logical
  project spans multiple checkouts (e.g. an implementation repo, a planning
  repo, and a shared agent working directory): the AI's sessions are recorded
  under whichever directory it ran in, but the provenance belongs to one
  workspace. Two ways to drive it, applied symmetrically to both the
  `claude-code` and `codex` importers (and to `basou refresh`):
  - `--project <path>` is now **repeatable** on `basou import claude-code`,
    `basou import codex`, and `basou refresh`. Each path is a source root to
    scan; passing several unions their sessions into the current workspace
    (deduplicated, so a root listed twice is scanned once). Explicit
    `--project` flags take precedence over the manifest setting below.
  - `manifest.import.source_roots` — an optional, ordered list of source roots
    **relative to the repository root** (e.g. `[".", "../basou-workspace"]`),
    so `basou refresh` with no arguments aggregates every listed repo. The list
    is complete: include `"."` to keep the host repository itself. Absent means
    "the host repository only" (the prior behaviour, unchanged). Absolute
    paths, `~`-expansion, and empty entries are rejected by the schema so the
    committed manifest stays path-clean and machine-portable.
  - `basou init --source-root <path>` (repeatable) seeds `import.source_roots`
    for a new workspace, normalizing each value to a repo-root-relative path.

### Fixed

- `basou import claude-code` and `basou import codex` now reject `--session`
  and `--all` together instead of silently honouring `--session` and ignoring
  `--all`. The selector must be unambiguous: import exactly one transcript or
  every one, never both at once.
- The published `session-import` JSON Schema description no longer mentions a
  `basou session export` command, which does not exist. It now documents only
  `basou session import` as the consumer of the payload.

## 0.6.0 — 2026-06-05

### Added

- `@basou/core` now ships JSON Schema artifacts for the on-disk `.basou/`
  document formats, generated from the canonical Zod schemas (so they cannot
  drift from validation). One schema per document — `manifest`, `session`,
  `event` (a `oneOf` over the event type), `task`, `approval`, `status`,
  `task-index`, and `session-import` — each a draft 2020-12 document with a
  stable `$id` (`https://basou.dev/schemas/0.1.0/<name>.schema.json`). They let
  non-JavaScript / cross-language tooling and editors validate `.basou/` files
  directly. Published under the package's `./schemas/*` export (e.g.
  `@basou/core/schemas/session.schema.json`). Prefixed-id fields carry a faithful
  ULID `pattern`; other refinement-only constraints are not expressible in JSON
  Schema and are omitted. Regenerate with `pnpm --filter @basou/core
  gen:schemas`; a drift-guard test fails CI if the committed files fall behind
  the Zod source.
- `@basou/sdk` v0.2 — the package gains a runtime, read-only programmatic API
  for reading a workspace's provenance (it was types-only before). It is a
  thin, ergonomic, semver-stable facade over `@basou/core`'s readers, so
  third-party tooling can read `.basou/` without stitching low-level calls
  together and without any risk of mutating provenance (no writers are
  exposed). `openWorkspace(repoRoot, options?)` returns a `Workspace` handle —
  `repoRoot` is any directory holding a `.basou/` (no git required);
  `resolveWorkspaceRoot(cwd)` is a git-based convenience for finding it. The
  handle exposes `manifest()`, `status()`, `listSessions()` /
  `getSession(idOrPrefix)`, `readEvents(idOrPrefix)` /
  `streamEvents(idOrPrefix)`, `listTasks()` / `getTask(idOrPrefix)`,
  `listApprovals()` / `getApproval(id)`, `stats(options?)`, and
  `renderHandoff()` / `renderDecisions()`. Session, task, and event lookups
  accept a unique prefix (matching nothing yields `null`, matching more than
  one throws `AmbiguousIdError`); `getApproval` takes an exact id. A missing or
  invalid `.basou/` throws `WorkspaceNotFoundError`. A `now` clock is injectable
  for deterministic reads.
  Read types (`Session`, `Event`, `Task`, `WorkStatsResult`, etc.) are
  re-exported so consumers import only from `@basou/sdk`. `BASOU_SDK_VERSION`
  is now `0.2.0`.
- `session.metrics.machine_active_time_ms` (additive, optional) — model compute
  time: the summed duration of a source's per-turn spans (Codex
  `task_complete.duration_ms`). A SUBSET of a session's active time, kept as a
  separate labeled measure. Unlike `active_intervals` it is a plain sum, NOT
  wall-clock-deduplicated, so two concurrent sessions can sum past their
  billable (union) active wall-clock — intended, as two models working at once
  did two machine-hours in one wall-clock hour. Captured only for sources that
  record per-turn duration (Codex today); absent otherwise. Surfaced as a
  `Model working` line in `basou stats` (and `--by-source` / `--by-day` /
  `--json`), as a `machine` segment on the `basou session show` `Work:` line,
  and in the `basou view` Stats tab. Re-import (`--force`, or `basou refresh`)
  to backfill existing Codex sessions.

### Changed

- Codex active time is now derived from the rollout's real per-turn intervals
  (`task_started` → `task_complete`) for the in-turn portion — the log's true
  wall-clock span, uncapped, and crediting the session's final turn — unioned
  with the gap-capped engagement series for between-turn bridging.
  `active_time_method` is `turn-intervals` for these sessions. The active-time
  SEMANTICS are unchanged (still human-engaged time with idle gaps over 5
  minutes excluded); only the in-turn precision improves, so a re-imported Codex
  session's active time typically rises (long turns are no longer truncated at
  the gap cap, and the final turn is counted). Claude imports are unchanged
  (their transcripts carry no explicit per-turn duration).

## 0.5.0 — 2026-06-04

### Added

- `basou stats` — report how much the AI worked across the workspace's
  sessions. It leads with output VOLUME (model output tokens, plus command /
  file / decision counts), which is the most direct "how much work" signal,
  and reports TIME measures as labeled proxies for billable human harness
  labor, with active time as the billing primary. `Billable active` is the
  UNION of every session's active intervals, so two sessions run concurrently
  do not bill the same wall-clock twice; the naive per-session `Summed` is
  shown alongside only when sessions overlapped. Per-session active time comes
  from each session's genuine engagement series (conversation turns plus action
  events), so design discussion that produced few tool calls is still counted;
  idle gaps over 5 minutes are not credited. `span` (total elapsed) and
  `command` (real shell-execution time) remain as context. Availability is
  tracked per source so the output never silently misleads:
  `claude-code-import` sessions report no shell time, sessions without captured
  engagement fall back to the event stream, and token totals are absent until a
  session is (re-)imported. `--by-source` breaks the totals down by source
  kind; `--by-day` shows the per-day time x volume billing view (bucketed in
  the host timezone); `--json` emits the full structured result. The same
  per-session summary appears as a `Work:` line in `basou session show`, and a
  Stats tab in `basou view`.
- `session.metrics` (additive, optional) — a per-session rollup on
  `session.yaml`. Model usage: `output_tokens` / `input_tokens` /
  `cached_input_tokens` / `reasoning_output_tokens` (Codex-only). Engaged time:
  `active_time_ms`, the merged wall-clock `active_intervals`, and the
  `active_gap_cap_ms` / `active_time_method` methodology lock. Populated at
  import time by the Claude and Codex adapters from the native log (token usage,
  and the engagement timestamps the event stream otherwise discards); absent for
  live `run` / `exec` sessions and for sessions imported before a field existed
  (re-import with `--force`, or `basou refresh`, to backfill).
- `basou refresh` — one command that imports every adapter's native logs for
  the project and regenerates `handoff.md` + `decisions.md`, instead of running
  four commands by hand. Best-effort: an adapter whose source-log directory is
  absent for the project is skipped, not an error (a present-but-empty source
  imports zero sessions). `--project <path>` targets a different project,
  `--force` re-imports, `--dry-run` previews imports and leaves the markdown
  untouched, `--json` prints the structured result.
- `basou view` — a localhost-only web UI (default `http://127.0.0.1:4319`) to
  browse sessions and their event timeline, tasks, decisions, approvals, and
  handoff, and to run imports / regeneration by clicking (the buttons share the
  `refresh` pipeline). `--port <n>` chooses the port, `--no-open` suppresses the
  browser launch. It binds to 127.0.0.1, validates the Host / Origin headers,
  and ships no authentication: a personal cockpit for the author, never to be
  exposed beyond the local machine.
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
- `basou import codex` — derive Basou sessions from OpenAI Codex native
  rollout logs (`~/.codex/sessions/<date>/rollout-*.jsonl`) after the fact.
  Each rollout becomes one imported session carrying `session_started` /
  `session_ended` and `command_executed` (from `exec_command` calls, recorded
  as `bash -c "<line>"`) with the real `exit_code` and `duration_ms` parsed
  from the paired command output. Because Codex stores rollouts by date rather
  than per project, discovery walks the tree and matches each rollout's
  recorded working directory against `--project` (default: the current
  repository root); only sessions started in that project are imported.
  `--all`, `--session <id>`, `--force`, `--dry-run`, and `--json` behave as
  for `import claude-code`. File changes and decisions are not derived: Codex
  applies edits inside `exec_command` (no dedicated edit tool) and has no
  structured question / answer record, so neither has a clean signal to map.
- `codex-import` session `source.kind` (additive enum value) to distinguish
  Codex-rollout-derived sessions from Claude imports and live adapter runs.
- `@basou/cli/program` — a side-effect-free `buildProgram()` (and
  `BASOU_CLI_VERSION`) export. Importing it builds the full command tree
  without parsing `argv` or running the CLI, so tooling can introspect the
  command surface — for example to generate the command reference on
  basou.dev — instead of scraping `--help`.

## 0.4.0 — 2026-05-27

The release that turns the repository into a properly operated public OSS
project. No CLI commands, flags, or on-disk data formats changed; this is
continuous integration, publishing, governance, and dependency hardening on top
of v0.3.1.

### Added

- **Quality CI workflow** — typecheck, build, test, and lint run on every pull
  request.
- **Security CI workflow** — secret scanning (gitleaks), a dependency
  vulnerability audit, and guards against absolute-path and internal-identifier
  leaks in tracked files.
- **OIDC trusted-publishing release workflow** — tag-driven npm publishing with
  provenance and no long-lived tokens, plus a cosign-signed GitHub Release that
  attaches the packed tarballs. Each package's metadata and the pinned Node
  version were prepared for it.
- **Dependabot** for the GitHub Actions and npm ecosystems.
- **ASCII-only commit-message enforcement** in CI.
- **Contributor governance**: `CONTRIBUTING.md` (including the English-only
  convention for commits, pull requests, and issues), `CODE_OF_CONDUCT.md`
  (Contributor Covenant 2.1), bug-report and feature-request issue templates,
  and a pull request template.
- **`docs/release-checklist.md`** with the publish dry-run procedure and the
  first scoped-release evidence.
- The bare-name `basou` redirect package (prepared, not yet published).

### Changed

- Migrated the Biome configuration and reformatted the tree for Biome 2.4.15;
  bumped TypeScript to 6.0.3 and silenced its `baseUrl` deprecation.
- Bumped pinned GitHub Actions (checkout, setup-node, pnpm/action-setup,
  cosign-installer, action-gh-release) via Dependabot.
- Tightened the three published packages' metadata ahead of the first scoped npm
  publish, pointed the README and CONTRIBUTING links at basou.dev (the
  quickstart became a redirect stub), and made the governance-doc security
  contact concrete — a live email, with GitHub Security Advisories documented as
  the private reporting channel.

### Fixed

- Sanitized public-facing internal identifiers and non-English comments out of
  the source and tests ahead of the public publish, and added the CI leak guard
  that scans for them.
- Fixed a pre-existing `package.json` keyword-format lint violation and an
  initial-run failure in the security workflow.

### Tests

Baseline unchanged at 1015 (v0.3.1 close → v0.4.0 close); this release adds CI,
publishing, and governance scaffolding rather than feature tests.

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
