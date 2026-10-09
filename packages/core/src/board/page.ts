import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeTime } from "ulid";
import { z } from "zod";
import { findErrorCode } from "../lib/error-codes.js";
import { isCalendarDate } from "./declaration.js";
import { diffCells } from "./diff.js";
import { readBoardRecordFile, recordIds } from "./previous.js";
import { BOARD_RECORD_VERSIONS } from "./record.js";

// The record versions the page draws: every version a record has had (a
// version is added to BOARD_RECORD_VERSIONS, never removed).
const DRAWN_VERSIONS = new Set<number>(BOARD_RECORD_VERSIONS);

const text = z.string();
const count = z.number().nullable();

// What the page draws from a record, kept loose: a key it does not draw is
// let through.
const pageRecordSchema = z.looseObject({
  record_version: z.number(),
  recorded_at: text,
  declaration: z.looseObject({
    title: text,
    stages: z.record(text, z.looseObject({ meaning: text })),
    lanes: z.array(
      z.looseObject({
        id: text,
        name: text,
        about: text.optional(),
        notes: z.array(text).optional(),
      }),
    ),
    measures: z.array(z.looseObject({ id: text, unit: text, lane: text.optional() })),
    ratios: z.array(z.looseObject({ id: text, label: text, numerator: text, denominator: text })),
    axis: z.looseObject({ version: z.number() }),
    effort: z.looseObject({
      milestones: z.array(z.looseObject({ date: text, label: text, ref: text })).optional(),
    }),
  }),
  measure: z.looseObject({
    measured_with: z.looseObject({ basou: text, build: text.nullable() }),
    complete: z.boolean(),
    not_found: z.array(z.looseObject({ at: text, reason: text })),
    measures: z.record(
      text,
      z.looseObject({ value: z.union([z.number(), text]).nullable(), unit: text }),
    ),
    ratios: z.record(text, z.looseObject({ value: z.number().nullable() })),
    trail: z.looseObject({
      tracks_open: z.array(z.looseObject({ id: text, title: text })).nullable(),
    }),
    integrity: z.looseObject({
      by_status: z.record(text, z.number()).nullable(),
      not_verified: count,
    }),
    effort: z.looseObject({
      start: text,
      time_zone: text.nullable(),
      elapsed_days: count,
      active_ms: z.looseObject({ union: count, claude: count, codex: count }),
      output_tokens: count,
      sessions_without_tokens: count,
      commits: z.record(text, count).nullable(),
      daily: z
        .array(
          z.looseObject({
            date: z.string().refine(isCalendarDate),
            active_ms: z.looseObject({ union: count, claude: count, codex: count }),
            commits: z.record(text, count),
          }),
        )
        .nullable(),
    }),
    axis: z.looseObject({
      review_needed: z.boolean().nullable(),
      last_review: z
        .looseObject({ date: text, model: text, from: text, record: text.optional() })
        .nullable(),
    }),
  }),
  observed: z.record(
    text,
    z.looseObject({ value: z.unknown(), observed_at: text, source: text, error: text.optional() }),
  ),
  cells: z.array(z.looseObject({ lane: text, stage: text, state: text, reason: text.optional() })),
  prose: z.looseObject({
    summary: text,
    lanes: z.record(text, text),
    operator_turns: z.array(z.looseObject({ text, source: text })),
    footnotes: z.array(text),
  }),
  judged_by: z.looseObject({ model: text }),
  order_anomalies: z.array(z.looseObject({ lane: text, stage: text, state: text, before: text })),
});

type PageRecord = z.output<typeof pageRecordSchema>;

/** A record the page can open: its ULID, and when it was written (from the ULID). */
export type BoardPageRecordRef = { id: string; at: string };

/** Why there is no board to draw. */
export type BoardPageUnavailable =
  | "no_board"
  | "no_records"
  | "records_not_directory"
  | "records_unreadable"
  | "not_found"
  | "not_json"
  | "unknown_version"
  | "not_a_record";

/** A value the page shows, and whether the judge reported it rather than basou measured it. */
export type BoardPageTile = {
  key: "live_lanes" | "blocked" | "unverified" | "open_tracks" | "sessions" | "turns";
  value: number | null;
  /** The lanes for live_lanes, the sessions not verified for sessions. */
  detail?: number | null;
  reported: boolean;
};

/** An observation from outside, with the previous record's value when this one has none. */
export type BoardPageObservation = {
  name: string;
  value: unknown;
  observed_at: string;
  source: string;
  error?: string;
  /** Present when the value is null: the previous record's value of the same name. */
  previous?: BoardPagePrevious;
};

/** The previous record's value of an observation: there, none, or not known. */
export type BoardPagePrevious =
  | { status: "value"; value: unknown }
  | { status: "none" }
  | { status: "unreadable" };

export type BoardPageCell = {
  stage: string;
  state: string;
  reason?: string;
  /** The state in the previous record, when it was another. */
  moved_from?: string;
};

export type BoardPageLane = {
  id: string;
  name: string;
  about?: string;
  notes?: string[];
  /** The furthest stage done or begun, null when there is none. */
  now: { stage: string; meaning: string; state: string } | null;
  attention: { stage: string; state: string; reason?: string }[];
  prose: string | null;
  measures: { id: string; value: number | string | null; unit: string }[];
  flags: { live: boolean; blocked: boolean; unverified: boolean };
};

/** One day of the effort, as the page draws it. */
export type BoardPageDay = {
  date: string;
  union: number | null;
  claude: number | null;
  /**
   * The active time not Claude's: Codex's, and work by hand or in a terminal,
   * when it was not at the same time as Claude's. The record's days cannot
   * tell Codex's alone apart.
   */
  not_claude: number | null;
  cumulative: number | null;
  /** The commits of every repo that day, null when one of them was not measured. */
  commits: number | null;
};

/** One week of the effort, from its Monday: null where a day of it was not measured. */
export type BoardPageWeek = {
  week: string;
  union: number | null;
  claude: number | null;
  codex: number | null;
  active_days: number | null;
  commits: number | null;
};

/** What the board page draws from one record: the eight sections, in order. */
export type BoardPageBody = {
  heading: {
    title: string;
    recorded_at: string;
    model: string;
    complete: boolean;
    not_found: number;
  };
  summary: { text: string; tiles: BoardPageTile[]; observed: BoardPageObservation[] };
  effort: {
    start: string;
    time_zone: string | null;
    elapsed_days: number | null;
    active_ms: { union: number | null; claude: number | null; codex: number | null };
    output_tokens: number | null;
    sessions_without_tokens: number | null;
    commits: { repo: string; count: number | null }[] | null;
    milestones: { date: string; label: string; ref: string }[];
    /**
     * The days the active time was more than none on, null when a day's time
     * was not measured.
     */
    active_days: number | null;
    /** The days from the start to today, the one the effort was measured on. */
    period_days: number | null;
    /**
     * Each day from the start, in milliseconds: the active time, Claude's, the
     * part not Claude's, and the running total of the active time (null from a
     * day whose time was not measured on).
     */
    daily: BoardPageDay[] | null;
    /** The days by week, from Monday. */
    weeks: BoardPageWeek[] | null;
  };
  matrix: {
    stages: { id: string; meaning: string }[];
    lanes: { id: string; name: string; cells: BoardPageCell[] }[];
    anomalies: { lane: string; stage: string; state: string; before: string }[];
  };
  lanes: BoardPageLane[];
  composition: {
    id: string;
    label: string;
    value: number | null;
    numerator: { id: string; value: number | string | null; unit: string | null };
    denominator: { id: string; value: number | string | null; unit: string | null };
  }[];
  turns: { text: string; source: string }[];
  footnotes: {
    notes: string[];
    axis: {
      version: number;
      review_needed: boolean | null;
      /**
       * Null when there is none on record, or, with `last_review_known`
       * false, when a record that may hold it could not be read.
       */
      last_review: { date: string; model: string; from: string; record?: string } | null;
      last_review_known: boolean;
    };
    model: string;
    not_found: { at: string; reason: string }[];
    measured_with: { basou: string; build: string | null };
  };
};

/** The board page's data for one record, or why there is none to draw. */
export type BoardPage =
  | {
      status: "unavailable";
      why: BoardPageUnavailable;
      records: BoardPageRecordRef[];
      /** The record asked for, or the last one, when there was one to ask for. */
      id: string | null;
      older: string | null;
      newer: string | null;
      /** The record_version it does not draw, for unknown_version. */
      version?: number;
    }
  | {
      status: "ok";
      records: BoardPageRecordRef[];
      id: string;
      older: string | null;
      newer: string | null;
      board: BoardPageBody;
    };

/** Say why there is no board to draw. */
export function boardPageUnavailable(
  why: BoardPageUnavailable,
  around: {
    records?: BoardPageRecordRef[];
    id?: string | null;
    older?: string | null;
    newer?: string | null;
    version?: number;
  } = {},
): BoardPage {
  return {
    status: "unavailable",
    why,
    records: around.records ?? [],
    id: around.id ?? null,
    older: around.older ?? null,
    newer: around.newer ?? null,
    ...(around.version === undefined ? {} : { version: around.version }),
  };
}

/**
 * Read what the board page draws for the record named `id` in a records
 * directory, or the last one when `id` is not given: only the records,
 * never the board.yaml as it is now, so a past record is drawn by the axis it
 * was judged by. The record before it marks the cells that moved and gives
 * the previous value of an observation not made.
 */
export async function boardPage(recordsDir: string, id?: string): Promise<BoardPage> {
  let names: string[];
  try {
    const entry = await lstat(recordsDir);
    if (!entry.isDirectory()) return boardPageUnavailable("records_not_directory");
    names = await readdir(recordsDir);
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) return boardPageUnavailable("no_records");
    return boardPageUnavailable("records_unreadable");
  }
  const ids = recordIds(names);
  const records = ids.map((name) => ({ id: name, at: new Date(decodeTime(name)).toISOString() }));
  if (ids.length === 0) return boardPageUnavailable("no_records", { records });
  const shown = id ?? (ids[ids.length - 1] as string);
  const index = ids.indexOf(shown);
  if (index === -1) return boardPageUnavailable("not_found", { records, id: shown });

  const older = index > 0 ? (ids[index - 1] as string) : null;
  const newer = ids[index + 1] ?? null;
  const read = await readPageRecord(recordsDir, shown);
  if (!read.ok) {
    return boardPageUnavailable(read.why, {
      records,
      id: shown,
      older,
      newer,
      ...(read.version === undefined ? {} : { version: read.version }),
    });
  }
  const previous = older === null ? null : await readBoardRecordFile(recordsDir, older);
  return {
    status: "ok",
    records,
    id: shown,
    older,
    newer,
    board: bodyOf(
      read.record,
      previous === null
        ? { status: "none" }
        : previous.ok
          ? { status: "found", cells: previous.record.cells, observed: previous.record.observed }
          : { status: "unreadable" },
    ),
  };
}

async function readPageRecord(
  recordsDir: string,
  id: string,
): Promise<
  | { ok: true; record: PageRecord }
  | { ok: false; why: "not_json" | "unknown_version" | "not_a_record"; version?: number }
> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(recordsDir, `${id}.json`), "utf8"));
  } catch {
    return { ok: false, why: "not_json" };
  }
  const version = (value as { record_version?: unknown } | null)?.record_version;
  if (typeof version === "number" && !DRAWN_VERSIONS.has(version)) {
    return { ok: false, why: "unknown_version", version };
  }
  const parsed = pageRecordSchema.safeParse(value);
  if (!parsed.success || !DRAWN_VERSIONS.has(parsed.data.record_version)) {
    return { ok: false, why: "not_a_record" };
  }
  return { ok: true, record: parsed.data };
}

type Previous =
  | { status: "none" }
  | { status: "unreadable" }
  | {
      status: "found";
      cells: readonly { lane: string; stage: string; state: string }[];
      observed: Readonly<Record<string, { value: unknown }>>;
    };

// The states a cell has when it is done or begun, and when it needs attention.
const REACHED = new Set(["done", "part"]);
const ATTENTION = new Set(["blocked", "shelved", "unverified"]);

function bodyOf(r: PageRecord, previous: Previous): BoardPageBody {
  const d = r.declaration;
  const m = r.measure;
  const stages = Object.entries(d.stages)
    .map(([id, stage]) => ({ id, meaning: stage.meaning }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const cellOf = (lane: string, stage: string) =>
    r.cells.find((c) => c.lane === lane && c.stage === stage);
  const moved = new Map<string, string>();
  if (previous.status === "found") {
    for (const change of diffCells(previous.cells, r.cells)) {
      if (change.before !== null && change.after !== null) {
        moved.set(`${change.lane}\0${change.stage}`, change.before);
      }
    }
  }
  const sessions =
    m.integrity.by_status === null
      ? null
      : Object.values(m.integrity.by_status).reduce((sum, n) => sum + n, 0);
  const stateCount = (state: string) => r.cells.filter((c) => c.state === state).length;
  const measureOf = (id: string) => ({
    id,
    value: m.measures[id]?.value ?? null,
    unit: m.measures[id]?.unit ?? null,
  });

  return {
    heading: {
      title: d.title,
      recorded_at: r.recorded_at,
      model: r.judged_by.model,
      complete: m.complete,
      not_found: m.not_found.length,
    },
    summary: {
      text: r.prose.summary,
      tiles: [
        {
          key: "live_lanes",
          value: d.lanes.filter((lane) => cellOf(lane.id, "06")?.state === "done").length,
          detail: d.lanes.length,
          reported: true,
        },
        { key: "blocked", value: stateCount("blocked"), reported: true },
        { key: "unverified", value: stateCount("unverified"), reported: true },
        { key: "open_tracks", value: m.trail.tracks_open?.length ?? null, reported: false },
        {
          key: "sessions",
          value: sessions,
          detail: m.integrity.not_verified,
          reported: false,
        },
        { key: "turns", value: r.prose.operator_turns.length, reported: true },
      ],
      observed: Object.entries(r.observed).map(([name, o]) => ({
        name,
        value: o.value,
        observed_at: o.observed_at,
        source: o.source,
        ...(o.error === undefined ? {} : { error: o.error }),
        ...(o.value === null ? { previous: previousValue(previous, name) } : {}),
      })),
    },
    effort: effortOf(m.effort, d.effort.milestones ?? []),
    matrix: {
      stages,
      lanes: d.lanes.map((lane) => ({
        id: lane.id,
        name: lane.name,
        cells: stages.map(({ id: stage }) => {
          const cell = cellOf(lane.id, stage);
          const from = moved.get(`${lane.id}\0${stage}`);
          return {
            stage,
            state: cell?.state ?? "none",
            ...(cell?.reason === undefined ? {} : { reason: cell.reason }),
            ...(from === undefined ? {} : { moved_from: from }),
          };
        }),
      })),
      anomalies: r.order_anomalies.map(({ lane, stage, state, before }) => ({
        lane,
        stage,
        state,
        before,
      })),
    },
    lanes: d.lanes.map((lane) => {
      const cells = stages.map(({ id }) => cellOf(lane.id, id));
      let now: BoardPageLane["now"] = null;
      stages.forEach((stage, i) => {
        const state = cells[i]?.state;
        if (state !== undefined && REACHED.has(state)) {
          now = { stage: stage.id, meaning: stage.meaning, state };
        }
      });
      return {
        id: lane.id,
        name: lane.name,
        ...(lane.about === undefined ? {} : { about: lane.about }),
        ...(lane.notes === undefined ? {} : { notes: lane.notes }),
        now,
        attention: cells.flatMap((cell) =>
          cell === undefined || !ATTENTION.has(cell.state)
            ? []
            : [
                {
                  stage: cell.stage,
                  state: cell.state,
                  ...(cell.reason === undefined ? {} : { reason: cell.reason }),
                },
              ],
        ),
        prose: Object.hasOwn(r.prose.lanes, lane.id) ? (r.prose.lanes[lane.id] as string) : null,
        measures: d.measures
          .filter((measure) => measure.lane === lane.id)
          .map((measure) => ({
            id: measure.id,
            value: m.measures[measure.id]?.value ?? null,
            unit: measure.unit,
          })),
        flags: {
          live: cellOf(lane.id, "06")?.state === "done",
          blocked: cells.some((cell) => cell?.state === "blocked"),
          unverified: cells.some((cell) => cell?.state === "unverified"),
        },
      };
    }),
    composition: d.ratios.map((ratio) => ({
      id: ratio.id,
      label: ratio.label,
      value: m.ratios[ratio.id]?.value ?? null,
      numerator: measureOf(ratio.numerator),
      denominator: measureOf(ratio.denominator),
    })),
    turns: r.prose.operator_turns.map(({ text: t, source }) => ({ text: t, source })),
    footnotes: {
      notes: [...r.prose.footnotes],
      axis: {
        version: d.axis.version,
        review_needed: m.axis.review_needed,
        last_review:
          m.axis.last_review === null
            ? null
            : {
                date: m.axis.last_review.date,
                model: m.axis.last_review.model,
                from: m.axis.last_review.from,
                ...(m.axis.last_review.record === undefined
                  ? {}
                  : { record: m.axis.last_review.record }),
              },
        last_review_known: !m.not_found.some((n) => n.at === "axis.last_review"),
      },
      model: r.judged_by.model,
      not_found: m.not_found.map(({ at, reason }) => ({ at, reason })),
      measured_with: { basou: m.measured_with.basou, build: m.measured_with.build },
    },
  };
}

// The previous record's value of an observation this record could not make.
function previousValue(previous: Previous, name: string): BoardPagePrevious {
  if (previous.status === "unreadable") return { status: "unreadable" };
  if (previous.status === "none" || !Object.hasOwn(previous.observed, name)) {
    return { status: "none" };
  }
  const value = previous.observed[name]?.value;
  return value === null || value === undefined ? { status: "none" } : { status: "value", value };
}

type MeasuredDay = {
  date: string;
  active_ms: { union: number | null; claude: number | null; codex: number | null };
  commits: Readonly<Record<string, number | null>>;
};

/** The effort section of a measurement, as a record holds it or as basou measured it now. */
export type MeasuredEffort = {
  start: string;
  time_zone: string | null;
  elapsed_days: number | null;
  active_ms: { union: number | null; claude: number | null; codex: number | null };
  output_tokens: number | null;
  sessions_without_tokens: number | null;
  commits: Readonly<Record<string, number | null>> | null;
  daily: readonly MeasuredDay[] | null;
};

/**
 * What the page draws of the period and effort: the measured effort, the
 * milestones declared, and the days and weeks derived from its daily rows.
 */
export function effortOf(
  effort: MeasuredEffort,
  milestones: readonly { date: string; label: string; ref: string }[],
): BoardPageBody["effort"] {
  return {
    start: effort.start,
    time_zone: effort.time_zone,
    elapsed_days: effort.elapsed_days,
    active_ms: {
      union: effort.active_ms.union,
      claude: effort.active_ms.claude,
      codex: effort.active_ms.codex,
    },
    output_tokens: effort.output_tokens,
    sessions_without_tokens: effort.sessions_without_tokens,
    commits:
      effort.commits === null
        ? null
        : Object.entries(effort.commits).map(([repo, n]) => ({ repo, count: n })),
    milestones: milestones.map(({ date, label, ref }) => ({ date, label, ref })),
    ...daysOf(effort.daily),
  };
}

// The sum, null when any of it was not measured: a part is not the whole.
function sumOf(values: readonly (number | null)[]): number | null {
  let sum = 0;
  for (const value of values) {
    if (value === null) return null;
    sum += value;
  }
  return sum;
}

// The days with active time, null when a day's time was not measured.
function activeDaysOf(rows: readonly MeasuredDay[]): number | null {
  if (rows.some((r) => r.active_ms.union === null)) return null;
  return rows.filter((r) => (r.active_ms.union ?? 0) > 0).length;
}

// The Monday of the week a calendar date is in, as YYYY-MM-DD.
function mondayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const day = new Date(0);
  day.setUTCFullYear(y, m - 1, d);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

function daysOf(rows: readonly MeasuredDay[] | null): {
  active_days: number | null;
  period_days: number | null;
  daily: BoardPageDay[] | null;
  weeks: BoardPageWeek[] | null;
} {
  if (rows === null) return { active_days: null, period_days: null, daily: null, weeks: null };
  let total: number | null = 0;
  const daily = rows.map((row) => {
    const { union, claude } = row.active_ms;
    total = total === null || union === null ? null : total + union;
    return {
      date: row.date,
      union,
      claude,
      not_claude: union === null || claude === null ? null : Math.max(0, union - claude),
      cumulative: total,
      commits: sumOf(Object.values(row.commits)),
    };
  });
  const byWeek = new Map<string, MeasuredDay[]>();
  for (const row of rows) {
    const week = mondayOf(row.date);
    byWeek.set(week, [...(byWeek.get(week) ?? []), row]);
  }
  const weeks = [...byWeek].map(([week, days]) => ({
    week,
    union: sumOf(days.map((r) => r.active_ms.union)),
    claude: sumOf(days.map((r) => r.active_ms.claude)),
    codex: sumOf(days.map((r) => r.active_ms.codex)),
    active_days: activeDaysOf(days),
    commits: sumOf(days.flatMap((r) => Object.values(r.commits))),
  }));
  return { active_days: activeDaysOf(rows), period_days: rows.length, daily, weeks };
}
