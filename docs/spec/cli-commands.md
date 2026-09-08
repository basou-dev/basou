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

# Hooks (handlers an AI tool runs at its own lifecycle points)
basou hook install [claude|codex]    # register the Claude Code Stop hook (default) or the
                                     #   Codex SessionStart hook, once, in the tool's user config
basou hook status [claude|codex]     # is it registered (codex: and has Codex trusted it yet)
basou hook uninstall [claude|codex]
basou hook stop | session-start      # the handlers themselves — the tool invokes them, not you

# User-global context faces (files every project's AI tool auto-loads)
basou channel clear codex  # remove an orientation block an older basou left in ~/.codex/AGENTS.md
```

For exact flags, subcommands, and arguments, see the generated reference linked
above — it is regenerated from the CLI on every release, so it never drifts from
the implementation.

### User-global context faces (`~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`)

Two files an AI tool auto-loads at startup are **user-global**: they are read
for **every** project on the machine, not just the workspace that wrote them.
Whatever is in them is in the context of the next Codex / Claude Code session
of any other workspace, including one whose work must never mix with this
one's. basou therefore writes to exactly one of them, with one kind of content:

- `~/.claude/CLAUDE.md` — `basou protocol sync` renders the operator's declared
  **standing protocols** (the BASOU:PROTOCOLS block). Protocols are
  operator-authored and global by design; keep workspace-specific facts —
  names, paths, positions — out of them, because every workspace's sessions
  read them.
- `~/.codex/AGENTS.md` — **nothing, from this release on.** Until 0.39 `basou refresh` and
  `basou run codex` could render the workspace's orientation there (opt-in via
  the now-retired `channels.codex`). That put one workspace's position in every
  other workspace's Codex. `basou channel clear codex` removes a block an older
  basou left there, writing no `.basou-bak` (the block is being removed because
  it should not be on the machine).

**How a position reaches Codex instead: the SessionStart hook.** `basou hook
install codex` registers, once, in the user-global `~/.codex/hooks.json`, a
SessionStart hook that runs `basou hook session-start`. Codex runs it when a
session starts and hands it the session's `cwd` on stdin; basou resolves the
workspace from that `cwd` (a member repo to its planning master, a view to its
master) and prints the workspace's position — the same text as `basou orient`
— which Codex adds to **that session's** context as developer text. The
position is computed at that moment and stored nowhere: a Codex opened in
another workspace gets that workspace's position, and one opened outside any
basou workspace (or before the desktop app has bound a folder, when `cwd` is
`/`) gets nothing. One hook, every workspace, no shared file. It is the same
shape as a Claude Code SessionStart hook that runs `basou orient` (which a
Claude Code user registers by hand in `~/.claude/settings.json`; basou does not
install one). It works in the Codex CLI, the desktop app, and the IDE
extension, which share the hooks system.

The hook speaks only for a workspace **registered in `~/.basou/portfolio.yaml`**
(the resolved root must be a registered path; a member repo resolves to its
planning master first). That file is the operator's allowlist and nothing in a
repository can add to it, so a cloned repository that happens to carry a
committed `.basou/` gets nothing — without the gate, a user-global hook would
render any repository's store, and a checked-in "next step" would arrive as
developer context. Register a new workspace (`basou portfolio` lists what is
registered) before expecting the hook to speak for it. The hook writes nothing:
unlike `basou orient` it does not refresh `.basou/orientation.md`.

The hook also stays silent when the position it would print **names another
registered workspace** — a recorded path under one, a captured decision that
mentions one. `basou orient` and `basou refresh` report that finding as a stderr
advisory the operator can read and act on; a hook has no reader for stderr and
its stdout becomes the session's trusted context, so it withholds the position
instead — the same outcome as an unregistered workspace. The next `basou
refresh` says which lines are responsible. Claude Code's SessionStart hook
sends the same kind of payload (a JSON object with `cwd`) and adds stdout to
context the same way, so a Claude Code user may register `basou hook
session-start` in `~/.claude/settings.json` in place of `basou orient` to get
both gates; basou does not install that one.

Codex trusts hooks by hash and skips a new or changed one until you review it:
the interactive CLI asks at startup ("Hooks need review"), the desktop app
lists it under Settings → Hooks; non-interactive `codex exec` skips an
untrusted hook silently. `basou hook status codex` (and the end of `basou hook
install codex`) reports whether the hook is registered and whether Codex has
trusted it, by reproducing Codex's identity hash for the installed handler and
comparing it with the record in `~/.codex/config.toml`; a record it cannot read
is reported as unknown. `basou run codex` says before launch when the hook is
not registered or not trusted. Both `install` and `status` also say when
`~/.codex/AGENTS.md` still carries an orientation block an earlier basou
rendered, and name `basou channel clear codex`.

The face paths stay hard-coded: a configurable path would let basou append to
arbitrary files.

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
