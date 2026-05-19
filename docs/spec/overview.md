# Overview

basou is a workspace-local evidence-trail tool for AI-assisted development.
The v0.1 / v0.2 specification covers what basou records, where it records it,
and how the artefacts are organized.

## Product foundations

- **Product name**: basou (the only external code name adopted for v0.1)
- **License**: Apache 2.0 (open core)
- **Release cadence**: staged, roughly twelve months from the first release
- **Vision**: make the invisible labor of the AI era auditable

## Scope decisions for v0.1

The v0.1 release intentionally narrows the surface area:

- The primary subject is **basou core**.
- The only built-in integration is **claude-code-adapter**.
- **git** and **terminal recording** are core capabilities, not separate
  layers.
- A dedicated provider layer is not implemented in v0.1.
- A dedicated policy engine is not implemented in v0.1.
- Import is limited to the minimal JSON form of the basou event schema.
- Remote approval is a core capability: the schema is fixed and a local CLI
  provides the minimal implementation. Remote endpoints are out of scope for
  v0.1.

## v0.1 design principles

- **Markdown that a human has reviewed is committed; raw logs are ignored.**
- **Using basou is a deliberate act in v0.1.** Explicit recording is
  preferred over implicit automation, so the tool stays observable.
- **basou does not reach into Claude Code's internal format.** The adapter
  treats Claude Code as an external child process.
- **The source of truth (JSONL) is kept separate from human-facing output
  (Markdown).** Generated Markdown can be regenerated; the JSONL cannot.
- **No code name without a concrete implementation is exposed in v0.1.**

These principles apply across the rest of this specification.
