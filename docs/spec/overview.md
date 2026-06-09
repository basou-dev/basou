# Overview

basou is a workspace-local evidence-trail tool for AI-assisted development.
This specification covers what basou records, where it records it,
and how the artefacts are organized.

## Product foundations

- **Product name**: basou (the only external code name adopted)
- **License**: Apache 2.0 (open core)
- **Release cadence**: staged, roughly twelve months from the first release
- **Vision**: make the invisible labor of the AI era auditable

## Scope

basou intentionally narrows the surface area:

- The primary product is **basou core**, the workspace tool itself.
- Adapters connect external AI tools: the **run** adapter wraps claude-code as
  a tracked child process; native-log **import** adapters cover claude-code and
  codex.
- **git** and **terminal recording** are core capabilities, not separate
  layers.
- A dedicated provider layer is not implemented.
- A dedicated policy engine is not implemented.
- Import accepts both a tool's native logs (`basou import <adapter>`) and a
  portable JSON form (`basou session import`).
- Remote approval is a core capability: the schema is fixed and a local CLI
  provides the minimal implementation. Remote endpoints are out of scope.

## Design principles

- **Markdown that a human has reviewed is committed; raw logs are ignored.**
- **Using basou is a deliberate act.** Explicit recording is
  preferred over implicit automation, so the tool stays observable.
- **The `run` adapter does not reach into Claude Code's internal format**; it
  treats Claude Code as an external child process. The `import` adapters read a
  tool's own native logs read-only.
- **The source of truth (JSONL) is kept separate from human-facing output
  (Markdown).** Generated Markdown can be regenerated; the JSONL cannot.
- **No code name without a concrete implementation is exposed.**

These principles apply across the rest of this specification.
