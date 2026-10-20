import { lstat, open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeTime } from "ulid";
import { z } from "zod";
import { findErrorCode } from "../lib/error-codes.js";
import { byCodePoint } from "./components.js";
import { type BoardObserve, isCalendarDate } from "./declaration.js";
import { type BoardObservedChange, diffCells, diffObserved } from "./diff.js";
import { observedValueProblems } from "./observed-shape.js";
import { readBoardRecordFile, recordIds } from "./previous.js";
import { BOARD_RECORD_VERSIONS } from "./record.js";

// The record versions the page draws: every version a record has had (a
// version is added to BOARD_RECORD_VERSIONS, never removed).
const DRAWN_VERSIONS = new Set<number>(BOARD_RECORD_VERSIONS);

const text = z.string();
const count = z.number().nullable();

// What the page draws from a record, kept loose: a key it does not draw is
// let through.
// An observation of a record's declaration, as the page reads it: a key of it
// not in its shape is read as not there.
const maybe = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);
const declaredObservationSchema = z.looseObject({
  key: text,
  kind: text,
  words: maybe(z.array(text)),
  count_pattern: maybe(text),
  capture_pattern: maybe(text),
  notes: maybe(z.array(text)),
  url: maybe(text),
  repo: maybe(text),
  package: maybe(text),
  workflow: maybe(text),
  check: maybe(text),
});
type DeclaredObservation = z.output<typeof declaredObservationSchema>;

// What an observation looks at, as the page names it under the observation.
const LOOKS_AT = ["url", "repo", "package", "workflow", "check"] as const;

// A repo of a record of version 3, and of one of version 1 or 2, which held
// the commits behind as behind_main and measured no base, ahead or fetch.
const repoFields = {
  path: text,
  name: text.nullable(),
  head: text.nullable(),
  branch: text.nullable(),
  last_commit: text.nullable(),
  commits: count,
  files: count,
  uncommitted: count,
};
const repoSchema = z.looseObject({
  ...repoFields,
  base: text.nullable(),
  behind: count,
  ahead: count,
  fetched_at: text.nullable(),
});
const olderRepoSchema = z.looseObject({ ...repoFields, behind_main: count });

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
    // A list in a record of version 3, one id in one of version 1 or 2.
    measures: z.array(
      z.looseObject({ id: text, unit: text, lane: z.union([text, z.array(text)]).optional() }),
    ),
    ratios: z.array(z.looseObject({ id: text, label: text, numerator: text, denominator: text })),
    axis: z.looseObject({ version: z.number() }),
    effort: z.looseObject({
      milestones: z.array(z.looseObject({ date: text, label: text, ref: text })).optional(),
    }),
    // None in a record of version 1. Each observation is checked on its own
    // (declaredObservationSchema): one not in that shape is drawn without
    // its words, and the others with theirs.
    observe: z.array(z.unknown()).optional().catch(undefined),
  }),
  measure: z.looseObject({
    measured_with: z.looseObject({ basou: text, build: text.nullable() }),
    complete: z.boolean(),
    // Read by the record's version (see repoSchema), and drawn as not in its
    // shape, rather than the record not drawn, when it is not.
    repos: z.unknown().optional(),
    // Read by hand (see componentsOf): a key of its own, such as __proto__,
    // stays one.
    components: z.unknown().optional(),
    not_found: z.array(z.looseObject({ at: text, reason: text })),
    measures: z.record(
      text,
      z.looseObject({ value: z.union([z.number(), text, z.array(text)]).nullable(), unit: text }),
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
  // A review not in its shape is drawn as none, not taken for a record that
  // cannot be drawn: the rest of the record is drawn as it was before.
  axis_review: z
    .looseObject({ triggers: z.array(text), summary: text })
    .nullable()
    .optional()
    .catch(null),
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
  /**
   * An http observation's words, as the record's declaration lists them, each
   * with what the value says of it. Present when the value holds one answer
   * for each word.
   */
  words?: { word: string; found: unknown }[];
  /** An http value read as its parts, present when it is in the shape its declaration gives it. */
  http?: BoardPageHttp;
  /** Its kind, as the record's declaration says, when that declares it. */
  kind?: string;
  /** What it looks at, as the record's declaration says: its url, or its repo, package, workflow and check. */
  looks_at?: string[];
  /** What to mind when making it, as the record's declaration says. */
  notes?: string[];
  /**
   * Present when the value is not null and it moved since the previous
   * record, as the record's diff compares observations (its value or its
   * error): what the previous record held.
   */
  moved?: BoardPageMovedFrom;
};

/**
 * An http value read as its parts. `body` is there when the observation reads
 * the body (words, a count or a capture), and null when the status is not
 * 2xx, so the body was not read.
 */
export type BoardPageHttp = {
  status: number;
  redirects: number;
  final_url: string;
  body?: {
    words?: { word: string; found: boolean }[];
    count?: number;
    capture?: string | null;
  } | null;
};

/**
 * What the previous record held of an observation that moved: its value,
 * drawn by that record's declaration (its words and the shape of its kind),
 * or none, when it had no observation of that name.
 */
export type BoardPageMovedFrom =
  | {
      status: "value";
      value: unknown;
      error?: string;
      words?: { word: string; found: unknown }[];
      http?: BoardPageHttp;
    }
  | { status: "none" };

/** The previous record's value of an observation: there, none, or not known. */
export type BoardPagePrevious =
  | { status: "value"; value: unknown }
  | { status: "none" }
  | { status: "unreadable" };

/** A measure of the record, in the table of every measure. */
export type BoardPageMeasure = {
  id: string;
  /** A number, a string, or the paths of a `file_paths`. */
  value: number | string | string[] | null;
  unit: string;
  /** The names of the lanes it is drawn in. */
  lanes: string[];
  /**
   * This value less the previous record's, when both are numbers; null when
   * one is not, or there is no previous record that can be read.
   */
  delta: number | null;
};

/** A repository as the board page draws it, measured on the spot or recorded. */
export type BoardPageRepo = {
  path: string;
  name: string | null;
  head: string | null;
  branch: string | null;
  last_commit: string | null;
  commits: number | null;
  files: number | null;
  uncommitted: number | null;
  base: string | null;
  behind: number | null;
  ahead: number | null;
  fetched_at: string | null;
};

/** A component as a record's page draws it. */
export type BoardPageComponent = {
  key: string;
  /** The kinds of marker found for it, null when it was not found. */
  kinds: string[] | null;
  /** Why it counts in no lane, for one registered with the lane '-'. */
  note?: string;
  /** Its kinds in the previous record, when they were others. */
  kind_changed?: { before: string[]; after: string[] };
};

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
  /**
   * Each measure drawn in the lane, one of more than one lane in each: a
   * number, a string, or the paths of a `file_paths`.
   */
  measures: { id: string; value: number | string | string[] | null; unit: string }[];
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

/** What the board page draws from one record, by section. */
export type BoardPageBody = {
  heading: {
    title: string;
    recorded_at: string;
    model: string;
    complete: boolean;
    not_found: number;
  };
  summary: {
    text: string;
    tiles: BoardPageTile[];
    observed: BoardPageObservation[];
    /** Whether there is a previous record, and whether it could be read. */
    previous_record: "found" | "none" | "unreadable";
  };
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
    /**
     * The days from the start to today (the one the effort was measured on),
     * both included: the rows of `daily`, one more than `elapsed_days`. The
     * page's time per day is the active time over these.
     */
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
  /** Every measure the record's declaration holds, in its order. */
  measures: BoardPageMeasure[];
  composition: {
    id: string;
    label: string;
    value: number | null;
    numerator: { id: string; value: number | string | string[] | null; unit: string | null };
    denominator: { id: string; value: number | string | string[] | null; unit: string | null };
  }[];
  /**
   * The repositories as the record measured them. A record of version 1 or 2
   * measured no base, commits ahead or fetch time (`base_measured` false), and
   * its commits behind are drawn as `behind`. Null when the record holds none
   * in a shape the page reads.
   */
  repos: { record_version: number; base_measured: boolean; list: BoardPageRepo[] } | null;
  /**
   * The components as the record measured them, against the registry its
   * declaration holds. Null when the record holds none in a shape the page
   * reads.
   */
  components: {
    /** False when they were not measured: `reasons` says why. */
    measured: boolean;
    /** What not_found says at `components` or under it. */
    reasons: string[];
    /** Each lane, with the components registered in it, by code point. */
    lanes: { id: string; name: string; components: BoardPageComponent[] }[];
    /** The components registered with the lane '-', each with its note. */
    uncounted: BoardPageComponent[];
    /** The components found that the registry does not hold. */
    unacknowledged: BoardPageComponent[];
    /** Those registered or found before that were not found; null when not known. */
    gone: string[] | null;
  } | null;
  turns: { text: string; source: string }[];
  footnotes: {
    notes: string[];
    axis: {
      version: number;
      /** Measured before this record was written, so before its own review. */
      review_needed: boolean | null;
      /**
       * The last review as measured before this record was written: when the
       * record reviews the axis itself (`this_review`), the review before it.
       * Null when there is none on record, or, with `last_review_known`
       * false, when a record that may hold it could not be read.
       */
      last_review: { date: string; model: string; from: string; record?: string } | null;
      last_review_known: boolean;
      /** The record's own review of the axis, as the judge reported it, or null. */
      this_review: { triggers: string[]; summary: string } | null;
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
  // The names that are files: the list opens no other (a FIFO would never answer).
  let files: Set<string>;
  try {
    const entry = await lstat(recordsDir);
    if (!entry.isDirectory()) return boardPageUnavailable("records_not_directory");
    const entries = await readdir(recordsDir, { withFileTypes: true });
    names = entries.map((e) => e.name);
    files = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) return boardPageUnavailable("no_records");
    return boardPageUnavailable("records_unreadable");
  }
  const ids = recordIds(names);
  const records = await recordTimes(recordsDir, ids, files);
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
          ? {
              status: "found",
              cells: previous.record.cells,
              observed: previous.record.observed,
              observe: declaredObservations(
                isRecord(previous.record.declaration) ? previous.record.declaration.observe : [],
              ),
              measures: measureValues(previous.record.measure.measures),
            }
          : { status: "unreadable" },
    ),
  };
}

// When each record was recorded, for the list of records: its own
// `recorded_at`, read off the head of the file basou wrote, so that the list
// does not read every record whole. A record written before 0.70.1 has a name
// of another time than its own, which is used only when the head does not
// hold one, or the name is not a file.
async function recordTimes(
  recordsDir: string,
  ids: readonly string[],
  files: ReadonlySet<string>,
): Promise<{ id: string; at: string }[]> {
  const out: { id: string; at: string }[] = [];
  for (const id of ids) {
    const name = `${id}.json`;
    const at = files.has(name) ? await recordedAtOf(join(recordsDir, name)) : undefined;
    out.push({ id, at: at ?? new Date(decodeTime(id)).toISOString() });
  }
  return out;
}

// How a record basou wrote begins (JSON.stringify with an indent of 2), with
// `recorded_at` as basou writes it: a time in UTC to the millisecond. Any
// other form would be read in the host's time zone, or not at all.
const RECORD_HEAD =
  /^\{\s*"record_version":\s*\d+,\s*"recorded_at":\s*"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)"/;
const RECORD_HEAD_BYTES = 256;

async function recordedAtOf(path: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const head = Buffer.alloc(RECORD_HEAD_BYTES);
    const { bytesRead } = await handle.read(head, 0, RECORD_HEAD_BYTES, 0);
    const at = RECORD_HEAD.exec(head.subarray(0, bytesRead).toString("utf8"))?.[1];
    return at === undefined || Number.isNaN(Date.parse(at))
      ? undefined
      : new Date(at).toISOString();
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
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
      observed: Readonly<Record<string, { value: unknown; error?: string | undefined }>>;
      /** The observations its declaration holds, by key. */
      observe: ReadonlyMap<string, DeclaredObservation>;
      /** The value of each of its measures, by id. */
      measures: ReadonlyMap<string, unknown>;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The observations a declaration holds, by key: an entry not in its shape is
// left out, and drawn with none of what the declaration says of it.
function declaredObservations(observe: unknown): Map<string, DeclaredObservation> {
  const out = new Map<string, DeclaredObservation>();
  if (!Array.isArray(observe)) return out;
  for (const raw of observe) {
    const o = declaredObservationSchema.safeParse(raw).data;
    if (o !== undefined && !out.has(o.key)) out.set(o.key, o);
  }
  return out;
}

// The observations that moved, compared as the record's diff compares them,
// by name. None when a value is nested deeper than the comparison goes, which
// only a record written by hand holds: the page is drawn without the marks.
function movedObservations(
  before: Readonly<Record<string, { value: unknown; error?: string | undefined }>>,
  after: PageRecord["observed"],
): [string, BoardObservedChange][] {
  try {
    return diffObserved(before, after).map((c) => [c.name, c]);
  } catch {
    return [];
  }
}

// The value of each measure of a measurement as a record holds it, by id.
function measureValues(measures: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!isRecord(measures)) return out;
  for (const [id, entry] of Object.entries(measures)) {
    if (isRecord(entry)) out.set(id, entry.value);
  }
  return out;
}

// The states a cell has when it is done or begun, and when it needs attention.
const REACHED = new Set(["done", "part"]);
const ATTENTION = new Set(["blocked", "shelved", "unverified"]);

function bodyOf(r: PageRecord, previous: Previous): BoardPageBody {
  const d = r.declaration;
  const m = r.measure;
  const declared = declaredObservations(d.observe ?? []);
  const movedNow = new Map<string, BoardObservedChange>(
    previous.status === "found" ? movedObservations(previous.observed, r.observed) : [],
  );
  const laneNames = new Map(d.lanes.map((lane) => [lane.id, lane.name]));
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
      observed: Object.entries(r.observed).map(([name, o]) => {
        const declaredNow = declared.get(name);
        const words = wordsOf(httpWords(declaredNow), o.value);
        const http = httpOf(declaredNow, o.value);
        const looksAt = LOOKS_AT.flatMap((key) => {
          const value = declaredNow?.[key];
          return value === undefined ? [] : [value];
        });
        const change = movedNow.get(name);
        return {
          name,
          value: o.value,
          observed_at: o.observed_at,
          source: o.source,
          ...(o.error === undefined ? {} : { error: o.error }),
          ...(o.value === null ? { previous: previousValue(previous, name) } : {}),
          ...(words === undefined ? {} : { words }),
          ...(http === undefined ? {} : { http }),
          ...(declaredNow === undefined ? {} : { kind: declaredNow.kind }),
          ...(looksAt.length === 0 ? {} : { looks_at: looksAt }),
          ...(declaredNow?.notes === undefined ? {} : { notes: [...declaredNow.notes] }),
          ...(o.value === null || change === undefined || previous.status !== "found"
            ? {}
            : { moved: movedFrom(change.before, previous.observe.get(name)) }),
        };
      }),
      previous_record: previous.status,
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
          .filter((measure) =>
            typeof measure.lane === "string"
              ? measure.lane === lane.id
              : (measure.lane ?? []).includes(lane.id),
          )
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
    measures: d.measures.map((measure) => {
      const value = m.measures[measure.id]?.value ?? null;
      const before = previous.status === "found" ? previous.measures.get(measure.id) : undefined;
      const lanes =
        measure.lane === undefined
          ? []
          : typeof measure.lane === "string"
            ? [measure.lane]
            : measure.lane;
      return {
        id: measure.id,
        value,
        unit: measure.unit,
        lanes: lanes.map((id) => laneNames.get(id) ?? id),
        delta: typeof value === "number" && typeof before === "number" ? value - before : null,
      };
    }),
    composition: d.ratios.map((ratio) => ({
      id: ratio.id,
      label: ratio.label,
      value: m.ratios[ratio.id]?.value ?? null,
      numerator: measureOf(ratio.numerator),
      denominator: measureOf(ratio.denominator),
    })),
    repos: reposOf(r.record_version, m.repos),
    components: componentsOf(m.components, d.components, d.lanes, m.not_found),
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
        this_review:
          r.axis_review === null || r.axis_review === undefined
            ? null
            : { triggers: [...r.axis_review.triggers], summary: r.axis_review.summary },
      },
      model: r.judged_by.model,
      not_found: m.not_found.map(({ at, reason }) => ({ at, reason })),
      measured_with: { basou: m.measured_with.basou, build: m.measured_with.build },
    },
  };
}

// An http observation's words beside what its value says of each, when the
// value holds one answer for each word: a previous value, under another
// declaration, is not paired with this one's words.
function wordsOf(
  words: readonly string[] | undefined,
  value: unknown,
): { word: string; found: unknown }[] | undefined {
  if (words === undefined || typeof value !== "object" || value === null) return undefined;
  const found = (value as { words?: unknown }).words;
  if (!Array.isArray(found) || found.length !== words.length) return undefined;
  return words.map((word, i) => ({ word, found: found[i] }));
}

// The words of an http observation a declaration holds.
function httpWords(o: DeclaredObservation | undefined): string[] | undefined {
  return o?.kind === "http" ? o.words : undefined;
}

// An http value read as its parts, when it is in the shape the declared
// observation gives it (the shape record held a value to when it was
// written, so a final_url with a query, which record took before it refused
// one, is still drawn as a part): a value of another shape, as a record
// written before that check may hold, is drawn as it is.
function httpOf(o: DeclaredObservation | undefined, value: unknown): BoardPageHttp | undefined {
  if (o?.kind !== "http" || value === null || value === undefined) return undefined;
  if (observedValueProblems(o as unknown as BoardObserve, value, { written: true }).length > 0) {
    return undefined;
  }
  const v = value as {
    status: number;
    redirects: number;
    final_url: string;
    words?: boolean[];
    count?: number;
    capture?: string | null;
  };
  const reads =
    o.words !== undefined || o.count_pattern !== undefined || o.capture_pattern !== undefined;
  const read = v.status >= 200 && v.status <= 299;
  const body = read
    ? {
        ...(o.words === undefined
          ? {}
          : { words: o.words.map((word, i) => ({ word, found: v.words?.[i] === true })) }),
        ...(o.count_pattern === undefined ? {} : { count: v.count as number }),
        ...(o.capture_pattern === undefined ? {} : { capture: v.capture ?? null }),
      }
    : null;
  return {
    status: v.status,
    redirects: v.redirects,
    final_url: v.final_url,
    ...(reads ? { body } : {}),
  };
}

// What the previous record held of an observation that moved, drawn by that
// record's declaration.
function movedFrom(
  before: { value: unknown; error?: string } | null,
  declaredThen: DeclaredObservation | undefined,
): BoardPageMovedFrom {
  if (before === null) return { status: "none" };
  const words = wordsOf(httpWords(declaredThen), before.value);
  const http = httpOf(declaredThen, before.value);
  return {
    status: "value",
    value: before.value,
    ...(before.error === undefined ? {} : { error: before.error }),
    ...(words === undefined ? {} : { words }),
    ...(http === undefined ? {} : { http }),
  };
}

// The repos of a record, read by its version: one of version 1 or 2 held the
// commits behind as behind_main, and measured no base, ahead or fetch time.
function reposOf(version: number, repos: unknown): BoardPageBody["repos"] {
  if (!Array.isArray(repos)) return null;
  const list: BoardPageRepo[] = [];
  for (const raw of repos) {
    if (version >= 3) {
      const r = repoSchema.safeParse(raw).data;
      if (r === undefined) return null;
      list.push({
        path: r.path,
        name: r.name,
        head: r.head,
        branch: r.branch,
        last_commit: r.last_commit,
        commits: r.commits,
        files: r.files,
        uncommitted: r.uncommitted,
        base: r.base,
        behind: r.behind,
        ahead: r.ahead,
        fetched_at: r.fetched_at,
      });
    } else {
      const r = olderRepoSchema.safeParse(raw).data;
      if (r === undefined) return null;
      list.push({
        path: r.path,
        name: r.name,
        head: r.head,
        branch: r.branch,
        last_commit: r.last_commit,
        commits: r.commits,
        files: r.files,
        uncommitted: r.uncommitted,
        base: null,
        behind: r.behind_main,
        ahead: null,
        fetched_at: null,
      });
    }
  }
  return { record_version: version, base_measured: version >= 3, list };
}

const isTexts = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

// The components of a record, held against the registry its declaration
// holds, read by hand so that a key of its own (such as __proto__) stays one.
function componentsOf(
  measured: unknown,
  registry: unknown,
  lanes: readonly { id: string; name: string }[],
  notFound: readonly { at: string; reason: string }[],
): BoardPageBody["components"] {
  if (!isRecord(measured)) return null;
  const { found, unacknowledged, gone, kind_changed: kindChanged } = measured;
  const reasons = notFound
    .filter(
      (n) =>
        n.at === "components" || n.at.startsWith("components.") || n.at.startsWith("components["),
    )
    .map((n) => n.reason);
  if (found === null) {
    return { measured: false, reasons, lanes: [], uncounted: [], unacknowledged: [], gone: null };
  }
  const kindsOf = new Map<string, string[]>();
  if (!isRecord(found)) return null;
  for (const [key, c] of Object.entries(found)) {
    if (!isRecord(c) || !isTexts(c.kinds)) return null;
    kindsOf.set(key, c.kinds);
  }
  const changed = new Map<string, { before: string[]; after: string[] }>();
  if (Array.isArray(kindChanged)) {
    for (const c of kindChanged) {
      if (isRecord(c) && typeof c.key === "string" && isTexts(c.before) && isTexts(c.after)) {
        changed.set(c.key, { before: c.before, after: c.after });
      }
    }
  }
  const row = (key: string, note?: string): BoardPageComponent => {
    const moved = changed.get(key);
    return {
      key,
      kinds: kindsOf.get(key) ?? null,
      ...(note === undefined ? {} : { note }),
      ...(moved === undefined ? {} : { kind_changed: moved }),
    };
  };
  const registered = isRecord(registry) ? registry : {};
  const keys = Object.keys(registered).sort(byCodePoint);
  const inLane = (id: string) =>
    keys.filter((key) => {
      const lane = (registered[key] as { lane?: unknown } | undefined)?.lane;
      return Array.isArray(lane) && lane.includes(id);
    });
  const uncounted = keys.flatMap((key) => {
    const c = registered[key];
    if (!isRecord(c) || c.lane !== "-") return [];
    return [row(key, typeof c.note === "string" ? c.note : undefined)];
  });
  const listed = (value: unknown) => (isTexts(value) ? [...value].sort(byCodePoint) : null);
  return {
    measured: true,
    reasons,
    lanes: lanes.map((lane) => ({
      id: lane.id,
      name: lane.name,
      components: inLane(lane.id).map((key) => row(key)),
    })),
    uncounted,
    unacknowledged: (listed(unacknowledged) ?? []).map((key) => row(key)),
    gone: listed(gone),
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
