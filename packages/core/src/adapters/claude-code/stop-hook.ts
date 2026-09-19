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
 * `basou review record --dry-run` validates and previews WITHOUT writing an
 * event, so it is not a record: it bought silence from a command that provably
 * recorded nothing.
 *
 * Scoped to ONE segment, and for the opposite reason to
 * {@link DRY_RUN_PUSH_PATTERN}. There, a miss is a false negative — one
 * un-nudged ship. Here a false positive DISCARDS a real record and nudges for a
 * review that happened, so `review record ... && npm publish --dry-run`, and the
 * validate-then-record pair `review record --dry-run && review record`, must
 * both still count.
 */
const DRY_RUN_REVIEW_PATTERN = /(?:^|\s)--dry-run(?![-\w=])/;

/** The record invocation with the segment boundary already consumed by the split. */
const REVIEW_RECORD_IN_SEGMENT = new RegExp(
  `^\\s*${CAPTURE_INVOCATION.source}\\s+review\\s+record\\b`,
);

/**
 * Command segments, split on the same separators the anchored patterns above
 * treat as boundaries. Not a shell parser: a separator inside a quoted string
 * splits too, which is the pre-existing behaviour of those anchors.
 */
function commandSegments(command: string): string[] {
  return command.split(/[\n;&|()]+/);
}

/** A command with at least one segment that actually WRITES a review record. */
function isReviewRecord(command: string): boolean {
  return commandSegments(command).some(
    (segment) => REVIEW_RECORD_IN_SEGMENT.test(segment) && !DRY_RUN_REVIEW_PATTERN.test(segment),
  );
}

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
 * Why the review gate stayed silent. The gate fires when a SHIP act happened,
 * the edits preceding it were substantive, and the LAST such ship act was not
 * covered by a review; each reason names the first of those three that did not
 * hold.
 *  - `stop_hook_active`: loop guard — a continuation turn never fires.
 *  - `no_ship_act`: nothing was shipped this turn (review is a pre-ship act, so
 *    a turn that did not push / open / merge owes no review).
 *  - `not_substantive_code`: shipped, but fewer than `minEdits` file edits
 *    PRECEDED the last ship act.
 *  - `already_reviewed`: a `basou review record` ran BEFORE the last ship act,
 *    and the working state did not substantively change between the two.
 */
export type ReviewGateSilentReason =
  | "stop_hook_active"
  | "no_ship_act"
  | "not_substantive_code"
  | "already_reviewed";

/**
 * Why the gate fired. A review that ran but did not cover what shipped is a
 * different failure from no review at all, and the two need different advice.
 *  - `no_review`: nothing was recorded before the ship act.
 *  - `changed_after_review`: a review was recorded, then the code substantively
 *    changed before shipping. Applying the review's own findings looks exactly
 *    like this, which is why the nudge asks rather than asserts -- but so does
 *    reimplementing after a review overturned the design, and THAT is the case
 *    this exists for: it is the one that gets more likely the harder reviews
 *    are made to bite.
 */
export type ReviewGateFireReason = "no_review" | "changed_after_review";

/**
 * The review gate's verdict, computed INDEPENDENTLY of the capture gate in the
 * same transcript pass: a session can have captured its decisions yet still owe
 * a review (it shipped code without recording one), and vice versa. Returned
 * alongside the capture verdict; no caller renders it yet — a follow-on slice
 * will have the CLI compose it with the capture signal into the nudge / block.
 */
export type ReviewGateResult =
  | { fires: false; reason: ReviewGateSilentReason }
  | { fires: true; reason: ReviewGateFireReason; additionalContext: string };

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
  // Order is the signal the old gate threw away: it kept only "a review record
  // ran somewhere", so one recorded AFTER the merge silenced it, and so did one
  // recorded before a substantive rewrite.
  //
  // The question is asked of the LAST ship act, not OR-ed over every ship in the
  // session. A topic-branch push and the merge that lands it are one unit of
  // work, and the push necessarily precedes the review -- the reviewer reads the
  // pull request. Latching on the first ship reported `no_review` for the
  // project's own documented workflow, permanently: no later review could clear
  // it, so the remedy the message prescribes was not one.
  //
  // File order is NOT assumed to be timestamp order -- the importer next door
  // documents that it is not. Measured on this workspace's transcripts, the
  // records this loop walks (`assistant` only) were out of order in 1 of 25,
  // 3 adjacent pairs, at most 7.4s apart, with zero sidechain records; the
  // interleaving lives in the `user` / `attachment` / `queue-operation` records
  // skipped above. A review and the ship it covers are minutes apart in
  // practice, so that jitter cannot reorder the pair this reads.
  let editsSinceReview = 0;
  let editsBeforeLastShip = 0;
  /** null until something ships; then whether the LAST ship act was covered. */
  let lastShipUncovered: ReviewGateFireReason | null = null;

  for (const record of input.records) {
    if (readString(record.type) !== "assistant") continue;
    // A sidechain is a subagent's turn, not this session's act: its `git push`
    // is not the parent shipping, and its `review record` did not cover what the
    // parent shipped. The importer excludes them for the same reason, and its
    // stated hazard -- sidechain blocks flush out of order -- bites here now
    // that position decides the verdict.
    if (record.isSidechain === true) continue;
    for (const tool of toolUsesOf(record)) {
      const name = readString(tool.name);
      if (name === undefined) continue;
      if (name === "Bash") {
        commandCount += 1;
        const toolInput = isObject(tool.input) ? tool.input : undefined;
        const command = toolInput !== undefined ? readString(toolInput.command) : undefined;
        if (command !== undefined) {
          if (CAPTURE_COMMAND_PATTERN.test(command)) captured = true;
          if (isShipAct(command)) {
            shipped = true;
            // Substantiveness is asked of what preceded THIS ship, not of the
            // session total: edits made after a push do not make that push
            // substantive, and treating them as if they did is the same
            // non-positional reading this commit removes on the review axis.
            editsBeforeLastShip = fileCount;
            if (!reviewed) lastShipUncovered = "no_review";
            else if (editsSinceReview >= minEdits) lastShipUncovered = "changed_after_review";
            else lastShipUncovered = null;
          }
          // Evaluated after the ship act, so a single command that does both is
          // conservatively read as shipping first. Neither pattern knows its
          // own position in the string, so `review && push` is read the same
          // way: one redundant nudge, never a missed one.
          if (isReviewRecord(command)) {
            reviewed = true;
            editsSinceReview = 0;
          }
        }
      } else if (FILE_EDIT_TOOLS.has(name)) {
        fileCount += 1;
        editsSinceReview += 1;
      }
    }
  }

  const decisionPointCount = countUncapturedDecisionPoints(input.records);
  const counts: StopHookCounts = { commandCount, fileCount, decisionPointCount };
  // The review gate is independent of the capture outcome, so compute it once
  // and attach it to every post-scan return (e.g. a session can be
  // `already_captured` yet still owe a review).
  const review = evaluateReviewGate({
    shipped,
    lastShipUncovered,
    editsBeforeLastShip,
    minEdits,
  });

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
 * (>= `minEdits` file edits) without a review that covered what shipped.
 *
 * "Covered" is positional, not a count of records, and it is asked of the LAST
 * ship act. The obvious alternative — compare the reviewed commit to the merged
 * one — does not survive contact with squash merge: of 62 reviewed commits
 * recorded on this workspace, 5 were reachable from `main`, 35 were not, and 22
 * no longer existed at all, because squashing discards the commit that was
 * reviewed BY DESIGN. Half of all review records name a working tree and carry
 * no commit to compare in the first place. Order needs neither.
 *
 * Asking about the last ship act, rather than every ship, means a review
 * recorded after an earlier uncovered push and followed by a clean re-ship does
 * clear the gate. That is deliberate: the nudge is a turn-end prompt to act, and
 * a verdict no action can change is not a prompt, it is wallpaper. What the gate
 * claims is "what you last shipped was covered", not "every ship this session
 * was" — the durable record of the latter is the review trail, which basou keeps
 * regardless, and `review-gaps` is where that question belongs.
 *
 * Unlike the capture gate, a free-form decision point does NOT make this fire —
 * you review code that shipped, not a conversation — so it keys on file edits
 * alone. The reasons are checked in the AND order (ship → substantive →
 * covered) so the silent reason names the first unmet condition.
 */
function evaluateReviewGate(input: {
  shipped: boolean;
  lastShipUncovered: ReviewGateFireReason | null;
  editsBeforeLastShip: number;
  minEdits: number;
}): ReviewGateResult {
  if (!input.shipped) return { fires: false, reason: "no_ship_act" };
  if (input.editsBeforeLastShip < input.minEdits) {
    return { fires: false, reason: "not_substantive_code" };
  }
  if (input.lastShipUncovered === null) return { fires: false, reason: "already_reviewed" };
  return {
    fires: true,
    reason: input.lastShipUncovered,
    additionalContext: renderReviewNudge(input.lastShipUncovered),
  };
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
    '  - Decisions: run `basou decision capture` and pipe a JSON array (one object per decision; "title" and "kind" required, plus optional rationale/alternatives/rejected_reason/linked_files). "kind" names the vessel: "track" for an unfinished strategic direction that must resurface until closed, "decision" for a settled point-in-time call.',
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
function renderReviewNudge(reason: ReviewGateFireReason): string {
  const RECORD_LINE =
    '  - run `basou review record` and pipe a JSON object: { "reviewer": "...", "target": "...", with optional "verdict" / "findings" / "blocked" } (an explicit "blocked": [] records that you blocked nothing).';
  if (reason === "changed_after_review") {
    return [
      "This session recorded a review, then substantively changed the code before shipping it. What shipped is not what was reviewed.",
      "Only you can tell which of these it was:",
      "  - the change only APPLIED the review's findings — nothing further is owed; say so.",
      "  - the review overturned a premise or a design and the work was redone — the new design has not been reviewed by anyone. That is the case this exists for, and it gets MORE likely the harder reviews are made to bite.",
      "If the second, review the current state before relying on it, and record that pass:",
      RECORD_LINE,
      "This verdict is about the ship act that already happened, so neither answer silences it here; reviewing and then shipping again from the reviewed state does.",
    ].join("\n");
  }
  return [
    "This session shipped code (a push / PR / merge) after substantive edits, and no review was recorded before that ship act.",
    "An adversarial / second-opinion review before shipping is the discipline here. If a review ran, record it so it lands on the durable trail:",
    RECORD_LINE,
    "Recording it does NOT change this verdict — the ship it would have covered already happened. What changes it is reviewing the current state and shipping again from there. The record still matters: without it, nothing on the trail says the review happened at all.",
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

/**
 * When the session this transcript belongs to started: the timestamp of its
 * first record that carries a parseable one.
 *
 * Used to date what the session is HOLDING. Anything the session read at start
 * — its instruction files, the protocols rendered into them — is the version
 * that existed at this instant, so a managed block whose stamp says it changed
 * after it is newer than the copy in that session's context.
 *
 * Not every record carries a timestamp (a leading `summary` record does not),
 * so this scans forward rather than reading `records[0]` and giving up.
 * `undefined` means the transcript never said, and callers then say nothing
 * rather than guess a start.
 */
export function transcriptStartedAt(records: ClaudeTranscriptRecord[]): string | undefined {
  for (const record of records) {
    const timestamp = readString(record.timestamp);
    if (timestamp !== undefined && !Number.isNaN(Date.parse(timestamp))) return timestamp;
  }
  return undefined;
}
