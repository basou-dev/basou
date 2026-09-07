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

# User-global context faces (files every project's AI tool auto-loads)
basou channel clear codex  # remove basou's orientation block from ~/.codex/AGENTS.md
```

For exact flags, subcommands, and arguments, see the generated reference linked
above — it is regenerated from the CLI on every release, so it never drifts from
the implementation.

### User-global context faces (`~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`)

Two files basou can write to are **user-global**: an AI tool auto-loads them at
startup for **every** project on the machine, not just the workspace that
wrote them. `basou refresh` and `basou run codex` render the workspace's
orientation into `~/.codex/AGENTS.md` (the BASOU:ORIENTATION block); `basou
protocol sync` renders the declared standing protocols into
`~/.claude/CLAUDE.md` (the BASOU:PROTOCOLS block). Whatever is in those blocks
is in the context of the next Codex / Claude Code session of any other
workspace, including one whose work must never mix with this one's.

The orientation render is therefore **opt-in per workspace and off by
default**: `basou refresh` and `basou run codex` write the face only when the
workspace's manifest declares `channels.codex: true`, and never when it
declares `policies.confidential: true` (which outranks the opt-in). A skipped render is
always said — a `codex channel: skipped (...)` line, and a `codexChannel`
field under `refresh --json` — so a run that wrote nothing cannot be read as
one that did. `--dry-run` never renders. The face paths themselves stay
hard-coded (a configurable path would let basou append to arbitrary files);
the gate decides *whether* a workspace writes, not *where*.

The gate governs writing only. It cannot keep a block another workspace
already rendered out of this workspace's tool: `basou channel clear codex`
removes the orientation block from `~/.codex/AGENTS.md` on the spot (leaving
any other content of the file intact, and writing no `.basou-bak` — the block
is being removed because it should not be on the machine), and `basou protocol
unsync` does the same for the protocol block in `~/.claude/CLAUDE.md`. When
basou creates a face file that did not exist, it records an empty `.basou-bak`
so that no later write can preserve basou's own block as the "pre-basou
original".

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

Each entry is a **planning master** — the repo that owns the `.basou/` store (a
grouped project's `-planning` hub, or a solo project's own repo). It is **not**
the throwaway **workspace view** dir (the symlink aggregator, which has no
`.basou/` of its own) and **not** a member / source-root repo the master
aggregates. Register the master only: listing its view or a member repo
alongside it resolves back to the same workspace and shows a duplicate card,
which `basou view --check` flags as `redundant`. (basou uses "workspace" two
ways — the registered planning master here, and the generated view dir; a
portfolio entry always means the master.)

```yaml
# ~/.basou/portfolio.yaml — each path is a planning master (the .basou-owning
# anchor), never its workspace view dir or a member repo it aggregates.
version: 1
workspaces:
  - path: /abs/path/to/project-a-planning   # absolute (~ allowed); owns .basou/
    label: project-a                        # optional display label
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

Safety preflight. Portfolio capture is import-based and writes only to each
**workspace** repo's `.basou/`, never to a monitored repo (basou reads the
agents' logs under `~/.claude/projects` / `~/.codex/sessions`, never the
monitored repo itself). The one residual risk is a misconfiguration — pointing
a workspace at a monitored repo, or a stray `basou init` / `run` / `exec` inside
one — that would leave a `.basou/` in a repo you need kept clean (e.g. a private
/ NDA repo). `basou view --check` makes this mechanical: for each workspace it
derives the monitored repos (its `source_roots` other than the workspace
itself) and verifies none has a `.basou/` footprint (filesystem + `git
ls-files`) and that no workspace sits inside a monitored repo. It prints a
report and exits non-zero on any finding, and `basou view --portfolio` runs it
on start and refuses to launch on danger (`--skip-safety-check` overrides). The
preflight is read-only — it only stats `.basou` and runs `git ls-files` against
monitored repos. Workspaces should be dedicated planning repos (a sibling of
each monitored repo), never the monitored repo itself.

The preflight also flags `redundant` entries — a registered path that resolves
to the same planning master as another entry (its workspace view, or a member /
source-root repo the master aggregates), which would show a duplicate card.
Redundancy is registry hygiene, not a write risk: it is reported by `--check`
(non-zero exit) but does **not** gate a `--portfolio` start. The fix is to
register only the planning master and drop the view / member entry.

Capture coverage. `basou view --portfolio --check` also reports which native
session logs on this machine are imported by **no** registered workspace. Both
importers attribute a source log by its own recorded `cwd` and require that
`cwd` to **equal** a declared source root; a log matching nothing is dropped,
and the drop is invisible from inside any single workspace — dropping a sibling
workspace's log is correct there, so only the whole registry can tell "no
workspace imports this" from "not this one". It therefore runs only for
`--portfolio` with no `--workspace` flag: an ad-hoc `--workspace` list replaces
the registry, so a registry-wide claim would be false against it.

The report groups the unattributed logs by recorded `cwd` and separates three
cases, whose remedies differ:

- `no_declared_root` — the `cwd` is under no declared root of any registered
  workspace. Usually a project nobody registered. A scratch directory, a temp
  path, or a GUI tool's own working directory has no repo to declare and is
  expected to stay here.
- `below_declared_root` — the `cwd` sits **inside** a declared root without
  equalling it, so the exact-match rule drops it: the enclosing declaration does
  not cover it. Declaring that subdirectory itself as a further
  `import.source_roots` entry does capture it.
- `dir_not_listed` — Claude Code only. The `cwd` **is** a declared root, but the
  transcript sits in a per-project directory that no declared root encodes to,
  and the importer only ever lists `encodeProjectDir(root)` directories, so the
  file is never read. Usually a sign that the workspace is registered under a
  different path spelling than the sessions ran in.

Only `import.source_roots` starts capture. Registering a path in
`~/.basou/portfolio.yaml` adds a workspace to this view and imports nothing by
itself: `basou import` resolves the git toplevel and asserts an initialized
`.basou/` before reading a log. A registered entry that fails either test
therefore contributes **no** declared roots and is reported separately as inert,
so registering a directory can never move the coverage number without capturing
a log.

Coverage is read-only (it opens source logs to read their `cwd` and writes
nothing) and **never** gates: it does not set the exit code and does not gate a
`--portfolio` start, because uncaptured provenance is a coverage gap, not a
write risk. Every attribution decision runs through the importers' own guards,
shared rather than re-derived — `resolveSourceRoots` for the roots (against the
git toplevel, as `resolveImportTarget` passes it), `readRolloutMeta` for a
rollout's `cwd` (so a rollout whose first record is not a usable `session_meta`
is reported as uncaptured, not attributed to a `cwd` appearing later in the
file), and `encodeProjectDir` for which transcript directories the Claude
importer will list. Claude's per-project listing is flat, so nested subagent
transcripts are not imported and are not counted. A log carrying no usable `cwd`
is dropped by both importers and is counted as uncaptured — just with no
directory to name — so the report never says "OK" on the strength of a log it
could not place.
