import { open, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSessionStartHookCommand,
  buildStopHookCommand,
  type ClaudeTranscriptRecord,
  DEFAULT_STOP_HOOK_MIN_EDITS,
  evaluateStopHook,
  findBasouSessionStartHook,
  findBasouStopHookCommand,
  ORIENTATION_END,
  ORIENTATION_START,
  parseMarkers,
  readMarkdownFile,
  removeSessionStartHook,
  removeStopHook,
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
import { DEFAULT_PORTFOLIO_CONFIG_PATH, loadPortfolioConfig } from "../lib/portfolio-config.js";
import { resolveBasouRootForCommand } from "../lib/repo-root.js";
import { renderOrientationForRoot } from "./orient.js";

/** Read at most this many trailing bytes of a transcript (keeps the per-turn hook bounded). */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

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
export function registerHookCommand(program: Command): void {
  const hook = program
    .command("hook")
    .description(
      "Hook handlers for AI coding tools (Claude Code, Codex): read a hook payload on stdin, emit the tool's hook output on stdout",
    );

  hook
    .command("session-start")
    .description(
      "Codex SessionStart hook: print the current position of the workspace Codex was opened in " +
        "(read from the payload's cwd) so Codex adds it to that session's context. Stays silent " +
        "outside a basou workspace; never fails the session.",
    )
    .addHelpText("after", HOOK_SESSION_START_HELP)
    .action(async () => {
      await runHookSessionStart();
    });

  hook
    .command("stop")
    .description(
      "Stop-hook: when a substantive session recorded no decisions or next " +
        "step, emit a non-blocking nudge to capture them. Reads the Stop hook " +
        "JSON payload on stdin; never blocks and never fails the session.",
    )
    .option(
      "--min-edits <n>",
      `Minimum file edits before nudging on edits alone (default ${DEFAULT_STOP_HOOK_MIN_EDITS})`,
    )
    .option(
      "--block",
      "Opt-in enforcement: hold the agent in-turn (decision:block) instead of a non-blocking reminder",
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
        "in ~/.claude/settings.json — advisory capture-only by default; --block opts into in-turn " +
        "enforcement, --require-review into the review gate. Target `codex`: the SessionStart hook " +
        "in ~/.codex/hooks.json, which hands each Codex session the position of the workspace it " +
        "was opened in. Codex asks you to review and trust a new hook once before it runs.",
    )
    .option(
      "--block",
      "claude: register the blocking (opt-in enforcement) form instead of advisory",
    )
    .option("--require-review", "claude: register with the opt-in review gate enabled")
    .option("--min-edits <n>", "claude: pass a custom file-edit threshold to the registered hook")
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
        codex: () => runCodexHookInstall(opts),
      });
    });

  hook
    .command("uninstall [target]")
    .description(
      "Remove a basou hook, leaving other hooks intact. Target `claude` (default): the Stop hook " +
        "in ~/.claude/settings.json. Target `codex`: the SessionStart hook in ~/.codex/hooks.json.",
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
        "mode. Target `codex`: the SessionStart hook, and whether Codex has trusted it yet.",
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

By default the reminder is non-blocking: Claude sees it and may act on it or
stop. With --block (opt-in enforcement, 'basou hook install --block') it instead
returns decision:block, holding the agent in-turn to act on the reminder; the
'stop_hook_active' flag and Claude Code's own loop prevention bound it to a
single turn. Either way the hook fails open: a bad payload or unreadable
transcript exits cleanly with no output.
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

  // Compose the two independent gates into one Stop response (a Stop hook emits
  // at most one). The capture nudge always participates; the review nudge only
  // when opted in via --require-review (otherwise the review verdict is ignored,
  // so the capture-only output stays byte-identical). When both fire, their
  // texts join into a single envelope.
  const parts: string[] = [];
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
 * Read Codex's SessionStart payload, take its `cwd`, and print that workspace's
 * position. Silent — by returning, not by printing — when the payload has no
 * usable `cwd`, when the cwd is not inside a git repo (the desktop app opens a
 * placeholder thread at `/` before a folder is chosen), when the repo is not a
 * basou workspace, or when the workspace is not registered in the operator's
 * portfolio: none of those is an error the session should hear about. The
 * output is plain text; Codex adds plain stdout as developer context.
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
  const cwd = (payload as Record<string, unknown>).cwd;
  if (typeof cwd !== "string" || cwd.length === 0) return;

  let body: string;
  try {
    body = (await render(cwd)).body;
  } catch {
    return; // not a workspace (or unreadable) => stay silent
  }
  if (body.trim().length === 0) return;
  write(`${body.replace(/\s+$/, "")}\n`);
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
  const { settings, action } = upsertStopHook(parsed, command);
  const newBody = `${JSON.stringify(settings, null, 2)}\n`;

  if (raw !== null && newBody === raw) {
    console.log(`The basou Stop hook is already registered (${mode}); no change.`);
    return;
  }

  if (options.dryRun === true) {
    console.log(`[dry-run] Would ${action} the basou Stop hook (${mode}).`);
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
  await writeFileDurable(settingsPath, newBody);
  console.log(`${action === "installed" ? "Installed" : "Updated"} the basou Stop hook (${mode}).`);
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
  const { settings, action } = removeStopHook(parsed);
  if (action === "absent") {
    console.log("No basou Stop hook found; nothing removed.");
    return;
  }
  const newBody = `${JSON.stringify(settings, null, 2)}\n`;

  if (options.dryRun === true) {
    console.log("[dry-run] Would remove the basou Stop hook from settings.json.");
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
  console.log("Removed the basou Stop hook from settings.json.");
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
    return;
  }
  const mode = describeHookMode({
    block: / --block\b/.test(command),
    review: / --require-review\b/.test(command),
  });
  console.log(`basou Stop hook: registered, ${mode}.`);
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
