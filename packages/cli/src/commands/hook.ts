import { open, readFile, stat } from "node:fs/promises";
import {
  type ClaudeTranscriptRecord,
  DEFAULT_STOP_HOOK_MIN_EDITS,
  evaluateStopHook,
} from "@basou/core";
import type { Command } from "commander";

/** Read at most this many trailing bytes of a transcript (keeps the per-turn hook bounded). */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

export type HookStopOptions = {
  minEdits?: number;
};

/** Raw option shape from commander (values arrive as strings; parsed leniently). */
type RawHookStopOptions = {
  minEdits?: string;
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
    .addHelpText("after", HOOK_STOP_HELP)
    .action(async (options: RawHookStopOptions) => {
      // Parse leniently at the boundary rather than with a throwing commander
      // parser: a bad value in a hook config (e.g. `--min-edits nope`) must
      // not exit non-zero and disrupt every Stop event — it falls back to the
      // default instead.
      const minEdits = parseMinEdits(options.minEdits);
      await runHookStop(minEdits !== undefined ? { minEdits } : {});
    });
}

const HOOK_STOP_HELP = `
Install as a Claude Code Stop hook in ~/.claude/settings.json:
  {
    "hooks": {
      "Stop": [
        { "hooks": [ { "type": "command", "command": "basou hook stop" } ] }
      ]
    }
  }

On every turn end basou inspects the session transcript. If the session did
content-substantive work but ran no capture verb ('basou decision capture' /
'decision record' / 'note'), it emits a non-blocking reminder so the agent can
record the why / next step. Substantive = EITHER >= ${DEFAULT_STOP_HOOK_MIN_EDITS} file edits (default)
OR a free-form AskUserQuestion answer (an uncaptured conversational decision).
Read-only Bash (ls / grep / git status) does NOT count. The reminder is
non-blocking: Claude sees it and may act on it or stop; it never forces the turn
to continue. The 'stop_hook_active' flag is honored so the nudge cannot loop.
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

  write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: evaluation.additionalContext,
      },
    })}\n`,
  );
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
