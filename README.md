# Basou

> Provenance layer for AI development.

**Today:** Basou live-wraps Claude Code only (`basou run claude-code`) and
imports native logs from both Claude Code and Codex (`basou import ...`).
**Roadmap (no dates):** live-wrap for more agent CLIs (OpenCode) that fit the
same process-wrap model. OpenRouter / Ollama are tracked separately as a
per-request capture mode, not yet designed.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Version: v0.7.0](https://img.shields.io/badge/version-v0.7.0-blue.svg)]()
[![Status: personal-tool](https://img.shields.io/badge/status-personal--tool-orange.svg)]()

**Status**: personal tool, v0.7.0. Built by one author for their own Claude
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
- **Claude Code is the one live-run adapter today.** `basou run claude-code`
  wraps the process so the surrounding session is recorded without Basou knowing
  about Anthropic-internal formats. Native-log **import** additionally covers
  Codex: `basou import claude-code` and `basou import codex` derive sessions
  from each tool's own logs after the fact. More live-run adapters (OpenCode)
  are on the roadmap, not yet built.
- **A local cockpit, for the author.** `basou refresh` imports the project's
  native agent logs and regenerates the markdown in one step; `basou view`
  opens a localhost-only web UI to browse sessions, tasks, decisions, and
  handoff and run those actions by clicking. Both are conveniences — the CLI
  and Markdown stay the primary surface, and the viewer binds to 127.0.0.1
  with no authentication (a personal tool, never exposed beyond your machine).

Recent highlights:

- **Native-log import**: `basou import claude-code` / `basou import codex`
  derive sessions from each tool's own logs, with multi-root capture across
  sibling repositories.
- **Local cockpit**: `basou refresh` (and `basou refresh --watch`) keep the
  workspace current; `basou view` opens a localhost-only web UI.
- **Work stats**: `basou stats` reports per-session and aggregate activity.
- **Read-only SDK + JSON Schemas**: `@basou/sdk` reads a workspace's
  provenance programmatically, and `@basou/core` ships JSON Schemas for the
  on-disk `.basou/` formats.

See [CHANGELOG.md](CHANGELOG.md) for the full per-release breakdown.

## Quickstart (5 minutes)

```bash
# 1. Install the CLI from npm (see Installation below for the from-source path)
npm install -g @basou/cli

# 2. Initialize a workspace at the root of any Git repo
cd /path/to/your/project
basou init

# 3. Record a task + a session note
basou task new --title "Refactor login form"
basou session note --body "Started exploring auth.ts"

# 4. Regenerate the human-readable summary
basou handoff generate
cat .basou/handoff.md

# 5. Or skip the per-command typing: import the project's native agent logs
#    and regenerate handoff + decisions in one step, then browse it all in a
#    local web UI (localhost only, no authentication)
basou refresh
basou view
```

For a step-by-step walkthrough with failure modes and sample output, see
[basou.dev/quickstart/](https://basou.dev/quickstart/). For the
underlying data model, see [docs/spec/](docs/spec/).

## Packages

| Package        | Description                                                        | Status              |
| -------------- | ------------------------------------------------------------------ | ------------------- |
| `@basou/cli`   | The `basou` command-line tool                                      | v0.7.0 — published on npm |
| `@basou/core`  | Core library: sessions, events, approvals, git capability          | v0.7.0 — published on npm |
| `@basou/sdk`   | Read-only SDK for reading a workspace's provenance                 | v0.7.0 — published on npm |

## Installation

### From npm (recommended)

Requires Node.js >= 20.10.0.

```bash
npm install -g @basou/cli

# Verify
basou --version    # → 0.7.0
```

See [basou.dev/installation/](https://basou.dev/installation/) for upgrade and
troubleshooting notes.

### From source

Build from `main` to track changes ahead of the published releases.

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
basou --version    # → 0.7.0
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
│   └── sdk/     # @basou/sdk  — read-only provenance SDK
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
