import { open, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildStopHookCommand,
  type ClaudeTranscriptRecord,
  DEFAULT_STOP_HOOK_MIN_EDITS,
  evaluateStopHook,
  findBasouStopHookCommand,
  removeStopHook,
  upsertStopHook,
} from "@basou/core";
import type { Command } from "commander";
import { assertNotSymlink, writeFileDurable } from "../lib/durable-write.js";
import { isVerbose, renderCliError } from "../lib/error-render.js";

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
};

/** Raw option shape from commander (values arrive as strings; parsed leniently). */
type RawHookStopOptions = {
  minEdits?: string;
  block?: boolean;
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
 * Wire `basou hook` (Claude Code hook handlers) onto `program`.
 *
 * Currently one handler: `basou hook stop`, a Stop-hook that nudges the agent
 * to capture a substantive session's decisions / next step before the turn
 * ends. It reads the Stop hook JSON payload on stdin and, when warranted,
 * emits a non-blocking `hookSpecificOutput.additionalContext` on stdout. It
 * NEVER blocks and NEVER fails the session: any error (bad stdin, unreadable
 * transcript) results in no output and a clean exit.
 */
export function registerHookCommand(program: Command): void {
  const hook = program
    .command("hook")
    .description(
      "Claude Code hook handlers (read a hook payload on stdin, emit hook JSON on stdout)",
    );

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
      });
    });

  hook
    .command("install")
    .description(
      "Register the Stop hook in ~/.claude/settings.json (reproducible, idempotent). " +
        "Default is advisory; --block opts into in-turn enforcement.",
    )
    .option("--block", "Register the blocking (opt-in enforcement) form instead of advisory")
    .option("--min-edits <n>", "Pass a custom file-edit threshold to the registered hook")
    .option("--settings <path>", "Override the settings.json path (intended for tests)")
    .option("--dry-run", "Print what would change without writing")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: RawHookInstallOptions) => {
      await runHookInstall(opts);
    });

  hook
    .command("uninstall")
    .description(
      "Remove the basou Stop hook from ~/.claude/settings.json (leaves other hooks intact)",
    )
    .option("--settings <path>", "Override the settings.json path (intended for tests)")
    .option("--dry-run", "Print what would change without writing")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: RawHookInstallOptions) => {
      await runHookUninstall(opts);
    });

  hook
    .command("status")
    .description("Report whether the basou Stop hook is registered, and in which mode")
    .option("--settings <path>", "Override the settings.json path (intended for tests)")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: RawHookInstallOptions) => {
      await runHookStatus(opts);
    });
}

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
  if (evaluation.kind !== "nudge") return;

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
      ? JSON.stringify({ decision: "block", reason: evaluation.additionalContext })
      : JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "Stop",
            additionalContext: evaluation.additionalContext,
          },
        });
  write(`${payloadJson}\n`);
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
  minEdits?: string;
  settings?: string;
  dryRun?: boolean;
  verbose?: boolean;
};

export type HookInstallOptions = {
  block?: boolean;
  minEdits?: number;
  settings?: string;
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
  if (raw.settings !== undefined) out.settings = raw.settings;
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
    ...(options.minEdits !== undefined ? { minEdits: options.minEdits } : {}),
  });
  const mode = options.block === true ? "blocking" : "advisory";

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
  const mode = / --block\b/.test(command)
    ? "blocking (opt-in enforcement)"
    : "advisory (non-blocking)";
  console.log(`basou Stop hook: registered, ${mode}.`);
}
