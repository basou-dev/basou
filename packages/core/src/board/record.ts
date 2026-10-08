import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ulid } from "../ids/ulid.js";
import { findErrorCode } from "../lib/error-codes.js";
import {
  BOARD_STAGE_IDS,
  type BoardDeclaration,
  formatIssue,
  formatPath,
  isCalendarDate,
} from "./declaration.js";
import type { BoardMeasurement } from "./measure.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The version of a record's shape, the shape of the measurement it holds
 * included. Raised whenever that shape changes: 2 added the observations the
 * declaration names (`declaration.observe`) and what each stage is judged by
 * (`look` and `notes` of `declaration.stages`). Every version is read.
 */
export const BOARD_RECORD_VERSION = 2;

/** The record versions this basou reads. A version is added here, never removed. */
export const BOARD_RECORD_VERSIONS = [1, 2] as const;

/** The states a cell of the board can be in. */
export const BOARD_CELL_STATES = [
  "done",
  "part",
  "blocked",
  "shelved",
  "none",
  "unverified",
] as const;

/** The triggers an axis review can name: (d) is the operator's word. */
export const BOARD_AXIS_REVIEW_TRIGGERS = ["a", "b", "c", "d", "e"] as const;

// The states a cell must give a reason for.
const NEEDS_REASON = new Set(["blocked", "shelved", "unverified"]);

const nonEmptyText = z
  .string()
  .refine((s) => s.trim().length > 0, { error: "must be a non-empty string" });

// A date, or a date and a time of day with its offset.
const OBSERVED_AT =
  /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2})))?$/;

function isObservedAt(text: string): boolean {
  const m = OBSERVED_AT.exec(text);
  if (m === null || !isCalendarDate(m[1] as string)) return false;
  const [hour, minute, second, offsetHour, offsetMinute] = m
    .slice(2)
    .map((part) => (part === undefined ? 0 : Number(part)));
  return (
    (hour ?? 0) <= 23 &&
    (minute ?? 0) <= 59 &&
    (second ?? 0) <= 59 &&
    (offsetHour ?? 0) <= 23 &&
    (offsetMinute ?? 0) <= 59
  );
}

// How deep the value of an observation may nest. JSON.parse reads deeper
// ones, but whatever walks them, a check here or a reader later, could run
// out of stack.
const MAX_VALUE_DEPTH = 100;

// The value of an observation, kept as JSON.parse read it (a number to double
// precision). It is walked without recursion, and refused where it is not a
// JSON value: a number too large to be held reads as Infinity, and a key
// named __proto__ would not survive as a key.
const observedValue = z.unknown().superRefine((value, ctx) => {
  if (value === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "must be given (null, with an error, when nothing was observed)",
    });
    return;
  }
  const stack: { value: unknown; path: (string | number)[] }[] = [{ value, path: [] }];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { value: v, path } = next;
    if (path.at(-1) === "__proto__") {
      ctx.addIssue({ code: "custom", message: "is not a name it can have", path });
    } else if (typeof v === "number") {
      if (!Number.isFinite(v)) {
        ctx.addIssue({ code: "custom", message: "is a number too large to be held", path });
      }
    } else if (Array.isArray(v) || isRecord(v)) {
      if (path.length >= MAX_VALUE_DEPTH) {
        ctx.addIssue({ code: "custom", message: `nests more than ${MAX_VALUE_DEPTH} deep`, path });
        continue;
      }
      const children: [string | number, unknown][] = Array.isArray(v)
        ? v.map((child, i) => [i, child])
        : Object.entries(v);
      // Reversed, so that what is wrong is reported in the order it is written.
      for (const [key, child] of children.reverse())
        stack.push({ value: child, path: [...path, key] });
    } else if (typeof v !== "string" && typeof v !== "boolean" && v !== null) {
      ctx.addIssue({ code: "custom", message: "is not a JSON value", path });
    }
  }
});

const observedSchema = z
  .strictObject({
    value: observedValue,
    observed_at: z.string().refine(isObservedAt, {
      error: "must be a calendar date (YYYY-MM-DD), or one with a time of day and its offset",
    }),
    source: nonEmptyText,
    error: nonEmptyText.optional(),
  })
  .refine((o) => o.value !== null || o.error !== undefined, {
    error: "a value of null needs an error saying why it was not observed",
    path: ["error"],
  });

const cellsSchema = z.array(
  z.strictObject({
    lane: z.string(),
    stage: z.string(),
    state: z.enum(BOARD_CELL_STATES, {
      error: `must be one of ${BOARD_CELL_STATES.join(", ")}`,
    }),
    reason: nonEmptyText.optional(),
  }),
);

const proseLanesSchema = z.record(z.string(), z.string()).default({});

const triggersSchema = z
  .array(
    z.enum(BOARD_AXIS_REVIEW_TRIGGERS, {
      error: `must be one of ${BOARD_AXIS_REVIEW_TRIGGERS.join(", ")}`,
    }),
  )
  .min(1, { error: "must name at least one trigger" });

const recordInputSchema = z.strictObject({
  measure_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/, {
    error: "must be the digest of a measurement (sha256: and 64 hex digits)",
  }),
  observed: z.record(z.string(), observedSchema).default({}),
  cells: cellsSchema,
  prose: z.strictObject({
    summary: z.string(),
    lanes: proseLanesSchema,
    operator_turns: z.array(z.strictObject({ text: z.string(), source: z.string() })).default([]),
    footnotes: z.array(z.string()).default([]),
  }),
  judged_by: z.strictObject({
    model: nonEmptyText,
    self_reported: z.literal(true, {
      error: "must be true: basou cannot tell which model judged",
    }),
  }),
  axis_review: z
    .strictObject({ triggers: triggersSchema, summary: nonEmptyText })
    .nullable()
    .default(null),
});

/** What the skill (the model) hands `basou board record`, checked. */
export type BoardRecordInput = z.output<typeof recordInputSchema>;

export type BoardRecordInputResult =
  | { ok: true; input: BoardRecordInput }
  | { ok: false; errors: string[] };

/**
 * Check what is to be recorded against its shape and the declaration, and
 * report every problem at once, each starting with where it is: each part
 * whose shape is right is held against the declaration even when another
 * part's shape is wrong. An unknown key is refused at every level but the
 * keys of `observed` and of `prose.lanes`, which the latter limits to the
 * declaration's lane ids. Every lane has a cell at every stage, once. The
 * value is what JSON.parse read, so a key given twice has kept its last.
 */
export function parseRecordInput(
  value: unknown,
  declaration: BoardDeclaration,
): BoardRecordInputResult {
  const errors: string[] = [];
  // A key named __proto__ does not survive the shape check as a key, so it
  // is looked for in the input as given.
  for (const at of [["observed"], ["prose", "lanes"]]) {
    const held = at.reduce<unknown>((v, k) => (isRecord(v) ? v[k] : undefined), value);
    if (isRecord(held) && Object.hasOwn(held, "__proto__")) {
      errors.push(`${formatPath([...at, "__proto__"])}: is not a name it can have`);
    }
  }
  const parsed = recordInputSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors.push(formatIssue(issue));
  }

  const given = isRecord(value) ? value : {};
  const lanes = declaration.lanes.map((lane) => lane.id);
  const laneSet = new Set(lanes);
  const stages: readonly string[] = BOARD_STAGE_IDS;

  if (isRecord(given.observed)) {
    for (const key of Object.keys(given.observed)) {
      if (key.trim() === "") {
        errors.push(`${formatPath(["observed", key])}: is not a name it can have`);
      }
    }
  }
  // A board that declares what to observe is recorded with exactly those
  // observations: one that was not made is given as null with its error, so
  // a closed exit is never dropped from the board unsaid, and a name the
  // declaration does not hold (a typo) would never meet the value the
  // previous record has under the right one.
  const observed = given.observed === undefined ? {} : given.observed;
  if (declaration.observe.length > 0 && isRecord(observed)) {
    const declared = new Set(declaration.observe.map((o) => o.key));
    for (const key of declared) {
      if (!Object.hasOwn(observed, key)) {
        errors.push(
          `${formatPath(["observed", key])}: the board declares it, so it must be given (null, with an error, when it was not observed)`,
        );
      }
    }
    for (const key of Object.keys(observed)) {
      if (!declared.has(key) && key.trim() !== "" && key !== "__proto__") {
        errors.push(`${formatPath(["observed", key])}: is not an observation the board declares`);
      }
    }
  }
  const cells = cellsSchema.safeParse(given.cells);
  if (cells.success) {
    const seen = new Set<string>();
    cells.data.forEach((cell, i) => {
      const at = formatPath(["cells", i]);
      if (!laneSet.has(cell.lane))
        errors.push(`${at}.lane: '${cell.lane}' is not a lane of the board`);
      if (!stages.includes(cell.stage)) {
        errors.push(`${at}.stage: '${cell.stage}' is not a stage (${stages.join(", ")})`);
      }
      const key = `${cell.lane}\0${cell.stage}`;
      if (seen.has(key)) {
        errors.push(`${at}: lane '${cell.lane}' at stage '${cell.stage}' is given more than once`);
      }
      seen.add(key);
      if (NEEDS_REASON.has(cell.state) && cell.reason === undefined) {
        errors.push(`${at}.reason: a cell that is ${cell.state} needs a reason`);
      }
    });
    for (const lane of lanes) {
      const missing = stages.filter((stage) => !seen.has(`${lane}\0${stage}`));
      if (missing.length > 0) {
        errors.push(
          `cells: lane '${lane}' has no cell at stage ${missing.map((s) => `'${s}'`).join(", ")}`,
        );
      }
    }
  }
  const proseLanes = proseLanesSchema.safeParse(isRecord(given.prose) ? given.prose.lanes : {});
  if (proseLanes.success) {
    for (const key of Object.keys(proseLanes.data)) {
      if (!laneSet.has(key))
        errors.push(`${formatPath(["prose", "lanes", key])}: is not a lane of the board`);
    }
  }
  const triggers = triggersSchema.safeParse(
    isRecord(given.axis_review) ? given.axis_review.triggers : undefined,
  );
  if (triggers.success && new Set(triggers.data).size !== triggers.data.length) {
    errors.push("axis_review.triggers: names a trigger more than once");
  }
  if (!parsed.success || errors.length > 0) return { ok: false, errors };
  return { ok: true, input: parsed.data };
}

/** A stage left behind: not started, blocked or shelved before a later one done or begun. */
export type BoardOrderAnomaly = {
  lane: string;
  stage: string;
  state: string;
  /** The first later stage of the lane that is done or begun. */
  before: string;
};

/**
 * The cells out of order: in a lane, a stage that is `none`, `blocked` or
 * `shelved` before a stage that is `done` or `part` (`unverified` does not
 * count either way). Recorded, not refused: refusing would press a judge to
 * bend a cell to get a record through.
 */
export function orderAnomalies(
  input: BoardRecordInput,
  declaration: BoardDeclaration,
): BoardOrderAnomaly[] {
  const out: BoardOrderAnomaly[] = [];
  for (const lane of declaration.lanes) {
    const states = BOARD_STAGE_IDS.map(
      (stage) => input.cells.find((c) => c.lane === lane.id && c.stage === stage)?.state,
    );
    BOARD_STAGE_IDS.forEach((stage, i) => {
      const state = states[i];
      if (state !== "none" && state !== "blocked" && state !== "shelved") return;
      const later = BOARD_STAGE_IDS.findIndex(
        (_s, j) => j > i && (states[j] === "done" || states[j] === "part"),
      );
      if (later !== -1) {
        out.push({ lane: lane.id, stage, state, before: BOARD_STAGE_IDS[later] as string });
      }
    });
  }
  return out;
}

/** What `basou board record` writes: one file a record. */
export type BoardRecord = {
  record_version: number;
  recorded_at: string;
  recorded_with: { basou: string; build: string | null };
  /**
   * The declaration the board was measured and judged by, as parsed (its
   * defaults filled in).
   */
  declaration: {
    title: string;
    stages: BoardDeclaration["stages"];
    lanes: BoardDeclaration["lanes"];
    measures: BoardDeclaration["measures"];
    ratios: BoardDeclaration["ratios"];
    components: BoardDeclaration["components"];
    axis: BoardDeclaration["axis"];
    effort: BoardDeclaration["effort"];
    observe: BoardDeclaration["observe"];
  };
  /**
   * What basou measured as it recorded, the digest the judge saw included,
   * but not its diff, which the previous record derives. What the digest
   * leaves out (freshness, the axis, the clock) is as it was measured again,
   * not necessarily as the judge saw it.
   */
  measure: Omit<BoardMeasurement, "diff">;
  observed: BoardRecordInput["observed"];
  cells: BoardRecordInput["cells"];
  prose: BoardRecordInput["prose"];
  judged_by: BoardRecordInput["judged_by"];
  axis_review: BoardRecordInput["axis_review"];
  order_anomalies: BoardOrderAnomaly[];
};

export function buildRecord(input: {
  declaration: BoardDeclaration;
  measurement: BoardMeasurement;
  recordInput: BoardRecordInput;
  recordedAt: Date;
  recordedWith: { basou: string; build: string | null };
}): BoardRecord {
  const { declaration: d, recordInput: r } = input;
  const { diff: _diff, ...measure } = input.measurement;
  return {
    record_version: BOARD_RECORD_VERSION,
    recorded_at: input.recordedAt.toISOString(),
    recorded_with: input.recordedWith,
    declaration: {
      title: d.title,
      stages: d.stages,
      lanes: d.lanes,
      measures: d.measures,
      ratios: d.ratios,
      components: d.components,
      axis: d.axis,
      effort: d.effort,
      observe: d.observe,
    },
    measure,
    observed: r.observed,
    cells: r.cells,
    prose: r.prose,
    judged_by: r.judged_by,
    axis_review: r.axis_review,
    order_anomalies: orderAnomalies(r, d),
  };
}

/**
 * Write a record to `<recordsDir>/<ULID>.json`, all of it or nothing: the text
 * goes to a file whose name is not a ULID's, then is linked into place (which
 * fails rather than replace a record of the same name, when another name is
 * tried). On a failure nothing is left behind, not even a records directory
 * made for it. Returns the name written.
 */
export async function writeRecord(recordsDir: string, record: BoardRecord): Promise<string> {
  const made = await mkdir(recordsDir, { recursive: true });
  try {
    const entry = await lstat(recordsDir);
    if (!entry.isDirectory()) {
      throw Object.assign(new Error("the records directory is not a directory"), {
        code: "ENOTDIR",
      });
    }
    const tmp = join(recordsDir, `.record-${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      for (let attempt = 0; ; attempt++) {
        const name = `${ulid()}.json`;
        try {
          await link(tmp, join(recordsDir, name));
          return name;
        } catch (error: unknown) {
          if (!findErrorCode(error, "EEXIST") || attempt >= 3) throw error;
        }
      }
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  } catch (error: unknown) {
    // Only when it is still empty.
    if (made !== undefined) await rmdir(made).catch(() => undefined);
    throw error;
  }
}
