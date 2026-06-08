# CLI command catalog (v0.1 + v0.2)

This document lists the CLI surface delivered by v0.1 and amended by v0.2.

## §15.1 v0.1 commands (with v0.2 additions)

> **Note**: this section is the v0.1 source of truth and is augmented as
> additional commands are introduced in v0.2 maintenance. Lines added in
> v0.2 carry a `# v0.2` comment for differentiation.

```bash
# Initialization
basou init

# Session management
basou session new
basou session list
basou session show <session_id>
basou session note <session_id>
basou session import --format json --from <path>

# Task management
basou task new
basou task list
basou task show <task_id>
basou task status <task_id> <new_status>
basou task reconcile [--task <task_id>] [--write] [--json] [-v|--verbose]  # v0.2
basou task refresh-linkage <task_id> [--write]                              # v0.2
basou task edit <task_id> [--title <text>] [...]                            # v0.2
basou task delete <task_id> --yes                                           # v0.2
basou task archive <task_id> --yes                                          # v0.2

# Decision records
basou decision record

# Adapter-mediated execution
basou run claude-code [args...]

# Environment observation
basou exec <command>

# Approval
basou approval list
basou approval show <approval_id>
basou approval approve <approval_id>
basou approval reject <approval_id> --reason "..."

# Status
basou status

# Regenerate generated artifacts
basou handoff generate
basou decisions generate

# Configuration
basou config <key> <value>
```

## §15.2 Commands deferred to v0.3 or later

The following commands are intentionally **not** implemented in v0.1 or
v0.2. They are listed for transparency and are reconsidered when v0.3
planning starts:

```bash
basou team new
basou review-flow new
basou report generate
basou analytics
```

> Native-log import did ship — but as its own `basou import <adapter>`
> command group (`basou import claude-code` / `basou import codex`), not as a
> `basou session import --source` flag. See
> [terminal-and-import.md](terminal-and-import.md) §14.2.
