import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type ReplayWarning, replayEvents } from "../events/event-replay.js";
import { findErrorCode } from "../lib/error-codes.js";
import { LOCAL_CLI_EVENT_SOURCE, TaskIdSchema } from "../schemas/shared.schema.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import { loadSessionEntries, type SessionSkipReason } from "../storage/sessions.js";
import { ARCHIVE_DIR_NAME } from "../storage/tasks.js";

/**
 * Decision-gap surfacer: which recorded decisions are still waiting for someone.
 *
 * The rule it applies, stated by the report that motivated it: a decision that
 * changes what gets built should have a task carrying it, and the ones with no
 * task are listed. It reads only captured provenance and writes nothing.
 *
 * The question is a RELATION — "is any task carrying this decision" — and the
 * text scan below is only today's way of answering it. Stating it that way is
 * deliberate: when `task_created` grows a field naming the decision it serves,
 * honouring that field answers the same question better and is an
 * implementation change, where redefining the question would not be.
 *
 * Two properties are load-bearing:
 *
 *  - Nothing here reads what a decision MEANS, so the answer does not depend on
 *    a model and does not change between runs over the same store.
 *  - The default is fail-closed: a decision with no task is listed. An opt-in
 *    mark ("this one produces work") was rejected upstream because forgetting
 *    the mark is the same failure the report exists to catch.
 *
 * Fail-closed only pays for itself if the list is drainable, so the population
 * is cut on four structural grounds — a timestamp, a `source`, a `kind`, and a
 * void. None requires reading meaning, and each is reported as a count so the
 * cut is never silent:
 *
 *  - {@link DECISION_GAPS_EPOCH}: decisions predating this feature are out of
 *    scope. Applying the rule to a whole history measured ~1450 entries on the
 *    store it was built against, which buries the signal on day one.
 *  - {@link LOCAL_CLI_EVENT_SOURCE}: only decisions somebody recorded by
 *    running basou (`basou decision capture` or `basou decision record`), as
 *    opposed to ones a reader derived. An importer derives decisions from a
 *    transcript's in-conversation questions ("how far should I implement? ->
 *    findings 1 and 3"), which were 70% of that store's decisions and 0 of the
 *    ones any task carried. Those are answers given while working, not plans
 *    anybody ratified.
 *  - `kind: "track"`: a track is ALREADY resurfaced, every session, until it is
 *    voided — orientation and handoff both carry it under "open tracks". For a
 *    track the premise "recorded, then never surfaced again" is false by
 *    construction, so listing it here says nothing the reader is not already
 *    shown, and it measured 27-45% of the list.
 *  - voided: `basou decision void` is the closing verb this product tells the
 *    operator to use, and a direction no longer in force is not waiting for
 *    anyone. Honouring it everywhere gives the operator ONE verb that closes;
 *    refusing it here would leave a list drainable only by writing a sham task.
 *
 * What it will not do is decide a decision's fate on anything it cannot check.
 * A task naming an id that no decision in the store has does NOT count as
 * carrying it, and a store it could only partly read says so rather than
 * reporting a clean answer over the part it managed.
 */

/**
 * Start of the population: decisions recorded before this instant are out of
 * scope, whatever else is true of them.
 *
 * A fixed constant rather than per-workspace state, so every workspace answers
 * the same question and nothing has to be initialised or migrated. The value is
 * the instant this was written; a release landing later, or a workspace first
 * running it later, only means that run starts with the decisions recorded in
 * between, and {@link DecisionGapsSummary.scope} reports the boundary on every
 * run so the head start is never silent. `--since` overrides it.
 */
export const DECISION_GAPS_EPOCH = "2026-09-18T12:00:00.000Z";

/** A decision in the population that no task carries. */
export type DecisionGap = {
  decisionId: string;
  title: string;
  recordedAt: string;
  sessionId: string;
};

/** The population's boundaries, as the run actually applied them. */
export type DecisionGapsScope = {
  /** Decisions recorded before this instant are out of scope. */
  start: string;
  /** Only decisions this event source recorded are in scope. */
  source: string;
};

/**
 * Why decisions left the population, by ground. The grounds are applied in this
 * order and each decision is counted under the FIRST that excludes it, so these
 * partition the excluded set.
 */
export type DecisionGapsExcluded = {
  /** Recorded before {@link DecisionGapsScope.start}. */
  byStart: number;
  /** Recorded by something other than {@link DecisionGapsScope.source}. */
  bySource: number;
  /** `kind: "track"` — already resurfaced every session until closed. */
  track: number;
  /** Closed with `basou decision void`. */
  voided: number;
};

/**
 * What the run could not read. Every field here can only make {@link
 * DecisionGapsSummary.gaps} wrong in a way the reader cannot see, so a non-zero
 * count is reported rather than absorbed.
 */
export type DecisionGapsIncomplete = {
  /**
   * Sessions this run could not read in full — a `session.yaml` that is missing
   * or does not validate, or an event log that failed to read.
   *
   * What was lost is not knowable from here: a log that fails partway through
   * has already yielded some events, so a session counted here may have
   * contributed everything, nothing, or part of what it holds. A decision of
   * theirs can therefore be missing from every count, and a void of theirs may
   * not have closed what it closes — so both a missing row and a wrongly
   * present one are possible.
   */
  sessions: number;
  /** Task files that could not be read, so any decision they carry looks uncarried. */
  tasks: number;
  /**
   * Ids named by a task that no decision in the store has. Counted, and
   * deliberately NOT treated as carrying anything: a string nobody recorded
   * must not be able to take a decision off this list.
   */
  unknownReferences: number;
};

export type DecisionGapsSummary = {
  generatedAt: string;
  scope: DecisionGapsScope;
  /** Decisions with no task carrying them, newest first. Capped by `limit`. */
  gaps: DecisionGap[];
  /** Entries omitted from `gaps` by `limit`; 0 when nothing was cut. */
  truncated: number;
  /** Population members some task carries. */
  carried: number;
  /** `gaps.length + truncated + carried`. */
  populationCount: number;
  excluded: DecisionGapsExcluded;
  incomplete: DecisionGapsIncomplete;
  /** Task files read (live and archived). */
  tasksScanned: number;
};

export type DecisionGapsInput = {
  paths: BasouPaths;
  nowIso: string;
  /** Defaults to {@link DECISION_GAPS_EPOCH}. */
  start?: string;
  /**
   * Maximum entries in `gaps`; the rest are counted in `truncated`. `0` yields
   * an empty `gaps` with everything in `truncated` — it is a cap of zero, not
   * "uncapped". Omit the field for uncapped. (The CLI's `--limit 0` means
   * uncapped and omits this.)
   */
  limit?: number;
  onWarning?: (warning: ReplayWarning, sessionId: string) => void;
  onSessionSkip?: (sessionId: string, reason: SessionSkipReason) => void;
};

/**
 * Decision ids as they appear in text: `decision_` plus a 26-character
 * Crockford base32 ULID (no I, L, O, or U), and NOT followed by a further
 * base32 character.
 *
 * The trailing boundary matters. Without it a 29-character token — a typo, a
 * concatenation — matches on its first 26 characters and takes a real decision
 * off the list, which is the fail-OPEN direction. An abbreviated reference
 * still does not match, and that is correct rather than merely safe: batches
 * written by one `basou decision capture` share a millisecond, so their ULIDs
 * differ only in the final characters and an abbreviation genuinely cannot name
 * one of them — measured, `decision_01M1BZC0T4` prefix-matches seven distinct
 * decisions.
 */
const DECISION_ID_IN_TEXT = /decision_[0-9A-HJKMNP-TV-Z]{26}(?![0-9A-HJKMNP-TV-Z])/gu;

/**
 * Whether a directory entry is a readable file named like a task, following
 * symlinks.
 *
 * The name is checked against the task id pattern rather than merely `.md`:
 * anything else under `tasks/` — a scratch note, a README, an editor backup —
 * is not a task, and letting one carry a decision would be the same hole as an
 * unrecorded id, entered through a different door. A file nobody created as a
 * task must not take an entry off this list.
 */
async function isTaskFile(dir: string, name: string): Promise<boolean> {
  const match = TASK_FILE_NAME.exec(name);
  if (match === null) return false;
  if (!TaskIdSchema.safeParse(match[1]).success) return false;
  try {
    // `stat`, not the Dirent: `readdir` reports a symlink as a symlink, and a
    // task reached through one is still a task. Dropping it on the Dirent would
    // both invent a gap and leave `incomplete.tasks` at zero, so the report
    // would carry its full confidence into an answer it never checked.
    return (await stat(join(dir, name))).isFile();
  } catch {
    return false;
  }
}

/** Task id pattern for a file under `tasks/`, matching what the writer produces. */
const TASK_FILE_NAME = /^(task_[0-9A-HJKMNP-TV-Z]{26})\.md$/u;

/** Readable task files directly under a directory; `[]` when it is absent. */
async function markdownFilesIn(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).slice();
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) return [];
    throw new Error("Failed to enumerate tasks", { cause: error });
  }
  const files: string[] = [];
  for (const name of names) {
    if (await isTaskFile(dir, name)) files.push(join(dir, name));
  }
  return files;
}

/**
 * Every decision id mentioned by any task file, live or archived.
 *
 * Files are read as raw text rather than through the task parser: the question
 * is whether a task carries the decision, and a task whose front matter no
 * longer parses still carries it. Archived tasks count for the same reason —
 * archiving records that work finished, so letting it un-carry a decision would
 * resurrect settled plans.
 */
export async function collectTaskReferences(
  paths: BasouPaths,
): Promise<{ refs: Set<string>; scanned: number; unreadable: number }> {
  const files = [
    ...(await markdownFilesIn(paths.tasks)),
    ...(await markdownFilesIn(join(paths.tasks, ARCHIVE_DIR_NAME))),
  ];
  const refs = new Set<string>();
  let unreadable = 0;
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      unreadable += 1;
      continue;
    }
    for (const match of text.matchAll(DECISION_ID_IN_TEXT)) refs.add(match[0]);
  }
  return { refs, scanned: files.length - unreadable, unreadable };
}

type Recorded = {
  decisionId: string;
  title: string;
  recordedAt: string;
  sessionId: string;
  kind: "decision" | "track";
};

/**
 * What a decision's events said about it. Accumulated per DECISION id, not per
 * event, so that every count this module reports has the same denominator: a
 * decision recorded twice is one decision, and cannot be simultaneously in
 * scope and counted as excluded.
 *
 * `inScope` holds the latest event that passed both boundaries; `lastOutOfScope`
 * the latest that failed one, used only when no event ever passed.
 */
type Seen = {
  inScope: Recorded | undefined;
  lastOutOfScope: { at: number; ground: "byStart" | "bySource" } | undefined;
};

/**
 * Find decisions in the population that no task carries.
 *
 * Ordering is `recordedAt` descending with the decision id (a ULID, so
 * monotonic) as tie-breaker, giving a stable newest-first list.
 */
export async function findDecisionGaps(input: DecisionGapsInput): Promise<DecisionGapsSummary> {
  const start = input.start ?? DECISION_GAPS_EPOCH;
  const startMs = Date.parse(start);
  if (Number.isNaN(startMs)) throw new Error(`Invalid start timestamp: ${start}`);

  const loadOpts: Parameters<typeof loadSessionEntries>[1] = { now: new Date(input.nowIso) };
  // Sessions counted by id, not by event: `loadSessionEntries` can report a
  // running session's log as unreadable AND still return the entry, whose replay
  // then fails too. Counting both would make the report state a number twice the
  // truth about how much it could not read.
  const unreadSessions = new Set<string>();
  loadOpts.onSkip = (sid, reason) => {
    unreadSessions.add(sid);
    input.onSessionSkip?.(sid, reason);
  };
  // Deliberately NOT forwarding `onWarning` here. `loadSessionEntries` replays a
  // running session's log to classify it, and this function replays every log
  // again below — passing the hook to both emits each warning twice.
  const entries = await loadSessionEntries(input.paths, loadOpts);

  const seen = new Map<string, Seen>();
  // Voids are collected across every session and applied at the end: the event
  // closing a decision is routinely written by a later session than the one
  // that recorded it, so a void seen before its target must not be dropped.
  const voided = new Set<string>();

  for (const entry of entries) {
    const sessionDir = join(input.paths.sessions, entry.sessionId);
    try {
      for await (const ev of replayEvents(sessionDir, {
        onWarning: (w) => input.onWarning?.(w, entry.sessionId),
      })) {
        if (ev.type === "decision_voided") {
          voided.add(ev.decision_id);
          continue;
        }
        if (ev.type !== "decision_recorded") continue;
        const entryFor = seen.get(ev.decision_id) ?? {
          inScope: undefined,
          lastOutOfScope: undefined,
        };
        seen.set(ev.decision_id, entryFor);
        // Instants, not text. The timestamp format admits a numeric offset and
        // the normalizer preserves it, so `"2026-09-18T20:00:00+09:00"` sorts
        // after a `Z` epoch it actually precedes.
        const at = Date.parse(ev.occurred_at);
        const ground =
          at < startMs ? "byStart" : ev.source !== LOCAL_CLI_EVENT_SOURCE ? "bySource" : null;
        if (ground !== null) {
          if (entryFor.lastOutOfScope === undefined || at >= entryFor.lastOutOfScope.at) {
            entryFor.lastOutOfScope = { at, ground };
          }
          continue;
        }
        entryFor.inScope = {
          decisionId: ev.decision_id,
          title: ev.title,
          recordedAt: ev.occurred_at,
          sessionId: ev.session_id,
          kind: ev.kind ?? "decision",
        };
      }
    } catch {
      // One corrupt log must not take the whole report down: the sibling
      // surfacers degrade here, and a session that cannot be read is reported
      // as unread rather than as absent.
      unreadSessions.add(entry.sessionId);
      input.onSessionSkip?.(entry.sessionId, "events_jsonl_unreadable");
    }
  }

  const { refs, scanned, unreadable } = await collectTaskReferences(input.paths);
  // A task can name an id no decision has — a hand-typed string, a decision from
  // another workspace, a fixture. Counted so the operator can go and look, and
  // never allowed to carry anything: otherwise typing a plausible id into a
  // markdown file would be a way to make this list shorter, with no event
  // recording that it happened.
  // Against every id the store ever recorded, not against the population: a
  // decision excluded by the start boundary is still a decision this store has,
  // and calling a task's reference to it "unknown" would be false.
  let unknownReferences = 0;
  for (const ref of refs) if (!seen.has(ref)) unknownReferences += 1;

  const excluded: DecisionGapsExcluded = { byStart: 0, bySource: 0, track: 0, voided: 0 };
  const open: DecisionGap[] = [];
  let carried = 0;
  for (const entry of seen.values()) {
    const d = entry.inScope;
    if (d === undefined) {
      // No event for this decision ever passed both boundaries, so the decision
      // is out of scope; its latest failing event names the ground.
      if (entry.lastOutOfScope !== undefined) excluded[entry.lastOutOfScope.ground] += 1;
      continue;
    }
    // Order fixed so the grounds partition: a voided track counts once, as a
    // track, and the four numbers sum to the decisions that left.
    if (d.kind === "track") {
      excluded.track += 1;
      continue;
    }
    if (voided.has(d.decisionId)) {
      excluded.voided += 1;
      continue;
    }
    if (refs.has(d.decisionId)) {
      carried += 1;
      continue;
    }
    open.push({
      decisionId: d.decisionId,
      title: d.title,
      recordedAt: d.recordedAt,
      sessionId: d.sessionId,
    });
  }
  open.sort((a, b) =>
    a.recordedAt === b.recordedAt
      ? b.decisionId.localeCompare(a.decisionId)
      : Date.parse(b.recordedAt) - Date.parse(a.recordedAt),
  );

  const limit = input.limit;
  const shown = limit !== undefined && limit >= 0 ? open.slice(0, limit) : open;
  return {
    generatedAt: input.nowIso,
    scope: { start, source: LOCAL_CLI_EVENT_SOURCE },
    gaps: shown,
    truncated: open.length - shown.length,
    carried,
    populationCount: open.length + carried,
    excluded,
    incomplete: { sessions: unreadSessions.size, tasks: unreadable, unknownReferences },
    tasksScanned: scanned,
  };
}

/** A decision as an already-replaying caller has it, for {@link countOpenDecisionGaps}. */
export type DecisionForGapCount = {
  decisionId: string;
  occurredAt: string;
  source: string;
  kind: "decision" | "track" | undefined;
};

/**
 * How many decisions are open with no task carrying them, for a caller that has
 * already replayed the store.
 *
 * It exists so `basou orient` can say the number without a second full replay —
 * orientation reads every event anyway, and doing that twice to print one line
 * is not a trade worth making.
 *
 * It MUST answer what {@link findDecisionGaps} answers on the same store: the
 * orient line names that command, so a disagreement is one surface of this
 * product contradicting another. Nothing in the types enforces that, so the two
 * are pinned against each other by a differential test rather than by a comment
 * asserting they agree.
 */
export async function countOpenDecisionGaps(input: {
  paths: BasouPaths;
  decisions: readonly DecisionForGapCount[];
  voidedDecisionIds: ReadonlySet<string>;
  start?: string;
}): Promise<number> {
  const startMs = Date.parse(input.start ?? DECISION_GAPS_EPOCH);
  // The LAST in-scope event for an id decides, exactly as in findDecisionGaps.
  // Testing `kind` per event and skipping instead would let an earlier non-track
  // event survive a later track one, and the two answers would disagree.
  const latest = new Map<string, DecisionForGapCount>();
  for (const d of input.decisions) {
    if (Date.parse(d.occurredAt) < startMs) continue;
    if (d.source !== LOCAL_CLI_EVENT_SOURCE) continue;
    latest.set(d.decisionId, d);
  }
  const inScope: string[] = [];
  for (const [id, d] of latest) {
    if ((d.kind ?? "decision") === "track") continue;
    if (input.voidedDecisionIds.has(id)) continue;
    inScope.push(id);
  }
  if (inScope.length === 0) return 0;
  const { refs } = await collectTaskReferences(input.paths);
  let open = 0;
  for (const id of inScope) if (!refs.has(id)) open += 1;
  return open;
}
