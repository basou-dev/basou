import { countUncapturedDecisionPoints } from "./ask-user-question.js";
import type { ClaudeTranscriptRecord } from "./transcript-importer.js";

/**
 * Default minimum number of FILE EDITS (Edit / Write / NotebookEdit) a session
 * must contain to read as substantive on edits alone. Read-only Bash does NOT
 * count toward this: a session that only ran `ls` / `grep` / `git status` did no
 * decision-worthy work and must stay silent rather than nag (the imprecision the
 * old raw command+edit count caused). A free-form decision point (see below)
 * makes a session substantive on its own, independent of this threshold.
 */
export const DEFAULT_STOP_HOOK_MIN_EDITS = 2;

/**
 * Commands that constitute capturing the session's intent: the agent ran one of
 * basou's capture verbs, so the why/next-step is recorded and no nudge is owed.
 * Matched against each Bash tool-use command string.
 *
 * The invocation may be either the `basou` binary/alias OR the CLI entry run via
 * node — `node /abs/.../cli/dist/index.js <verb>` — because in a non-interactive
 * context (this Stop hook, an agent's Bash) `basou` is often a shell alias that
 * is not on PATH, so the CLI is invoked by its node path instead. That is the
 * SAME reason the documented SessionStart hook uses the node path; a capture
 * done that way must not be missed (which would nudge a session that did record
 * its intent). The node arm is anchored to `cli/dist/index.js` — the tail shared
 * by both the source build (`packages/cli/dist/index.js`) and the npm install
 * (`@basou/cli/dist/index.js`) — so an unrelated `node scripts/index.js note` in
 * some other project does NOT masquerade as a Basou capture.
 *
 * Either invocation must START a command segment — at the beginning of the line
 * or after a `;` / `&` / `|` / `(` / newline separator (so `cd x && basou note`
 * matches) — so a capture verb merely MENTIONED inside another command's quoted
 * argument (e.g. `rg "basou note"`, `echo "node …/cli/dist/index.js note"`) does
 * NOT falsely count as a capture and permanently silence the nudge.
 *
 * This stays a best-effort heuristic, deliberately not a shell parser: a
 * separator INSIDE a quoted argument can still satisfy the segment-start guard,
 * and wrapper forms (an env prefix, intervening `node` flags, `pnpm`/`npx`) are
 * not recognized. Both were already true of the `basou`-only predicate; the
 * cost of a miss is one redundant nudge, never a blocked turn.
 */
const CAPTURE_INVOCATION = /(?:basou|(?:\S*\/)?node\s+\S*cli\/dist\/index\.js)/;
const CAPTURE_VERB = /(?:decision\s+(?:capture|record)|note)\b/;
const CAPTURE_COMMAND_PATTERN = new RegExp(
  `(?:^|[\\n;&|(])\\s*${CAPTURE_INVOCATION.source}\\s+${CAPTURE_VERB.source}`,
);

/** Tool-use names that mutate a file; each counts as one substantive edit. */
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
  /** Override the file-edit threshold (defaults to {@link DEFAULT_STOP_HOOK_MIN_EDITS}). */
  minEdits?: number;
};

/** Why the hook stayed silent (useful for tests and `--json` introspection). */
export type StopHookSilentReason = "stop_hook_active" | "not_substantive" | "already_captured";

type StopHookCounts = {
  /** Bash tool uses (informational — does NOT drive the trigger). */
  commandCount: number;
  /** File edits (Edit / Write / NotebookEdit) — the primary substantive signal. */
  fileCount: number;
  /** Free-form AskUserQuestion answers (uncaptured conversational decisions). */
  decisionPointCount: number;
};

export type StopHookEvaluation =
  | ({ kind: "silent"; reason: StopHookSilentReason } & StopHookCounts)
  | ({ kind: "nudge"; additionalContext: string } & StopHookCounts);

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
 *  - the session did CONTENT-SUBSTANTIVE work, so trivial / read-only check
 *    sessions are left alone. Substantive = EITHER enough file edits
 *    (>= `minEdits`) OR a free-form AskUserQuestion answer (an uncaptured
 *    conversational decision). Raw read-only Bash (ls / grep / git status) does
 *    NOT count — the old raw command+edit count nagged on pure exploration;
 *  - no capture verb (`basou decision capture` / `decision record` / `note`)
 *    was run this session, so a session that already recorded its intent is
 *    left alone.
 */
export function evaluateStopHook(input: StopHookEvaluationInput): StopHookEvaluation {
  const minEdits = input.minEdits ?? DEFAULT_STOP_HOOK_MIN_EDITS;

  // Loop guard first: a turn that is already a continuation from a prior nudge
  // can never nudge again, so short-circuit before scanning the transcript at
  // all (the counts are unused on this path).
  if (input.stopHookActive) {
    return {
      kind: "silent",
      reason: "stop_hook_active",
      commandCount: 0,
      fileCount: 0,
      decisionPointCount: 0,
    };
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
        const toolInput = isObject(tool.input) ? tool.input : undefined;
        const command = toolInput !== undefined ? readString(toolInput.command) : undefined;
        if (command !== undefined && CAPTURE_COMMAND_PATTERN.test(command)) captured = true;
      } else if (FILE_EDIT_TOOLS.has(name)) {
        fileCount += 1;
      }
    }
  }

  const decisionPointCount = countUncapturedDecisionPoints(input.records);
  const counts: StopHookCounts = { commandCount, fileCount, decisionPointCount };

  if (captured) {
    return { kind: "silent", reason: "already_captured", ...counts };
  }
  // Content-aware substantiveness: read-only Bash no longer counts. A session is
  // substantive when it edited enough files OR hit a free-form decision point —
  // the precise signals indicating decision-worthy work the next session should
  // be able to resume from.
  const substantive = fileCount >= minEdits || decisionPointCount > 0;
  if (!substantive) {
    return { kind: "silent", reason: "not_substantive", ...counts };
  }

  return { kind: "nudge", additionalContext: renderNudge(counts), ...counts };
}

/**
 * The advisory text fed back to the model (addressed to the agent, not the
 * user). The lead clause names only the signals that actually fired, so a nudge
 * triggered solely by a decision point does not misreport "edited 0 files".
 */
function renderNudge(counts: StopHookCounts): string {
  const did: string[] = [];
  if (counts.commandCount > 0) {
    did.push(`ran ${counts.commandCount} ${counts.commandCount === 1 ? "command" : "commands"}`);
  }
  if (counts.fileCount > 0) {
    did.push(`edited ${counts.fileCount} ${counts.fileCount === 1 ? "file" : "files"}`);
  }
  if (counts.decisionPointCount > 0) {
    const n = counts.decisionPointCount;
    did.push(`answered ${n} open-ended ${n === 1 ? "question" : "questions"}`);
  }
  const summary = did.length > 0 ? did.join(", ") : "did substantive work";
  return [
    `This session ${summary} but recorded no decisions or next step.`,
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
