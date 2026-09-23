import { execFile } from "node:child_process";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  basouPaths,
  buildSessionStartHookCommand,
  buildStopHookCommand,
  type ClaudeTranscriptRecord,
  DEFAULT_STOP_HOOK_MIN_EDITS,
  evaluateStopHook,
  findBasouSessionStartHook,
  findBasouStopHookCommand,
  findClaudeSessionStartHooks,
  findUnrecognizedSessionStart,
  isClaudeSessionStartMalformed,
  isProtocolUpdateDue,
  ORIENTATION_END,
  ORIENTATION_START,
  observedRepoRoots,
  observeSessionChanges,
  PROTOCOL_END,
  PROTOCOL_START,
  parseMarkers,
  parseProtocolStamp,
  protocolSectionsFrom,
  protocolUpdateToken,
  readManifest,
  readMarkdownFile,
  recordSessionBaseline,
  removeClaudeSessionStartHook,
  removeSessionStartHook,
  removeStopHook,
  renderProtocolUpdate,
  transcriptStartedAt,
  upsertClaudeSessionStartHook,
  upsertSessionStartHook,
  upsertStopHook,
} from "@basou/core";
import type { Command } from "commander";
import {
  codexHookStateKey,
  commandHandlerFields,
  computeCodexHookIdentityHash,
  describeCodexHookTrust,
  judgeCodexHookTrust,
  readCodexHookState,
} from "../lib/codex-hook-trust.js";
import { assertNotSymlink, writeFileDurable } from "../lib/durable-write.js";
import { isVerbose, renderCliError } from "../lib/error-render.js";
import { findForeignWorkspaceNames } from "../lib/foreign-workspace-warn.js";
import { DEFAULT_PORTFOLIO_CONFIG_PATH, loadPortfolioConfig } from "../lib/portfolio-config.js";
import { DEFAULT_TARGET_PATH as PROTOCOL_TARGET_PATH } from "../lib/protocols-config.js";
import { resolveBasouRootForCommand } from "../lib/repo-root.js";
import { renderOrientationForRoot } from "./orient.js";

/** Read at most this many trailing bytes of a transcript (keeps the per-turn hook bounded). */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

/**
 * Read at most this many LEADING bytes when dating a session's start. The first
 * records of a transcript are small, and the start is all this read is for.
 */
const MAX_TRANSCRIPT_HEAD_BYTES = 256 * 1024;

/** Chunk size for the streaming token scan that dedupes a protocol delivery. */
const TOKEN_SCAN_CHUNK_BYTES = 1024 * 1024;

export type HookStopOptions = {
  minEdits?: number;
  /**
   * Opt-in enforcement: when true a warranted nudge is emitted as a blocking
   * `decision:"block"` (the agent is held in-turn to act on it) instead of the
   * default non-blocking `additionalContext`. Default (false) keeps the
   * advisory behavior byte-identical.
   */
  block?: boolean;
  /**
   * Opt-in review gate: when true, a session that shipped substantive code
   * without recording a review also warrants a nudge (composed into the same
   * envelope as the capture nudge). Default (false) ignores the review verdict
   * entirely, keeping the capture-only output byte-identical.
   */
  requireReview?: boolean;
};

/** Raw option shape from commander (values arrive as strings; parsed leniently). */
type RawHookStopOptions = {
  minEdits?: string;
  block?: boolean;
  requireReview?: boolean;
};

/**
 * Records what a session changed on disk, for one of the two passes. Injected
 * so the hook handlers can be tested without a git repository or the
 * operator's real portfolio.
 */
export type ObserveSessionHook = (
  fields: Record<string, unknown>,
  pass: "baseline" | "changes",
  portfolioConfigPath: string | undefined,
) => Promise<void>;

export type HookStopContext = {
  /**
   * Read the Stop hook's stdin payload to EOF. Defaults to reading
   * `process.stdin`. Injectable for tests so they do not depend on a real
   * stdin stream.
   */
  readStdin?: () => Promise<string>;
  /** Read a transcript file. Defaults to `readFile(path, "utf8")`. Injectable for tests. */
  readTranscript?: (path: string) => Promise<string>;
  /** Sink for the hook's stdout JSON. Defaults to `process.stdout.write`. Injectable for tests. */
  write?: (text: string) => void;
  /** Path to the file the protocol block is rendered into. Injectable for tests. */
  protocolTargetPath?: string;
  /** The operator's workspace registry (`~/.basou/portfolio.yaml`). Injectable for tests. */
  portfolioConfigPath?: string;
  /**
   * Observe the session's file changes through git. Defaults to
   * {@link observeSessionFromPayload}; tests inject a spy (or a no-op) so a
   * fake payload cannot reach the operator's real portfolio or store.
   */
  observe?: ObserveSessionHook;
};

/**
 * Wire `basou hook` (hook handlers for AI coding tools) onto `program`.
 *
 * Two handlers. `basou hook stop` is a Claude Code Stop-hook that nudges the
 * agent to capture a substantive session's decisions / next step before the
 * turn ends; it reads the Stop hook JSON payload on stdin and, when warranted,
 * emits a non-blocking `hookSpecificOutput.additionalContext` on stdout.
 * `basou hook session-start` is a Codex SessionStart hook that prints the
 * position of the workspace Codex was opened in; Codex adds the hook's stdout
 * to that session's context as developer text. Both are fail-open: any error
 * (bad stdin, unreadable transcript, a cwd that is not a basou workspace)
 * results in no output and a clean exit, so a hook never breaks a session.
 *
 * `install` / `uninstall` / `status` take an optional target: `claude`
 * (default — the Stop hook in `~/.claude/settings.json`) or `codex` (the
 * SessionStart hook in `~/.codex/hooks.json`).
 */
import { BASOU_VERSION_LINE } from "../program.js";

const execFileAsync = promisify(execFile);

export function registerHookCommand(program: Command): void {
  const hook = program
    .command("hook")
    .description(
      "Hook handlers for AI coding tools (Claude Code, Codex): read a hook payload on stdin, emit the tool's hook output on stdout",
    );

  hook
    .command("session-start")
    .description(
      "SessionStart hook (Codex; Claude Code too): print the current position of the workspace the " +
        "session was opened in (read from the payload's cwd) so the tool adds it to that session's " +
        "context. Stays silent outside a registered basou workspace, and when the position names " +
        "another registered workspace; never fails the session.",
    )
    .addHelpText("after", HOOK_SESSION_START_HELP)
    .action(async () => {
      await runHookSessionStart();
    });

  hook
    .command("stop")
    .description(
      "Stop-hook: when a substantive session recorded no decisions or next " +
        "step, emit a non-blocking nudge to capture them. Also hands a running " +
        "session the standing protocols when they changed after it started — the " +
        "copy it read at start is stale, and only this hook reaches a session " +
        "still running. Reads the Stop hook JSON payload on stdin; never blocks " +
        "and never fails the session.",
    )
    .option(
      "--min-edits <n>",
      `Minimum file edits before nudging on edits alone (default ${DEFAULT_STOP_HOOK_MIN_EDITS})`,
    )
    .option(
      "--block",
      "Opt-in enforcement: hold the agent in-turn (decision:block) instead of a non-blocking message",
    )
    .option(
      "--require-review",
      "Opt-in review gate: also remind when a session shipped substantive code (push / PR / merge) without recording a review",
    )
    .addHelpText("after", HOOK_STOP_HELP)
    .action(async (options: RawHookStopOptions) => {
      // Parse leniently at the boundary rather than with a throwing commander
      // parser: a bad value in a hook config (e.g. `--min-edits nope`) must
      // not exit non-zero and disrupt every Stop event — it falls back to the
      // default instead.
      const minEdits = parseMinEdits(options.minEdits);
      await runHookStop({
        ...(minEdits !== undefined ? { minEdits } : {}),
        ...(options.block === true ? { block: true } : {}),
        ...(options.requireReview === true ? { requireReview: true } : {}),
      });
    });

  hook
    .command("install [target]")
    .description(
      "Register a basou hook (reproducible, idempotent). Target `claude` (default): the Stop hook " +
        "and the SessionStart hook in ~/.claude/settings.json. The Stop hook is advisory capture-only " +
        "by default; --block opts into in-turn enforcement, --require-review into the review gate. " +
        "The SessionStart hook hands each session the workspace's position and records the git " +
        "baseline the Stop hook measures the session's file changes against; --no-session-start " +
        "leaves it out. Target `codex`: the SessionStart hook " +
        "in ~/.codex/hooks.json, which hands each Codex session the position of the workspace it " +
        "was opened in. Codex asks you to review and trust a new hook once before it runs.",
    )
    .option(
      "--block",
      "claude: register the blocking (opt-in enforcement) form instead of advisory",
    )
    .option("--require-review", "claude: register with the opt-in review gate enabled")
    .option("--min-edits <n>", "claude: pass a custom file-edit threshold to the registered hook")
    .option(
      "--no-session-start",
      "claude: register the Stop hook only, and leave any SessionStart hook as it is",
    )
    .option("--settings <path>", "claude: override the settings.json path (intended for tests)")
    .option("--hooks <path>", "codex: override the hooks.json path (intended for tests)")
    .option(
      "--codex-config <path>",
      "codex: override the Codex config.toml path (intended for tests)",
    )
    .option(
      "--codex-face <path>",
      "codex: override the user-global AGENTS.md checked for a leftover block (intended for tests)",
    )
    .option("--dry-run", "Print what would change without writing")
    .option("-v, --verbose", "Show error causes")
    .action(async (target: string | undefined, opts: RawHookInstallOptions) => {
      await dispatchHookTarget(target, opts, {
        claude: () => runHookInstall(opts),
        codex: async () => {
          // The Codex registration IS a SessionStart hook; a flag that says to
          // leave SessionStart out cannot be honoured there, and ignoring it
          // would install exactly what the operator asked not to.
          if (opts.sessionStart === false) {
            renderCliError(
              new Error(
                "--no-session-start applies to target claude only; the Codex hook is itself a SessionStart hook.",
              ),
              { verbose: isVerbose(opts) },
            );
            process.exitCode = 1;
            return;
          }
          await runCodexHookInstall(opts);
        },
      });
    });

  hook
    .command("uninstall [target]")
    .description(
      "Remove a basou hook, leaving other hooks intact. Target `claude` (default): the Stop hook " +
        "and the SessionStart hook in ~/.claude/settings.json. Target `codex`: the SessionStart " +
        "hook in ~/.codex/hooks.json.",
    )
    .option("--settings <path>", "claude: override the settings.json path (intended for tests)")
    .option("--hooks <path>", "codex: override the hooks.json path (intended for tests)")
    .option("--dry-run", "Print what would change without writing")
    .option("-v, --verbose", "Show error causes")
    .action(async (target: string | undefined, opts: RawHookInstallOptions) => {
      await dispatchHookTarget(target, opts, {
        claude: () => runHookUninstall(opts),
        codex: () => runCodexHookUninstall(opts),
      });
    });

  hook
    .command("status [target]")
    .description(
      "Report whether a basou hook is registered. Target `claude` (default): the Stop hook and its " +
        "mode, and the SessionStart hook. Target `codex`: the SessionStart hook, and whether Codex " +
        "has trusted it yet.",
    )
    .option("--settings <path>", "claude: override the settings.json path (intended for tests)")
    .option("--hooks <path>", "codex: override the hooks.json path (intended for tests)")
    .option(
      "--codex-config <path>",
      "codex: override the Codex config.toml path (intended for tests)",
    )
    .option("-v, --verbose", "Show error causes")
    .action(async (target: string | undefined, opts: RawHookInstallOptions) => {
      await dispatchHookTarget(target, opts, {
        claude: () => runHookStatus(opts),
        codex: () => runCodexHookStatus(opts),
      });
    });
}

/** The tools a basou hook can be registered with. `claude` is the default when the target is omitted. */
export type HookTarget = "claude" | "codex";

/**
 * Route `install` / `uninstall` / `status` to the target's implementation. An
 * unknown target is a usage error (exit 1); the message names the valid ones.
 */
async function dispatchHookTarget(
  target: string | undefined,
  options: { verbose?: boolean },
  handlers: Record<HookTarget, () => Promise<void>>,
): Promise<void> {
  const resolved = target ?? "claude";
  if (resolved !== "claude" && resolved !== "codex") {
    renderCliError(
      new Error(`Unknown hook target '${target}'. Targets: claude (default), codex.`),
      { verbose: isVerbose(options) },
    );
    process.exitCode = 1;
    return;
  }
  await handlers[resolved]();
}

const HOOK_SESSION_START_HELP = `
Register this hook reproducibly with 'basou hook install codex' (it writes the
correct node-path command into ~/.codex/hooks.json). 'basou hook uninstall codex'
removes it; 'basou hook status codex' reports whether it is registered and
whether Codex has trusted it.

Codex runs the hook when a session starts and passes the session's cwd on stdin.
basou resolves the workspace from that cwd (a member repo resolves to its
planning master, a workspace view to its master) and prints the workspace's
current position — the same text as 'basou orient' — which Codex adds to that
session's context as developer text. The position is computed at that moment
from that cwd and stored nowhere: a Codex opened in another workspace gets that
workspace's position, and one opened outside any basou workspace (or before the
desktop app has bound a folder, when cwd is '/') gets nothing. That is how one
user-global hook serves every workspace without any workspace's position ever
being written where another workspace's session would read it.

The hook stays silent in one more case: when the position it would print names
ANOTHER registered workspace (a recorded path under it, a captured decision that
mentions it). 'basou orient' and 'basou refresh' report that as a stderr
advisory the operator can read; a hook has no reader for stderr and its stdout
becomes the session's trusted context, so it withholds the position instead.
Run 'basou refresh' to see which lines are responsible.

Claude Code's SessionStart hook sends the same kind of payload (a JSON object
with 'cwd') and adds stdout to context the same way. 'basou hook install'
registers this command there too, in ~/.claude/settings.json, and replaces a
hand-registered 'basou orient' SessionStart hook with it. In Claude Code it also
records where each declared repository stood when the session started, which is
what the Stop hook measures the session's file changes against.

Codex trusts hooks by hash. A newly installed or changed hook is skipped until
you review it: the interactive CLI asks at startup ("Hooks need review"), the
desktop app lists it under Settings -> Hooks. Non-interactive 'codex exec' skips
an untrusted hook silently.
`;

const HOOK_STOP_HELP = `
Register this Stop hook reproducibly with 'basou hook install' (it writes the
correct node-path command into ~/.claude/settings.json). 'basou hook uninstall'
removes it; 'basou hook status' reports whether it is registered.

On every turn end basou inspects the session transcript. If the session did
content-substantive work but ran no capture verb ('basou decision capture' /
'decision record' / 'note'), it reminds the agent to record the why / next step.
Substantive = EITHER >= ${DEFAULT_STOP_HOOK_MIN_EDITS} file edits (default) OR a free-form AskUserQuestion
answer (an uncaptured conversational decision). Read-only Bash (ls / grep /
git status) does NOT count.

With --require-review (opt-in, 'basou hook install --require-review') it also
reminds when the session SHIPPED substantive code (git push / git merge /
gh pr create|merge) without recording a review ('basou review record'). This
gate is off by default; when on, its reminder is composed into the same
envelope as the capture reminder.

It also hands a RUNNING session the standing protocols when they changed after
that session started. The protocol block in ~/.claude/CLAUDE.md is read at
session start, so an update made mid-session never reaches the session it was
meant to correct; this is the only channel that does. The complete current set
is delivered, not a diff, so what it supersedes -- including a protocol that is
no longer there -- is unambiguous. It reads the rendered block and nothing else,
so an edit not yet published by 'basou protocol sync' cannot reach a session,
and it delivers once per block state: a second update in the same session still
lands, the same one twice does not. This part is always on, needs no flag, and
says nothing at all unless the block actually changed.

By default every message here is non-blocking: Claude sees it and may act on it
or stop. With --block (opt-in enforcement, 'basou hook install --block') it
instead returns decision:block, holding the agent in-turn; the 'stop_hook_active'
flag and Claude Code's own loop prevention bound it to a single turn. Note that
this covers the protocol delivery too, which carries no action to take -- with
--block the turn is held so the new text lands before more work is done on the
old. Either way the hook fails open: a bad payload or unreadable transcript
exits cleanly with no output.
`;

/**
 * Programmatic entry for `basou hook stop`. Owns process state. Fail-open by
 * design: a Stop hook that throws or exits non-zero would disrupt every turn,
 * so ALL errors are swallowed and the process exits cleanly with no output.
 */
export async function runHookStop(
  options: HookStopOptions,
  ctx: HookStopContext = {},
): Promise<void> {
  try {
    await doRunHookStop(options, ctx);
  } catch {
    // Intentionally silent: never let a hook failure break the user's session.
  }
}

export async function doRunHookStop(options: HookStopOptions, ctx: HookStopContext): Promise<void> {
  const readStdin = ctx.readStdin ?? defaultReadStdin;
  const readTranscript = ctx.readTranscript ?? readTranscriptBounded;
  const write = ctx.write ?? ((text) => void process.stdout.write(text));

  const raw = await readStdin();
  if (raw.trim().length === 0) return;

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // malformed payload => stay silent
  }
  if (typeof payload !== "object" || payload === null) return;
  const fields = payload as Record<string, unknown>;

  // Observe BEFORE every gate below, including the continuation-turn guard: the
  // gates decide whether the agent hears something, which has nothing to do
  // with whether the session changed files. A session whose last turn is a
  // continuation (the turn that answers a blocking nudge — often the one that
  // captures the decisions) would otherwise have its final edits unobserved.
  const observe = ctx.observe ?? observeSessionFromPayload;
  await observe(fields, "changes", ctx.portfolioConfigPath).catch(() => undefined);

  // A continuation turn (already responding to a prior nudge) can never nudge
  // again, so bail before any transcript I/O — both honoring the loop guard and
  // keeping the continuation turn cheap.
  if (fields.stop_hook_active === true) return;

  const transcriptPath = typeof fields.transcript_path === "string" ? fields.transcript_path : "";
  if (transcriptPath.length === 0) return;

  let transcript: string;
  try {
    transcript = await readTranscript(transcriptPath);
  } catch {
    return; // transcript not readable => stay silent
  }

  const records = parseTranscript(transcript);
  const evaluation = evaluateStopHook({
    records,
    // stop_hook_active was already handled by the early return above.
    stopHookActive: false,
    ...(options.minEdits !== undefined ? { minEdits: options.minEdits } : {}),
  });

  // Compose the independent gates into one Stop response (a Stop hook emits at
  // most one). The capture nudge always participates; the review nudge only
  // when opted in via --require-review (otherwise the review verdict is ignored,
  // so the capture-only output stays byte-identical); the protocol delivery only
  // when the block actually moved. When several fire, their texts join into a
  // single envelope.
  //
  // The protocol delivery LEADS that envelope, because it carries the rules the
  // other parts are written against — the capture nudge is a restatement of the
  // standing capture protocol — so the agent has the governing text in hand
  // before the reminders that follow from it.
  const protocolUpdate = await evaluateProtocolUpdateGate({
    transcriptPath,
    target: ctx.protocolTargetPath ?? PROTOCOL_TARGET_PATH,
  });

  const parts: string[] = [];
  if (protocolUpdate !== null) parts.push(protocolUpdate);
  if (evaluation.kind === "nudge") parts.push(evaluation.additionalContext);
  if (options.requireReview === true && evaluation.review.fires) {
    parts.push(evaluation.review.additionalContext);
  }
  if (parts.length === 0) return;
  const reason = parts.join("\n\n");

  // Default (advisory): a non-blocking reminder the agent may act on next turn
  // or ignore. Opt-in (--block): hold the agent in-turn so it acts on the
  // reminder now. Both carry the SAME text; only the envelope differs. The
  // `decision:"block"` form (exit 0 + stdout JSON, not exit 2) is what lets a
  // `... hook stop --block 2>/dev/null || true` registration keep blocking —
  // `|| true` would swallow an exit-2 block but leaves the JSON form intact.
  // The already-handled `stop_hook_active` early return bounds a block to a
  // single turn (and Claude Code's own loop prevention bounds it regardless).
  const payloadJson =
    options.block === true
      ? JSON.stringify({ decision: "block", reason })
      : JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "Stop",
            additionalContext: reason,
          },
        });
  write(`${payloadJson}\n`);
}

/**
 * Hand a RUNNING session the standing protocols, when they changed after it
 * started.
 *
 * `basou protocol sync` renders the declared protocols into a user-global
 * instruction file the tool auto-loads at SESSION START, so an update made
 * mid-session never reaches the session it was meant to correct: the agent goes
 * on obeying the text it read at start. That is not disobedience, and no
 * SessionStart hook can fix it — it fires at the one moment the copy is already
 * fresh. The Stop hook is the only channel basou owns that reaches a session
 * still running, so the delivery rides it.
 *
 * What is delivered is the protocol TEXT, not a pointer to it: basou cannot
 * observe whether an agent re-read a file, so a "go re-read this" notice would
 * leave the deciding step outside anything basou can see. And it is the
 * COMPLETE current set rather than a diff, which is what lets the message say
 * truthfully that it supersedes what was read at start — including the
 * protocols that are no longer there.
 *
 * It reads the rendered block and nothing else. Not the protocols config, not
 * the source files: they could be moved or unreadable and take the feature
 * silently dead with them, and an edit the operator has not synced is not in
 * the block, so unpublished text cannot reach a session by construction.
 *
 * Once per block STATE, not once per session. The token carries the content
 * digest, so a second update inside one session — usually the correction of the
 * first — still lands. The transcript is what remembers: the tool records a
 * hook's output there, so an earlier delivery is found by its token and no new
 * state is written to disk.
 *
 * Fail-silent in its own right: every failure path returns `null` rather than
 * throwing, so an unreadable file or a damaged block cannot take the capture
 * and review nudges down with it.
 */
async function evaluateProtocolUpdateGate(input: {
  transcriptPath: string;
  target: string;
}): Promise<string | null> {
  try {
    // The session start must come from the HEAD of the transcript. The other
    // gates read a bounded TAIL, and past that bound its first record is not
    // the session's first — it drifts forward as the session grows, which would
    // silently stop the delivery on exactly the long sessions it exists for.
    const head = await readTranscriptHead(input.transcriptPath);
    const sessionStartedAt = transcriptStartedAt(parseTranscript(head));
    if (sessionStartedAt === undefined) return null;

    // Cheap early-out for the overwhelmingly common turn: a target untouched
    // since the session started cannot be carrying anything new.
    const touchedAt = await targetModifiedAt(input.target);
    if (touchedAt !== null && touchedAt <= Date.parse(sessionStartedAt)) return null;

    const existing = await readMarkdownFile(input.target);
    if (existing === null) return null;
    const section = parseMarkers(existing, { start: PROTOCOL_START, end: PROTOCOL_END });
    if (section.kind !== "ok") return null;
    const stamp = parseProtocolStamp(section.generated);
    if (stamp === null) return null;
    if (!isProtocolUpdateDue({ stamp, sessionStartedAt })) return null;

    const sections = protocolSectionsFrom(section.generated);
    if (sections === null || sections.trim().length === 0) return null;

    // Only now — on a turn where something really did change — is the whole
    // transcript worth scanning. Scanning the bounded tail instead would make
    // the delivery repeat once the token scrolled out of it.
    if (await transcriptCarries(input.transcriptPath, protocolUpdateToken(stamp.contentHash))) {
      return null;
    }
    return renderProtocolUpdate(sections, stamp);
  } catch {
    return null;
  }
}

/** Last-modified time of the render target in ms, or `null` when it cannot be read. */
async function targetModifiedAt(target: string): Promise<number | null> {
  try {
    return (await stat(target)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Whether `token` appears anywhere in the file at `path`, read in chunks so a
 * long transcript is never held in memory at once.
 *
 * Chunks overlap by one less than the token's length, so a token straddling a
 * chunk boundary is still found. Called only on a turn where a delivery is
 * otherwise due, which is rare enough that the full read costs nothing in
 * practice.
 */
async function transcriptCarries(path: string, token: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const overlap = Math.max(token.length - 1, 0);
    const chunk = Buffer.alloc(TOKEN_SCAN_CHUNK_BYTES);
    let carry = "";
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, TOKEN_SCAN_CHUNK_BYTES, position);
      if (bytesRead === 0) return false;
      position += bytesRead;
      const text = carry + chunk.subarray(0, bytesRead).toString("utf8");
      if (text.includes(token)) return true;
      carry = overlap > 0 ? text.slice(-overlap) : "";
    }
  } finally {
    await handle.close();
  }
}

export type HookSessionStartContext = {
  /** Read the SessionStart payload on stdin to EOF. Injectable for tests. */
  readStdin?: () => Promise<string>;
  /** Sink for the hook's stdout. Defaults to `process.stdout.write`. Injectable for tests. */
  write?: (text: string) => void;
  /**
   * Render the position for a cwd. Defaults to {@link renderRegisteredWorkspacePosition}:
   * resolve the workspace, refuse one the operator has not registered, render
   * without writing. Injectable for tests of the handler's own logic.
   */
  render?: (cwd: string) => Promise<{ body: string }>;
  /** The operator's workspace registry (`~/.basou/portfolio.yaml`). Injectable for tests. */
  portfolioConfigPath?: string;
  /**
   * Observe the session's file changes through git. Defaults to
   * {@link observeSessionFromPayload}; tests inject a spy (or a no-op) so a
   * fake payload cannot reach the operator's real portfolio or store.
   */
  observe?: ObserveSessionHook;
};

/**
 * The production renderer behind `basou hook session-start`.
 *
 * The hook is user-global: Codex runs it for every session on the machine,
 * with whatever directory the session was opened in. Left to `basou orient`'s
 * own rule, that would render the `.basou/` of ANY repository the user opens —
 * including a clone whose author committed one (the default `basou init`
 * ignore rules track the manifest and per-session metadata), turning a
 * checked-in "next step" into developer context the model trusts more than the
 * repository's own AGENTS.md. So the hook speaks only for a workspace the
 * operator has registered in `~/.basou/portfolio.yaml`: the resolved root (a
 * member repo resolves to its planning master, a view to its master) must be
 * one of the registered paths. That file is the operator's own allowlist, and
 * nothing inside a repository can add to it. An unregistered workspace — a
 * clone, or a greenfield `basou init` not yet registered — gets silence.
 *
 * The render does not write `.basou/orientation.md`: a session-start hook must
 * not leave a file in a repository it only read, and a workspace whose store is
 * read-only must still get its position.
 */
export async function renderRegisteredWorkspacePosition(
  cwd: string,
  portfolioConfigPath: string = DEFAULT_PORTFOLIO_CONFIG_PATH,
): Promise<{ body: string }> {
  const root = await resolveBasouRootForCommand(cwd, "hook session-start", {
    portfolioConfigPath,
  });
  if (!(await isRegisteredWorkspace(root, portfolioConfigPath))) {
    throw new Error("The workspace is not registered in the portfolio; the hook stays silent.");
  }
  const rendered = await renderOrientationForRoot(root, {}, { cwd }, { write: false });
  // Second gate, on the CONTENT. The position is assembled from recorded paths
  // and captured decisions, and either can carry another registered
  // workspace's name. On the commands an operator runs that is a stderr
  // advisory they can read and act on; here nobody reads stderr, and the body
  // is about to become another tool's trusted context. So the hook withholds
  // the position rather than hand a foreign name to the session: silence, the
  // same outcome as an unregistered workspace. The next `basou refresh` or
  // `basou orient` says which lines are responsible.
  const foreign = await findForeignWorkspaceNames({
    text: rendered.body,
    selfPath: root,
    configPath: portfolioConfigPath,
  });
  if (foreign !== null) {
    throw new Error("The position names another registered workspace; the hook stays silent.");
  }
  return { body: rendered.body };
}

/**
 * Whether `root` is one of the workspaces registered in the portfolio, compared
 * by realpath on both sides so a symlinked layout or a `~`-relative entry still
 * matches. An absent or unreadable registry registers nothing.
 */
async function isRegisteredWorkspace(root: string, portfolioConfigPath: string): Promise<boolean> {
  let entries: { path: string }[];
  try {
    entries = await loadPortfolioConfig(portfolioConfigPath);
  } catch {
    return false;
  }
  const rootReal = await realpath(root).catch(() => root);
  for (const entry of entries) {
    const entryReal = await realpath(entry.path).catch(() => null);
    if (entryReal !== null && entryReal === rootReal) return true;
  }
  return false;
}

/**
 * Programmatic entry for `basou hook session-start`. Fail-open by design: a
 * SessionStart hook that throws, exits non-zero, or prints an error would put
 * that error into every Codex session's context (or block the start), so ALL
 * errors are swallowed and the process exits cleanly with no output.
 */
export async function runHookSessionStart(ctx: HookSessionStartContext = {}): Promise<void> {
  try {
    await doRunHookSessionStart(ctx);
  } catch {
    // Intentionally silent: never let a hook failure reach the session.
  }
}

/**
 * Read the SessionStart payload, take its `cwd`, and print that workspace's
 * position. Silent — by returning, not by printing — when the payload has no
 * usable `cwd`, when the cwd is not inside a git repo (the desktop app opens a
 * placeholder thread at `/` before a folder is chosen), when the repo is not a
 * basou workspace, when the workspace is not registered in the operator's
 * portfolio, or when its position names another registered workspace: none of
 * those is an error the session should hear about. The output is plain text;
 * Codex, and Claude Code, add plain stdout to the session's context.
 */
export async function doRunHookSessionStart(ctx: HookSessionStartContext): Promise<void> {
  const readStdin = ctx.readStdin ?? defaultReadStdin;
  const write = ctx.write ?? ((text) => void process.stdout.write(text));
  const render =
    ctx.render ??
    ((cwd: string) => renderRegisteredWorkspacePosition(cwd, ctx.portfolioConfigPath));

  const raw = await readStdin();
  if (raw.trim().length === 0) return;

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof payload !== "object" || payload === null) return;
  const fields = payload as Record<string, unknown>;
  const cwd = fields.cwd;
  if (typeof cwd !== "string" || cwd.length === 0) return;

  // The baseline is recorded independently of what the session is told: the
  // silence gates below are about what text may enter a session's context,
  // while this only writes into the operator's own store. Recording it FIRST
  // also means a render that throws does not cost the session its base.
  const observe = ctx.observe ?? observeSessionFromPayload;
  await observe(fields, "baseline", ctx.portfolioConfigPath).catch(() => undefined);

  let body: string;
  try {
    body = (await render(cwd)).body;
  } catch {
    return; // not a workspace (or unreadable) => stay silent
  }
  if (body.trim().length === 0) return;
  write(`${body.replace(/\s+$/, "")}\n`);
}

/**
 * Observe, through git, what a session has changed on disk — the half of its
 * work no transcript can show.
 *
 * A transcript records a file only when the agent edited it with an editing
 * TOOL. Work done through the shell — a heredoc, a `sed -i`, a script that
 * computes its own paths — leaves no file path anywhere in it, so a session
 * that works that way reads as having touched nothing, and every reader built
 * on `related_files` (the latest-session line, the changed-files line) goes
 * quiet about real work. Git sees that work, and the hooks are the only place
 * basou stands inside a vendor session while it happens.
 *
 * Two passes, one per hook:
 * - SessionStart records where each declared repository stood, so there is a
 *   base to measure from. Without it the only available answer would be "what
 *   changed in this time window", which attributes by proximity rather than by
 *   observation.
 * - Stop recomputes the net change against that base, every turn, so the last
 *   observation before the session ends is the one the import consumes.
 *
 * Gated on the operator's portfolio: a hook is user-global and fires for every
 * directory on the machine, so only a workspace they registered themselves is
 * ever written to. Everything else — an unregistered clone, a payload without
 * the vendor's session id, a store that cannot be written — is silence.
 *
 * Never throws: an observation failure must not cost the session its hook.
 */
async function observeSessionFromPayload(
  fields: Record<string, unknown>,
  pass: "baseline" | "changes",
  portfolioConfigPath: string | undefined,
): Promise<void> {
  const externalId = typeof fields.session_id === "string" ? fields.session_id : "";
  const cwd = typeof fields.cwd === "string" ? fields.cwd : "";
  if (externalId.length === 0 || cwd.length === 0) return;

  const configPath = portfolioConfigPath ?? DEFAULT_PORTFOLIO_CONFIG_PATH;
  let root: string;
  try {
    root = await resolveBasouRootForCommand(cwd, "hook observe", {
      portfolioConfigPath: configPath,
    });
  } catch {
    return; // not a basou workspace => nothing to observe
  }
  if (!(await isRegisteredWorkspace(root, configPath))) return;

  const paths = basouPaths(root);
  const nowIso = new Date().toISOString();
  if (pass === "changes") {
    await observeSessionChanges({
      observationsDir: paths.observations,
      externalId,
      nowIso,
    });
    return;
  }

  const manifest = await readManifest(paths);
  await recordSessionBaseline({
    observationsDir: paths.observations,
    repoRoots: observedRepoRoots(root, manifest),
    externalId,
    nowIso,
  });
}

/** Parse a JSONL transcript into records, skipping blank and malformed lines. */
function parseTranscript(transcript: string): ClaudeTranscriptRecord[] {
  const records: ClaudeTranscriptRecord[] = [];
  for (const line of transcript.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        records.push(parsed as ClaudeTranscriptRecord);
      }
    } catch {
      // Skip a malformed line (e.g. a partially-flushed final record).
    }
  }
  return records;
}

async function defaultReadStdin(): Promise<string> {
  // A Stop hook is always invoked with piped stdin; if attached to a TTY there
  // is no payload, so return empty rather than block forever.
  if (process.stdin.isTTY === true) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read a transcript, bounded to {@link MAX_TRANSCRIPT_BYTES} so a pathologically
 * large session cannot stall the per-turn hook or exhaust memory. When the file
 * exceeds the cap, only the trailing window is read (and its first partial line
 * dropped): that window still holds far more than `minEdits` edits (so the
 * session reads as substantive) and any end-of-session capture verb, so the
 * decision is unchanged for normal usage while the read stays bounded.
 */
export async function readTranscriptBounded(
  path: string,
  maxBytes: number = MAX_TRANSCRIPT_BYTES,
): Promise<string> {
  const { size } = await stat(path);
  if (size <= maxBytes) return readFile(path, "utf8");
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, size - maxBytes);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const firstNewline = text.indexOf("\n");
    return firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
  } finally {
    await handle.close();
  }
}

/**
 * Read at most the leading `maxBytes` of a transcript.
 *
 * The sibling {@link readTranscriptBounded} reads the TAIL, which is right for
 * counting what a session did and wrong for dating when it began: past the
 * bound its first record is not the session's first. A partial trailing line is
 * dropped so the caller only ever parses whole records.
 */
export async function readTranscriptHead(
  path: string,
  maxBytes: number = MAX_TRANSCRIPT_HEAD_BYTES,
): Promise<string> {
  const { size } = await stat(path);
  if (size <= maxBytes) return readFile(path, "utf8");
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lastNewline = text.lastIndexOf("\n");
    return lastNewline >= 0 ? text.slice(0, lastNewline + 1) : text;
  } finally {
    await handle.close();
  }
}

/**
 * Lenient parse for `--min-edits`: a valid non-negative integer, otherwise
 * `undefined` (fall back to the default). Never throws — a bad value in a hook
 * config must not exit non-zero and disrupt the session.
 */
export function parseMinEdits(raw: string | undefined): number | undefined {
  // Strictly a run of digits: avoids Number()'s coercions ("" / " " -> 0,
  // "1e3" -> 1000) so only an explicit non-negative integer is honored;
  // anything else falls back to the default.
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

// --- hook install / uninstall / status -------------------------------------
//
// Unlike `hook stop` (a fail-open per-turn handler), these are interactive
// management commands: they report errors and exit non-zero. They edit the
// user-global settings.json by parsing it, applying a pure transform from core
// (which touches only basou's Stop entry), and writing it back durably with a
// one-time backup and an optimistic-concurrency recheck — the same safety
// posture as `basou protocol sync`.

/** Canonical location of the Claude Code user settings file. */
export const DEFAULT_CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

/** Raw option shape from commander for the management subcommands. */
type RawHookInstallOptions = {
  block?: boolean;
  requireReview?: boolean;
  minEdits?: string;
  /** commander's `--no-session-start`: false when the flag is given. */
  sessionStart?: boolean;
  settings?: string;
  /** codex: override the hooks.json path (tests). */
  hooks?: string;
  /** codex: override the config.toml path read for trust state (tests). */
  codexConfig?: string;
  /** codex: override the user-global AGENTS.md checked for a leftover block (tests). */
  codexFace?: string;
  dryRun?: boolean;
  verbose?: boolean;
};

export type HookInstallOptions = {
  block?: boolean;
  requireReview?: boolean;
  minEdits?: number;
  /** claude: register the Stop hook only and leave SessionStart as it is. */
  noSessionStart?: boolean;
  settings?: string;
  hooks?: string;
  codexConfig?: string;
  codexFace?: string;
  dryRun?: boolean;
  verbose?: boolean;
};

export type HookInstallContext = {
  /** Resolve the CLI entry path to register. Injectable so tests do not depend on argv. */
  resolveCliEntry?: () => string;
};

/**
 * Resolve the node entry to register: the script this process was invoked as
 * (`process.argv[1]`), realpath-resolved so an npm bin symlink points at the
 * real `dist/index.js`. Registering the running entry is what makes the hook
 * reproducible across the source build and an npm install.
 */
function resolveCliEntry(): string {
  // Resolve the CLI's own entry from this module's URL rather than process.argv[1]:
  // when basou is launched through the bare `basou` installer (whose bin is just
  // `import "@basou/cli"`), argv[1] is that wrapper — not the CLI — so the
  // registered hook would not be recognized later by status / uninstall. This
  // file is bundled into the CLI's dist/index.js (the bin), so import.meta.url
  // points at the entry to register under both the npm install and source build.
  return fileURLToPath(import.meta.url);
}

function normalizeInstallOptions(raw: RawHookInstallOptions): HookInstallOptions {
  const out: HookInstallOptions = {};
  if (raw.block === true) out.block = true;
  if (raw.requireReview === true) out.requireReview = true;
  if (raw.sessionStart === false) out.noSessionStart = true;
  if (raw.settings !== undefined) out.settings = raw.settings;
  if (raw.hooks !== undefined) out.hooks = raw.hooks;
  if (raw.codexConfig !== undefined) out.codexConfig = raw.codexConfig;
  if (raw.codexFace !== undefined) out.codexFace = raw.codexFace;
  if (raw.dryRun === true) out.dryRun = true;
  if (raw.verbose === true) out.verbose = true;
  if (raw.minEdits !== undefined) {
    // Strict here (unlike the fail-open `hook stop`): an interactive install
    // must not silently ignore a typo'd threshold.
    const parsed = parseMinEdits(raw.minEdits);
    if (parsed === undefined) {
      throw new Error("--min-edits must be a non-negative integer.");
    }
    out.minEdits = parsed;
  }
  return out;
}

/** Read settings.json: `{ raw, parsed }`. Absent or empty => raw null; invalid JSON => throws. */
async function readSettings(path: string): Promise<{ raw: string | null; parsed: unknown }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && (error as { code?: string }).code === "ENOENT") {
      return { raw: null, parsed: undefined };
    }
    throw error;
  }
  if (raw.trim().length === 0) return { raw, parsed: undefined };
  try {
    return { raw, parsed: JSON.parse(raw) };
  } catch (error: unknown) {
    throw new Error(
      "The Claude settings.json is not valid JSON. Fix it (or remove it) and retry.",
      {
        cause: error,
      },
    );
  }
}

/**
 * Back up the settings file's original content the first time basou modifies it
 * (a single stable `<path>.basou-bak`, never overwritten), so the pre-basou
 * original is preserved exactly once. Mirrors `protocol sync`'s backupOnce.
 */
async function backupSettingsOnce(path: string, raw: string | null): Promise<void> {
  if (raw === null) return;
  const bak = `${path}.basou-bak`;
  try {
    await stat(bak);
    return; // backup already exists
  } catch (error: unknown) {
    if (!(error instanceof Error && (error as { code?: string }).code === "ENOENT")) throw error;
  }
  await writeFileDurable(bak, raw);
}

export async function runHookInstall(
  options: RawHookInstallOptions,
  ctx: HookInstallContext = {},
): Promise<void> {
  try {
    await doRunHookInstall(normalizeInstallOptions(options), ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

export async function doRunHookInstall(
  options: HookInstallOptions,
  ctx: HookInstallContext = {},
): Promise<void> {
  const settingsPath = options.settings ?? DEFAULT_CLAUDE_SETTINGS_PATH;
  const cliEntry = (ctx.resolveCliEntry ?? resolveCliEntry)();
  const command = buildStopHookCommand({
    cliEntry,
    ...(options.block === true ? { block: true } : {}),
    ...(options.requireReview === true ? { requireReview: true } : {}),
    ...(options.minEdits !== undefined ? { minEdits: options.minEdits } : {}),
  });
  const mode = describeHookMode({
    block: options.block === true,
    review: options.requireReview === true,
  });

  await assertNotSymlink(settingsPath);
  const { raw, parsed } = await readSettings(settingsPath);
  const stop = upsertStopHook(parsed, command);

  // The SessionStart half is new; a settings file it cannot read (a
  // `hooks.SessionStart` that is not a list) must not cost the operator the
  // Stop hook, which installed fine before this half existed.
  let sessionStart: SessionStartInstallOutcome;
  if (options.noSessionStart === true) {
    sessionStart = { kind: "skipped" };
  } else {
    try {
      const upsert = upsertClaudeSessionStartHook(
        stop.settings,
        buildSessionStartHookCommand({ cliEntry }),
      );
      sessionStart = { kind: "done", action: upsert.action, settings: upsert.settings };
    } catch (error: unknown) {
      if (!isClaudeSessionStartMalformed(stop.settings)) throw error;
      sessionStart = { kind: "malformed" };
    }
  }
  const settings = sessionStart.kind === "done" ? sessionStart.settings : stop.settings;

  // Write only when a hook actually changed. Comparing the whole file text
  // instead would rewrite a file whose hooks are already right but whose
  // formatting differs -- and report "no change" while doing it. Same rule as
  // the Codex install.
  const changed =
    stop.action !== "unchanged" ||
    (sessionStart.kind === "done" && sessionStart.action !== "unchanged");
  const dryRun = options.dryRun === true;

  const lines = [
    describeStopInstall(stop.action, mode, dryRun),
    describeSessionStartInstall(sessionStart, dryRun),
    ...describeSessionStartLeftovers(settings),
  ];

  if (!changed || dryRun) {
    for (const line of lines) console.log(line);
    return;
  }

  // Optimistic concurrency (see protocol sync): re-read and abort on a
  // concurrent edit before backing up or writing.
  const recheck = await readSettings(settingsPath);
  if (recheck.raw !== raw) {
    throw new Error(
      "The settings.json changed during install; aborting so a concurrent edit is not overwritten. Re-run 'basou hook install'.",
    );
  }

  await backupSettingsOnce(settingsPath, raw);
  await writeFileDurable(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  for (const line of lines) console.log(line);
}

type SessionStartInstallOutcome =
  | { kind: "skipped" }
  | { kind: "malformed" }
  | {
      kind: "done";
      action: "installed" | "updated" | "replaced" | "unchanged";
      settings: Record<string, unknown>;
    };

function describeStopInstall(
  action: "installed" | "updated" | "unchanged",
  mode: string,
  dryRun: boolean,
): string {
  if (action === "unchanged") {
    return `The basou Stop hook is already registered (${mode}); no change.`;
  }
  if (dryRun) {
    return `[dry-run] Would ${action === "installed" ? "install" : "update"} the basou Stop hook (${mode}).`;
  }
  return `${action === "installed" ? "Installed" : "Updated"} the basou Stop hook (${mode}).`;
}

/**
 * The SessionStart half of an install, in words that say what the hook is FOR
 * when it is new -- the position at session start, and the git baseline
 * without which the session's shell edits are invisible -- and every way the
 * replacement for a hand-registered `basou orient` behaves differently.
 */
function describeSessionStartInstall(outcome: SessionStartInstallOutcome, dryRun: boolean): string {
  if (outcome.kind === "skipped") {
    return "The SessionStart hook was left as it is (--no-session-start).";
  }
  if (outcome.kind === "malformed") {
    return "The basou SessionStart hook was NOT installed: 'hooks.SessionStart' in settings.json is not a list of hook groups. Fix it and re-run 'basou hook install'.";
  }
  const action = outcome.action;
  if (action === "unchanged") {
    return "The basou SessionStart hook is already registered; no change.";
  }
  const prefix = dryRun ? "[dry-run] Would " : "";
  if (action === "replaced") {
    return `${prefix}${dryRun ? "replace" : "Replaced"} the hand-registered 'basou orient' SessionStart hook with 'basou hook session-start': the same position, plus the baseline the Stop hook measures the session's file changes against. It differs in three ways: it speaks only for a workspace registered in ~/.basou/portfolio.yaml, it does not rewrite .basou/orientation.md at session start, and it stays silent when the position names another registered workspace.`;
  }
  if (action === "updated") {
    return `${prefix}${dryRun ? "update" : "Updated"} the basou SessionStart hook.`;
  }
  return `${prefix}${dryRun ? "install" : "Installed"} the basou SessionStart hook: each session gets the workspace's position, and the Stop hook can see the files the session changes through the shell.`;
}

/**
 * What the settings still say about SessionStart that a reader should know,
 * after install has done what it may. Two things, both about the position
 * arriving twice, and both said only when it actually can:
 * - a command that runs basou inside something longer, which install does not
 *   rewrite (it would delete what was written around it), next to a hook of
 *   basou's own;
 * - more than one basou entry left under different matchers, which install
 *   does not collapse (it would narrow when the hook fires).
 */
function describeSessionStartLeftovers(settings: unknown): string[] {
  const own = findClaudeSessionStartHooks(settings);
  if (own.length === 0) return [];
  const lines: string[] = [];
  for (const other of findUnrecognizedSessionStart(settings)) {
    lines.push(
      `note: this SessionStart hook runs basou '${other.runs === "orient" ? "orient" : "hook session-start"}' inside a longer command, so it was left as written, and a session may receive the position twice: ${other.command}`,
    );
  }
  if (own.length > 1) {
    const matchers = own.map((o) => o.matcher ?? "(every source)").join(", ");
    lines.push(
      `note: ${own.length} basou SessionStart hooks remain, under different matchers (${matchers}). They were kept so that no session source stops firing; a source that more than one matches receives the position twice. Remove the one you do not want by hand.`,
    );
  }
  return lines;
}

export async function runHookUninstall(options: RawHookInstallOptions): Promise<void> {
  try {
    await doRunHookUninstall(normalizeInstallOptions(options));
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

export async function doRunHookUninstall(options: HookInstallOptions): Promise<void> {
  const settingsPath = options.settings ?? DEFAULT_CLAUDE_SETTINGS_PATH;

  await assertNotSymlink(settingsPath);
  const { raw, parsed } = await readSettings(settingsPath);
  if (raw === null) {
    console.log("No settings.json; nothing to remove.");
    return;
  }
  const stop = removeStopHook(parsed);
  const sessionStart = removeClaudeSessionStartHook(stop.settings);
  if (stop.action === "absent" && sessionStart.action === "absent") {
    console.log("No basou Stop hook or SessionStart hook found; nothing removed.");
    return;
  }
  const newBody = `${JSON.stringify(sessionStart.settings, null, 2)}\n`;
  const removedNames = [
    ...(stop.action === "removed" ? ["Stop hook"] : []),
    ...(sessionStart.action === "removed" ? ["SessionStart hook"] : []),
  ];

  if (options.dryRun === true) {
    for (const name of removedNames) {
      console.log(`[dry-run] Would remove the basou ${name} from settings.json.`);
    }
    return;
  }

  const recheck = await readSettings(settingsPath);
  if (recheck.raw !== raw) {
    throw new Error(
      "The settings.json changed during uninstall; aborting so a concurrent edit is not overwritten. Re-run 'basou hook uninstall'.",
    );
  }

  await backupSettingsOnce(settingsPath, raw);
  await writeFileDurable(settingsPath, newBody);
  for (const name of removedNames) {
    console.log(`Removed the basou ${name} from settings.json.`);
  }
}

export async function runHookStatus(options: RawHookInstallOptions): Promise<void> {
  try {
    await doRunHookStatus(normalizeInstallOptions(options));
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

export async function doRunHookStatus(options: HookInstallOptions): Promise<void> {
  const settingsPath = options.settings ?? DEFAULT_CLAUDE_SETTINGS_PATH;
  const { parsed } = await readSettings(settingsPath);
  const command = findBasouStopHookCommand(parsed);
  if (command === null) {
    console.log("basou Stop hook: not registered. Run 'basou hook install' to register it.");
  } else {
    const mode = describeHookMode({
      block: / --block\b/.test(command),
      review: / --require-review\b/.test(command),
    });
    console.log(`basou Stop hook: registered, ${mode}.`);
    await reportHookEntryBuild(command);
  }
  reportSessionStartStatus(parsed);
}

/**
 * The SessionStart half of `hook status`. Its absence has a consequence the
 * operator cannot see from anywhere else — the Stop hook keeps running, but
 * with no baseline it records nothing about the files a session changes
 * through the shell — so each state says what it means, not only what it is.
 */
function reportSessionStartStatus(parsed: unknown): void {
  if (isClaudeSessionStartMalformed(parsed)) {
    console.log(
      "basou SessionStart hook: cannot tell -- 'hooks.SessionStart' in settings.json is not a list of hook groups.",
    );
    return;
  }
  const own = findClaudeSessionStartHooks(parsed);
  const others = findUnrecognizedSessionStart(parsed);
  // The hook that does the work is reported first: a `hook session-start`
  // entry records the baseline whatever else sits beside it.
  for (const hook of own.filter((o) => o.kind === "session-start")) {
    console.log(`basou SessionStart hook: registered, fires ${describeFiring(hook.matcher)}.`);
  }
  for (const hook of own.filter((o) => o.kind === "orient")) {
    console.log(
      `basou SessionStart hook: 'basou orient' registered by hand, fires ${describeFiring(hook.matcher)}. It delivers the position but records no git baseline, so the files a session changes through the shell are not observed; 'basou hook install' replaces it with 'basou hook session-start'.`,
    );
  }
  if (own.length === 0) {
    if (others.length === 0) {
      console.log(
        "basou SessionStart hook: not registered. Sessions get no position at start, and the files a session changes through the shell are not observed. Run 'basou hook install' to register it.",
      );
    }
    for (const other of others) {
      console.log(
        other.runs === "orient"
          ? `basou SessionStart hook: not registered by basou. A SessionStart hook runs 'basou orient' inside a longer command, so sessions may get the position, but no git baseline is recorded: ${other.command}`
          : `basou SessionStart hook: not registered by basou. A SessionStart hook runs 'basou hook session-start' inside a longer command, which basou leaves as written: ${other.command}`,
      );
    }
  }
  for (const line of describeSessionStartLeftovers(parsed)) console.log(line);
}

function describeFiring(matcher: string | undefined): string {
  return matcher === undefined || matcher === "" || matcher === "*"
    ? "on every session source"
    : `on ${matcher}`;
}

/**
 * Say which BUILD the registered hook will actually execute.
 *
 * The hook runs a node entry path, not the `basou` on `PATH`, and the wrapper
 * it carries (`2>/dev/null || true`) is deliberately fail-open so a broken or
 * stale entry never blocks a turn. That silence is the right default for every
 * turn and the wrong one for the moment somebody asks whether their hook is
 * current -- which is what this command is for. So the question is answered
 * here, where it was asked, and nowhere that costs a session-start byte.
 *
 * The build is obtained by ASKING the entry (`--version`), not by reading a
 * path or a timestamp: the entry is the only thing that knows what it is.
 */
async function reportHookEntryBuild(command: string): Promise<void> {
  // Both halves are printed, always. The question behind the question is "is
  // my hook current", and the two builds are ALLOWED to differ -- the hook
  // often runs a source build while `basou` on PATH is the npm global -- so
  // this makes no verdict. It just stops asking the reader to run a second
  // command and hold the first answer in their head.
  console.log(`  this basou is: ${BASOU_VERSION_LINE}`);

  const entry = extractHookEntryPath(command);
  if (entry === undefined) {
    // The alias form (`basou hook stop`) is a registration shape basou itself
    // recognizes, and no path can be read out of it. Saying so is the point:
    // a silent return here prints output identical to a healthy hook's, which
    // is precisely the false reassurance this command exists to remove.
    console.log(
      "  runs: (registered by alias, not by path) — which build that resolves to depends on the hook's PATH, so this cannot tell you.",
    );
    return;
  }

  try {
    const { stdout } = await execFileAsync(process.execPath, [entry, "--version"], {
      timeout: 10_000,
    });
    const reported = stdout.trim();
    console.log(`  the hook runs: ${entry}`);
    console.log(`  that build is: ${reported}`);
    if (!reported.includes("(build ")) {
      console.log(
        "  note: that build predates build stamping, so what it reports is its package.json rather than itself — it cannot tell you which build it is. Update it (rebuild a source checkout, or reinstall the package) to find out.",
      );
    }
  } catch {
    console.log(`  the hook runs: ${entry}`);
    console.log(
      "  that build is: could not be executed — the hook's wrapper fails open, so it is silently doing nothing.",
    );
  }
}

/**
 * Split a registered hook command the way a POSIX shell would, honouring
 * single and double quotes. Returns `undefined` for input the shell itself
 * would reject (an unterminated quote), because a command that cannot be
 * parsed is one this must not pretend to understand.
 */
function tokenizeShellCommand(command: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | undefined;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = undefined;
      else if (ch === "\\" && i + 1 < command.length) current += command[++i] as string;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += command[++i] as string;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote !== undefined) return undefined;
  if (started) tokens.push(current);
  return tokens;
}

/**
 * Pull the node entry path out of the registered hook command.
 *
 * This tokenizes rather than pattern-matches, because the shapes basou itself
 * accepts as a registration are wider than the one it writes: a quoted path
 * (either quote), an `ENV=1` prefix, node flags before the entry, an absolute
 * interpreter. A regex over the raw string got each of those wrong in a way
 * that produced a CONFIDENT and false report -- `node --enable-source-maps
 * '<entry>' hook stop` yielded `--enable-source-maps`, which this then executed
 * with `--version` and printed node's own version as "the build", followed by
 * advice to rebuild.
 *
 * `undefined` means "cannot tell", and the caller must say so. The alias form
 * (`basou hook stop`) lands here by design: there is no path in it, and which
 * build it resolves to depends on the hook's PATH.
 */
function extractHookEntryPath(command: string): string | undefined {
  const tokens = tokenizeShellCommand(command);
  if (tokens === undefined) return undefined;

  let index = 0;
  // Environment assignments precede the command word.
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] as string)) index++;

  const interpreter = tokens[index];
  if (interpreter === undefined) return undefined;
  // Only a node invocation carries an entry path as an argument. Anything else
  // (the `basou` alias, a wrapper script) has no path to read.
  const base = interpreter.replace(/\\/g, "/").split("/").pop() ?? "";
  if (base !== "node" && base !== "node.exe") return undefined;
  index++;

  // Node's own flags come before the script.
  while (index < tokens.length && (tokens[index] as string).startsWith("-")) index++;

  const entry = tokens[index];
  return entry === undefined || entry === "" ? undefined : entry;
}

/**
 * Human-readable description of an installed Stop hook's tiers: the enforcement
 * dimension (advisory vs blocking, from `--block`) and which gates are active
 * (capture is always on; review is added by `--require-review`).
 */
function describeHookMode(tiers: { block: boolean; review: boolean }): string {
  const enforcement = tiers.block ? "blocking (opt-in enforcement)" : "advisory (non-blocking)";
  const gates = tiers.review ? "capture + review" : "capture";
  return `${enforcement}, ${gates}`;
}

// --- codex: SessionStart hook install / uninstall / status ------------------
//
// The Codex twin of the Claude Stop hook management above, against
// `~/.codex/hooks.json`. Same safety posture: parse, apply a pure transform from
// core that touches only basou's entry, write back durably with a one-time
// backup and an optimistic-concurrency recheck.

/**
 * Codex's user-global AGENTS.md — the face a basou of 0.39 or before rendered
 * the orientation into. Retiring the writer did not remove what it wrote, so
 * `hook install codex` and `hook status codex` look for a leftover block and
 * name the command that removes it.
 */
export const DEFAULT_CODEX_FACE_PATH = join(homedir(), ".codex", "AGENTS.md");

const LEFTOVER_FACE_NOTE = (label: string): string =>
  `${label} still carries an orientation block rendered by an earlier basou (0.39 or before); every Codex session on this machine reads it. \`basou channel clear codex\` removes it.`;

/** Whether the face still holds a BASOU:ORIENTATION block (well-formed or not). Never throws. */
async function faceHasLeftoverOrientationBlock(facePath: string): Promise<boolean> {
  try {
    const existing = await readMarkdownFile(facePath);
    if (existing === null) return false;
    const section = parseMarkers(existing, { start: ORIENTATION_START, end: ORIENTATION_END });
    return section.kind !== "no_markers";
  } catch {
    return false;
  }
}

/** Canonical location of the Codex user-global hooks file. */
export const DEFAULT_CODEX_HOOKS_PATH = join(homedir(), ".codex", "hooks.json");

/** Canonical location of the Codex user config, where hook trust is recorded. */
export const DEFAULT_CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");

/** Read hooks.json: `{ raw, parsed }`. Absent or empty => raw null; invalid JSON => throws. */
async function readHooksFile(path: string): Promise<{ raw: string | null; parsed: unknown }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && (error as { code?: string }).code === "ENOENT") {
      return { raw: null, parsed: undefined };
    }
    throw error;
  }
  if (raw.trim().length === 0) return { raw, parsed: undefined };
  try {
    return { raw, parsed: JSON.parse(raw) };
  } catch (error: unknown) {
    throw new Error("The Codex hooks.json is not valid JSON. Fix it (or remove it) and retry.", {
      cause: error,
    });
  }
}

/**
 * What the operator must still do after an install: Codex trusts hooks by hash
 * and skips a new or changed one until reviewed. Said on every install and on
 * `status`, because non-interactive `codex exec` skips silently and the desktop
 * app has been reported not to prompt.
 */
const CODEX_TRUST_NOTE =
  "Codex reviews a new or changed hook once before running it: start `codex` in a terminal and trust it when asked (desktop app: Settings -> Hooks). Until then the hook is skipped silently.";

export async function runCodexHookInstall(
  options: RawHookInstallOptions,
  ctx: HookInstallContext = {},
): Promise<void> {
  try {
    await doRunCodexHookInstall(normalizeInstallOptions(options), ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

export async function doRunCodexHookInstall(
  options: HookInstallOptions,
  ctx: HookInstallContext = {},
): Promise<void> {
  const hooksPath = options.hooks ?? DEFAULT_CODEX_HOOKS_PATH;
  const cliEntry = (ctx.resolveCliEntry ?? resolveCliEntry)();
  const command = buildSessionStartHookCommand({ cliEntry });

  await assertNotSymlink(hooksPath);
  const { raw, parsed } = await readHooksFile(hooksPath);
  const { hooksFile, action } = upsertSessionStartHook(parsed, command);
  const newBody = `${JSON.stringify(hooksFile, null, 2)}\n`;

  // `unchanged` means the installed handler already carries the canonical
  // fields — Codex's trust hash is unaffected — so nothing is written even when
  // the file's formatting differs from what basou would emit: a reformat would
  // take a backup and announce an update the operator would then be told to
  // re-trust, for a hook Codex still trusts.
  if (action === "unchanged" || (raw !== null && newBody === raw)) {
    console.log("The basou Codex SessionStart hook is already registered; no change.");
    await reportCodexHookState(hooksPath, hooksFile, options);
    return;
  }
  if (options.dryRun === true) {
    console.log(
      `[dry-run] Would ${action === "installed" ? "install" : "update"} the basou Codex SessionStart hook in ${hooksPath}.`,
    );
    return;
  }

  const recheck = await readHooksFile(hooksPath);
  if (recheck.raw !== raw) {
    throw new Error(
      "The hooks.json changed during install; aborting so a concurrent edit is not overwritten. Re-run 'basou hook install codex'.",
    );
  }
  await backupSettingsOnce(hooksPath, raw);
  await writeFileDurable(hooksPath, newBody);
  console.log(
    `${action === "installed" ? "Installed" : "Updated"} the basou Codex SessionStart hook in ${hooksPath}.`,
  );
  await reportCodexHookState(hooksPath, hooksFile, options);
}

/**
 * What the operator needs to know right after an install or on `status`: has
 * Codex trusted this exact handler yet (a new or changed hook is skipped until
 * reviewed, silently under non-interactive `codex exec`), and does the
 * user-global face still carry a block an earlier basou left there.
 */
async function reportCodexHookState(
  hooksPath: string,
  hooksFile: unknown,
  options: HookInstallOptions,
): Promise<void> {
  const location = findBasouSessionStartHook(hooksFile);
  if (location !== null) {
    const trust = await codexHookTrustFor(hooksPath, location, options.codexConfig);
    console.log(`Codex trust: ${describeCodexHookTrust(trust)}.`);
    if (trust.status === "untrusted" || trust.status === "modified") console.log(CODEX_TRUST_NOTE);
  }
  const facePath = options.codexFace ?? DEFAULT_CODEX_FACE_PATH;
  if (await faceHasLeftoverOrientationBlock(facePath)) {
    console.log(LEFTOVER_FACE_NOTE(options.codexFace ?? "~/.codex/AGENTS.md"));
  }
}

export async function runCodexHookUninstall(options: RawHookInstallOptions): Promise<void> {
  try {
    await doRunCodexHookUninstall(normalizeInstallOptions(options));
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

export async function doRunCodexHookUninstall(options: HookInstallOptions): Promise<void> {
  const hooksPath = options.hooks ?? DEFAULT_CODEX_HOOKS_PATH;

  await assertNotSymlink(hooksPath);
  const { raw, parsed } = await readHooksFile(hooksPath);
  if (raw === null) {
    console.log("No hooks.json; nothing to remove.");
    return;
  }
  const { hooksFile, action } = removeSessionStartHook(parsed);
  if (action === "absent") {
    console.log("No basou Codex SessionStart hook found; nothing removed.");
    return;
  }
  const newBody = `${JSON.stringify(hooksFile, null, 2)}\n`;

  if (options.dryRun === true) {
    console.log("[dry-run] Would remove the basou Codex SessionStart hook from hooks.json.");
    return;
  }
  const recheck = await readHooksFile(hooksPath);
  if (recheck.raw !== raw) {
    throw new Error(
      "The hooks.json changed during uninstall; aborting so a concurrent edit is not overwritten. Re-run 'basou hook uninstall codex'.",
    );
  }
  await backupSettingsOnce(hooksPath, raw);
  await writeFileDurable(hooksPath, newBody);
  console.log("Removed the basou Codex SessionStart hook from hooks.json.");
}

export async function runCodexHookStatus(options: RawHookInstallOptions): Promise<void> {
  try {
    await doRunCodexHookStatus(normalizeInstallOptions(options));
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

export async function doRunCodexHookStatus(options: HookInstallOptions): Promise<void> {
  const hooksPath = options.hooks ?? DEFAULT_CODEX_HOOKS_PATH;
  const { parsed } = await readHooksFile(hooksPath);
  const location = findBasouSessionStartHook(parsed);
  if (location === null) {
    console.log(
      "basou Codex SessionStart hook: not registered. Run 'basou hook install codex' to register it.",
    );
    const facePath = options.codexFace ?? DEFAULT_CODEX_FACE_PATH;
    if (await faceHasLeftoverOrientationBlock(facePath)) {
      console.log(LEFTOVER_FACE_NOTE(options.codexFace ?? "~/.codex/AGENTS.md"));
    }
    return;
  }
  const matcher = location.matcher ?? "(every source)";
  console.log(
    `basou Codex SessionStart hook: registered in ${hooksPath} (matcher: ${matcher}); speaks only for workspaces registered in ~/.basou/portfolio.yaml.`,
  );
  // The Codex handler carries the same fail-open wrapper as the Claude Stop
  // hook and the same silence, and it is the more consequential of the two:
  // this is the channel where a build too old to parse a newer event drops it
  // line by line. Whatever the Stop hook is asked, ask this one too.
  await reportHookEntryBuild(location.command);
  await reportCodexHookState(hooksPath, parsed, options);
}

/**
 * Codex's own verdict on the installed handler, read from `config.toml` and
 * compared against the hash Codex would compute for what is in hooks.json.
 * Never throws: an unreadable config or a handler shape the hash cannot cover
 * reports `unknown` with the reason.
 */
export async function codexHookTrustFor(
  hooksPath: string,
  location: {
    groupIndex: number;
    handlerIndex: number;
    matcher: string | undefined;
    handler: Record<string, unknown>;
  },
  configPath: string | undefined,
): Promise<ReturnType<typeof judgeCodexHookTrust>> {
  const fields = commandHandlerFields(location.handler);
  if (fields === null)
    return { status: "unknown", detail: "the installed handler is not a command hook" };
  let configToml: string;
  try {
    configToml = await readFile(configPath ?? DEFAULT_CODEX_CONFIG_PATH, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && (error as { code?: string }).code === "ENOENT") {
      return { status: "untrusted" }; // no config at all => Codex has recorded no trust
    }
    return {
      status: "unknown",
      detail: `could not read ${configPath ?? DEFAULT_CODEX_CONFIG_PATH}`,
    };
  }
  const key = codexHookStateKey(
    hooksPath,
    "session_start",
    location.groupIndex,
    location.handlerIndex,
  );
  const state = readCodexHookState(configToml, key);
  const current = computeCodexHookIdentityHash({
    eventKey: "session_start",
    matcher: location.matcher,
    handler: fields,
  });
  return judgeCodexHookTrust(state, current);
}
