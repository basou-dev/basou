# Approval events

This document specifies the approval event family. Approval is a core
capability in v0.1: the schema is fixed and the local CLI provides the
minimal implementation. Remote endpoints are out of scope for v0.1.

## §9.1 `approval_requested`

```json
{
  "schema_version": "0.1.0",
  "type": "approval_requested",
  "id": "evt_01HX...",
  "session_id": "ses_01HX...",
  "occurred_at": "2026-05-04T10:00:00+09:00",
  "source": "claude-code-adapter",
  "approval_id": "appr_01HX...",
  "expires_at": null,
  "risk_level": "medium",
  "action": {
    "kind": "shell_command",
    "command": "rm -rf dist"
  },
  "reason": "Destructive command requires approval",
  "status": "pending"
}
```

## §9.2 `approval_approved`

```json
{
  "schema_version": "0.1.0",
  "type": "approval_approved",
  "id": "evt_01HX...",
  "session_id": "ses_01HX...",
  "occurred_at": "2026-05-04T10:01:23+09:00",
  "source": "local-cli",
  "approval_id": "appr_01HX...",
  "resolver": "local-cli",
  "note": null
}
```

## §9.3 `approval_rejected`

```json
{
  "schema_version": "0.1.0",
  "type": "approval_rejected",
  "id": "evt_01HX...",
  "session_id": "ses_01HX...",
  "occurred_at": "2026-05-04T10:01:23+09:00",
  "source": "local-cli",
  "approval_id": "appr_01HX...",
  "resolver": "local-cli",
  "reason": "Should not delete dist; use git clean instead"
}
```

## §9.4 `risk_level` vocabulary

v0.1 fixes four values:

- `low`: routine activity; informational only.
- `medium`: limited impact, but confirmation recommended.
- `high`: destructive operations or external sends.
- `critical`: irreversible operations (e.g. force push, production changes).

## §9.5 `expires_at` semantics

- Default: `null` (no expiry).
- An ISO 8601 timestamp may be provided.
- v0.1 does not run a background job that automatically transitions
  `pending` approvals to `expired` when `expires_at` is reached.
- `basou approval list` lazily evaluates `expires_at`: an entry is marked
  `expired` when the list is consulted, without mutating the YAML file.

## §9.6 File layout

- `.basou/approvals/pending/<approval_id>.yaml`
- `.basou/approvals/resolved/<approval_id>.yaml`

Both directories are **gitignored by default** because approval payloads
often contain sensitive context.
