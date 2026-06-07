# Session lifecycle, terminal recording, import

This document covers three related areas: the session lifecycle (including
the `imported` terminal state), the v0.1 terminal-recording strategy, and
the v0.1 import surface.

## §6.1 Session lifecycle states

| State | Meaning |
|---|---|
| `initialized` | `session.yaml` exists but execution has not started |
| `running` | execution in progress |
| `waiting_approval` | an `approval_requested` event has been emitted; awaiting response |
| `completed` | normal termination |
| `failed` | abnormal termination (non-zero exit code or exception) |
| `interrupted` | user interrupted (e.g. Ctrl+C) |
| `imported` | imported from an external source; basou did not run the session |
| `archived` | compressed historical session; **not implemented in v0.1** (the value is reserved) |

## §6.2 Transition diagram

```text
initialized --> running
running --> waiting_approval
waiting_approval --> running       (approved)
waiting_approval --> interrupted   (rejected and user-interrupted)
running --> completed
running --> failed
running --> interrupted
imported   (independent terminal state; does not transition)
archived   (not implemented in v0.1)
```

## §6.3 Notes

- v0.1 does **not** guarantee automatic resumption from `waiting_approval`.
  Full pause / resume orchestration by the adapter is reconsidered for
  v0.2 or later.
- The state is recorded, but the actual control flow is human-driven.

---

## §13.1 Terminal recording strategy

**Staged adoption: v0.1 ships a wrapper only; v0.2 may add an opt-in
precmd hook.**

## §13.2 v0.1 implementation

The user explicitly runs commands through `basou exec`:

```bash
basou exec npm test
basou exec npm run build
basou exec git status
```

Internally, basou spawns the command as a child process and records a
`command_executed` event with the command, exit code, and duration.

## §13.3 Rationale

- In v0.1, the user is encouraged to be deliberate about what is recorded;
  this aligns with the evidence-trail philosophy.
- Many basou users handle confidential workloads. Explicit recording is
  safer than automatic capture for those contexts.
- Resolving zsh / bash precmd-hook differences cleanly is deferred to v0.2.

## §13.4 v0.2 candidates

- zsh / bash precmd hook (opt-in mode)
- `script(1)` wrapping (full output capture)

---

## §14.1 v0.1 import implementation

Only the minimal `basou session import` form is supported:

```bash
basou session import --format json
```

- JSON is read from stdin.
- It is converted to the basou event schema.
- Events are appended to
  `.basou/sessions/<session_id>/events.jsonl`.
- `session.status` is fixed to `imported`.

## §14.2 v0.2 import extensions

Source-specific parsers are reconsidered for v0.2:

```bash
basou session import --source claude-code
basou session import --source codex
basou session import --source gemini
basou session import --source copilot
```

## §14.3 Multi-root source roots

A single logical project can span several sibling repositories — for
example an implementation repo, a planning repo, and a shared agent
working directory the AI is launched from. The AI's native logs are
recorded under whichever directory it ran in (Codex keys each rollout by
its session `cwd`; Claude Code stores transcripts under a per-project
directory), but the provenance belongs to one `.basou/` workspace.

Discovery therefore accepts a set of **source roots** instead of one:

- `--project <path>` is repeatable on `basou import claude-code`,
  `basou import codex`, and `basou refresh`. Each path is a source root;
  several paths union their sessions into the workspace. Resolved against
  the cwd, then de-duplicated.
- `manifest.import.source_roots` is an optional, ordered list of roots
  **relative to the repository root** (e.g. `[".", "../basou-workspace"]`).
  `basou refresh` with no `--project` reads it. The list is complete —
  include `"."` to keep the host repository. Absolute paths, `~`-expansion,
  and empty entries are rejected so the committed manifest stays path-clean.
- Precedence: explicit `--project` flags, else `import.source_roots`, else
  the repository root alone (the prior single-root behaviour).

Each session is sanitized against its own `working_directory`, so
aggregating sibling repos never relativizes a path across repositories or
leaks an absolute host path beyond the existing pathless contract.

## §14.4 Keeping the corpus current (`--watch`)

Import is a pull, so the corpus only advances when `basou refresh` runs.
`basou refresh --watch [--interval <seconds>]` keeps it current without a
manual step:

- It runs one catch-up refresh on start, then polls the native-log stores
  (`~/.codex/sessions`, `~/.claude/projects`) every `interval` seconds
  (default 30, minimum 5).
- A cycle re-imports and regenerates only when the logs have **settled**
  (unchanged since the previous poll, so an in-progress session is not
  captured mid-write) **and** changed since the last import. Handoff /
  decisions regenerate only when something was actually imported, so AI
  work in unrelated projects never rewrites this workspace's files.
- Polling is dependency-free and cross-platform; the trade-off is that
  capture latency is the poll interval, not real-time. Ctrl-C / SIGTERM
  stops the watcher after the current cycle (never mid-write).
- `--watch` cannot be combined with `--dry-run`, `--json`, or `--force`.
  Because import is idempotent (already-imported sessions are skipped), a
  session that is still **active when the watcher starts** (captured by the
  start-up catch-up) or that **resumes** after it settled is recorded only up
  to that point and is not re-imported; run `basou refresh --force` to rebuild
  those from the latest logs.
