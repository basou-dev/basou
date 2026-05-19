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
