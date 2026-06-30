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

/**
 * Commands that ship work outward — the boundary at which an adversarial /
 * second-opinion review should already have run. Matched against each Bash
 * command string with the SAME segment-start guard as
 * {@link CAPTURE_COMMAND_PATTERN}: the ship verb must START a command segment
 * (line start or after a `;` / `&` / `|` / `(` / newline) so a ship command
 * merely MENTIONED inside another command's quoted argument (e.g.
 * `echo "git push"`, `rg "gh pr create"`) does not falsely trip the gate.
 *
 * Built-in coverage only — `git` / `gh` are near-universal. A declared,
 * per-workspace override (`ship_acts`) and a code-vs-docs edit filter are
 * deliberate follow-ups, NOT part of this MVP: the gate starts on built-in
 * patterns at the same edit threshold as capture, and dogfeedback tunes it.
 *
 * Each verb is closed with a `(?![-\w])` lookahead, not a bare `\b`: `\b` treats
 * a hyphen as a boundary, so `git\s+merge\b` would also match the read-only
 * `git merge-base` / `git merge-tree` (and `\w` keeps `git pushd` etc. out). The
 * lookahead requires the verb to end at a real token boundary (space / EOL /
 * quote), so hyphenated sibling subcommands are NOT mistaken for a ship act.
 *
 * Best-effort heuristic, like the capture predicate: a separator inside a
 * quoted argument can still satisfy the guard, and wrapper forms (env prefix,
 * `xargs`, …) are not recognized. The cost of a miss is one redundant nudge,
 * never a blocked turn.
 */
const SHIP_ACT_PATTERN =
  /(?:^|[\n;&|(])\s*(?:git\s+push|git\s+merge|gh\s+pr\s+(?:create|merge))(?![-\w])/;

/**
 * A `git push` carrying a dry-run flag (`--dry-run` / `-n`) in its OWN command
 * segment: it reports what it WOULD ship without shipping, so it is not a ship
 * act. The flag is scoped to the push's segment (`[^\n;&|()]*?`) so an unrelated
 * `-n` on another command (`git commit -n && git push`) does not wrongly clear a
 * real push. `git push` is the only built-in ship verb with a dry-run form that
 * matters. A miss here is a false-NEGATIVE (one un-nudged ship) — the safe
 * direction — never a false block.
 */
const DRY_RUN_PUSH_PATTERN = /(?:^|[\n;&|(])\s*git\s+push\b[^\n;&|()]*?\s-(?:-dry-run|n)\b/;

/**
 * Whether a Bash command string ships work outward. Matches a built-in ship
 * verb ({@link SHIP_ACT_PATTERN}) but rules out a dry-run push
 * ({@link DRY_RUN_PUSH_PATTERN}).
 */
function isShipAct(command: string): boolean {
  return SHIP_ACT_PATTERN.test(command) && !DRY_RUN_PUSH_PATTERN.test(command);
}

/**
 * Recording that a review ran: `basou review record` (or the node-path form,
 * for the same alias-not-on-PATH reason as {@link CAPTURE_COMMAND_PATTERN}).
 * When present this session, the review gate is satisfied and stays silent —
 * the twin signal to {@link CAPTURE_COMMAND_PATTERN} for the capture gate.
 */
const REVIEW_RECORD_PATTERN = new RegExp(
  `(?:^|[\\n;&|(])\\s*${CAPTURE_INVOCATION.source}\\s+review\\s+record\\b`,
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

/**
 * Why the review gate stayed silent. The gate fires only when a SHIP act, a
 * substantive-code edit, and the ABSENCE of a review record all hold; each
 * reason names the first of those three that did not.
 *  - `stop_hook_active`: loop guard — a continuation turn never fires.
 *  - `no_ship_act`: nothing was shipped this turn (review is a pre-ship act, so
 *    a turn that did not push / open / merge owes no review).
 *  - `not_substantive_code`: shipped, but fewer than `minEdits` file edits.
 *  - `already_reviewed`: a `basou review record` ran this session.
 */
export type ReviewGateSilentReason =
  | "stop_hook_active"
  | "no_ship_act"
  | "not_substantive_code"
  | "already_reviewed";

/**
 * The review gate's verdict, computed INDEPENDENTLY of the capture gate in the
 * same transcript pass: a session can have captured its decisions yet still owe
 * a review (it shipped code without recording one), and vice versa. Returned
 * alongside the capture verdict; no caller renders it yet — a follow-on slice
 * will have the CLI compose it with the capture signal into the nudge / block.
 */
export type ReviewGateResult =
  | { fires: false; reason: ReviewGateSilentReason }
  | { fires: true; additionalContext: string };

type StopHookCounts = {
  /** Bash tool uses (informational — does NOT drive the trigger). */
  commandCount: number;
  /** File edits (Edit / Write / NotebookEdit) — the primary substantive signal. */
  fileCount: number;
  /** Free-form AskUserQuestion answers (uncaptured conversational decisions). */
  decisionPointCount: number;
};

export type StopHookEvaluation =
  | ({ kind: "silent"; reason: StopHookSilentReason; review: ReviewGateResult } & StopHookCounts)
  | ({ kind: "nudge"; additionalContext: string; review: ReviewGateResult } & StopHookCounts);

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
 *
 * It ALSO computes a second, independent verdict: the {@link ReviewGateResult}
 * (whether a substantive-code session shipped — push / PR / merge — without
 * recording a review). The two are computed in one transcript pass and returned
 * together; the CLI composes them. The review verdict is purely additive here —
 * the capture `kind` / `additionalContext` / `reason` are byte-identical to
 * before, so consumers that read only the capture signal are unaffected.
 */
export function evaluateStopHook(input: StopHookEvaluationInput): StopHookEvaluation {
  const minEdits = input.minEdits ?? DEFAULT_STOP_HOOK_MIN_EDITS;

  // Loop guard first: a turn that is already a continuation from a prior nudge
  // can never nudge again, so short-circuit before scanning the transcript at
  // all (the counts are unused on this path). Both gates honor it.
  if (input.stopHookActive) {
    return {
      kind: "silent",
      reason: "stop_hook_active",
      review: { fires: false, reason: "stop_hook_active" },
      commandCount: 0,
      fileCount: 0,
      decisionPointCount: 0,
    };
  }

  let commandCount = 0;
  let fileCount = 0;
  let captured = false;
  let shipped = false;
  let reviewed = false;

  for (const record of input.records) {
    if (readString(record.type) !== "assistant") continue;
    for (const tool of toolUsesOf(record)) {
      const name = readString(tool.name);
      if (name === undefined) continue;
      if (name === "Bash") {
        commandCount += 1;
        const toolInput = isObject(tool.input) ? tool.input : undefined;
        const command = toolInput !== undefined ? readString(toolInput.command) : undefined;
        if (command !== undefined) {
          if (CAPTURE_COMMAND_PATTERN.test(command)) captured = true;
          if (isShipAct(command)) shipped = true;
          if (REVIEW_RECORD_PATTERN.test(command)) reviewed = true;
        }
      } else if (FILE_EDIT_TOOLS.has(name)) {
        fileCount += 1;
      }
    }
  }

  const decisionPointCount = countUncapturedDecisionPoints(input.records);
  const counts: StopHookCounts = { commandCount, fileCount, decisionPointCount };
  // The review gate is independent of the capture outcome, so compute it once
  // and attach it to every post-scan return (e.g. a session can be
  // `already_captured` yet still owe a review).
  const review = evaluateReviewGate({ shipped, reviewed, fileCount, minEdits });

  if (captured) {
    return { kind: "silent", reason: "already_captured", review, ...counts };
  }
  // Content-aware substantiveness: read-only Bash no longer counts. A session is
  // substantive when it edited enough files OR hit a free-form decision point —
  // the precise signals indicating decision-worthy work the next session should
  // be able to resume from.
  const substantive = fileCount >= minEdits || decisionPointCount > 0;
  if (!substantive) {
    return { kind: "silent", reason: "not_substantive", review, ...counts };
  }

  return { kind: "nudge", additionalContext: renderNudge(counts), review, ...counts };
}

/**
 * Decide whether a finished turn warrants a review nudge: it SHIPPED work (a
 * push / PR / merge appeared this session) after a substantive-code edit
 * (>= `minEdits` file edits) yet recorded NO review (`basou review record`).
 *
 * Unlike the capture gate, a free-form decision point does NOT make this fire —
 * you review code that shipped, not a conversation — so it keys on file edits
 * alone. MVP: built-in ship patterns at the same edit threshold as capture,
 * with no code-vs-docs filter; dogfeedback tunes it. The reasons are checked in
 * the AND order (ship → substantive → not-reviewed) so the silent reason names
 * the first unmet condition.
 */
function evaluateReviewGate(input: {
  shipped: boolean;
  reviewed: boolean;
  fileCount: number;
  minEdits: number;
}): ReviewGateResult {
  if (!input.shipped) return { fires: false, reason: "no_ship_act" };
  if (input.fileCount < input.minEdits) return { fires: false, reason: "not_substantive_code" };
  if (input.reviewed) return { fires: false, reason: "already_reviewed" };
  return { fires: true, additionalContext: renderReviewNudge() };
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

/**
 * The review-gate advisory, addressed to the agent. Fixed text (no counts):
 * the trigger is the ship-act + missing review, not a quantity. Names the
 * `basou review record` verb and gives the model an out so it does not
 * fabricate a review record.
 */
function renderReviewNudge(): string {
  return [
    "This session shipped code (a push / PR / merge) after substantive edits but recorded no review.",
    "An adversarial / second-opinion review before shipping is the discipline here. If a review ran, record it now so it lands on the durable trail:",
    '  - run `basou review record` and pipe a JSON object: { "reviewer": "...", "target": "...", with optional "verdict" / "findings" / "blocked" } (an explicit "blocked": [] records that you blocked nothing).',
    "If no review ran, that is the gap this is meant to catch — review before relying on this. If a review genuinely was not warranted, just stop — do not fabricate a review record.",
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
