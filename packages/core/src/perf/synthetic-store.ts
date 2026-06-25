/**
 * Synthetic `.basou` store generator for the perf bench. NOT shipped — it is
 * reachable only from `perf-budget.test.ts`, never from `src/index.ts`, so
 * tsup (entry = `src/index.ts`) leaves it out of `dist`.
 *
 * Builds a realistic store at a caller-chosen scale: each session carries the
 * full lifecycle event spine plus a configurable number of `decision_recorded`
 * events with rich fields (so the rendered `decisions.md` approximates the
 * ~455 B/decision observed in production), occasional `track` decisions, a
 * `next_step` note, and periodic `decision_voided` events. Both the event count
 * and the decision count therefore scale linearly with the session count, which
 * is exactly the axis the budget guards.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { ulid } from "../ids/ulid.js";
import { type BasouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";

export type SyntheticStoreOptions = {
  /** Absolute root dir under which the `.basou` store is created. */
  root: string;
  /** Number of sessions to generate. */
  sessions: number;
  /** decision_recorded events per session (default 3 ≈ the prod ratio). */
  decisionsPerSession?: number;
  /** Every Nth decision is promoted to a `track` (default 40). */
  trackEveryNDecisions?: number;
  /** Every Nth session voids one of its own decisions (default 25). */
  voidEverySessions?: number;
  /** Epoch ms of the newest session; older sessions march backwards. */
  baseTimeMs?: number;
};

export type SyntheticStoreResult = {
  paths: BasouPaths;
  sessionCount: number;
  decisionCount: number;
  eventCount: number;
};

const ONE_HOUR_MS = 60 * 60 * 1000;
const WRITE_CONCURRENCY = 64;

// Length-representative filler so a rendered decision approximates production
// weight without depending on any real content.
const RATIONALE =
  "Chosen after weighing the alternatives against the moat invariants " +
  "(read-only basic posture, reversible, human stays in control). The rejected " +
  "options either froze a still-churning surface too early or broke zero-network.";
const ALTERNATIVES = [
  "Block on every turn end (rejected: too invasive for a session-end-once goal)",
  "Pure advisory with no trigger (rejected: structurally inert on the final turn)",
];

function id(prefix: "ses" | "evt" | "decision", seedMs: number): string {
  return `${prefix}_${ulid(seedMs)}`;
}

function buildEvents(
  sessionId: string,
  startedAtMs: number,
  decisionsPerSession: number,
  trackEveryNDecisions: number,
  emitVoid: boolean,
  globalDecisionIndexBase: number,
): { lines: string; decisionCount: number; eventCount: number } {
  const lines: string[] = [];
  let t = startedAtMs;
  const occurredAt = (): string => new Date(t).toISOString();
  const push = (event: Record<string, unknown>): void => {
    lines.push(
      JSON.stringify({
        schema_version: "0.1.0",
        id: id("evt", t),
        session_id: sessionId,
        occurred_at: occurredAt(),
        source: "local-cli",
        ...event,
      }),
    );
    t += 1_000;
  };

  push({ type: "session_started" });
  push({ type: "session_status_changed", from: "initialized", to: "running" });

  const decisionIds: string[] = [];
  for (let d = 0; d < decisionsPerSession; d++) {
    const decisionId = id("decision", t);
    decisionIds.push(decisionId);
    const globalIndex = globalDecisionIndexBase + d;
    const isTrack = trackEveryNDecisions > 0 && (globalIndex + 1) % trackEveryNDecisions === 0;
    // Distinct paths per decision: the renderer caches existence per unique
    // path, so reusing a path would collapse the lstat cost to O(1) and hide
    // the real per-decision I/O that resolving linked_files incurs. The files
    // do not exist (they resolve to "(missing)"), which still exercises the
    // lstat path the renderer awaits at render time.
    const linkedFiles = [`packages/core/src/synthetic_${globalIndex}.ts`];
    if (globalIndex % 3 === 0) linkedFiles.push(`docs/synthetic_${globalIndex}.md`);
    push({
      type: "decision_recorded",
      decision_id: decisionId,
      title: `Decision ${globalIndex}: settle the enforcement strength for the stop-hook nudge tier`,
      rationale: RATIONALE,
      alternatives: ALTERNATIVES,
      linked_files: linkedFiles,
      ...(isTrack ? { kind: "track" } : {}),
    });
  }

  // A resume hint on every session exercises orientation's latest-note path.
  push({
    type: "note_added",
    kind: "next_step",
    body: `Next step for ${sessionId}: register the stop-hook in settings.json and start the real dogfood.`,
  });

  if (emitVoid && decisionIds[0] !== undefined) {
    push({
      type: "decision_voided",
      decision_id: decisionIds[0],
      reason: "superseded by a later direction",
    });
  }

  push({ type: "session_status_changed", from: "running", to: "completed" });
  push({ type: "session_ended", exit_code: 0 });

  return {
    lines: `${lines.join("\n")}\n`,
    decisionCount: decisionsPerSession,
    eventCount: lines.length,
  };
}

function buildSessionYaml(sessionId: string, startedAtMs: number): string {
  const iso = new Date(startedAtMs).toISOString();
  return stringify({
    schema_version: "0.1.0",
    session: {
      id: sessionId,
      label: `Synthetic session ${sessionId.slice(-6)}`,
      task_id: null,
      workspace_id: "ws_01HXABCDEF1234567890ABCDEF",
      source: { kind: "terminal", version: "0.1.0" },
      started_at: iso,
      ended_at: iso,
      status: "completed",
      working_directory: "/tmp/synthetic",
      invocation: { command: "basou", args: ["orient"], exit_code: 0 },
      related_files: [],
      events_log: "events.jsonl",
    },
  });
}

/** Generate a `.basou` store under `options.root` and return its paths + counts. */
export async function buildSyntheticStore(
  options: SyntheticStoreOptions,
): Promise<SyntheticStoreResult> {
  const decisionsPerSession = options.decisionsPerSession ?? 3;
  const trackEveryNDecisions = options.trackEveryNDecisions ?? 40;
  const voidEverySessions = options.voidEverySessions ?? 25;
  const baseTimeMs = options.baseTimeMs ?? Date.parse("2026-06-25T00:00:00.000Z");

  const paths = await ensureBasouDirectory(options.root);

  let decisionCount = 0;
  let eventCount = 0;

  const tasks: Array<() => Promise<void>> = [];
  for (let i = 0; i < options.sessions; i++) {
    // Newest session at baseTimeMs; each older session one hour earlier.
    const startedAtMs = baseTimeMs - (options.sessions - 1 - i) * ONE_HOUR_MS;
    const sessionId = id("ses", startedAtMs);
    const emitVoid = voidEverySessions > 0 && (i + 1) % voidEverySessions === 0;
    const built = buildEvents(
      sessionId,
      startedAtMs,
      decisionsPerSession,
      trackEveryNDecisions,
      emitVoid,
      decisionCount,
    );
    decisionCount += built.decisionCount;
    eventCount += built.eventCount;
    const sessionDir = join(paths.sessions, sessionId);
    const yaml = buildSessionYaml(sessionId, startedAtMs);
    tasks.push(async () => {
      await mkdir(sessionDir, { recursive: true });
      await Promise.all([
        writeFile(join(sessionDir, "session.yaml"), yaml),
        writeFile(join(sessionDir, "events.jsonl"), built.lines),
      ]);
    });
  }

  for (let i = 0; i < tasks.length; i += WRITE_CONCURRENCY) {
    await Promise.all(tasks.slice(i, i + WRITE_CONCURRENCY).map((run) => run()));
  }

  return { paths, sessionCount: options.sessions, decisionCount, eventCount };
}
