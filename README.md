# Basou

> A harness for steering AI coding agents.

AI coding agents do the typing now. Basou is the harness you steer them
from: a **declarative workspace** you drive each project from, an
**orientation layer** that carries your intent across sessions, and a
replayable, local-first trail of what the agents actually did — all kept
in plain files next to your code.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@basou/cli.svg)](https://www.npmjs.com/package/@basou/cli)
[![Node](https://img.shields.io/badge/node-%3E%3D20.10-339933.svg)](#installation)

Basou is local-first and zero-network: it reads the agent logs already on
your machine and writes only into a `.basou/` directory beside your repo.
Nothing leaves your machine.

## Why Basou?

When an agent writes most of the code, the scarce thing is no longer typing
— it's **control**: keeping a human in the saddle, steering each project the
same way every time, and not losing the *why* between sessions. The answers
to "what does this code do?" already live in the code; a read-only assistant
can reconstruct them. What no after-the-fact reader can recover is the live
context around a decision — the intent, the road not taken, what you were in
the middle of. That has to be captured at the moment, and it has to survive
the gap to the next session.

Basou is built around those two needs. It is **not** a dashboard you watch
or an audit log you file away — it is the tack you actually hold while you
work.

## The two foundations

### 🐎 The saddle — a declarative workspace

Declare each repo once — its visibility, its language, where its agent
instructions live — in a single manifest, and `basou project` derives the
rest: the capture `source_roots`, the `AGENTS.md` / `CLAUDE.md` / Copilot
instruction-file wiring, the `.gitignore` entries that keep private
canonicals out of public history, and the combined workspace view. You edit
the declaration; Basou maintains the plumbing.

The lifecycle is covered end to end and every generator is **dry-run by
default** (`--apply` to write), additive, and non-destructive:

- `basou project new` / `derive` — scaffold and materialize a project's
  wiring from the declaration.
- `basou project adopt` / `check` / `sync` — bootstrap a roster from an
  existing layout and keep capture aligned with it.
- `basou project preset` / `symlinks` / `gitignore` / `workspace` —
  generate each piece of the instruction-file topology.
- `basou project archive` / `rename` / `retrofit` / `teardown` — evolve or
  unwind a repo's place in the project without hand-editing symlinks.

**Instruction files: `hub` or `self`.** Each repo declares where its
canonical `AGENTS.md` lives, via `instructions:` on its manifest entry:

- **`hub`** (the default) — Basou's native hub-and-spoke topology. The
  canonical `AGENTS.md` lives once in the project anchor and each repo
  carries gitignored symlinks to it, so a private planning canonical is
  edited in one place and never committed to a public repo's history.
- **`self`** — the escape hatch for a repo that wants to own its
  instructions in its own git history (the common case for a public OSS
  repo): the canonical `AGENTS.md` is a regular committed file in the repo,
  with `CLAUDE.md` / Copilot as committed spoke symlinks to it, and Basou
  stays hands-off about its content.

`hub` is the default and the recommended path; `self` exists so adopting
Basou never forces a repo to give up owning its own `AGENTS.md`. Omitting
`instructions:` keeps the `hub` behavior unchanged.

### 🪢 The reins — orientation that carries intent

`basou orient` tells you where the work stands and what to do next —
drawing on the trail, not on your memory. `basou decision capture` and
`basou note` record the *why* and the next step at the moment you make
them, so intent survives the gap between sessions instead of being
re-derived from scratch each time you sit back down.

- `basou orient` — the resume view: latest decisions, open tracks, the
  recorded next step, and whether your trail is stale.
- `basou decision capture` / `basou note` — record a decision (with its
  rationale and rejected alternatives) or the terminal next step.
- `basou handoff generate` — a regenerated, hand-editable summary for the
  next session or a teammate.

Capture is deterministic and does not depend on a runtime LLM — an agent
hands Basou structured decisions and Basou writes them; the trail is yours,
verifiable, and offline.

## Underneath: a replayable provenance trail

Both foundations rest on a simple, inspectable substrate that lives next to
your code:

- **JSONL as the source of truth.** Every observable event — a command run,
  a file changed, a decision recorded, an approval resolved — is appended to
  `.basou/sessions/<session_id>/events.jsonl`, hash-chained and verifiable
  with `basou verify`.
- **Markdown as the human view.** `.basou/handoff.md` and
  `.basou/decisions.md` are regenerated from the event log (and may be
  hand-edited); review them in any editor or in a PR.
- **Tasks as the goal unit.** A task can span many sessions; its `task.md`
  snapshot stays in sync with the event log.

Capturing the trail is decoupled from the agent's internal formats:

- **Live-wrap** records a session as it happens. `basou run claude-code`
  wraps the process so the surrounding session is recorded without Basou
  knowing anything Anthropic-internal. (More live-run adapters, e.g.
  OpenCode, are on the roadmap.)
- **Native-log import** covers tools after the fact, across sibling repos:
  `basou import claude-code` and `basou import codex` derive sessions from
  each tool's own logs.
- **A local cockpit** keeps it current and browsable: `basou refresh` (and
  `basou refresh --watch`) imports logs and regenerates the Markdown in one
  step; `basou view` opens a localhost-only, no-auth web UI bound to
  127.0.0.1 — a convenience over the CLI and Markdown, never exposed beyond
  your machine.

Also available: `basou stats` for per-session and aggregate activity, the
read-only `@basou/sdk` for reading a workspace's provenance
programmatically, and JSON Schemas (shipped in `@basou/core`) for every
on-disk `.basou/` format. See [CHANGELOG.md](CHANGELOG.md) for the full
per-release breakdown.

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
[basou.dev/quickstart/](https://basou.dev/quickstart/). For the underlying
data model, see [docs/spec/](docs/spec/).

## Status & stability

Basou is **open source, local-first, and pre-1.0**, maintained by a single
author who runs it daily across their own projects. The `0.x` line is being
driven toward a **1.0 release aimed at broad adoption** — a version external
maintainers and teams can rely on — without giving up the local-first,
zero-network design.

What that means for you today:

- **The `basou` CLI surface is frozen for the `0.x` line** — commands and
  flags are stable. Internal `@basou/core` APIs may still change between
  minor releases.
- **The on-disk `.basou/` formats are versioned** and ship JSON Schemas;
  `1.0` is where the formats and semver guarantees are committed.
- **Adopting is low-risk and reversible**: everything lives in a `.basou/`
  directory next to your code, nothing is sent off-machine, and the
  generators are dry-run-by-default and non-destructive.

Issues and contributions are welcome.

## Packages

| Package       | Description                                                | Status           |
| ------------- | ---------------------------------------------------------- | ---------------- |
| `@basou/cli`  | The `basou` command-line tool                              | Published on npm |
| `@basou/core` | Core library: sessions, events, approvals, git capability | Published on npm |
| `@basou/sdk`  | Read-only SDK for reading a workspace's provenance         | Published on npm |

## Installation

### From npm (recommended)

Requires Node.js >= 20.10.0.

```bash
npm install -g @basou/cli

# Verify
basou --version
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
basou --version
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
```
