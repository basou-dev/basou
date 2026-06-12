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
