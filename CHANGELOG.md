# Changelog

All notable changes to **basou** are recorded here. The project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) starting with v0.1.0.

## Unreleased

### Added

- Portfolio view — live repo links. The workspace overview now lists each
  declared roster repo with a clickable link to where it is hosted, derived
  live from the repo's local git config (`remote.origin.url`) at request time
  and normalized to a host-agnostic `https://` URL (GitHub / GitLab / self-
  hosted). Nothing is stored — the link tracks a GitHub-org move or rename with
  no manifest state and no drift — and reading local git config is not a network
  call (the browser only navigates when you click). A repo with no remote, or a
  URL that cannot be normalized, shows "local only" instead of a link.

### Changed

- `.basou` format version gate (pre-1.0-freeze). The on-disk `schema_version` /
  `basou_version` fields are now validated as a forward-compatible **format
  major** rather than the exact literal `0.1.0`: any `0.x.y` is accepted (a newer
  minor/patch parses, since the entity schemas are loose and preserve unknown
  fields), while a higher/unknown major (`1.x.y`+) is gated with an explicit
  "upgrade basou" error instead of a cryptic field-level parse failure. The
  format major is decoupled from the npm/product version — shipping product
  `1.0.0` does not bump the format major; it stays `0` until the format itself
  changes incompatibly. Defined before the semver-1.0 freeze because the gate
  behavior is itself part of the frozen format contract and cannot be
  retrofitted onto a frozen literal. The published JSON Schemas now carry a
  `pattern` (`^0\.\d+\.\d+$`) in place of the old `const`, so cross-language
  validators enforce the same major.

## 0.30.0 — 2026-07-01

### Added

- `basou run codex` — wrap the Codex CLI as a Basou-tracked session, the twin of
  `basou run claude-code`. Two grips beyond plain tracking: it injects
  `-c shell_environment_policy.inherit=all` so Codex's own tool calls can reach
  `basou` on PATH, and just before spawn it re-renders THIS workspace's
  orientation into the Codex context face (`~/.codex/AGENTS.md`) so the
  about-to-start interactive Codex auto-loads the current position even when the
  global channel last reflected a different workspace. The pre-spawn render is
  best-effort (a failure never blocks the launch) and surfaces the
  last-refreshed orientation without re-importing. The session is attributed to
  the new `codex-adapter` source kind.

- Codex context channel — `basou refresh` now renders the regenerated
  orientation into `~/.codex/AGENTS.md` (a marker-delimited `BASOU:ORIENTATION`
  block), the file Codex auto-loads at startup. Codex exposes no SessionStart
  hook, so this static channel is the only vendor-neutral way a "where am I"
  reaches an interactive Codex — the floor of the Codex adapter that lets basou
  steer more than just its maintainer's Claude Code. The orientation block is
  transient (it changes every refresh) and lives in its own marker pair, so it
  never disturbs a protocol block in the same file; the pre-basou original is
  backed up once to `~/.codex/AGENTS.md.basou-bak`. The render is best-effort: a
  channel failure never fails the refresh, and `--dry-run` writes nothing.

- `basou review record` — record that an adversarial / second-opinion review
  ran, from a JSON object piped on stdin (or `--file`). The in-loop agent runs
  the review with its own vendor-specific command, then pipes a description —
  required `reviewer` + `target`, plus optional `verdict` / `findings[]` /
  `blocked[]` — and basou writes one `review_recorded` event deterministically
  (no runtime LLM), the twin of `basou decision capture`. `blocked[]` (a
  spec-deviation / design-reversal the reviewer's finding was held back as) gives
  the adversarial-review protocol's "always report what you blocked" a durable
  trail home; an explicit empty `blocked: []` records that nothing was blocked.
  It is a self-report — basou records that a review happened, it does not verify
  the review executed. It is the signal source for the opt-in review gate below.

- `basou hook stop --require-review` — an opt-in review gate for the Stop hook,
  the twin of the capture reminder. Off by default; when enabled (register it via
  `basou hook install --require-review`), basou also reminds the agent when the
  session SHIPPED substantive code — a `git push` / `git merge` /
  `gh pr create|merge` after enough file edits — without recording a review
  (`basou review record`). The capture and review reminders compose into one Stop
  envelope, and `--block` (opt-in enforcement) applies to both. `hook status`
  reports which gates are active (`capture` vs `capture + review`). The default
  capture-only output is byte-identical.

### Internal

- Added the `codex-adapter` session-source kind to `SessionSourceKindSchema`
  (and the regenerated published JSON Schema) for live `basou run codex`
  sessions — distinct from the after-the-fact `codex-import`. Added
  `codexAdapterMetadata` / `resolveCodexCommand` to the core codex adapter, and
  generalized `runClaudeCode`'s lifecycle into a shared `runTrackedTool(args,
  options, ctx, adapter)` parametrized by per-tool seams (command resolver,
  source metadata, arg transform, pre-spawn hook); `runClaudeCode` / `runCodex`
  are thin wrappers. Claude-code behavior is preserved (its run tests are
  unchanged and pass).
- Added `ORIENTATION_START` / `ORIENTATION_END` markers to core and a shared
  `context-channel` lib (`syncMarkerBlock` / `removeMarkerBlock` /
  `assertNoMarkerLine`) that owns the symlink guard, append/replace, one-time
  backup, marker-line screen, and optimistic-concurrency recheck for managed
  marker blocks in foreign auto-load files. `basou protocol` now delegates its
  block mechanics to this helper: functional behavior is preserved (install /
  update / unchanged / dry-run / symlink / backup / concurrency all match), while
  the rare error and status messages are now shared and slightly more generic.
  The protocol channel and the new orientation channel share one code path — the
  vendor-neutral generalization of the protocol channel (Claude Code's
  SessionStart hook is just its dynamic, Claude-specific counterpart).
- Added the `review_recorded` event variant to the event schema (and its
  regenerated published JSON Schema), plus a deterministic writer in core
  (`parseReviewRecordInput` / `buildReviewRecordedEvent`).
- `evaluateStopHook` now also computes a review-gate verdict (`ReviewGateResult`)
  in the same transcript pass — detecting ship acts and `basou review record`,
  independently of the capture verdict. Ship detection is hyphen-safe (the
  read-only `git merge-base` / `merge-tree` are not mistaken for `git merge`) and
  excludes a dry-run push (`--dry-run` / `-n`).

## 0.29.0 — 2026-06-30

### Added

- `basou hook install` / `hook uninstall` / `hook status` — register, remove, and
  inspect the Stop-hook capture reminder in `~/.claude/settings.json` instead of
  hand-editing it. `install` is idempotent (it upgrades an existing entry in
  place rather than duplicating), writes the node-path form so a shell alias is
  not required, preserves all other settings and hooks, and keeps a one-time
  backup. It registers the CLI's own resolved entry, so the same command works
  whether basou runs from an npm install or a source build.
- `basou hook stop --block` — an opt-in enforcement tier for the capture
  reminder. By default the Stop hook stays non-blocking (advisory); with
  `--block` (register it via `basou hook install --block`) a warranted reminder
  is returned as a blocking `decision:"block"`, holding the agent in-turn to act
  on it, bounded to a single turn by the loop guard. The default advisory output
  is unchanged.

### Internal

- Added a per-package coverage gate (`pnpm test:coverage`, wired into the CI
  quality scan as `Test + coverage gate`). Each package's `vitest.config.ts`
  carries a ratchet floor — the measured baseline rounded down ~a point to
  absorb cross-runner noise, not an aspirational target — and coverage falling
  below it fails CI. The shared measurement policy (v8 provider, whole-`src`
  denominator via `all`) lives in `vitest.coverage.ts`, so each package
  declares only its own floor. Floors only ever move up: raise them in the same
  PR when coverage improves; they are never lowered to make a red build pass.
  No runtime behavior change.

## 0.28.0 — 2026-06-27

### Added

- Per-repo `instructions: hub | self` on a manifest `repos` entry — an additive
  instruction-source axis, independent of `visibility` / `language` / `publishes`.
  `hub` (the default when absent, so existing rosters are unchanged) is basou's
  native hub-and-spoke topology: the canonical `AGENTS.md` lives in the project
  anchor (`agents/<repo>/AGENTS.md`) and each repo carries gitignored symlinks to
  it. `self` is the opt-in for a repo that owns its instructions in its own git
  history: the canonical `AGENTS.md` is a regular, committed file in the repo, with
  `CLAUDE.md` / Copilot as committed spoke symlinks to it. For a `self` repo the
  `project` generators adapt — `symlinks` wires only the spokes (never the
  `AGENTS.md` hub link, and reports `selfAgentsMissing` until the repo authors its
  `AGENTS.md`); `gitignore` never ignores its shared instruction files; `preset`
  is hands-off (it never writes the repo's `AGENTS.md`); `wiring` treats its
  committed instruction files as intentional (never a privacy risk); and
  `retrofit` refuses it (the `AGENTS.md` stays in the repo). `check`, `derive`,
  and capture are unchanged.

## 0.27.0 — 2026-06-27

### Added

- `basou project retrofit <repo>` — fold an existing repo's hand-authored
  `AGENTS.md` into the project topology. It moves the repo's regular-file
  `AGENTS.md` to the anchor canonical (`agents/<repo>/AGENTS.md`) and replaces it
  with a symlink, so the prose lives at the single source of truth. Dry-run by
  default; `--apply` relocates. The onboarding counterpart to `new` for a repo
  that already carries its own `AGENTS.md` — run it before `basou project
  derive`, which then adds the preset block, the `CLAUDE.md` / Copilot spokes,
  and the `.gitignore`. Non-destructive: it refuses when the destination
  canonical already exists (never clobbering it) and skips a repo whose
  `AGENTS.md` is already a symlink or absent; the anchor is refused.

## 0.26.0 — 2026-06-26

### Added

- `basou project new [repos…]` — the greenfield entry point for standing up a
  new multi-repo project from a declaration. At the anchor git repository it
  scaffolds `.basou/` and seeds the manifest with a candidate `repos` roster
  (the anchor plus any given repos, which must already be git repositories) and
  a `workspace.view` placeholder; `source_roots` are derived (roster + view).
  Dry-run by default; `--apply` writes. Supports `--view` / `--no-view` /
  `--force` / `--local-only`. The declaration lives in the manifest's own
  vocabulary, so the same shape drives both bootstrap and maintenance.
- `basou project derive` — materialize a project's full wiring from the declared
  manifest: sync `source_roots`, generate each repo's preset canonical and
  instruction-file symlinks, the workspace view, and each public repo's
  `.gitignore`, in dependency order. Dry-run by default; `--apply` writes.
  Re-runnable (idempotent) — the greenfield counterpart to `new` and a one-shot
  maintenance pass.
- `basou project teardown <repo>` — remove the basou-generated wiring for one
  repo (its instruction symlinks, `.gitignore` patterns, workspace-view symlink,
  and the generated block in the anchor's canonical). Dry-run by default (a
  classified removable / foreign / blocked plan); `--apply` removes only the
  verified-basou artifacts, re-checking each just before it acts. The
  destructive counterpart to `archive`; the anchor is refused and removal is not
  reversible.

### Changed

- The `project` and `review-gaps` command output is now **English**, matching
  basou's English-only public-surface convention. Report output (`orient`,
  handoff, decisions) is unchanged. Command behavior is unchanged and `--json`
  output is byte-identical.

### Internal

- Added a language lint (`pnpm lint:lang`, wired into CI) that fails on Japanese
  in `packages/*/src` (excluding tests) outside a small allowlist of report
  renderers — guarding the English-only convention that the formatter cannot
  detect.

## 0.25.0 — 2026-06-25

### Fixed

- The `basou hook stop` Stop-hook no longer falsely nudges a session that
  recorded its intent through the CLI's **node path** —
  `node …/cli/dist/index.js decision capture|record|note` — instead of the
  `basou` alias. That node-path form is how a non-interactive context (the hook
  itself, an agent's Bash) invokes the CLI when `basou` is a shell alias not on
  PATH, the same form the documented SessionStart hook uses; the capture-verb
  detection missed it and nagged a session that had in fact captured. Detection
  now recognizes both forms, the node arm anchored to the `cli/dist/index.js`
  tail (shared by the source build and the `@basou/cli` npm install) so an
  unrelated `node …/index.js` is not mistaken for a capture.

### Changed

- The CLI's top-line description (`basou --help`) now reads **"A harness for
  steering AI coding agents"**, replacing the earlier "provenance layer"
  framing so the declarative-workspace and orientation foundations are visible.
  The README is updated to match and its version badge is now a dynamic npm
  badge.

### Internal

- Added a read-side performance budget: a synthetic-store benchmark (opt-in via
  `BASOU_PERF=1`) plus an always-on scaling-regression guard, establishing that
  `orient` / `decisions` / `handoff` render near-linearly with store size. No
  shipped runtime change.

## 0.24.0 — 2026-06-25

### Changed

- The `basou hook stop` Stop-hook nudge now uses a **content-aware trigger** instead
  of a raw command+edit count. A session reads as substantive — and so worth a
  capture nudge — only when it did decision-worthy work: enough **file edits**
  (`--min-edits`, default 2) or a **free-form AskUserQuestion answer** (a reply
  matching no offered option — an uncaptured conversational decision). Read-only
  Bash (`ls` / `grep` / `git status`) no longer counts, so pure exploration
  sessions are left alone (the false-fire the old count caused). The `--min-actions`
  flag is renamed `--min-edits` to reflect that it gates file edits. The reminder
  stays non-blocking (enforcement strength is unchanged). The AskUserQuestion
  option-matching rule is now shared with the importer so the set it auto-derives
  and the set the hook treats as uncaptured stay exact complements.
- `basou orient`'s freshness gate no longer fires an unsatisfiable 「必ず `basou refresh`」
  for the **live session you are in**. A merely *grown* (`更新`) session — which the
  active session always is, since its transcript advances past the last import —
  now renders a **non-imperative** verdict that still offers `basou refresh` (a grown
  *finished* session is real, refresh-clearable backlog) but explains the live-session
  residual is normal, and shows **no top banner** — instead of the imperative that a
  refresh could never satisfy (the learned-helplessness dbp_wp reported). The assertive
  「古いです…必ず refresh」 is reserved for genuinely **never-imported** (`新規`) sessions,
  which a refresh will actually clear. Separately, the unverifiable-source wording now points only at
  `basou refresh --force` and names `basou verify` as a *separate* integrity axis
  (a clean verify does not mean there is nothing to import), resolving the apparent
  contradiction with the header's `suspect 0`. (dbp_wp dogfeedback.)

## 0.23.0 — 2026-06-24

### Added

- `basou orient --refresh` imports every adapter first (writing provenance), then
  renders a guaranteed-fresh position — a one-command way for a SessionStart hook
  to close the freshness gate. Bare `basou orient` stays **read-only** (it never
  imports; the dry-run probe only reports staleness), preserving the invariant
  that a plain orient never mutates the store.

### Changed

- When `basou orient` has **confirmed** staleness (the probe counted uncaptured /
  grown native sessions), the warning is now asserted, not hedged: 「古いです（未取り込み N 件）—
  着手前に必ず `basou refresh`」instead of 「古いかもしれません」. basou knows there is
  uncaptured work, so it states it plainly with an imperative remediation rather
  than understating the urgency. The genuinely-uncertain cases keep their hedged
  wording (an un-re-importable grown session: 「最新か確認できません」; an unrun probe:
  「最新か確認するには…」).

## 0.22.0 — 2026-06-24

### Added

- `basou orient` now includes a **「最近の流れ」 (recent direction)** section: the
  last 5 non-archived sessions, newest first, each condensed to the decision
  titles and next-step notes it recorded (voided decisions filtered out). This
  surfaces the *arc* of recent intent rather than only the single latest
  decision/note — the read-side safety net for the intent-leak gap. When a
  session recorded neither a decision nor a note, its top changed files stand in
  as the activity signal, so the recent trajectory stays visible even when
  explicit capture was missed. Deterministic and read-only (no LLM); ties on
  session boundary break by session id so the arc never depends on on-disk order.

## 0.21.0 — 2026-06-24

### Added

- `basou orient` now surfaces a concise **staleness banner at the top** of the
  output (right after the header) whenever there is uncaptured or un-re-importable
  native work — not only in the "これは最新か" verdict at the very bottom. A reader
  grounding top-down now meets "⚠️ 古いかもしれません … 着手前に `basou refresh`"
  before the direction / next-step sections, instead of starting work above the
  warning. The banner shows only for actionable-stale states; the full verdict
  still renders at the bottom.

### Fixed

- `basou task` subcommands now resolve the workspace the same view-aware way as
  `orient` / `note` / `decision` / `refresh`: from a non-git workspace-view
  directory they redirect to the linked planning repo (or portfolio master)
  instead of failing with "Not a git repository". A genuinely non-git, non-view
  directory still gets the same git-init hint.
- `basou note` now refuses a body that is exactly a single subcommand-like word
  (`list`, `ls`, `show`, `add`, …) with a hint, instead of silently recording it
  as a note. `basou note` takes the note text positionally and has no
  subcommands, so `basou note list` previously created a note whose body was
  "list" — which then surfaced as orientation's next step. Multi-word bodies, or
  those words inside a phrase, are unaffected.
- `AskUserQuestion` answers are now derived into a `decision_recorded` only when
  the answer is a **confirmed selection of an offered option** (it matches an
  option label the question presented). A free-text "Other" reply — a
  counter-question, guidance, or other meta answer — matches no offered option
  and is no longer recorded as a decision. Previously every answer became a
  decision, so a meta reply could land in `decisions.md` and even surface as
  orientation's "直近の判断" (latest decision), misrepresenting the current
  direction on resume. A genuine free-text choice can still be recorded
  explicitly with `basou decision capture`. Existing noisy decisions clear on the
  next `basou refresh --force` re-import.

## 0.20.0 — 2026-06-24

### Added

- `basou hook stop` — a Claude Code **Stop-hook** that nudges the agent to
  capture a session's intent before the turn ends. It reads the Stop hook JSON
  payload on stdin and, when a session did substantive work (≥ 5 commands +
  file edits by default, tunable with `--min-actions`) but ran no capture verb
  (`basou decision capture` / `decision record` / `note`), emits a non-blocking
  `hookSpecificOutput.additionalContext` reminder pointing at the capture
  commands. It is **advisory, not coercive**: the reminder lets the model act or
  stop and never blocks; the `stop_hook_active` flag is honored so it can never
  loop; and it is **fail-open** — any error (missing/unreadable transcript,
  malformed stdin) results in no output and a clean exit, so a hook failure can
  never disrupt a session. Install by adding `basou hook stop` as a `Stop` hook
  in `~/.claude/settings.json` (see `basou hook stop --help`). This is the
  write-side companion to the v0.19.0 track-level decisions: where tracks make a
  captured intent resurface, the Stop-hook makes the capture itself more likely
  to happen, closing the "capture never fired" gap that buried intent between
  sessions.

## 0.19.0 — 2026-06-24

### Added

- Decisions can now be recorded as a **track** — a strategic, unfinished
  direction (the next essential thing to build, and *why*) — with
  `basou decision record --track` or a `"kind": "track"` field on a
  `basou decision capture` item. Unlike a point-in-time decision (only ever
  surfaced as the single latest one), an open track resurfaces in the
  "どこへ向かう" / 未完トラック section of `basou orient` and `basou handoff`
  **every session until it is explicitly closed** with `basou decision void`
  (or superseded). This is the intent-continuity layer: a direction agreed in
  conversation no longer sinks into the flat decision list and fails to carry to
  the next session. `decisions.md` marks tracks `[TRACK]`; the rationale (the
  why) rides alongside the title wherever a track is surfaced. Additive and
  backward-compatible — a decision with no `kind` is a plain decision, and all
  pre-existing `decision_recorded` events round-trip unchanged.

## 0.18.0 — 2026-06-24

### Added

- `basou decision void <decision_id> [--reason <text>] [--superseded-by <id>]`
  marks a recorded decision no longer in force. Append-only: a new
  `decision_voided` event is recorded; the original `decision_recorded` line is
  never mutated. The void is then reflected everywhere a decision surfaces:
  `decisions.md` renders it struck-through with its reason (and the superseding
  decision, if any); `basou orient` and `basou handoff` skip it when choosing
  the latest direction; and `basou report` annotates it `(voided)`. So a
  decision that was wrong or recorded against the wrong project is structurally
  correctable instead of needing a free-text correction note. The target must
  exist (a typo'd id fails loudly).
- `basou decision capture` / `basou decision record` now warn (read-only,
  advisory) when a decision's `linked_files` resolve OUTSIDE the project's
  declared `import.source_roots` — the write-side companion to the v0.17.0
  cross-project surfacing, so a decision captured from a session that wandered
  into another repo is flagged before it is recorded against the wrong
  project's master. Gated to a declared `source_roots` list (a multi-repo
  workspace); warn-only (capture is agent-facing and must not be blocked).
  Relative links resolve against the invocation cwd; the agent's own tooling
  dirs are exempt. `basou note` is not covered — it carries no `linked_files`.

## 0.17.0 — 2026-06-23

### Added

- Cross-project boundary surfacing (read-only, advisory). A Claude Code / Codex
  session is attributed to a project by its recorded cwd, but it can still edit
  files outside the project's declared `import.source_roots` (e.g. an unrelated
  sibling repo). Those paths used to surface unmarked in `basou orient`'s recent
  files and could mislead a resuming agent into continuing another project's
  work. Now, for a workspace that declares `source_roots`:
  - `basou orient` flags the latest local session's recent files that resolve
    outside the source roots with a `⚠ … source_roots 外` advisory line.
  - `basou import` (and `basou refresh`) warns on stderr when an imported
    session edited files outside the source roots.

  Classification is realpath-aware (a file reached through a workspace-view
  symlink is not mis-flagged) and biased against false alarms (an unresolvable
  path stays in-root); the agent's own tooling dirs (`~/.claude`, `~/.codex`,
  `~/.basou`) are treated as in-root so routine plan / memory edits are not
  flagged. No event schema or write-behavior changes — the trail is unchanged.

## 0.16.0 — 2026-06-23

### Added

- `basou orient` can now merge sessions from other hosts' trail stores listed in
  `~/.basou/hosts.yaml`, giving a unified current-position view across machines
  (a laptop plus SSH-host / Remote-SSH boxes, where Claude Code runs remotely
  and its transcripts never reach the laptop). Each registry entry is a LOCAL
  path — an SSHFS mount or an rsync / Syncthing mirror of another host's
  `.basou`, kept in sync by your own tooling over the SSH you already use; basou
  itself performs no network I/O (it owns the merge, not the transport). Merged
  sessions are attributed to their host (an ` @host` suffix on the latest
  session / decision / next-step / suspect lines, and a `> hosts:` banner),
  de-duped by session id then source-namespaced external id; the freshness
  verdict is scoped to the local host, since a remote host's freshness is only
  knowable by running `basou refresh` there. With no `~/.basou/hosts.yaml`,
  behaviour is byte-identical to before. Handoff, decisions, `basou view`, and
  the `refresh`-written `orientation.md` remain local-only for now.

## 0.15.0 — 2026-06-23

### Added

- `basou protocol` (sync / list / unsync) — a managed standing-protocol channel.
  It renders operator-declared protocols from `~/.basou/protocols.yaml` into a
  marker-delimited block (`BASOU:PROTOCOLS`) inside the user-global
  `~/.claude/CLAUDE.md`, which Claude Code auto-loads every session. Only the
  bytes between the markers are ever touched; the rest of the file is preserved
  (durable temp+rename write, symlink guard, optimistic compare-and-set
  recheck). This is the standing-protocol foundation for systematically
  reminding the in-loop agent to capture conversational decisions and next-steps
  at session end — declaring the protocol that a later enforcement hook can
  build on.

### Fixed

- A portfolio *member* repo — itself a git repo but holding no `.basou` store
  because its trail aggregates into a separate planning master (declared via the
  master's `import.source_roots`) — no longer fails with "Workspace not
  initialized" when running `orient` / `refresh` / `note` / `decision capture` /
  `project*` / `review-gaps` / `session` (or the SessionStart orient hook) from
  inside it. When a resolved git repo owns no store, command resolution now
  reverse-looks-up the portfolio registry (`~/.basou/portfolio.yaml`): a single
  master whose realpath-resolved `source_roots` claim the repo redirects to it
  (mirroring the view-symlink fallback), two or more distinct masters raise an
  ambiguity error, and none preserves the original message. Claimants are
  de-duped by canonical root so a master registered under an alias spelling does
  not become a false ambiguity, and a present-but-malformed registry is surfaced
  on stderr rather than silently swallowed. Normal repos and view directories
  short-circuit on the store probe and pay nothing.

## 0.14.1 — 2026-06-23

### Changed

- Resume coherence: orientation and handoff no longer present a *stale* recorded
  decision as the current direction. When captured activity continued well past
  the latest decision, the forward section asks you to confirm the continuation
  point and demotes the decision to a labelled reference instead of inferring
  direction from it; `handoff.md` now carries the same staleness caveat on its
  `直近の判断` (it previously had none). This closes a resume failure where an
  agent treated an already-resolved "open question" as the next task.
- `最終 session` now represents the most recent *substantive* session (one that
  touched files) rather than a bare resume/refresh session (e.g. 1 command, 0
  files) that merely happens to be newest, in both orientation and handoff.
- Orientation and handoff now flag when the latest recorded decision comes from a
  different session than `最終 session`, so the "latest" pointers do not silently
  disagree.

## 0.14.0 — 2026-06-22

### Added

- `basou decision capture` — record a batch of decisions from a JSON array on
  stdin (or `--file`). The auto-derived decision signal is narrow (Claude Code
  derives one only from `AskUserQuestion`; Codex derives none), so a session's
  real conversational decisions — and their rationale, alternatives, and
  rejected reasons — are otherwise lost. This command lets the in-loop agent,
  which still has the conversation in context, extract those decisions and pipe
  them in; basou writes them deterministically (it runs no LLM itself) into one
  ad-hoc session timestamped now, so orientation surfaces them as the latest
  decisions. Validation errors name the offending array index and field
  (e.g. `decision[2].title must be a non-empty string`) so the agent can
  self-correct. `--dry-run` previews without writing; `--json` emits a
  structured summary. Like `orient` / `refresh` / `note`, it is view-aware and
  resolves a workspace-view directory to its planning repo.

### Changed

- Orientation and `basou refresh` now point at `basou decision capture` when a
  decision is stale or none were auto-recorded, so the surface that detects the
  why-capture gap also names the way to close it.
- `basou decision record` now rejects a whitespace-only `--title` / `--rationale`
  / `--rejected-reason` / `--alternative` / `--linked-file` and a malformed
  `--linked-event` id up front (previously a malformed id was accepted here and
  only failed later inside the event-schema write with a generic error). This
  hardening is shared with the new `basou decision capture`.

## 0.13.1 — 2026-06-22

### Fixed

- `basou import claude-code` / `basou refresh` now locate Claude Code
  transcripts using Claude's full per-project directory encoding — every
  non-alphanumeric path character maps to `-`, not just `/`. A workspace whose
  path contains `_` (or `.` / space), e.g. `.../spectrum_chisel-workspace`, was
  looked up under an underscore-preserving directory name, missed, and silently
  skipped as "no source logs"; its sessions are now discovered. Each transcript
  is additionally attributed by its own recorded `cwd` and skipped when it does
  not belong to a requested project, so the lossy directory encoding cannot
  import a colliding sibling project's transcripts under the wrong project.

## 0.13.0 — 2026-06-22

### Added

- `basou review-gaps` — a read-only check that surfaces commits with no bound
  cross-model review, so a declared "review before commit" protocol can be seen
  to hold rather than silently eroding. Review-gap repos are bound by `realpath`
  (not a workspace-view directory name) and require a git repo root, so a
  worktree / view does not mis-bind or false-clear.
- `basou project` — a declarative workspace toolkit. The project is a list of
  repos and each repo's `source` (visibility / language); symlinks, source
  roots, views, and `.gitignore` lines are derived from that manifest rather
  than hand-maintained. Subcommands (read-only inspectors first, generators
  behind `--apply` with a dry-run default): `check` (declared roster vs
  `source_roots` drift), `sync` (reconcile `source_roots` to the roster),
  `adopt` (bootstrap the roster from existing `source_roots`), `wiring`
  (inspect agent instruction-file wiring), `gitignore` (exclude instruction
  files in public repos), `symlinks` (generate instruction-file symlinks),
  `workspace` (generate the workspace view; `--prune` removes stray view
  symlinks), `preset` (generate the canonical instruction-file preset block),
  `archive` (fold a repo out of the roster), and `rename` (re-path a repo).
- `basou note "<text>"` — record a free-text next step. It creates an ad-hoc
  session by default (so it works even though imported sessions are not
  attachable); `--session` attaches to an existing attachable session. The
  `note_added` event gains an optional `kind`; `basou note` sets
  `kind: "next_step"` to mark a deliberate resume hint, and orientation surfaces
  only the latest such note as the recorded starting point — a plain
  `basou session note` annotation is never mislabeled as the next step.

### Changed

- `basou orient` now anchors the latest decision to captured activity: the
  decision line carries its relative age, and a note is appended when captured
  activity continued past the latest recorded decision, so a mid-session
  decision is not presented as the current direction. The forward section
  surfaces the latest recorded next-step note ahead of planned tasks (with the
  same staleness caveat). `OrientationSummary.freshness` gains `latestActivityAt`.
- Session labels for a session that spans a day boundary render as a
  `start..end` date range instead of only the start day, so late-finishing work
  is not buried under the older date.
- `basou session` commands resolve the repository with the workspace-view
  fallback (matching `orient` / `refresh`), so they no longer fail with "Not a
  git repository" when run from a git-untracked view directory.
- `basou refresh` surfaces a decisions=0 gap when there is captured work and
  nudges recording decisions manually, instead of printing a success-looking
  `regenerated (0)`.
- The manifest parser preserves unknown top-level fields (a loose schema) and
  surfaces them on read/write commands, so a field written by a newer basou is
  not silently dropped.
- Project commands share one lexical relative-path normalizer.

### Fixed

- `basou orient`'s freshness verdict no longer over-claims completeness: it
  states exactly what it checks (uncaptured native sessions + suspect sessions)
  and notes what it does not detect (plan/impl drift, unrecorded decisions),
  rather than implying a clean bill of health.

## 0.12.0 — 2026-06-20

### Added

- `basou orient` — a read-first "current position" command for a supervisor who
  delegated execution to AI agents. It answers four orientation questions (where
  am I now / what is in flight / where am I heading / is this current) and leads
  with structured facts an LLM cannot reliably derive from raw transcripts: the
  pending-approval list (risk / action / reason, not just a count), suspect
  sessions, in-flight task linkage, and capture freshness / coverage. It prints
  to stdout by default and also writes `.basou/orientation.md` — a transient,
  gitignored, markerless snapshot overwritten whole on each run; `--quiet` writes
  the file only. `basou orient` runs no import, so the freshness section reflects
  already-captured state (run `basou refresh` to re-import). `basou refresh` now
  regenerates `.basou/orientation.md` alongside handoff and decisions.
- `@basou/core` exposes `summarizeOrientation()` returning a serializable
  `OrientationSummary` — the structured facts behind orientation (latest
  session, latest decision, in-flight tasks with linkage, the pending-approval
  list with risk/reason, suspect sessions, and capture freshness / source
  breakdown). `renderOrientation` now formats this summary, so its markdown is
  unchanged; programmatic consumers read the facts without parsing prose. The
  summary carries no work-stats and no per-agent / productivity / utilization
  metrics — orientation shows product state, not surveillance.
- `basou view --portfolio` (and ad-hoc `basou view --workspace <path>`) — a
  multi-workspace portfolio: the cross-repo generalization of `basou orient`. A
  single owner sees the current position of several workspaces (separate repos)
  on one localhost screen and drills into any one. `--portfolio` reads
  `~/.basou/portfolio.yaml` (local GUI config, not trail data; absolute paths);
  `--workspace` is ad-hoc and resolved against the cwd; a missing / uninitialized
  path shows as a degraded card. New endpoints `GET /api/portfolio` (aggregate
  cards) and `/api/ws/<key>/*` (workspace-scoped) are additive — the flat
  `/api/*` routes and single-mode behavior are unchanged. Aggregation is
  read-only (no import on load; stale capture shown as stale), cards carry
  structured facts only (no work-stats / productivity metrics), and the server
  stays localhost-only and unauthenticated. Monitored repos are never written
  to (capture is import-based, from the agents' own logs).
- `basou view --check` — a read-only safety preflight for portfolio mode. For
  each workspace it derives the monitored repos (its `import.source_roots` other
  than the workspace itself) and verifies none carries a `.basou/` footprint
  (filesystem + `git ls-files`) and that no workspace's `.basou/` would land
  inside a monitored repo, then prints a report and exits non-zero on any
  finding. `basou view --portfolio` runs this preflight on start and aborts
  before binding the port if it finds danger (override with
  `--skip-safety-check`), so an irreversible footprint in an NDA / private repo
  is caught up front.
- `basou init --local-only` — write a single `.basou/` full-exclude `.gitignore`
  block instead of the default ignore+commit block, so the trail is kept out of
  version control (personal/local state, regenerable by re-importing). The
  default is unchanged; the flag is opt-in. The `.gitignore` append is now
  idempotent against a standalone `.basou/` line as well as the `# Basou`
  marker, so it no longer double-appends on a repo that already excludes
  `.basou/`.
- `basou refresh --portfolio` — refresh every workspace listed in
  `~/.basou/portfolio.yaml` in one invocation (best-effort: a failing workspace
  is reported and skipped, the rest continue, and the process exits non-zero if
  any failed). The `basou view --portfolio` cards gain a read-only staleness
  badge — the uncaptured / grown / unverifiable native sessions a real refresh
  would pick up — so an out-of-date capture is visible instead of silently
  stale. The probe writes nothing.
- `basou orient` gains a plain one-line "is this current" verdict (current /
  maybe-stale / cannot-confirm) driven by a read-only dry-run staleness probe,
  with the raw freshness telemetry moved under `--verbose`. A grown source that
  cannot be re-imported safely (broken prior hash chain, unreadable prior
  events, or a non-append change) is surfaced as "cannot confirm" pointing at
  `basou verify` / `basou refresh --force`, never as a false "current".
- `basou orient` / `basou refresh` now run from an agents-workspace "view"
  directory (a git-untracked dir that symlinks its planning repo): they resolve
  to the single linked sibling repo whose git toplevel holds a `.basou/` store,
  or report an ambiguity error naming the candidates. A git failure other than a
  genuine "not a git repository" (e.g. a corrupt repo) surfaces as an error
  rather than triggering the view fallback.

## 0.11.0 — 2026-06-12

### Added

- `basou report generate` — a neutral, point-in-time **work report**: a
  human-readable export explaining the work captured in a workspace (volume and
  active time, decisions, approvals, tasks, changed files, and per-session
  integrity verdicts). It composes the existing read primitives only and
  introduces no new persisted schema. Markdown to stdout by default; `--out
  <path>` writes a file (confirmation on stderr); `--json` emits a curated,
  pipe-safe structured shape; `--title <text>` sets a subject line. A successful
  render always exits 0 — integrity verdicts inside it are informational and
  never fail the command (unlike `basou verify`). The report is an
  "explain your own work" export, not an audit or billing product: the word
  "billable" never appears and the integrity section states internal hash-chain
  consistency only, not a third-party cryptographic proof.
- `@basou/sdk` exposes `Workspace.renderReport(options?)` (returning the report
  markdown), alongside the existing `renderHandoff` / `renderDecisions`
  (`BASOU_SDK_VERSION` → `0.3.0`).

## 0.10.0 — 2026-06-12

### Changed

- **Live event logs are now tamper-evident.** Sessions written through the
  append path — `basou exec` / `run`, ad-hoc `decision` / `note` / `task`, and
  the attach and approval-resolution paths — now hash-chain their
  `events.jsonl` like imported logs do. Each append derives its `prev_hash`
  from the real on-disk tail under a short-lived session lock, and the
  `integrity` head anchor is stamped once, at the terminal-status finalize.
  Sessions created before this change keep their plain unchained logs (never
  half-chained) and still verify as `unchained`. No schema-version bump — the
  `prev_hash` and `integrity` fields already existed.

### Added

- `basou verify` gains the `in_progress` verdict for a still-live (non-terminal)
  session: its internal chain is fully verified while the legitimately growing
  tail and not-yet-written anchor are forgiven (exit 0). A crashed live append
  (an unterminated final line) is benign on a live session and abandons it; a
  later append refuses rather than corrupting the chain.

### Notes

- `verify` stays read-only and lock-free; it re-snapshots once before returning
  a strict `anchor_mismatch`, so verifying a session that is being finalized
  concurrently is not mistaken for tampering.
- Resolving an approval now holds the session lock across the duplicate-check
  fence and the resolution append, closing a pre-existing double-resolution
  race in addition to chaining the resolution line. It also refuses a session
  that is not active (any non-attachable status, not just `imported`), matching
  every other attach path, so a resolution line is never chained onto a
  finalized log.

## 0.9.0 — 2026-06-11

### Added

- **Tamper-evident imported event logs.** `events.jsonl` written by the import
  paths (`basou import`, `basou refresh`, in-place re-import of a grown
  source) now carries a per-line hash chain: each event records `prev_hash`,
  the sha-256 of the previous line's written bytes, with a session-bound
  genesis hash on the first line. `session.yaml` gains an `integrity` head
  anchor (`head_hash` + `event_count`) so tail truncation is detected
  independently. Both fields are additive optional — no schema-version bump;
  existing sessions are unaffected until their next re-import.
- `basou verify [--session <id>] [--all] [--json]` — read-only integrity
  checker. Reports `verified` / `unchained` / `empty` / `incomplete` /
  `tampered` per session and exits non-zero only when something is
  `tampered`. Live / ad-hoc and pre-feature sessions are `unchained`
  (informational).
- The in-place re-import refuses to rebuild a session whose prior chain fails
  verification (skip reason `prior_chain_broken`), so a broken chain cannot be
  laundered into a freshly valid one. `--force` remains the explicit override.
- `basou session rechain (--session <id> | --all) [--dry-run] [--json]` — migrate
  imported sessions created **before** chaining existed: adds the hash chain
  and head anchor **in place**, preserving event ids, order, field sets and
  key order exactly (each original line is re-emitted with only `prev_hash`
  appended), so cross-session references survive — unlike a `--force`
  re-import. Only `imported` sessions are eligible; a `tampered` log is
  refused (no laundering), and any line that cannot be preserved byte-exactly
  skips the session untouched. Rechaining asserts tamper-evidence from now
  on; it does not retroactively prove the prior history.

### Notes

- The chain is **non-cryptographic** tamper-evidence, not a signature: an
  attacker rewriting both `events.jsonl` and `session.yaml` consistently is
  not detected. It raises the bar from "edit one line" to "recompute and
  rewrite two coordinated files". Signing / external anchoring is a possible
  follow-up.
- v1 scope is import-only: live `exec` / `run` / ad-hoc sessions stay
  unchained for now; chaining the live append path is a planned follow-up.

## 0.8.0 — 2026-06-10

### Changed

- Import now keeps an already-imported source **current** instead of skipping it
  unconditionally. When a native log has **grown** since it was imported (an
  append-only transcript the AI resumed), `basou import` / `basou refresh` /
  `basou refresh --watch` re-import it **in place**: the Basou session id is
  preserved, the adapter's events are re-derived, and any human-authored or
  other-source events are kept and merged back in chronological order. Prior
  derived event ids are reused for unchanged derivations, so cross-session
  references (a decision's `linked_events`) stay valid across the re-import.
  Previously a grown source stayed stale until a global `basou refresh --force`.

### Added

- `session.source.source_size_bytes` — the byte size of the source native log at
  import time (additive optional field; no schema-version bump). It is the
  baseline that detects a grown source for in-place re-import.

### Notes

- Change detection is by source byte size: a source that **shrank** (truncated /
  rotated) is not auto-replaced (use `--force`), and a rewrite that leaves the
  size unchanged is not detected. Sessions imported before `source_size_bytes`
  existed carry no baseline and are left untouched until the next `--force`. An
  external id mapped to more than one session (anomalous) is skipped for in-place
  re-import rather than replaced. `--force` is unchanged (full delete + recreate
  under a fresh id).

## 0.7.0 — 2026-06-08

### Added

- `basou refresh --watch [--interval <seconds>]` — keep the workspace current
  automatically instead of re-running `basou refresh` by hand. It does one
  catch-up refresh on start, then polls the native-log stores (`~/.codex/sessions`,
  `~/.claude/projects`) and re-imports + regenerates only when they have settled
  (unchanged since the previous poll, so no session is captured mid-write) AND
  changed since the last import. Handoff / decisions are regenerated only when
  something was actually imported, so unrelated AI work elsewhere never rewrites
  this workspace's files. Polling (default 30s, min 5s) is dependency-free and
  cross-platform; latency is the interval, not real-time. Ctrl-C / SIGTERM stops
  after the in-flight cycle. `--watch` cannot be combined with `--dry-run`,
  `--json`, or `--force`. Because import is idempotent, a session that was
  already imported is not re-imported in watch mode — so a session still active
  when the watcher starts (caught by the start-up catch-up) or one that resumes
  after it settled is captured only up to that point; run `basou refresh --force`
  to rebuild those from the latest logs.
- Multi-root capture — one `.basou/` workspace can now aggregate the native
  logs of several sibling repositories. This matters when a single logical
  project spans multiple checkouts (e.g. an implementation repo, a planning
  repo, and a shared agent working directory): the AI's sessions are recorded
  under whichever directory it ran in, but the provenance belongs to one
  workspace. Two ways to drive it, applied symmetrically to both the
  `claude-code` and `codex` importers (and to `basou refresh`):
  - `--project <path>` is now **repeatable** on `basou import claude-code`,
    `basou import codex`, and `basou refresh`. Each path is a source root to
    scan; passing several unions their sessions into the current workspace
    (deduplicated, so a root listed twice is scanned once). Explicit
    `--project` flags take precedence over the manifest setting below.
  - `manifest.import.source_roots` — an optional, ordered list of source roots
    **relative to the repository root** (e.g. `[".", "../basou-workspace"]`),
    so `basou refresh` with no arguments aggregates every listed repo. The list
    is complete: include `"."` to keep the host repository itself. Absent means
    "the host repository only" (the prior behaviour, unchanged). Absolute
    paths, `~`-expansion, and empty entries are rejected by the schema so the
    committed manifest stays path-clean and machine-portable.
  - `basou init --source-root <path>` (repeatable) seeds `import.source_roots`
    for a new workspace, normalizing each value to a repo-root-relative path.

### Fixed

- `basou import claude-code` and `basou import codex` now reject `--session`
  and `--all` together instead of silently honouring `--session` and ignoring
  `--all`. The selector must be unambiguous: import exactly one transcript or
  every one, never both at once.
- The published `session-import` JSON Schema description no longer mentions a
  `basou session export` command, which does not exist. It now documents only
  `basou session import` as the consumer of the payload.

## 0.6.0 — 2026-06-05

### Added

- `@basou/core` now ships JSON Schema artifacts for the on-disk `.basou/`
  document formats, generated from the canonical Zod schemas (so they cannot
  drift from validation). One schema per document — `manifest`, `session`,
  `event` (a `oneOf` over the event type), `task`, `approval`, `status`,
  `task-index`, and `session-import` — each a draft 2020-12 document with a
  stable `$id` (`https://basou.dev/schemas/0.1.0/<name>.schema.json`). They let
  non-JavaScript / cross-language tooling and editors validate `.basou/` files
  directly. Published under the package's `./schemas/*` export (e.g.
  `@basou/core/schemas/session.schema.json`). Prefixed-id fields carry a faithful
  ULID `pattern`; other refinement-only constraints are not expressible in JSON
  Schema and are omitted. Regenerate with `pnpm --filter @basou/core
  gen:schemas`; a drift-guard test fails CI if the committed files fall behind
  the Zod source.
- `@basou/sdk` v0.2 — the package gains a runtime, read-only programmatic API
  for reading a workspace's provenance (it was types-only before). It is a
  thin, ergonomic, semver-stable facade over `@basou/core`'s readers, so
  third-party tooling can read `.basou/` without stitching low-level calls
  together and without any risk of mutating provenance (no writers are
  exposed). `openWorkspace(repoRoot, options?)` returns a `Workspace` handle —
  `repoRoot` is any directory holding a `.basou/` (no git required);
  `resolveWorkspaceRoot(cwd)` is a git-based convenience for finding it. The
  handle exposes `manifest()`, `status()`, `listSessions()` /
  `getSession(idOrPrefix)`, `readEvents(idOrPrefix)` /
  `streamEvents(idOrPrefix)`, `listTasks()` / `getTask(idOrPrefix)`,
  `listApprovals()` / `getApproval(id)`, `stats(options?)`, and
  `renderHandoff()` / `renderDecisions()`. Session, task, and event lookups
  accept a unique prefix (matching nothing yields `null`, matching more than
  one throws `AmbiguousIdError`); `getApproval` takes an exact id. A missing or
  invalid `.basou/` throws `WorkspaceNotFoundError`. A `now` clock is injectable
  for deterministic reads.
  Read types (`Session`, `Event`, `Task`, `WorkStatsResult`, etc.) are
  re-exported so consumers import only from `@basou/sdk`. `BASOU_SDK_VERSION`
  is now `0.2.0`.
- `session.metrics.machine_active_time_ms` (additive, optional) — model compute
  time: the summed duration of a source's per-turn spans (Codex
  `task_complete.duration_ms`). A SUBSET of a session's active time, kept as a
  separate labeled measure. Unlike `active_intervals` it is a plain sum, NOT
  wall-clock-deduplicated, so two concurrent sessions can sum past their
  billable (union) active wall-clock — intended, as two models working at once
  did two machine-hours in one wall-clock hour. Captured only for sources that
  record per-turn duration (Codex today); absent otherwise. Surfaced as a
  `Model working` line in `basou stats` (and `--by-source` / `--by-day` /
  `--json`), as a `machine` segment on the `basou session show` `Work:` line,
  and in the `basou view` Stats tab. Re-import (`--force`, or `basou refresh`)
  to backfill existing Codex sessions.

### Changed

- Codex active time is now derived from the rollout's real per-turn intervals
  (`task_started` → `task_complete`) for the in-turn portion — the log's true
  wall-clock span, uncapped, and crediting the session's final turn — unioned
  with the gap-capped engagement series for between-turn bridging.
  `active_time_method` is `turn-intervals` for these sessions. The active-time
  SEMANTICS are unchanged (still human-engaged time with idle gaps over 5
  minutes excluded); only the in-turn precision improves, so a re-imported Codex
  session's active time typically rises (long turns are no longer truncated at
  the gap cap, and the final turn is counted). Claude imports are unchanged
  (their transcripts carry no explicit per-turn duration).

## 0.5.0 — 2026-06-04

### Added

- `basou stats` — report how much the AI worked across the workspace's
  sessions. It leads with output VOLUME (model output tokens, plus command /
  file / decision counts), which is the most direct "how much work" signal,
  and reports TIME measures as labeled proxies for billable human harness
  labor, with active time as the billing primary. `Billable active` is the
  UNION of every session's active intervals, so two sessions run concurrently
  do not bill the same wall-clock twice; the naive per-session `Summed` is
  shown alongside only when sessions overlapped. Per-session active time comes
  from each session's genuine engagement series (conversation turns plus action
  events), so design discussion that produced few tool calls is still counted;
  idle gaps over 5 minutes are not credited. `span` (total elapsed) and
  `command` (real shell-execution time) remain as context. Availability is
  tracked per source so the output never silently misleads:
  `claude-code-import` sessions report no shell time, sessions without captured
  engagement fall back to the event stream, and token totals are absent until a
  session is (re-)imported. `--by-source` breaks the totals down by source
  kind; `--by-day` shows the per-day time x volume billing view (bucketed in
  the host timezone); `--json` emits the full structured result. The same
  per-session summary appears as a `Work:` line in `basou session show`, and a
  Stats tab in `basou view`.
- `session.metrics` (additive, optional) — a per-session rollup on
  `session.yaml`. Model usage: `output_tokens` / `input_tokens` /
  `cached_input_tokens` / `reasoning_output_tokens` (Codex-only). Engaged time:
  `active_time_ms`, the merged wall-clock `active_intervals`, and the
  `active_gap_cap_ms` / `active_time_method` methodology lock. Populated at
  import time by the Claude and Codex adapters from the native log (token usage,
  and the engagement timestamps the event stream otherwise discards); absent for
  live `run` / `exec` sessions and for sessions imported before a field existed
  (re-import with `--force`, or `basou refresh`, to backfill).
- `basou refresh` — one command that imports every adapter's native logs for
  the project and regenerates `handoff.md` + `decisions.md`, instead of running
  four commands by hand. Best-effort: an adapter whose source-log directory is
  absent for the project is skipped, not an error (a present-but-empty source
  imports zero sessions). `--project <path>` targets a different project,
  `--force` re-imports, `--dry-run` previews imports and leaves the markdown
  untouched, `--json` prints the structured result.
- `basou view` — a localhost-only web UI (default `http://127.0.0.1:4319`) to
  browse sessions and their event timeline, tasks, decisions, approvals, and
  handoff, and to run imports / regeneration by clicking (the buttons share the
  `refresh` pipeline). `--port <n>` chooses the port, `--no-open` suppresses the
  browser launch. It binds to 127.0.0.1, validates the Host / Origin headers,
  and ships no authentication: a personal cockpit for the author, never to be
  exposed beyond the local machine.
- `basou import claude-code` — derive Basou sessions from Claude Code native
  transcripts (`~/.claude/projects/<encoded-cwd>/*.jsonl`) after the fact,
  rather than wrapping a live process. Each transcript becomes one imported
  session carrying `session_started` / `session_ended`, `command_executed`
  (from `Bash` tool uses, recorded as `bash -c "<line>"`), and `file_changed`
  (from `Edit` / `Write` / `NotebookEdit` tool uses). `--all` imports every
  transcript for a project, `--session <id>` imports one, and `--dry-run`
  previews without writing. Transcripts with no observable command / file
  action are skipped. Imports reuse the existing `session import` pipeline,
  so path sanitization and id minting are unchanged. Re-running an import is
  idempotent: a transcript already imported is skipped rather than duplicated.
  Imported sessions are labelled with a human summary
  (`claude-code <date>: <n> commands, <m> files`) instead of the raw session
  id, so they read as content in `basou session list` and the handoff.
- `claude-code-import` session `source.kind` (additive enum value) to
  distinguish transcript-derived sessions from live `claude-code-adapter`
  runs and Basou-format `import`s.
- `session.source.external_id` (additive, optional) — records the originating
  session id in the source tool's namespace (e.g. the Claude Code session
  UUID), the key that makes re-imports idempotent.
- `basou import codex` — derive Basou sessions from OpenAI Codex native
  rollout logs (`~/.codex/sessions/<date>/rollout-*.jsonl`) after the fact.
  Each rollout becomes one imported session carrying `session_started` /
  `session_ended` and `command_executed` (from `exec_command` calls, recorded
  as `bash -c "<line>"`) with the real `exit_code` and `duration_ms` parsed
  from the paired command output. Because Codex stores rollouts by date rather
  than per project, discovery walks the tree and matches each rollout's
  recorded working directory against `--project` (default: the current
  repository root); only sessions started in that project are imported.
  `--all`, `--session <id>`, `--force`, `--dry-run`, and `--json` behave as
  for `import claude-code`. File changes and decisions are not derived: Codex
  applies edits inside `exec_command` (no dedicated edit tool) and has no
  structured question / answer record, so neither has a clean signal to map.
- `codex-import` session `source.kind` (additive enum value) to distinguish
  Codex-rollout-derived sessions from Claude imports and live adapter runs.
- `@basou/cli/program` — a side-effect-free `buildProgram()` (and
  `BASOU_CLI_VERSION`) export. Importing it builds the full command tree
  without parsing `argv` or running the CLI, so tooling can introspect the
  command surface — for example to generate the command reference on
  basou.dev — instead of scraping `--help`.

## 0.4.0 — 2026-05-27

The release that turns the repository into a properly operated public OSS
project. No CLI commands, flags, or on-disk data formats changed; this is
continuous integration, publishing, governance, and dependency hardening on top
of v0.3.1.

### Added

- **Quality CI workflow** — typecheck, build, test, and lint run on every pull
  request.
- **Security CI workflow** — secret scanning (gitleaks), a dependency
  vulnerability audit, and guards against absolute-path and internal-identifier
  leaks in tracked files.
- **OIDC trusted-publishing release workflow** — tag-driven npm publishing with
  provenance and no long-lived tokens, plus a cosign-signed GitHub Release that
  attaches the packed tarballs. Each package's metadata and the pinned Node
  version were prepared for it.
- **Dependabot** for the GitHub Actions and npm ecosystems.
- **ASCII-only commit-message enforcement** in CI.
- **Contributor governance**: `CONTRIBUTING.md` (including the English-only
  convention for commits, pull requests, and issues), `CODE_OF_CONDUCT.md`
  (Contributor Covenant 2.1), bug-report and feature-request issue templates,
  and a pull request template.
- **`docs/release-checklist.md`** with the publish dry-run procedure and the
  first scoped-release evidence.
- The bare-name `basou` redirect package (prepared, not yet published).

### Changed

- Migrated the Biome configuration and reformatted the tree for Biome 2.4.15;
  bumped TypeScript to 6.0.3 and silenced its `baseUrl` deprecation.
- Bumped pinned GitHub Actions (checkout, setup-node, pnpm/action-setup,
  cosign-installer, action-gh-release) via Dependabot.
- Tightened the three published packages' metadata ahead of the first scoped npm
  publish, pointed the README and CONTRIBUTING links at basou.dev (the
  quickstart became a redirect stub), and made the governance-doc security
  contact concrete — a live email, with GitHub Security Advisories documented as
  the private reporting channel.

### Fixed

- Sanitized public-facing internal identifiers and non-English comments out of
  the source and tests ahead of the public publish, and added the CI leak guard
  that scans for them.
- Fixed a pre-existing `package.json` keyword-format lint violation and an
  initial-run failure in the security workflow.

### Tests

Baseline unchanged at 1015 (v0.3.1 close → v0.4.0 close); this release adds CI,
publishing, and governance scaffolding rather than feature tests.

## 0.3.1 — 2026-05-21

A small follow-up that picks two paper-cut issues out of the v0.3.0
post-release observation lane. No CLI surface or data-format changes;
upgrading from v0.3.0 is a `pnpm install && pnpm -r build` away.

### Fixed

- `basou --version` now reads from `packages/cli/package.json` at
  runtime instead of a hardcoded constant. The v0.2.0 and v0.3.0
  releases both shipped with `basou --version` still printing `0.1.0`
  because the constant was never bumped alongside the package version;
  the dynamic read closes that drift class permanently, and a new
  `src/index.test.ts` integration test now exec's the built CLI and
  asserts the printed version matches `package.json`.

### Changed

- `basou status` renames the human-readable label `Basou version:` to
  `Spec version:` so it no longer collides with the release-version
  semantics of `basou --version`. The underlying JSON field
  (`workspace.basou_version`) is unchanged, so JSON consumers are
  unaffected; only the text-mode label moves.

### Tests

Baseline grew from 1014 (v0.3.0 close) → 1015 (v0.3.1 close), +1 for
the version-drift guard test.

## 0.3.0 — 2026-05-21

This release focuses on the three workflow gaps surfaced during v0.2
dogfooding: handoff rendering rough edges, the lack of strict isolation
between concurrent writers, and the absolute paths v0.2 was happy to write
into `.basou/`. UX, concurrency, and security each ship as a self-contained
cluster so a downstream consumer can opt out of any one without breaking
the rest.

### Improved handoff rendering (UX)

- `handoff.md` "latest task" line is now driven by the most recent
  `task_status_changed` event rather than the most recent
  `task_created`. A `done` task that finished after a long-running
  `planned` task no longer disappears from the latest-activity slot;
  the fallback to `task_created` still applies when no status-change
  event exists yet.
- The latest task line gains a `(linked_sessions: N)` suffix when more
  than one session has touched the task, so the operator sees breadth
  at a glance.
- The footer's `Sessions: N` is split by status: `Sessions: N
  (completed K, failed M, running L, ...)` for any status with a
  non-zero count.
- Import sessions (`session.source.kind === "import"`) are now broken
  out into their own `### Imported sessions` table and excluded from
  the `## 直近の変更ファイル` union so live work is not buried under
  a back-fill.

### Concurrency

- Added an advisory lockfile helper at `packages/core/src/storage/
  lockfile.ts` (POSIX `link(2)` atomic create, PID-based stale
  detection with a 1h age fallback). Lockfiles live at
  `.basou/locks/<scope>_<ulid>.lock` and are gitignored.
- Per-task lock now guards the read-modify-write window of
  `updateTaskStatusWithEvent`, `reconcileTask`,
  `refreshTaskLinkedSessions`, `editTask`, `deleteTask`, and
  `archiveTask`. `createTaskWithEvent` is intentionally not locked
  (= a fresh task id is a fresh ULID; no two creates can race for the
  same id).
- Per-session lock now guards the events.jsonl append + surrounding
  session.yaml mutation at every caller of
  `appendEventToExistingSession` (= attach-flavoured task commands,
  `basou decision record --session`, `basou session note`). The lock
  is caller-owned to avoid re-entrant deadlock against
  `appendEventToExistingSession` itself.
- `task → session` is the fixed acquisition order whenever both locks
  are held (= attach-flavoured task paths). Cross-API deadlocks are
  thereby impossible by construction.
- Added a workspace-scoped task index at `.basou/tasks/index.json`
  (small JSON cache of id / status / label / updated_at). Maintained
  write-through on every task mutation; rebuilt from disk on missing,
  parse-broken, or version-mismatched index. `enumerateTaskIds` now
  reads the index on the hot path so `basou task list` no longer
  re-parses every front matter for the id list alone.
- Index updates are best-effort: a write failure (disk full, EACCES)
  surfaces as a single `Index update failed; rebuild on next read`
  warning and the task mutation still returns success. The next
  enumerate rebuilds from disk. Concurrent `createTask` calls can
  produce a stale-but-valid index (= the lazy-rebuild trigger does
  not fire on a structurally valid cache); `rm
  .basou/tasks/index.json && basou task list` force-rebuilds. See
  `docs/spec/workspace.md` §1.2 for the recovery procedure.

### Security

- Added a path sanitizer at `packages/core/src/lib/path-sanitizer.ts`
  with three exports: `sanitizePath`,
  `sanitizeWorkingDirectory` (sentinel-based variant for the field
  itself), and `sanitizeRelatedFiles`.
- The two-rule rewrite is: workingDirectory-internal paths become
  repo-relative; homedir-internal paths become tilde-prefixed
  (`/Users/<u>/projects/foo/x.ts` → `~/projects/foo/x.ts`). System
  paths outside both bases (e.g. `/etc/...`) are preserved verbatim
  so an operator that deliberately recorded a system file is not
  redacted by surprise.
- Hardening: null-byte input is rejected with `Invalid path:
  contains null byte`; backslashes are folded to forward slashes
  (v0.3 targets macOS / Linux; full Windows support is a v0.4+
  task). `..`-escapes are normalised purely before prefix matching
  so an input like `<wd>/../escape/x.ts` cannot masquerade as
  workspace-internal.
- Sanitization is applied on the write side at every caller —
  `basou run claude-code`, `basou exec`, every ad-hoc session path
  (task new / status / reconcile / refresh-linkage / delete /
  archive / decision / note), and `basou session import`.
- `basou session import` emits a single `Imported session: N
  path(s) sanitized (related_files: K, working_directory: 0|1)`
  warning to stderr when at least one field was rewritten. The
  import itself still succeeds; the warning fires for `--dry-run`
  too so the operator can preview the rewrite before committing.
- `basou session show` displays sanitized relative
  `working_directory` values verbatim instead of trying to make
  them relative against the repo root a second time, with the one
  literal `.` collapsing to `<repository_root>`.
- Backward compatibility: existing `session.yaml` files written
  before v0.3 are NOT retroactively rewritten. A future v0.4+
  release may introduce `basou session migrate` for that.

### New CLI surface

- (No new top-level commands; v0.3 is an internal hardening pass.
  The new behaviour is reachable through the existing CLI surface.)

### Spec updates

- `docs/spec/workspace.md` §1.2 — documents `tasks/index.json`
  semantics (write-through, lazy rebuild, source-of-truth invariant,
  concurrent-create caveat with the force-rebuild recovery procedure).
- `docs/spec/workspace.md` §1.3 — `.basou/locks/` added to the
  default ignore block.
- `docs/spec/workspace.md` §1.5 (new) — per-task and per-session
  lock scopes, PID-based stale detection with the 1h age fallback,
  the fixed task → session acquisition order, and the
  `createTask` exemption.
- `docs/spec/schemas.md` §5.1 / §5.2 — the `working_directory`
  example flips to a sanitized form; §5.2 documents the two-rule
  sanitizer, the working-directory-specific sentinel skip, the
  null-byte / backslash hardening, the session-import warning
  format, and the backward-compat invariant.

### Tests

Baseline grew from 923 (v0.2.0 close) → 1014 (v0.3.0 close), a
`+91` spread across the three clusters:

- UX: `+9` covering the four handoff renderer changes
  plus a `task_status_changed`-without-`task_created` fallback case.
- Concurrency: `+53` covering the lockfile helper
  (PID / age / EPERM / null / null-bytes), per-task and per-session
  lock contention, the task-index schema and helper, and the
  write-through integration with the existing task APIs.
- Security: `+29` covering each rewrite rule (with
  `..`-escape and prefix-preference cases), the sanitize-then-
  warn flow on import, `--dry-run` warning visibility, and the
  display-side `~/...` / `.` / repo-relative formatting.

`pnpm typecheck` / `pnpm -r build` / `pnpm -r test` / `pnpm lint`
are green at the tip of `main`.

### Notes

- v0.3.0 is OSS-publish ready as a standalone release. NDA case
  introduction is independently gated on out-of-tree feedback from
  external dogfood (5 sessions); release notes for downstream users
  should wait on that lane.
- Adapter UX (claude-code wrap, terminal-recording precmd hook,
  session pause/resume) was sized for this release but deferred
  pending further dogfood signal. It is a v0.3.x candidate rather
  than a v0.4 prerequisite.

## 0.2.0 — 2026-05-18

This release strengthens the v0.1 task-lifecycle foundation with broken-ref
recovery, snapshot-vs-events sync, full task-lifecycle CLI surface, audit-rich
decisions, and the validation needed to safely import sessions across
workspaces. Two small internal-API renames are flagged as breaking.

### Breaking changes

- `FailedToFinalizeError.decisionEventId` was renamed to `targetEventId` in
  v0.2 development, then further generalised to `targetEventIds` (a
  non-empty `ReadonlyArray<EventId>`) so a single ad-hoc session that fires
  multiple target events (e.g. `task new --status done`) carries every
  minted id on the error. CLI callers that read the first anchor should use
  `targetEventIds[0]`.
- `createAdHocSessionWithEvent`'s `targetEventBuilder: (sessionId, eventId)
  => Event` is replaced by `targetEventBuilders:
  ReadonlyArray<(sessionId, eventId) => Event>`. Existing single-target
  callers wrap their builder in a one-element array (`[builder]`).
  `CreateAdHocSessionResult.targetEventId` is similarly renamed to
  `targetEventIds: PrefixedId<"evt">[]`.

Both renames are observable only on direct programmatic users of
`@basou/core`; CLI users are unaffected.

### New CLI surface

- **Broken-ref recovery**: `basou task reconcile [--task <id>] [--write]
  [--json] [-v]` — dry-run audit of `task.md.created_in_session` and
  `linked_sessions[]` against the live session directory; `--write` mints
  an ad-hoc reconcile session, fires `task_reconciled`, and repairs the
  task.md snapshot. `--task` limits the scan to one task; the default
  scans every task and exits 1 on any per-task failure.
- **Forward sync (events → task.md)**: `basou task refresh-linkage
  <task_id> [--write]` re-derives `linked_sessions[]` from
  `session.yaml.task_id` matches across the workspace plus the
  `created_in_session` anchor, fires `task_linkage_refreshed`, and
  overwrites the snapshot. Distinct from reconcile so each audit event
  carries a single, focused story.
- **Lifecycle CLI**: `basou task edit <task_id> [--title <text>] [--status
  <status>]` (title rewrite without an event; status routed through
  `task_status_changed`), `basou task delete <task_id> [--yes]` (hard
  delete with `task_deleted` audit event), `basou task archive <task_id>
  [--yes]` (move to `.basou/tasks/archive/` with `task_archived` audit
  event). Both destructive subcommands prompt for confirmation by default
  and refuse to run on a non-TTY stdin without `--yes`.
- **Retroactive task creation**: `basou task new --status done|cancelled
  [--completed-at <iso>]` records terminal-status tasks in one call. The
  orchestrator emits `task_created` plus a follow-up
  `task_status_changed (planned → terminal)` in the same ad-hoc session
  so the audit trail captures the implicit transition. `--completed-at`
  affects only `task.md.updated_at`; event timestamps stay at recording
  time so the lifecycle ordering invariant holds.
- **Status transition shortcuts**: `basou task status <id> done` and
  `basou task status <id> cancelled` now succeed directly from
  `planned`. The 1 transition = 1 event invariant is preserved.
- **Read-only archive surface**: `basou task list --include-archived`
  scans `<paths.tasks>/archive/` in addition to the main directory and
  prefixes rows with `[archived]`. `basou task show <task_id>` falls
  back to the archive directory and tags the header with `[archived]`.
- **Decision rich fields**: `basou decision record --rationale <text>
  --alternatives <text>... --rejected-reason <text> --linked-events
  <id>... --linked-files <path>...` (all optional) persist into the
  `decision_recorded` event and render into `.basou/decisions.md`.
  Linked-events / linked-files are treated as opaque references —
  missing targets surface inline as `(missing)` so cross-workspace
  round-trips never reject parse-time.

### New events

- `task_reconciled` (`.strict()`) — fired by `task reconcile --write`,
  carries `task_id`, optional `removed_created_in_session`,
  `created_in_session_replacement`, `removed_linked_sessions`.
- `task_linkage_refreshed` (`.strict()`) — fired by `task
  refresh-linkage --write`, carries `task_id`, optional
  `added_linked_sessions`, `removed_linked_sessions`, `final_count`.
- `task_deleted` (`.strict()`) — fired by `task delete --yes`, carries
  `task_id` + last-known `title`. No tombstone; this event is the only
  persistent record after the unlink succeeds.
- `task_archived` (`.strict()`) — fired by `task archive --yes`,
  carries `task_id` + last-known `title`. Session.yaml's `task_id` is
  pinned because the task continues to exist at the new path.
- `decision_recorded` schema gains five optional rich fields described
  above; v0.1-shape payloads (= core 4 fields only) round-trip
  unchanged.

### Stricter validation

- `basou session import` now refuses any payload whose `task_id` carrier
  events (`task_created` / `task_status_changed` / `task_reconciled` /
  `task_linkage_refreshed` / `task_deleted` / `task_archived`) — and the
  effective `session.task_id` override-wins value — reference a task
  that does not exist in the target workspace. Pathless rejection
  message: `Imported session references unknown task_id`.
- Direct programmatic callers of `createTaskWithEvent` get a boundary
  parse on `completedAt` (ISO-8601 shape) before any event is written,
  so a malformed timestamp cannot leave durable events with no valid
  task.md.

### Internal refactor

- Atomic file helpers `atomicCreate` / `atomicReplace` extracted into
  `packages/core/src/storage/atomic.ts` and reused across the storage
  layer (tasks, manifest, status, markdown).
- CLI `render*Error` wrappers consolidated into
  `packages/cli/src/lib/error-render.ts`, dedup-ing the pathless-contract
  surface across `task` / `session` / `approval` / `decision` / `exec` /
  `run` / `handoff` / `decisions` / `init` / `status`.
- ad-hoc label cap raised from 40 to 80 characters so long task and
  reconcile titles retain their core information; the cap applies
  consistently across `Ad-hoc task:`, `Ad-hoc task status:`, `Ad-hoc
  task reconcile:`, `Ad-hoc task refresh-linkage:`, `Ad-hoc task
  delete:`, `Ad-hoc task archive:`, and `Ad-hoc decision:` labels.
- Multi-target event support inside `createAdHocSessionWithEvent` (= the
  one-pass atomic write now accepts N target events between the lifecycle
  status-change pair).
- Planning-document identifiers removed from public source / tests /
  comments so the public repository stays independent of the private
  planning repository.

### Tests

Baseline grew from 720 → 923 (v0.2.0 close), a `+203`
spread across the new events, the new CLI subcommands, the validation
strengthening, and the refactors above. `pnpm typecheck` / `pnpm -r
build` / `pnpm -r test` / `pnpm lint` are green at the tip of `main`.

## 0.1.0 — 2026-05-13

Initial release covering the v0.1 MVP scope:

- `basou init` workspace bootstrap (`.basou/` directory layout,
  `manifest.yaml`).
- Session lifecycle CLI (`basou session start` / `session list` /
  `session show` / `session note`).
- Task lifecycle CLI (`basou task new` / `task list` / `task show` /
  `task status`).
- Decision recording CLI (`basou decision record`) with the v0.1
  4-field shape.
- Approval CLI (`basou approval list` / `approval show` /
  `approval approve` / `approval reject`).
- Command execution recording (`basou exec`) and adapter passthrough
  (`basou run claude-code`).
- Markdown handoff and decisions auto-generation (`basou handoff
  generate`, `basou decisions generate`).
- Session import (`basou session import --format json`).
- Status snapshot (`basou status`).

This repository is intended to operate as a standalone codebase.
