import { join } from "node:path";
import { type ReplayWarning, replayEvents } from "../events/event-replay.js";
import type { Event } from "../schemas/event.schema.js";
import type {
  Session,
  SessionMetrics,
  SessionSourceKind,
  SessionStatus,
} from "../schemas/session.schema.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import { loadSessionEntries, type SessionSkipReason } from "../storage/sessions.js";

/**
 * Gap longer than this between two consecutive events is treated as idle and
 * excluded from `activeTimeMs`. A deliberately coarse heuristic: "active" time
 * is a focus proxy, NOT a measure of model compute. 5 minutes.
 */
export const ACTIVE_GAP_CAP_MS = 5 * 60 * 1000;

export type WorkStatsInput = {
  paths: BasouPaths;
  /** Shared clock; running sessions are measured up to this instant. */
  now: Date;
  onWarning?: (warning: ReplayWarning, sessionId: string) => void;
  onSessionSkip?: (sessionId: string, reason: SessionSkipReason) => void;
};

/** Which measures are meaningful for a given session / source. */
export type MeasureAvailability = {
  /** Always true (started_at + now bound the span). */
  span: boolean;
  /**
   * `commandTimeMs` reflects real shell time. False for `claude-code-import`,
   * whose transcript carries no per-command duration (recorded as 0).
   */
  commandTime: boolean;
  /** Meaningful only with >= 2 timestamped events. */
  activeTime: boolean;
  /** Token totals were captured (model-usage metrics present). */
  tokens: boolean;
};

/** Token rollup. Zero when not captured; `reasoning` is Codex-only. */
export type TokenTotals = {
  output: number;
  input: number;
  cached: number;
  reasoning: number;
};

export type SessionWorkStats = {
  sessionId: string;
  label: string | undefined;
  status: SessionStatus;
  sourceKind: SessionSourceKind;
  startedAt: string;
  endedAt: string | undefined;
  /** ended_at absent: span is measured to `now`. */
  open: boolean;
  sessionSpanMs: number;
  commandTimeMs: number;
  activeTimeMs: number;
  commandCount: number;
  fileChangedCount: number;
  decisionCount: number;
  eventCount: number;
  tokens: TokenTotals;
  availability: MeasureAvailability;
  /** ended_at < started_at (clock skew): span was clamped to 0. */
  spanClamped: boolean;
  /** events.jsonl could not be read: action / time counts are 0 + untrustworthy. */
  eventsUnreadable: boolean;
};

export type SourceWorkStats = {
  sourceKind: SessionSourceKind;
  sessionCount: number;
  sessionSpanMs: number;
  commandTimeMs: number;
  activeTimeMs: number;
  commandCount: number;
  fileChangedCount: number;
  decisionCount: number;
  eventCount: number;
  tokens: TokenTotals;
  /** Every session of this kind reports real command time. */
  commandTimeReliable: boolean;
  /** At least one session of this kind captured token totals. */
  tokensAvailable: boolean;
};

export type StatusCount = { status: SessionStatus; count: number };

export type WorkStatsTotals = {
  sessionCount: number;
  openSessionCount: number;
  sessionSpanMs: number;
  commandTimeMs: number;
  activeTimeMs: number;
  commandCount: number;
  fileChangedCount: number;
  decisionCount: number;
  eventCount: number;
  tokens: TokenTotals;
  /** No `claude-code-import` sessions present, so command time is workspace-wide real. */
  commandTimeReliable: boolean;
  tokensAvailable: boolean;
};

export type WorkStatsResult = {
  generatedAt: string;
  totals: WorkStatsTotals;
  /** Per session, started_at ascending (loadSessionEntries order). */
  sessions: SessionWorkStats[];
  bySource: SourceWorkStats[];
  byStatus: StatusCount[];
};

// Fixed display order, mirroring the handoff renderer (+ archived appended).
const STATUS_ORDER: readonly SessionStatus[] = [
  "completed",
  "failed",
  "running",
  "interrupted",
  "waiting_approval",
  "initialized",
  "imported",
  "archived",
];

/**
 * Aggregate "how much the AI worked" across the workspace's sessions.
 *
 * Honesty note: this returns a LABELED SET of measures, not one number. Token
 * volume (when captured) is the most direct "how much work" signal; the time
 * measures are proxies — `sessionSpanMs` overcounts (includes idle),
 * `commandTimeMs` is shell-execution only (and 0 for `claude-code-import`),
 * and `activeTimeMs` is a gap-capped focus heuristic. Availability flags let
 * callers caveat each measure rather than present a misleading total.
 *
 * Session enumeration goes through {@link loadSessionEntries} (the handoff /
 * decisions path), so `session.yaml`-broken sessions are skipped consistently.
 */
export async function computeWorkStats(input: WorkStatsInput): Promise<WorkStatsResult> {
  const { now } = input;
  // Surface events_jsonl_unreadable exactly once per session even when the
  // throw happens in our own replay loop below (verbatim from the renderers).
  const unreadableEmitted = new Set<string>();
  const wrappedSkip: (sid: string, reason: SessionSkipReason) => void = (sid, reason) => {
    if (reason === "events_jsonl_unreadable") unreadableEmitted.add(sid);
    input.onSessionSkip?.(sid, reason);
  };
  const loadOpts: Parameters<typeof loadSessionEntries>[1] = { now, onSkip: wrappedSkip };
  if (input.onWarning !== undefined) loadOpts.onWarning = input.onWarning;
  const entries = await loadSessionEntries(input.paths, loadOpts);

  const sessions: SessionWorkStats[] = [];
  for (const entry of entries) {
    const events: Event[] = [];
    let eventsUnreadable = false;
    try {
      for await (const ev of replayEvents(join(input.paths.sessions, entry.sessionId), {
        onWarning: (w) => input.onWarning?.(w, entry.sessionId),
      })) {
        events.push(ev);
      }
    } catch {
      eventsUnreadable = true;
      if (!unreadableEmitted.has(entry.sessionId)) {
        wrappedSkip(entry.sessionId, "events_jsonl_unreadable");
      }
    }
    sessions.push(
      sessionWorkStatsFromEvents(
        entry.sessionId,
        entry.session.session,
        events,
        now,
        eventsUnreadable,
      ),
    );
  }

  return {
    generatedAt: now.toISOString(),
    totals: computeTotals(sessions),
    sessions,
    bySource: computeBySource(sessions),
    byStatus: computeByStatus(sessions),
  };
}

/**
 * Compute one session's work stats from its inner record + event list. Pure
 * and exported so a single-session surface (e.g. `basou session show`) can
 * reuse the exact same measures the workspace aggregator produces.
 */
export function sessionWorkStatsFromEvents(
  sessionId: string,
  inner: Session["session"],
  events: ReadonlyArray<Event>,
  now: Date,
  eventsUnreadable = false,
): SessionWorkStats {
  let commandCount = 0;
  let fileChangedCount = 0;
  let decisionCount = 0;
  let commandTimeMs = 0;
  const timestamps: number[] = [];
  for (const ev of events) {
    const t = Date.parse(ev.occurred_at);
    if (Number.isFinite(t)) timestamps.push(t);
    if (ev.type === "command_executed") {
      commandCount++;
      commandTimeMs += ev.duration_ms;
    } else if (ev.type === "file_changed") {
      fileChangedCount++;
    } else if (ev.type === "decision_recorded") {
      decisionCount++;
    }
  }
  const span = computeSpan(inner.started_at, inner.ended_at, now);
  const tokens = readTokens(inner.metrics);
  return {
    sessionId,
    label: inner.label,
    status: inner.status,
    sourceKind: inner.source.kind,
    startedAt: inner.started_at,
    endedAt: inner.ended_at,
    open: inner.ended_at === undefined,
    sessionSpanMs: span.ms,
    commandTimeMs,
    activeTimeMs: activeTime(timestamps),
    commandCount,
    fileChangedCount,
    decisionCount,
    eventCount: events.length,
    tokens,
    availability: {
      span: true,
      commandTime: inner.source.kind !== "claude-code-import",
      activeTime: timestamps.length >= 2,
      tokens: hasTokens(tokens),
    },
    spanClamped: span.clamped,
    eventsUnreadable,
  };
}

function computeSpan(
  startedAt: string,
  endedAt: string | undefined,
  now: Date,
): { ms: number; clamped: boolean } {
  const start = Date.parse(startedAt);
  const end = endedAt !== undefined ? Date.parse(endedAt) : now.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { ms: 0, clamped: true };
  const raw = end - start;
  return raw < 0 ? { ms: 0, clamped: true } : { ms: raw, clamped: false };
}

/** Sum of inter-event gaps, each clamped to [0, ACTIVE_GAP_CAP_MS]. */
function activeTime(timestamps: number[]): number {
  if (timestamps.length < 2) return 0;
  const sorted = [...timestamps].sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (prev === undefined || curr === undefined) continue;
    const gap = curr - prev;
    total += Math.min(Math.max(gap, 0), ACTIVE_GAP_CAP_MS);
  }
  return total;
}

function readTokens(metrics: SessionMetrics | undefined): TokenTotals {
  return {
    output: metrics?.output_tokens ?? 0,
    input: metrics?.input_tokens ?? 0,
    cached: metrics?.cached_input_tokens ?? 0,
    reasoning: metrics?.reasoning_output_tokens ?? 0,
  };
}

function hasTokens(t: TokenTotals): boolean {
  return t.output > 0 || t.input > 0 || t.cached > 0 || t.reasoning > 0;
}

function emptyTokens(): TokenTotals {
  return { output: 0, input: 0, cached: 0, reasoning: 0 };
}

function addTokens(a: TokenTotals, b: TokenTotals): void {
  a.output += b.output;
  a.input += b.input;
  a.cached += b.cached;
  a.reasoning += b.reasoning;
}

function computeTotals(sessions: readonly SessionWorkStats[]): WorkStatsTotals {
  const tokens = emptyTokens();
  const totals: WorkStatsTotals = {
    sessionCount: sessions.length,
    openSessionCount: 0,
    sessionSpanMs: 0,
    commandTimeMs: 0,
    activeTimeMs: 0,
    commandCount: 0,
    fileChangedCount: 0,
    decisionCount: 0,
    eventCount: 0,
    tokens,
    commandTimeReliable: true,
    tokensAvailable: false,
  };
  for (const s of sessions) {
    if (s.open) totals.openSessionCount++;
    totals.sessionSpanMs += s.sessionSpanMs;
    totals.commandTimeMs += s.commandTimeMs;
    totals.activeTimeMs += s.activeTimeMs;
    totals.commandCount += s.commandCount;
    totals.fileChangedCount += s.fileChangedCount;
    totals.decisionCount += s.decisionCount;
    totals.eventCount += s.eventCount;
    addTokens(tokens, s.tokens);
    if (!s.availability.commandTime) totals.commandTimeReliable = false;
    if (s.availability.tokens) totals.tokensAvailable = true;
  }
  return totals;
}

function computeBySource(sessions: readonly SessionWorkStats[]): SourceWorkStats[] {
  const map = new Map<SessionSourceKind, SourceWorkStats>();
  for (const s of sessions) {
    let row = map.get(s.sourceKind);
    if (row === undefined) {
      row = {
        sourceKind: s.sourceKind,
        sessionCount: 0,
        sessionSpanMs: 0,
        commandTimeMs: 0,
        activeTimeMs: 0,
        commandCount: 0,
        fileChangedCount: 0,
        decisionCount: 0,
        eventCount: 0,
        tokens: emptyTokens(),
        commandTimeReliable: true,
        tokensAvailable: false,
      };
      map.set(s.sourceKind, row);
    }
    row.sessionCount++;
    row.sessionSpanMs += s.sessionSpanMs;
    row.commandTimeMs += s.commandTimeMs;
    row.activeTimeMs += s.activeTimeMs;
    row.commandCount += s.commandCount;
    row.fileChangedCount += s.fileChangedCount;
    row.decisionCount += s.decisionCount;
    row.eventCount += s.eventCount;
    addTokens(row.tokens, s.tokens);
    if (!s.availability.commandTime) row.commandTimeReliable = false;
    if (s.availability.tokens) row.tokensAvailable = true;
  }
  return [...map.values()].sort((a, b) => a.sourceKind.localeCompare(b.sourceKind));
}

function computeByStatus(sessions: readonly SessionWorkStats[]): StatusCount[] {
  const counts = new Map<SessionStatus, number>();
  for (const s of sessions) counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
  const ordered: StatusCount[] = [];
  for (const status of STATUS_ORDER) {
    const count = counts.get(status);
    if (count !== undefined && count > 0) ordered.push({ status, count });
  }
  return ordered;
}
