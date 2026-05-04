# Basou

> Provenance layer for AI development.
> AI 時代の見えない労働を、証跡化する。

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-orange.svg)]()

**Status**: Pre-alpha. v0.1 MVP under active development.
APIs and CLI surface are not yet stable.

## What is Basou?

Basou records what AI coding agents do — sessions, decisions, approvals, git
snapshots, and command output — into a structured, replayable trail that lives
next to your code.

The v0.1 MVP focuses on a single dogfood-able local CLI:

- **JSONL as the source of truth.** Every observable event (command run, file
  changed, decision recorded, approval resolved) is appended to
  `.basou/sessions/<session_id>/events.jsonl`.
- **Markdown as the human view.** `handoff.md` and `decisions.md` are
  regenerated from the event log and may be hand-edited; both forms can be
  reviewed in any text editor or PR.
- **Claude Code as the beachhead adapter.** `basou run claude-code` wraps the
  process so the surrounding session is recorded without Basou knowing about
  Anthropic-internal formats.

Multi-provider, policy engines, and GUI surfaces are deliberately out of scope
for v0.1.

## Packages

| Package        | Description                                                        | Status                    |
| -------------- | ------------------------------------------------------------------ | ------------------------- |
| `@basou/cli`   | The `basou` command-line tool                                      | v0.1 in progress          |
| `@basou/core`  | Core library: sessions, events, approvals, git capability          | v0.1 in progress          |
| `@basou/sdk`   | Type-only SDK for adapter authors                                  | type stubs only in v0.1   |

## Installation

> **Coming soon.** `@basou/cli` is not yet published to npm. v0.1 will publish
> after the initial dogfooding milestone.

```bash
# Once published:
npm install -g @basou/cli
```

## Development

Requirements:

- Node.js >= 20.10.0
- pnpm >= 8.15.0

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Project Structure

```text
basou/
├── packages/
│   ├── core/    # @basou/core — provenance primitives
│   ├── cli/     # @basou/cli  — `basou` command
│   └── sdk/     # @basou/sdk  — adapter SDK (type-only in v0.1)
└── apps/        # Reserved for future GUI / desktop apps
```

## License

Apache 2.0 — see [LICENSE](LICENSE). Copyright Basou Project Contributors.

## Links

- Website: https://basou.dev
- GitHub:  https://github.com/basou-dev/basou
- npm:     https://www.npmjs.com/org/basou
