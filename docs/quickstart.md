# Quickstart

This walkthrough gets you from a fresh checkout to a working
`.basou/handoff.md` in about 30 minutes. It is the recommended
starting point for first-time users — including external reviewers
trialling Basou as part of v0.3.0 dogfooding.

## What you will end up with

```text
your-project/
├── .basou/
│   ├── manifest.yaml
│   ├── sessions/<session_id>/
│   │   ├── session.yaml
│   │   ├── events.jsonl
│   │   └── transcript.md
│   ├── tasks/
│   │   ├── <task_id>.md
│   │   └── index.json
│   ├── handoff.md
│   └── decisions.md
└── (your source code, unchanged)
```

You will know it worked when `cat .basou/handoff.md` shows your task
and session in a readable Markdown table.

## 0. Prerequisites

- **Node.js**: 20.10.0 or newer (`node --version`)
- **pnpm**: 8.15.0 or newer (`pnpm --version`)
- **Git**: any modern version (`git --version`)
- **OS**: macOS or Linux. Windows is not a v0.3 target.

If `pnpm` is missing: `npm install -g pnpm` (or use Corepack:
`corepack enable && corepack prepare pnpm@latest --activate`).

## 1. Build Basou from source

```bash
git clone https://github.com/basou-dev/basou.git
cd basou
pnpm install
pnpm -r build
```

The build takes 30–60 seconds on a recent laptop. `pnpm test` (≈ 15
seconds) is a useful sanity check — at v0.3.0 you should see
**1014 tests pass** across `@basou/core`, `@basou/cli`, and
`@basou/sdk`.

Make the `basou` command available globally:

```bash
pnpm --filter @basou/cli link --global
basou --version    # → 0.3.0
```

If `basou --version` errors with "command not found", check that the
pnpm global bin directory is on your `$PATH`:

```bash
pnpm config get global-bin-dir   # e.g. /Users/<you>/Library/pnpm
# Add the printed path to your shell rc file if missing.
```

## 2. Initialize a Basou workspace

```bash
cd /path/to/your/git-repository
basou init
```

Output:

```text
Initialized Basou workspace: ws_01HXB...
```

`basou init` is idempotent on an already-initialised workspace — it
will refuse to overwrite the manifest unless you pass `--force`.

Take a look at what was created:

```bash
ls .basou/
# approvals  locks  logs  manifest.yaml  raw  sessions  tasks  tmp
```

Only the directory skeleton plus `manifest.yaml` exist right after
`basou init`. The commit-friendly Markdown files (`handoff.md`,
`decisions.md`) and the local-only state file (`status.json`) appear
once you run their generators (`basou handoff generate`,
`basou decisions generate`, `basou status`), which you'll do in §6.

The default `.gitignore` block was appended to your repo's
`.gitignore` so logs / raw output / locks stay local; `manifest.yaml`,
`handoff.md`, `decisions.md`, and `tasks/` are commit-friendly.

## 3. Record your first task

```bash
basou task new --title "Refactor login form"
```

Output:

```text
Created task_01HXC... in ad-hoc session 01HXC...
  Title:  Refactor login form
  Status: planned
  Label:  (none)
```

`basou task new` mints a new task plus a fresh "ad-hoc" session that
fires the `task_created` event. The short session id (= ULID part
without the `ses_` prefix) is what most other commands accept as an
identifier shortcut. Look at what got recorded:

```bash
basou task list
# SHORT_ID                    STATUS   CREATED_AT                 LINKS  LABEL   TITLE
# 01HXC...                    planned  2026-05-21T12:34:56+09:00  1      (none)  Refactor login form

basou task show task_01HXC...
```

```text
Task: task_01HXC...
  Title:       Refactor login form
  Status:      planned
  Label:       (none)
  Created at:  2026-05-21T...
  Updated at:  2026-05-21T...
  Workspace:   ws_01HXB...

Linked sessions (1):
  ses_01HXC...  (completed)

Description:
(no description)

Events: 1 total

Last 1 events:
  2026-05-21T... [local-cli]  task_created             Refactor login form
```

## 4. Record a decision

```bash
basou decision record --title "Refactor handleLogin into a hook"
```

Output:

```text
Recorded decision_01HXD... in ad-hoc session 01HXD...
```

(Add `--rationale "why this approach"` to see the rationale echoed
on the same line: `Recorded ... (rationale: why this approach)`.)

`basou decision record` mints a fresh ad-hoc session and fires a
`decision_recorded` event. On the next `basou decisions generate`
the decision is appended to `.basou/decisions.md`. Optional
`--rationale` / `--alternatives` / `--rejected-reason` /
`--linked-events` / `--linked-files` flags persist into the same
event and render into the decisions.md row.

If you already have a running session (e.g. inside a
`basou run claude-code` block in another terminal — see §7), you can
attach the decision to it with `--session <short-id>`; otherwise
`basou decision record` always creates a fresh ad-hoc session, so
this command works in any state.

> **Why not `basou session note`?** `session note` is the
> "attach a free-form note to a live session" command and only
> accepts sessions in `initialized` / `running` /
> `waiting_approval` status. The ad-hoc sessions minted by
> `task new` and `task status` are already `completed` by the time
> you see them, so a quickstart that only uses task / decision
> commands does not have an attachable target. See §7 for the
> `basou run` flow that does.

## 5. Update the task status as you make progress

```bash
basou task status task_01HXC... in_progress
# Updated task_01HXC... status: planned -> in_progress (in session 01HXC...)

basou task status task_01HXC... done
# Updated task_01HXC... status: in_progress -> done (in session 01HXC...)
```

Each `basou task status` call mints a fresh ad-hoc session that fires
exactly one `task_status_changed` event. The `task.md` snapshot is
overwritten atomically, and the new session id is appended to
`task.md.linked_sessions[]`.

## 6. Generate the handoff

```bash
basou handoff generate
```

Output:

```text
Generated .basou/handoff.md (sessions: 4, tasks: 1, decisions: 1, pending approvals: 0)
```

The exact counts depend on what you did above; the line above
matches the §3-§5 walkthrough (= one ad-hoc session per `task new`
+ one per `decision record` + two per `task status` = 4).

`.basou/handoff.md` is generated Markdown wrapped in
`<!-- BASOU:GENERATED:START -->` / `<!-- BASOU:GENERATED:END -->`
markers. Anything you write **outside** the markers is preserved
across regenerations, so you can hand-edit narrative context above
or below the generated block and it survives. Inside the markers
you'll find roughly this layout:

```markdown
<!-- BASOU:GENERATED:START -->
# Handoff

> Generated at 2026-05-21T... from ses_01HXC...01HXC...

## 現在の状態

- 最終 session: ses_01HXC... (completed)
- 最終 task: task_01HXC... (done): Refactor login form (linked_sessions: 3)

## 直近の変更ファイル

(no related files recorded)

## 直近の判断

- decision_01HXD...: Refactor handleLogin into a hook

(1 decisions total — see decisions.md)

## 未決事項

(none)

## 次に読むべきファイル

- .basou/decisions.md

## 次に実行すべき作業

(no pending tasks)

## セッション一覧

| short_id | status | started_at | label |
|---|---|---|---|
| 01HXEJ4F | completed | 2026-05-21T... | Ad-hoc task status: Refactor ... |
| 01HXEJ2P | completed | 2026-05-21T... | Ad-hoc task status: Refactor ... |
| 01HXEHHS | completed | 2026-05-21T... | Ad-hoc decision: Refactor ...    |
| 01HXDZGT | completed | 2026-05-21T... | Ad-hoc task: Refactor login form |

Sessions: 4 (completed 4). Tasks: 1.
<!-- BASOU:GENERATED:END -->
```

What the generated block tells you:

- **`## 現在の状態`** — the latest task line is driven by the most
  recent `task_status_changed` event (with a `(linked_sessions: N)`
  suffix when more than one session has touched the task).
- **`## 直近の変更ファイル`** — union of `related_files[]` across
  live sessions, sanitized (= `imported` sessions are excluded so a
  backfill cannot bury today's work). Empty here because the
  quickstart did not run any `basou run` / `basou exec` commands.
- **`## 直近の判断`** — recent decisions; full list lives in
  `.basou/decisions.md` after `basou decisions generate`.
- **`## 次に実行すべき作業`** — `planned` / `in_progress` tasks
  only. Terminal-status tasks (`done` / `cancelled`) are excluded,
  so this section is `(no pending tasks)` once you've marked the
  one task `done`.
- **`## セッション一覧`** — every non-`imported` session, newest
  first. Imported sessions live in a separate
  `### Imported sessions` subsection (= empty in the quickstart).
- **Sessions footer** — `Sessions: N (completed K, failed M, ...)`.

Have a look at the actual file:

```bash
cat .basou/handoff.md
```

## 7. Optional: wrap a Claude Code session

If you have the `claude-code` CLI installed, you can have Basou wrap
an entire AI-assisted session:

```bash
basou run claude-code -- "Help me extract handleLogin into a hook"
```

Basou:

1. Records `session_started` + pre-run `git_snapshot` (= the dirty
   files at session start).
2. Spawns the child `claude-code` process unchanged; its stdout/stderr
   passes through.
3. After exit, records `session_ended` + post-run `git_snapshot` +
   one `file_changed` event per file that moved between the two
   snapshots.
4. Updates `session.yaml.related_files[]` with the union of changed
   files, sanitized so no operator-private absolute path is stored.

The session id printed at start is what you pass to
`basou session show <id>` for the post-mortem view.

## 8. What's next

- `basou decision record --title "..."` to capture a deliberate
  decision tied to a session — output flows into `.basou/decisions.md`
  on the next regeneration.
- `basou task reconcile --task <id>` to audit broken
  `created_in_session` / `linked_sessions[]` references (dry-run by
  default; pass `--write` to actually repair).
- `basou session import --format json --from path/to/payload.json` to
  round-trip a session from another workspace; v0.3 sanitizes any
  absolute paths in the imported `related_files[]` and
  `working_directory` and emits a `Imported session: N path(s)
  sanitized` warning to stderr.
- `basou status` for a single-line "what's open right now" snapshot.

The full CLI surface lives in [docs/spec/cli-commands.md](spec/cli-commands.md).
For the underlying data model, start with
[docs/spec/workspace.md](spec/workspace.md) and
[docs/spec/schemas.md](spec/schemas.md).

## Troubleshooting

### `basou: command not found`

`pnpm --filter @basou/cli link --global` did not put the binary on
your `$PATH`. Check `pnpm config get global-bin-dir` and add the
printed path to your shell rc file.

### `Not a git repository. Run 'git init' first, then re-run 'basou init'.`

`basou init` and most subsequent commands require a Git repository
root. Run `git init` first if your project is not yet under version
control.

### `Already initialized. Use --force to overwrite.`

Re-running `basou init` against an existing `.basou/` exits with
this message rather than silently overwriting. Pass `--force` only
if you want to mint a fresh `manifest.yaml` (= `workspace_id`
regenerated, losing the previous identity).

### `basou status` shows "Basou version: 0.1.0" but `basou --version` shows 0.3.0

These are two different versions: `basou --version` is the **release
version** of `@basou/cli` (`0.3.0`), while the line in `basou status`
output is the **spec version** (`basou_version` in
`.basou/manifest.yaml`), which is locked to `0.1.0` because the v0.3
release ships no data-format breaking changes. The label is
genuinely confusing — slated for re-wording in a future release.

### `Lock is held by another process`

Another `basou` command is mutating the same task or session. Wait
for it to finish; if no other instance is running, the lockfile may
be stale — see [docs/spec/workspace.md](spec/workspace.md) §1.5 for
the recovery procedure (the next acquire auto-recovers when the
holding PID is dead or the lockfile is older than one hour).

### `Index update failed; rebuild on next read`

A write-through update to `.basou/tasks/index.json` failed; the
underlying `task.md` is still authoritative. Run `basou task list`
once to trigger a rebuild. If you suspect drift after concurrent
`basou task new` calls, `rm .basou/tasks/index.json && basou task
list` force-rebuilds from disk.

### Reporting other friction

External reviewers: please collect friction as a short text note
(scenario / expected / actual / proposed fix) and pass it back to
the project maintainer. v0.3 dogfooding feedback is the only path
that can promote a deferred item into a v0.3.x patch.

## Sanity-check checklist

Before reporting feedback, please confirm:

- [ ] `basou --version` prints `0.3.0`
- [ ] `pnpm test` is green at the tip of `main`
- [ ] You ran the walkthrough end-to-end at least once (= `basou init`
      → `task new` → `session note` → `task status` → `handoff
      generate`)
- [ ] You looked at `.basou/handoff.md` and at least one
      `sessions/<id>/session.yaml`

If any of the four fails, that's a higher-priority bug than the
friction you would otherwise report — please mention which one.
