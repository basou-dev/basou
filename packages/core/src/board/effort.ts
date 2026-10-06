import { join } from "node:path";
import type { SessionSourceKind } from "../schemas/session.schema.js";
import { type IntervalMs, intervalsIsoToMs, mergeIntervals } from "../stats/active-time.js";
import { computeWorkStats, type SessionWorkStats } from "../stats/work-stats.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import type { AuthorDates } from "./repos.js";
import { listSessions, lostAmong } from "./sessions.js";

/**
 * The version of how the `effort` section measures. Raised whenever a value of
 * the section would change for the same trail and repositories, as when
 * `basou stats` measures active time differently.
 */
export const BOARD_EFFORT_METHOD = 1;

// Which vendor's work each kind of session is. A Record keyed by the union,
// so a kind added to the schema fails to compile here until it is placed.
const VENDOR: Record<SessionSourceKind, "claude" | "codex" | null> = {
  "claude-code-adapter": "claude",
  "claude-code-import": "claude",
  "codex-adapter": "codex",
  "codex-import": "codex",
  human: null,
  import: null,
  terminal: null,
};

// The kinds whose import records the tokens of the model, where a session
// with none recorded is one whose tokens are missing. A launcher's session
// (an adapter) leaves them to the import of the same work.
const TOKEN_KINDS: ReadonlySet<string> = new Set(["claude-code-import", "codex-import"]);

/** Active time in milliseconds, as `basou stats` measures it. */
export type BoardActiveMs = {
  /** Every session's active intervals, merged. */
  union: number | null;
  /** Claude Code's sessions' intervals, merged among themselves. */
  claude: number | null;
  /** Codex's sessions' intervals, merged among themselves. */
  codex: number | null;
};

export type BoardEffortDay = {
  /** The day, in the section's time zone. */
  date: string;
  active_ms: BoardActiveMs;
  /** The output tokens of the sessions that started that day. */
  output_tokens: number | null;
  /** The commits authored that day, by the manifest's path. */
  commits: Record<string, number | null>;
};

/**
 * The work since the board's start, in its time zone. Time and tokens are
 * every session's, as `basou stats` counts them; an interval that crosses a
 * midnight is split between the days, and nothing before the start counts.
 */
export type BoardEffort = {
  /** The declared start. */
  start: string;
  /** The time zone the days are in: the declared one, or this host's, as named by `Intl`. */
  time_zone: string;
  /** Days from the start to today. Left out of the digest. */
  elapsed_days: number;
  /**
   * Null with an entry at `effort.active_ms` when a session could not be read.
   * `codex` is also null, with no entry, when there is no Codex session at
   * all: a null that means so, where 0 is a Codex that did nothing.
   */
  active_ms: BoardActiveMs;
  /**
   * The output tokens of the sessions that recorded them (reasoning not
   * included). Null with an entry at `effort.output_tokens` when a session
   * could not be read.
   */
  output_tokens: number | null;
  /**
   * The Claude Code and Codex imports that recorded no tokens, so that
   * `output_tokens` is a floor while it is above 0.
   */
  sessions_without_tokens: number | null;
  /**
   * The commits reachable from HEAD authored on a day from the start to
   * today, by the manifest's path. Null with an entry at
   * `effort.commits[<path>]` for a repository whose history is not known.
   */
  commits: Record<string, number | null>;
  /** One row for each day from the start to today, today's left out of the digest. */
  daily: BoardEffortDay[];
};

export type EffortInput = {
  paths: BasouPaths;
  now: Date;
  start: string;
  /** The declared time zone, if any. */
  timeZone?: string | undefined;
  /** The manifest's paths, in its order. */
  repos: readonly string[];
  authorDates: ReadonlyMap<string, AuthorDates>;
};

/** The `effort` section of a measurement, and why a value is missing when it is. */
export async function measureEffort(input: EffortInput): Promise<{
  effort: BoardEffort;
  notFound: { at: string; reason: string }[];
}> {
  const notFound: { at: string; reason: string }[] = [];
  const zone = new Intl.DateTimeFormat("en-US", {
    ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
  }).resolvedOptions().timeZone;
  const calendar = new Calendar(zone);
  const today = calendar.dateOf(input.now.getTime());
  const days = datesFrom(input.start, today);
  const elapsedDays = Math.round((utcOf(today) - utcOf(input.start)) / 86_400_000);
  const startMs = calendar.midnightOf(input.start);

  // Commits, each repository apart.
  const commits: Record<string, number | null> = {};
  const commitsByDay = new Map<string, Record<string, number | null>>();
  for (const day of days) commitsByDay.set(day, {});
  for (const path of input.repos) {
    const authored = input.authorDates.get(path);
    if (authored === undefined || !authored.ok) {
      commits[path] = null;
      notFound.push({
        at: `effort.commits[${path}]`,
        reason: authored?.reason ?? "the history of the repo is not known",
      });
      for (const row of commitsByDay.values()) row[path] = null;
      continue;
    }
    for (const row of commitsByDay.values()) row[path] = 0;
    let total = 0;
    for (const date of authored.dates) {
      const row = commitsByDay.get(calendar.dateOf(Date.parse(date)));
      if (row === undefined) continue;
      row[path] = (row[path] ?? 0) + 1;
      total++;
    }
    commits[path] = total;
  }

  const sessions = await readSessions(input.paths, input.now, zone);
  let effort: BoardEffort;
  if (!sessions.ok) {
    for (const at of ["effort.active_ms", "effort.output_tokens"]) {
      notFound.push({ at, reason: sessions.reason });
    }
    const unknown = { union: null, claude: null, codex: null };
    effort = {
      start: input.start,
      time_zone: zone,
      elapsed_days: elapsedDays,
      active_ms: unknown,
      output_tokens: null,
      sessions_without_tokens: null,
      commits,
      daily: days.map((date) => ({
        date,
        active_ms: unknown,
        output_tokens: null,
        commits: commitsByDay.get(date) ?? {},
      })),
    };
  } else {
    const all = sessions.sessions;
    const hasCodex = all.some((s) => VENDOR[s.sourceKind] === "codex");
    const vendorOf = (wanted: "claude" | "codex") =>
      all.filter((s) => VENDOR[s.sourceKind] === wanted);
    const union = byDay(all, calendar, startMs, days);
    const claude = byDay(vendorOf("claude"), calendar, startMs, days);
    const codex = byDay(vendorOf("codex"), calendar, startMs, days);

    const tokensByDay = new Map<string, number>();
    for (const day of days) tokensByDay.set(day, 0);
    let withoutTokens = 0;
    for (const session of all) {
      const day = calendar.dateOf(Date.parse(session.startedAt));
      if (!tokensByDay.has(day)) continue;
      if (session.availability.tokens) {
        tokensByDay.set(day, (tokensByDay.get(day) ?? 0) + session.tokens.output);
      } else if (TOKEN_KINDS.has(session.sourceKind)) {
        withoutTokens++;
      }
    }
    const sum = (values: Iterable<number>) => [...values].reduce((a, b) => a + b, 0);
    effort = {
      start: input.start,
      time_zone: zone,
      elapsed_days: elapsedDays,
      active_ms: {
        union: sum(union.values()),
        claude: sum(claude.values()),
        codex: hasCodex ? sum(codex.values()) : null,
      },
      output_tokens: sum(tokensByDay.values()),
      sessions_without_tokens: withoutTokens,
      commits,
      daily: days.map((date) => ({
        date,
        active_ms: {
          union: union.get(date) ?? 0,
          claude: claude.get(date) ?? 0,
          codex: hasCodex ? (codex.get(date) ?? 0) : null,
        },
        output_tokens: tokensByDay.get(date) ?? 0,
        commits: commitsByDay.get(date) ?? {},
      })),
    };
  }
  return { effort, notFound };
}

// Every session as `basou stats` measures it, or why one could not be read.
async function readSessions(
  paths: BasouPaths,
  now: Date,
  timeZone: string,
): Promise<{ ok: true; sessions: SessionWorkStats[] } | { ok: false; reason: string }> {
  const listed = await listSessions(paths);
  if (!listed.ok) return listed;
  // A running session's events are read twice, once to tell whether it is
  // suspect, so a line is known by where it is rather than counted per call.
  const malformed = new Map<string, Set<number>>();
  const offSchema = new Set<string>();
  const unreadable = new Set<string>();
  const notDirectories = new Set<string>();
  let sessions: SessionWorkStats[];
  try {
    const stats = await computeWorkStats({
      paths,
      now,
      timeZone,
      onWarning: (warning, sessionId) => {
        if (warning.kind === "malformed_json") {
          const lines = malformed.get(sessionId) ?? new Set<number>();
          lines.add(warning.line);
          malformed.set(sessionId, lines);
        } else if (warning.kind === "schema_violation") {
          offSchema.add(`${sessionId}\0${warning.line}`);
        }
      },
      onSessionSkip: (sessionId, reason) => {
        if (reason === "session_dir_not_directory") notDirectories.add(sessionId);
        else unreadable.add(sessionId);
      },
    });
    sessions = stats.sessions;
  } catch {
    return { ok: false, reason: "the sessions of the workspace could not be read" };
  }
  let lost = offSchema.size;
  for (const [sessionId, lines] of malformed) {
    lost += await lostAmong(join(paths.sessions, sessionId, "events.jsonl"), [...lines]);
  }
  const problems: string[] = [];
  if (lost > 0) problems.push(`${lost} event line${lost === 1 ? "" : "s"} could not be read`);
  if (unreadable.size > 0) {
    const n = unreadable.size;
    problems.push(`${n} session${n === 1 ? "" : "s"} could not be read`);
  }
  if (notDirectories.size > 0) {
    const n = notDirectories.size;
    problems.push(
      `${n} session ${n === 1 ? "entry is" : "entries are"} not a directory (a symlink or a file)`,
    );
  }
  if (problems.length > 0) {
    return {
      ok: false,
      reason: `${problems.join(", and ")}, so the time and tokens are not known`,
    };
  }
  return { ok: true, sessions };
}

// The merged active time of `sessions` on each of `days`, from the start on.
function byDay(
  sessions: readonly SessionWorkStats[],
  calendar: Calendar,
  startMs: number,
  days: readonly string[],
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const day of days) totals.set(day, 0);
  const intervals: IntervalMs[] = [];
  for (const session of sessions) intervals.push(...intervalsIsoToMs(session.activeIntervals));
  for (const [from, to] of mergeIntervals(intervals)) {
    let begin = Math.max(from, startMs);
    while (begin < to) {
      const day = calendar.dateOf(begin);
      const next = Math.min(to, calendar.midnightOf(nextDate(day)));
      // A day the zone never reaches midnight on still ends where the next begins.
      const end = next > begin ? next : to;
      if (totals.has(day)) totals.set(day, (totals.get(day) ?? 0) + (end - begin));
      begin = end;
    }
  }
  return totals;
}

// Every date from `first` to `last`, both included; none when `first` is later.
function datesFrom(first: string, last: string): string[] {
  const out: string[] = [];
  for (let day = first; day <= last; day = nextDate(day)) out.push(day);
  return out;
}

function utcOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function nextDate(date: string): string {
  return new Date(utcOf(date) + 86_400_000).toISOString().slice(0, 10);
}

// Dates and midnights in one time zone.
class Calendar {
  private readonly format: Intl.DateTimeFormat;

  constructor(timeZone: string) {
    this.format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }

  /** The date of an instant in the zone. */
  dateOf(ms: number): string {
    const part: Record<string, string> = {};
    for (const { type, value } of this.format.formatToParts(ms)) part[type] = value;
    return `${(part.year ?? "").padStart(4, "0")}-${part.month ?? ""}-${part.day ?? ""}`;
  }

  private readonly midnights = new Map<string, number>();

  /**
   * The first instant of a date in the zone: midnight, or where the zone
   * skips midnight, the first instant it reaches on that date.
   */
  midnightOf(date: string): number {
    const known = this.midnights.get(date);
    if (known !== undefined) return known;
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    const target = Date.UTC(y, m - 1, d);
    // No zone is two days from UTC, so the answer lies between these.
    let low = target - 2 * 86_400_000;
    let high = target + 2 * 86_400_000;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.dateOf(middle) < date) low = middle + 1;
      else high = middle;
    }
    this.midnights.set(date, low);
    return low;
  }
}
