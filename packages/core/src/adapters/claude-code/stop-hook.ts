import type { ClaudeTranscriptRecord } from "./transcript-importer.js";

/**
 * Default minimum number of "action" tool uses (Bash commands + file edits) a
 * session must contain before the Stop-hook nudge treats it as substantive
 * enough to be worth a session-end capture. Below this the session reads as a
 * trivial check / quick question and the hook stays silent rather than nagging.
 */
export const DEFAULT_STOP_HOOK_MIN_ACTIONS = 5;

/**
 * Commands that constitute capturing the session's intent: the agent ran one of
 * basou's capture verbs, so the why/next-step is recorded and no nudge is owed.
 * Matched against each Bash tool-use command string. The verb must START a
 * command segment — at the beginning of the line or after a `;` / `&` / `|` /
 * `(` / newline separator (so `cd x && basou note "..."` matches) — so a capture
 * verb merely MENTIONED inside another command's quoted argument (e.g.
 * `rg "basou note"`, `echo "basou decision capture"`) does NOT falsely count as
 * a capture and permanently silence the nudge.
 */
const CAPTURE_COMMAND_PATTERN = /(?:^|[\n;&|(])\s*basou\s+(?:decision\s+(?:capture|record)|note)\b/;

/** Tool-use names that mutate a file; each counts as one substantive action. */
const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

export type StopHookEvaluationInput = {
  /**
   * Parsed transcript records, one per JSONL line of the current session's
   * transcript. The caller drops malformed lines; this function reads every
   * field defensively, like the importer, since the format is undocumented.
   */
  records: ReadonlyArray<ClaudeTranscriptRecord>;
  /**
   * The Stop hook's `stop_hook_active` stdin flag: true when Claude is already
   * continuing because of a previous Stop-hook response. When true the nudge
   * stays silent so it can never form a continuation loop.
   */
  stopHookActive: boolean;
  /** Override the substantive-work threshold (defaults to {@link DEFAULT_STOP_HOOK_MIN_ACTIONS}). */
  minActions?: number;
};

/** Why the hook stayed silent (useful for tests and `--json` introspection). */
export type StopHookSilentReason = "stop_hook_active" | "not_substantive" | "already_captured";

export type StopHookEvaluation =
  | { kind: "silent"; reason: StopHookSilentReason; commandCount: number; fileCount: number }
  | { kind: "nudge"; additionalContext: string; commandCount: number; fileCount: number };

/**
 * Decide whether a finished turn warrants a non-blocking capture nudge.
 *
 * Pure: no disk or environment access. The CLI handler reads the Stop hook's
 * stdin payload and the transcript file, parses the JSONL into `records`, and
 * passes them here. A `nudge` result is rendered as
 * `hookSpecificOutput.additionalContext` (non-blocking — Claude may act on it
 * or stop); a `silent` result emits nothing.
 *
 * The nudge fires only when ALL hold:
 *  - not already continuing from a prior nudge (`stopHookActive` is false), so
 *    the hook never loops;
 *  - the session did substantive work (>= `minActions` Bash commands + edits),
 *    so trivial check sessions are left alone;
 *  - no capture verb (`basou decision capture` / `decision record` / `note`)
 *    was run this session, so a session that already recorded its intent is
 *    left alone.
 */
export function evaluateStopHook(input: StopHookEvaluationInput): StopHookEvaluation {
  const minActions = input.minActions ?? DEFAULT_STOP_HOOK_MIN_ACTIONS;

  // Loop guard first: a turn that is already a continuation from a prior nudge
  // can never nudge again, so short-circuit before scanning the transcript at
  // all (the counts are unused on this path).
  if (input.stopHookActive) {
    return { kind: "silent", reason: "stop_hook_active", commandCount: 0, fileCount: 0 };
  }

  let commandCount = 0;
  let fileCount = 0;
  let captured = false;

  for (const record of input.records) {
    if (readString(record.type) !== "assistant") continue;
    for (const tool of toolUsesOf(record)) {
      const name = readString(tool.name);
      if (name === undefined) continue;
      if (name === "Bash") {
        commandCount += 1;
        const input2 = isObject(tool.input) ? tool.input : undefined;
        const command = input2 !== undefined ? readString(input2.command) : undefined;
        if (command !== undefined && CAPTURE_COMMAND_PATTERN.test(command)) captured = true;
      } else if (FILE_EDIT_TOOLS.has(name)) {
        fileCount += 1;
      }
    }
  }

  if (captured) {
    return { kind: "silent", reason: "already_captured", commandCount, fileCount };
  }
  if (commandCount + fileCount < minActions) {
    return { kind: "silent", reason: "not_substantive", commandCount, fileCount };
  }

  return {
    kind: "nudge",
    additionalContext: renderNudge(commandCount, fileCount),
    commandCount,
    fileCount,
  };
}

/** The advisory text fed back to the model (addressed to the agent, not the user). */
function renderNudge(commandCount: number, fileCount: number): string {
  const ran = `${commandCount} ${commandCount === 1 ? "command" : "commands"}`;
  const edited = `${fileCount} ${fileCount === 1 ? "file" : "files"}`;
  return [
    `This session ran ${ran} and edited ${edited} but recorded no decisions or next step.`,
    "If meaningful decisions were made (the chosen approach, rejected alternatives, and why) or there is a clear next step, capture them now so the next session can resume correctly:",
    '  - Decisions: run `basou decision capture` and pipe a JSON array (one object per decision; "title" required, plus optional rationale/alternatives/rejected_reason/linked_files; set "kind":"track" for an unfinished strategic direction).',
    '  - Next step: run `basou note "<what you would do next>"`.',
    "If nothing is worth capturing, just stop — do not invent decisions.",
  ].join("\n");
}

// --- defensive readers (mirror transcript-importer's undocumented-format style) ---

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract the `tool_use` items from an assistant record's `message.content[]`.
 * Returns an empty array for any record that does not match the expected
 * nesting, so callers can iterate unconditionally.
 */
function toolUsesOf(record: ClaudeTranscriptRecord): Array<Record<string, unknown>> {
  const message = isObject(record.message) ? record.message : undefined;
  const content = message !== undefined && Array.isArray(message.content) ? message.content : [];
  const result: Array<Record<string, unknown>> = [];
  for (const item of content) {
    if (isObject(item) && readString(item.type) === "tool_use") result.push(item);
  }
  return result;
}
