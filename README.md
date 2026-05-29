# Basou

> Provenance layer for AI development.

**Today:** Basou wraps Claude Code only — the one implemented adapter.
**Roadmap (no dates):** Codex and OpenCode (agent CLIs that fit the same
process-wrap model). OpenRouter / Ollama are tracked separately as a
per-request capture mode, not yet designed.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Version: v0.4.0](https://img.shields.io/badge/version-v0.4.0-blue.svg)]()
[![Status: personal-tool](https://img.shields.io/badge/status-personal--tool-orange.svg)]()

**Status**: personal tool, v0.4.0. Built by one author for their own Claude
Code sessions and updated occasionally — not a supported product. The CLI
surface is frozen for the 0.x line; internal `@basou/core` APIs may still
change between minor releases. Bug reports are welcome; feature requests are
evaluated against the author's own use case.

## What is Basou?

Basou records what AI coding agents do — sessions, decisions, approvals, git
snapshots, and command output — into a structured, replayable trail that lives
next to your code.

- **JSONL as the source of truth.** Every observable event (command run, file
  changed, decision recorded, approval resolved) is appended to
  `.basou/sessions/<session_id>/events.jsonl`.
- **Markdown as the human view.** `.basou/handoff.md` and
  `.basou/decisions.md` are regenerated from the event log and may be
  hand-edited; both forms can be reviewed in any text editor or PR.
- **Tasks as the goal unit.** A task may span multiple sessions; the
  `task.md` snapshot stays in sync with the event log via
  `basou task reconcile` / `basou task refresh-linkage`.
- **Claude Code is the one implemented adapter today.** `basou run claude-code`
  wraps the process so the surrounding session is recorded without Basou knowing
  about Anthropic-internal formats. Other adapters (Codex, OpenCode) are on the
  roadmap, not yet built.

What's new in v0.3:

- **Concurrency**: per-task and per-session advisory lockfiles, plus a
  workspace-scoped `tasks/index.json` cache for faster `basou task list`.
- **Security**: a path sanitizer rewrites operator-private absolute paths
  (homedir / working-directory prefixes) inside `related_files` and
  `working_directory` so `.basou/` stays portable.
- **UX**: handoff rendering picks the latest task from `task_status_changed`
  events, splits the session footer by status, and breaks imported sessions
  out into their own table.

See [CHANGELOG.md](CHANGELOG.md) for the full per-release breakdown.

## Quickstart (5 minutes)

```bash
# 1. Build from source (see Installation below for full prerequisites)
git clone https://github.com/basou-dev/basou.git
cd basou && pnpm install && pnpm -r build
pnpm --filter @basou/cli link --global   # exposes the `basou` binary

# 2. Initialize a workspace at the root of any Git repo
cd /path/to/your/project
basou init

# 3. Record a task + a session note
basou task new --title "Refactor login form"
basou session note --body "Started exploring auth.ts"

# 4. Regenerate the human-readable summary
basou handoff generate
cat .basou/handoff.md
```

For a step-by-step walkthrough with failure modes and sample output, see
[basou.dev/quickstart/](https://basou.dev/quickstart/). For the
underlying data model, see [docs/spec/](docs/spec/).

## Packages

| Package        | Description                                                        | Status              |
| -------------- | ------------------------------------------------------------------ | ------------------- |
| `@basou/cli`   | The `basou` command-line tool                                      | v0.4.0 — published* |
| `@basou/core`  | Core library: sessions, events, approvals, git capability          | v0.4.0 — published* |
| `@basou/sdk`   | Type-only SDK for adapter authors                                  | v0.4.0 — type stubs |

\* published locally via `pnpm link --global`; npm publish is a planned
post-dogfood milestone (see [basou.dev/installation/](https://basou.dev/installation/)).

## Installation

### From source (current)

Requirements:

- Node.js >= 20.10.0
- pnpm >= 8.15.0
- Git

```bash
git clone https://github.com/basou-dev/basou.git
cd basou
pnpm install
pnpm -r build
pnpm --filter @basou/cli link --global

# Verify
basou --version    # → 0.4.0
```

### From npm (future)

`@basou/cli` is not yet published to npm; install from source for now.

```bash
# Once published:
npm install -g @basou/cli
```

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test          # full unit + integration suite
pnpm -r build
```

## Project Structure

```text
basou/
├── packages/
│   ├── core/    # @basou/core — provenance primitives
│   ├── cli/     # @basou/cli  — `basou` command
│   └── sdk/     # @basou/sdk  — adapter SDK (type-only)
├── docs/
│   ├── quickstart.md   # Redirect stub → basou.dev/quickstart/
│   └── spec/           # workspace layout, schemas, CLI surface, ...
├── apps/        # Reserved for future GUI / desktop apps
├── CHANGELOG.md
└── README.md
```

## License

Apache 2.0 — see [LICENSE](LICENSE). Copyright Basou Project Contributors.

## Links

- Documentation: https://basou.dev/getting-started/
- Website:       https://basou.dev
- GitHub:        https://github.com/basou-dev/basou
- npm:           https://www.npmjs.com/org/basou
