# CLI command catalog

basou's command surface is organized into a few top-level command groups. The
**authoritative, always-current flag-level reference** is generated from the
CLI itself and published at <https://basou.dev/commands/reference/>; you can
also read it locally with `basou <command> --help`. This document gives the
conceptual map and records what is intentionally deferred.

## §15.1 Top-level command groups

```text
# Workspace
basou init                  # create a .basou/ workspace at the Git repo root
basou status                # show the current workspace status
basou stats                 # report how much the AI worked (volume + time proxies)

# Sessions and execution
basou exec <command> [args...]   # run a command and record it as a session
basou run claude-code [args...]  # run an AI tool through basou as a tracked session
basou session ...                # inspect sessions (list / show / note / import / rechain)
basou import claude-code|codex   # import provenance from a tool's native logs
basou refresh                    # import all adapters + regenerate handoff/decisions
basou verify                     # check the tamper-evidence hash chain of session event logs
basou view                       # open a local web UI to browse provenance
                                 #   (--portfolio / --workspace: several workspaces at once)

# Tasks
basou task ...              # purpose units spanning sessions (new / list / show /
                            #   status / reconcile / refresh-linkage / edit /
                            #   delete / archive)

# Decisions and approvals
basou decision record      # record a human-authored decision as an event
basou approval ...         # manage approval requests (list / show / approve / reject)

# Generated artifacts
basou handoff generate     # generate or inspect .basou/handoff.md
basou decisions generate   # generate or inspect .basou/decisions.md
basou report generate      # generate a work report (stdout / --out / --json)
basou orient               # show the current position (also writes .basou/orientation.md)
```

For exact flags, subcommands, and arguments, see the generated reference linked
above — it is regenerated from the CLI on every release, so it never drifts from
the implementation.

## §15.2 Commands considered but not implemented

The following are intentionally **not** implemented. They are listed for
transparency and reconsidered in a future release:

```bash
basou team new
basou review-flow new
basou analytics
```

`basou report generate` graduated from this list: it now ships as a generated
artifact (see §15.1). It is a neutral, point-in-time work-explanation export
that composes the existing read primitives — it is not an audit or billing
product, and it adds no orchestration (the reason `team new` / `review-flow new`
remain deferred).

## §15.3 Portfolio mode (cross-workspace orientation)

`basou view` normally serves the one workspace at the Git repo root. With
`--portfolio` (or one or more `--workspace <path>` flags) it instead serves
several workspaces side by side — the multi-repo generalization of
`basou orient`. A single owner who delegated execution to AI agents across many
repos (private contract / NDA work, public OSS, personal projects) sees each
repo's current position on one screen and drills into any one.

```bash
basou view --portfolio                       # every workspace in ~/.basou/portfolio.yaml
basou view --workspace ../a --workspace ../b  # ad-hoc, resolved against the cwd
```

Discovery. `--portfolio` reads `~/.basou/portfolio.yaml`. This is **local GUI
config, not provenance/trail data** — it is not part of the workspace schema
bundle and is never written into a monitored repo. Because it is not a committed
manifest, its paths are **absolute** (a leading `~` is expanded); the
`import.source_roots` relative-only rule does not apply here. `--workspace`
paths are ad-hoc and resolved against the cwd. An entry whose `.basou/` is
missing or unreadable shows as a degraded card rather than failing the view.

```yaml
# ~/.basou/portfolio.yaml
version: 1
workspaces:
  - path: /abs/path/to/project-a    # absolute (~ allowed)
    label: project-a                # optional display label
  - path: /abs/path/to/project-b
```

API. Portfolio mode adds `GET /api/portfolio` (the aggregate of per-workspace
"current position" cards) and `/api/ws/<key>/*` (the existing single-workspace
routes, scoped to one workspace by its stable key). The flat `/api/*` routes are
unchanged and target the first workspace, so single mode behaves exactly as
before.

Boundaries (intentional, kept neutral). Aggregation is **read-only**: a
portfolio load runs no import (a stale capture is shown as stale; run a refresh
to re-import). Cards carry structured facts only — latest session/decision,
in-flight count, pending-approval risk, suspect count, capture freshness — and
**never** work-stats or per-agent productivity / utilization metrics: this is
the owner orienting across their own work, not surveillance of a fleet. The
server stays **localhost-only and unauthenticated** (do not expose the port);
there is no orchestration, cost tracking, or analytics dashboard.
