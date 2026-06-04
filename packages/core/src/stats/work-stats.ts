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
import {
  ACTIVE_GAP_CAP_MS,
  activeTimeFromTimestamps,
  type IntervalMs,
  type IsoInterval,
  intervalsIsoToMs,
  intervalsMsToIso,
  unionDurationMs,
} from "./active-time.js";

// Re-exported for callers that imported the cap from this module historically.
export { ACTIVE_GAP_CAP_MS };

/**
 * Resolve the timezone used to bucket per-day stats. Native logs are UTC, so a
 * billing day needs an explicit timezone; default to the host's local zone.
 */
function resolveTimeZone(timeZone: string | undefined): string {
  if (timeZone !== undefined && timeZone.length > 0) return timeZone;
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export type WorkStatsInput = {
  paths: BasouPaths;
  /** Shared clock; running sessions are measured up to this instant. */
  now: Date;
  /**
   * IANA timezone used to bucket the per-day breakdown (logs are UTC, so a
   * billing day needs an explicit zone). Defaults to the host's local zone;
   * injectable for deterministic tests.
   */
  timeZone?: string;
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
  /** At least one active interval could be measured (stored or event-derived). */
  activeTime: boolean;
  /** Token totals were captured (model-usage metrics present). */
  tokens: boolean;
  /** Model compute time was captured (`machine_active_time_ms`; Codex only). */
  machineActive: boolean;
};

/** Token rollup. Zero when not captured; `reasoning` is Codex-only. */
export type TokenTotals = {
  output: number;
  input: number;
  cached: number;
  reasoning: number;
};

/** How a session's active time was derived. */
export type ActiveTimeBasis = "engaged-turns" | "events";

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
  /**
   * How `activeTimeMs` / `activeIntervals` were derived: `engaged-turns` from
   * the engagement timestamps stored at import (captures conversation), or
   * `events` from the action-event stream (live sessions and pre-v2 imports).
   */
  activeTimeBasis: ActiveTimeBasis;
  /**
   * Merged active wall-clock ranges. Their summed duration equals
   * `activeTimeMs`; the aggregator unions them across sessions so overlapping
   * (concurrent) work is not double-counted in billable totals.
   */
  activeIntervals: IsoInterval[];
  /**
   * Model compute time: the source's summed per-turn duration
   * (`metrics.machine_active_time_ms`). A subset of `activeTimeMs`; 0 when the
   * source records no per-turn duration (everything but Codex today).
   */
  machineActiveTimeMs: number;
  /**
   * Methodology lock copied from `metrics.active_time_method` (e.g.
   * `turn-intervals` / `engaged-turns`); undefined when active time was derived
   * from the event stream rather than stored metrics.
   */
  activeTimeMethod: string | undefined;
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
  machineActiveTimeMs: number;
  commandCount: number;
  fileChangedCount: number;
  decisionCount: number;
  eventCount: number;
  tokens: TokenTotals;
  /** Every session of this kind reports real command time. */
  commandTimeReliable: boolean;
  /** At least one session of this kind captured token totals. */
  tokensAvailable: boolean;
  /** At least one session of this kind captured model compute time. */
  machineActiveAvailable: boolean;
};

export type StatusCount = { status: SessionStatus; count: number };

/**
 * One calendar day of the time x volume billing view. `billableActiveTimeMs` is
 * the union of active intervals starting on this date (so per-day sums to the
 * de-duplicated workspace total); volume is attributed to each session's
 * `started_at` date.
 */
export type DayWorkStats = {
  /** Calendar date `YYYY-MM-DD` in the report timezone. */
  date: string;
  billableActiveTimeMs: number;
  /**
   * Model compute time for sessions started on this date (summed
   * `machine_active_time_ms`). Not wall-clock-deduplicated, so — unlike
   * `billableActiveTimeMs` — concurrent sessions sum freely.
   */
  machineActiveTimeMs: number;
  sessionCount: number;
  commandCount: number;
  fileChangedCount: number;
  decisionCount: number;
  tokens: TokenTotals;
};

export type WorkStatsTotals = {
  sessionCount: number;
  openSessionCount: number;
  sessionSpanMs: number;
  commandTimeMs: number;
  /** Naive sum of per-session active time; double-counts overlapping sessions. */
  activeTimeMs: number;
  /**
   * Billable active time: the UNION of every session's active intervals, so
   * concurrent sessions do not double-count human wall-clock. Equals
   * `activeTimeMs` when no sessions overlap, and is smaller when they do.
   */
  billableActiveTimeMs: number;
  /**
   * Workspace-wide model compute time: summed `machine_active_time_ms`. A plain
   * sum (not interval union), so it can exceed `billableActiveTimeMs` when
   * sessions ran concurrently — two models working at once is two machine-hours
   * in one wall-clock hour.
   */
  machineActiveTimeMs: number;
  commandCount: number;
  fileChangedCount: number;
  decisionCount: number;
  eventCount: number;
  tokens: TokenTotals;
  /** No `claude-code-import` sessions present, so command time is workspace-wide real. */
  commandTimeReliable: boolean;
  tokensAvailable: boolean;
  /** At least one session captured model compute time (`machine_active_time_ms`). */
  machineActiveAvailable: boolean;
};

export type WorkStatsResult = {
  generatedAt: string;
  /** Idle-gap cap applied to active time (methodology lock). */
  activeGapCapMs: number;
  /** IANA timezone used to bucket {@link WorkStatsResult.byDay}. */
  timeZone: string;
  totals: WorkStatsTotals;
  /** Per session, started_at ascending (loadSessionEntries order). */
  sessions: SessionWorkStats[];
  bySource: SourceWorkStats[];
  byStatus: StatusCount[];
  /** Per-day time x volume billing view, date ascending. */
  byDay: DayWorkStats[];
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
 * Aggregate work + engaged-time across the workspace's sessions.
 *
 * Honesty note: this returns a LABELED SET of measures, not one number. Token
 * volume (when captured) is the most direct "how much the AI produced" signal.
 * The time measures are proxies, ordered from most to least billing-relevant:
 *
 * - `billableActiveTimeMs` (totals) is the headline for billing human harness
 *   labor: the UNION of every session's active intervals, so two sessions run
 *   concurrently do not bill the same wall-clock twice. `activeTimeMs` is the
 *   naive sum, kept only to expose the overlap delta.
 * - Per-session active time is derived from the session's ENGAGED series. For
 *   imported sessions this is the genuine engagement timestamps captured at
 *   import (conversation turns plus action events), so design discussion that
 *   produced few tool calls is still counted; idle gaps over `ACTIVE_GAP_CAP_MS`
 *   (5 min) are not credited. Live sessions and pre-v2 imports lack that signal
 *   and fall back to the action-event stream (`activeTimeBasis: "events"`).
 * - `sessionSpanMs` overcounts (includes idle) and `commandTimeMs` is
 *   shell-execution only (0 for `claude-code-import`); both are kept as context.
 *
 * The per-day view buckets the union intervals by `timeZone` (logs are UTC, so
 * a billing day needs an explicit zone). A union interval crossing local
 * midnight is attributed to its start day; per-day time still sums to the
 * billable total. Availability flags let callers caveat each measure.
 *
 * Session enumeration goes through {@link loadSessionEntries} (the handoff /
 * decisions path), so `session.yaml`-broken sessions are skipped consistently.
 */
export async function computeWorkStats(input: WorkStatsInput): Promise<WorkStatsResult> {
  const { now } = input;
  const timeZone = resolveTimeZone(input.timeZone);
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

  // Union every session's active intervals once; both the billable total and
  // the per-day view are attributed from the same merged ranges so they agree.
  const allIntervals: IntervalMs[] = [];
  for (const s of sessions) allIntervals.push(...intervalsIsoToMs(s.activeIntervals));
  const union = unionDurationMs(allIntervals);

  return {
    generatedAt: now.toISOString(),
    activeGapCapMs: ACTIVE_GAP_CAP_MS,
    timeZone,
    totals: computeTotals(sessions, union.ms),
    sessions,
    bySource: computeBySource(sessions),
    byStatus: computeByStatus(sessions),
    byDay: computeByDay(sessions, union.merged, timeZone),
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
  const active = resolveActiveTime(inner.metrics, timestamps);
  const machineActiveTimeMs = inner.metrics?.machine_active_time_ms ?? 0;
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
    activeTimeMs: active.ms,
    activeTimeBasis: active.basis,
    activeIntervals: intervalsMsToIso(active.intervals),
    machineActiveTimeMs,
    activeTimeMethod: inner.metrics?.active_time_method,
    commandCount,
    fileChangedCount,
    decisionCount,
    eventCount: events.length,
    tokens,
    availability: {
      span: true,
      commandTime: inner.source.kind !== "claude-code-import",
      activeTime: active.intervals.length > 0,
      tokens: hasTokens(tokens),
      machineActive: machineActiveTimeMs > 0,
    },
    spanClamped: span.clamped,
    eventsUnreadable,
  };
}

/**
 * Resolve a session's active time + intervals. Prefer the engaged-time
 * intervals stored at import (they capture conversation turns the event stream
 * misses); otherwise derive from the action-event timestamps. Either way
 * `ms` equals the summed interval duration.
 */
function resolveActiveTime(
  metrics: SessionMetrics | undefined,
  eventTimestamps: number[],
): { ms: number; intervals: IntervalMs[]; basis: ActiveTimeBasis } {
  const stored = metrics?.active_intervals;
  if (stored !== undefined && stored.length > 0) {
    const intervals = intervalsIsoToMs(stored);
    const ms = intervals.reduce((n, [start, end]) => n + (end - start), 0);
    return { ms, intervals, basis: "engaged-turns" };
  }
  const derived = activeTimeFromTimestamps(eventTimestamps, ACTIVE_GAP_CAP_MS);
  return { ms: derived.ms, intervals: derived.intervals, basis: "events" };
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

function computeTotals(
  sessions: readonly SessionWorkStats[],
  billableActiveTimeMs: number,
): WorkStatsTotals {
  const tokens = emptyTokens();
  const totals: WorkStatsTotals = {
    sessionCount: sessions.length,
    openSessionCount: 0,
    sessionSpanMs: 0,
    commandTimeMs: 0,
    activeTimeMs: 0,
    billableActiveTimeMs,
    machineActiveTimeMs: 0,
    commandCount: 0,
    fileChangedCount: 0,
    decisionCount: 0,
    eventCount: 0,
    tokens,
    commandTimeReliable: true,
    tokensAvailable: false,
    machineActiveAvailable: false,
  };
  for (const s of sessions) {
    if (s.open) totals.openSessionCount++;
    totals.sessionSpanMs += s.sessionSpanMs;
    totals.commandTimeMs += s.commandTimeMs;
    totals.activeTimeMs += s.activeTimeMs;
    totals.machineActiveTimeMs += s.machineActiveTimeMs;
    totals.commandCount += s.commandCount;
    totals.fileChangedCount += s.fileChangedCount;
    totals.decisionCount += s.decisionCount;
    totals.eventCount += s.eventCount;
    addTokens(tokens, s.tokens);
    if (!s.availability.commandTime) totals.commandTimeReliable = false;
    if (s.availability.tokens) totals.tokensAvailable = true;
    if (s.availability.machineActive) totals.machineActiveAvailable = true;
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
        machineActiveTimeMs: 0,
        commandCount: 0,
        fileChangedCount: 0,
        decisionCount: 0,
        eventCount: 0,
        tokens: emptyTokens(),
        commandTimeReliable: true,
        tokensAvailable: false,
        machineActiveAvailable: false,
      };
      map.set(s.sourceKind, row);
    }
    row.sessionCount++;
    row.sessionSpanMs += s.sessionSpanMs;
    row.commandTimeMs += s.commandTimeMs;
    row.activeTimeMs += s.activeTimeMs;
    row.machineActiveTimeMs += s.machineActiveTimeMs;
    row.commandCount += s.commandCount;
    row.fileChangedCount += s.fileChangedCount;
    row.decisionCount += s.decisionCount;
    row.eventCount += s.eventCount;
    addTokens(row.tokens, s.tokens);
    if (!s.availability.commandTime) row.commandTimeReliable = false;
    if (s.availability.tokens) row.tokensAvailable = true;
    if (s.availability.machineActive) row.machineActiveAvailable = true;
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

/**
 * Build the per-day billing view. Time comes from the pre-merged union
 * intervals, attributed to each interval's start date so the per-day totals sum
 * exactly to `totals.billableActiveTimeMs`. Volume (tokens, action counts) is
 * attributed to each session's `started_at` date.
 */
function computeByDay(
  sessions: readonly SessionWorkStats[],
  unionMerged: readonly IntervalMs[],
  timeZone: string,
): DayWorkStats[] {
  const days = new Map<string, DayWorkStats>();
  const ensure = (date: string): DayWorkStats => {
    let day = days.get(date);
    if (day === undefined) {
      day = {
        date,
        billableActiveTimeMs: 0,
        machineActiveTimeMs: 0,
        sessionCount: 0,
        commandCount: 0,
        fileChangedCount: 0,
        decisionCount: 0,
        tokens: emptyTokens(),
      };
      days.set(date, day);
    }
    return day;
  };
  for (const [start, end] of unionMerged) {
    ensure(tzDate(start, timeZone)).billableActiveTimeMs += end - start;
  }
  for (const s of sessions) {
    const startedMs = Date.parse(s.startedAt);
    if (!Number.isFinite(startedMs)) continue;
    const day = ensure(tzDate(startedMs, timeZone));
    day.sessionCount++;
    day.machineActiveTimeMs += s.machineActiveTimeMs;
    day.commandCount += s.commandCount;
    day.fileChangedCount += s.fileChangedCount;
    day.decisionCount += s.decisionCount;
    addTokens(day.tokens, s.tokens);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Calendar date (`YYYY-MM-DD`) of an instant in the given IANA timezone. */
function tzDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}
