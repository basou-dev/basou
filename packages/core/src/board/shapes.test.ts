import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { BOARD_DECLARATION_SCHEMAS } from "./declaration.js";
import { recordInputSchema } from "./record.js";

// The shapes a board's guaranteed files and input take, pinned: a key, a kind
// or a value taken away, renamed or made required fails here, and so does one
// added to a board_version that is already read (a new one comes with a new
// version). What each output prints is pinned beside the commands that print
// it, in the cli's board-shapes test.

// The parts of a zod schema's definition the walk reads.
type Def = {
  type: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  valueType?: z.ZodType;
  options?: z.ZodType[];
  discriminator?: string;
  innerType?: z.ZodType;
  in?: z.ZodType;
  values?: unknown[];
  entries?: Record<string, unknown>;
};

const defOf = (schema: z.ZodType): Def => (schema as unknown as { _zod: { def: Def } })._zod.def;

// The kinds of schema that only wrap another.
const WRAPPERS = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "readonly",
  "catch",
  "nonoptional",
]);
// The wrappers that let an input leave a key out.
const MAY_BE_LEFT_OUT = new Set(["optional", "default", "prefault"]);

function mayBeLeftOut(schema: z.ZodType): boolean {
  for (let def = defOf(schema); ; def = defOf(def.innerType as z.ZodType)) {
    if (MAY_BE_LEFT_OUT.has(def.type)) return true;
    if (!WRAPPERS.has(def.type) || def.innerType === undefined) return false;
  }
}

function literalsOf(schema: z.ZodType): string[] {
  const def = defOf(schema);
  if (def.type === "literal") return (def.values ?? []).map(String);
  if (WRAPPERS.has(def.type) && def.innerType !== undefined) return literalsOf(def.innerType);
  return [];
}

// The shape a schema takes, as sorted lines: one for each object, `path: {key,
// key?}` (a `?` for a key that may be left out), and one for each value a
// literal or an enum takes, `path = a | b`. A list's entries are at `path[]`,
// a mapping's values at `path.*`, and each option of a union told apart by a
// key at `path<key=value>`.
function shapeLines(schema: z.ZodType): string[] {
  const lines = new Set<string>();
  const walk = (s: z.ZodType, at: string): void => {
    const def = defOf(s);
    switch (def.type) {
      case "object": {
        const shape = def.shape ?? {};
        const keys = Object.keys(shape)
          .sort()
          .map((key) => (mayBeLeftOut(shape[key] as z.ZodType) ? `${key}?` : key));
        lines.add(`${at === "" ? "(top)" : at}: {${keys.join(", ")}}`);
        for (const [key, child] of Object.entries(shape)) {
          walk(child, at === "" ? key : `${at}.${key}`);
        }
        return;
      }
      case "array":
        if (def.element !== undefined) walk(def.element, `${at}[]`);
        return;
      case "record":
        if (def.valueType !== undefined) walk(def.valueType, `${at}.*`);
        return;
      case "union":
        for (const option of def.options ?? []) {
          const by = def.discriminator;
          if (by === undefined) walk(option, at);
          else walk(option, `${at}<${by}=${literalsOf(defOf(option).shape?.[by] as z.ZodType)}>`);
        }
        return;
      case "pipe":
        if (def.in !== undefined) walk(def.in, at);
        return;
      case "literal":
        lines.add(`${at} = ${(def.values ?? []).map(String).join(" | ")}`);
        return;
      case "enum":
        lines.add(
          `${at} = ${Object.values(def.entries ?? {})
            .map(String)
            .join(" | ")}`,
        );
        return;
      case "null":
        lines.add(`${at} = null`);
        return;
      default:
        if (WRAPPERS.has(def.type) && def.innerType !== undefined) walk(def.innerType, at);
    }
  };
  walk(schema, "");
  return [...lines].sort();
}

describe("the shapes a board's files and input take", () => {
  it("walks a schema into the lines it pins", async () => {
    const { z } = await import("zod");
    const schema = z.strictObject({
      a: z.string(),
      b: z.number().optional(),
      c: z.array(z.strictObject({ d: z.enum(["x", "y"]) })).default([]),
      e: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("p"), f: z.string() }),
        z.strictObject({ kind: z.literal("q"), g: z.record(z.string(), z.literal(1)) }),
      ]),
      h: z.union([z.literal("-"), z.array(z.string())]).nullable(),
    });
    expect(shapeLines(schema)).toEqual([
      "(top): {a, b?, c?, e, h}",
      "c[].d = x | y",
      "c[]: {d}",
      "e<kind=p>.kind = p",
      "e<kind=p>: {f, kind}",
      "e<kind=q>.g.* = 1",
      "e<kind=q>.kind = q",
      "e<kind=q>: {g, kind}",
      "h = -",
    ]);
  });

  it("pins what board.yaml of each board_version reads", () => {
    const lines = Object.fromEntries(
      Object.entries(BOARD_DECLARATION_SCHEMAS).map(([version, schema]) => [
        version,
        shapeLines(schema),
      ]),
    );
    expect(lines).toEqual(BOARD_YAML_SHAPES);
  });

  it("pins what the input of basou board record takes", () => {
    expect(shapeLines(recordInputSchema)).toEqual(RECORD_INPUT_SHAPE);
  });
});

// What each board_version reads (board.md, 2).
const BOARD_YAML_SHAPES: Record<string, string[]> = {
  "1": [
    "(top): {axis, board_version, components?, effort, lanes, measures?, ratios?, stages, title}",
    "axis.seed_review: {date, model}",
    "axis: {review_due_days, seed_review?, version}",
    "board_version = 1 | 2 | 3",
    "components.*.lane = -",
    "components.*: {lane, note?}",
    "effort.milestones[]: {date, label, ref}",
    "effort: {milestones?, start, time_zone?}",
    "lanes[]: {about?, id, name, notes?}",
    "measures[]<kind=dir_count>.kind = dir_count",
    "measures[]<kind=dir_count>: {at?, depth, exclude?, id, include?, kind, lane?, path, repo, unit}",
    "measures[]<kind=file_count>.kind = file_count",
    "measures[]<kind=file_count>: {at?, exclude?, id, include, kind, lane?, repo, unit}",
    "measures[]<kind=json_length>.kind = json_length",
    "measures[]<kind=json_length>: {at?, file, id, kind, lane?, pointer, repo, unit}",
    "measures[]<kind=line_count>.kind = line_count",
    "measures[]<kind=line_count>: {at?, exclude?, id, include, kind, lane?, repo, unit}",
    "measures[]<kind=match_count>.kind = match_count",
    "measures[]<kind=match_count>.section.on_missing = null",
    "measures[]<kind=match_count>.section.on_missing = zero",
    "measures[]<kind=match_count>.section: {end?, on_missing, start}",
    "measures[]<kind=match_count>: {at?, exclude?, id, include, kind, lane?, pattern, repo, section?, unit}",
    "measures[]<kind=regex_capture>.kind = regex_capture",
    "measures[]<kind=regex_capture>.section.on_missing = null",
    "measures[]<kind=regex_capture>.section: {end?, on_missing, start}",
    "measures[]<kind=regex_capture>: {at?, file, group?, id, kind, lane?, pattern, repo, section?, unit}",
    "measures[]<kind=trail_count>.kind = trail_count",
    "measures[]<kind=trail_count>.of = decisions_all | decisions_live | tracks_open | tasks",
    "measures[]<kind=trail_count>.status = planned | in_progress | done | cancelled",
    "measures[]<kind=trail_count>: {id, kind, lane?, of, status?, unit}",
    "ratios[]: {denominator, id, label, numerator}",
    "stages.01: {meaning}",
    "stages.02: {meaning}",
    "stages.03: {meaning}",
    "stages.04: {meaning}",
    "stages.05: {meaning}",
    "stages.06: {meaning}",
    "stages: {01, 02, 03, 04, 05, 06}",
  ],
  "2": [
    "(top): {axis, board_version, components?, effort, lanes, measures?, observe?, ratios?, stages, title}",
    "axis.seed_review: {date, model}",
    "axis: {review_due_days, seed_review?, version}",
    "board_version = 1 | 2 | 3",
    "components.*.lane = -",
    "components.*: {lane, note?}",
    "effort.milestones[]: {date, label, ref}",
    "effort: {milestones?, start, time_zone?}",
    "lanes[]: {about?, id, name, notes?}",
    "measures[]<kind=dir_count>.kind = dir_count",
    "measures[]<kind=dir_count>: {at?, depth, exclude?, id, include?, kind, lane?, path, repo, unit}",
    "measures[]<kind=file_count>.kind = file_count",
    "measures[]<kind=file_count>: {at?, exclude?, id, include, kind, lane?, repo, unit}",
    "measures[]<kind=json_length>.kind = json_length",
    "measures[]<kind=json_length>: {at?, file, id, kind, lane?, pointer, repo, unit}",
    "measures[]<kind=line_count>.kind = line_count",
    "measures[]<kind=line_count>: {at?, exclude?, id, include, kind, lane?, repo, unit}",
    "measures[]<kind=match_count>.kind = match_count",
    "measures[]<kind=match_count>.section.on_missing = null",
    "measures[]<kind=match_count>.section.on_missing = zero",
    "measures[]<kind=match_count>.section: {end?, on_missing, start}",
    "measures[]<kind=match_count>: {at?, exclude?, id, include, kind, lane?, pattern, repo, section?, unit}",
    "measures[]<kind=regex_capture>.kind = regex_capture",
    "measures[]<kind=regex_capture>.section.on_missing = null",
    "measures[]<kind=regex_capture>.section: {end?, on_missing, start}",
    "measures[]<kind=regex_capture>: {at?, file, group?, id, kind, lane?, pattern, repo, section?, unit}",
    "measures[]<kind=trail_count>.kind = trail_count",
    "measures[]<kind=trail_count>.of = decisions_all | decisions_live | tracks_open | tasks",
    "measures[]<kind=trail_count>.status = planned | in_progress | done | cancelled",
    "measures[]<kind=trail_count>: {id, kind, lane?, of, status?, unit}",
    "observe[]<kind=github_ci>.kind = github_ci",
    "observe[]<kind=github_ci>: {branch?, key, kind, repo, workflow}",
    "observe[]<kind=github_open_issues>.kind = github_open_issues",
    "observe[]<kind=github_open_issues>: {key, kind, repo}",
    "observe[]<kind=github_open_prs>.kind = github_open_prs",
    "observe[]<kind=github_open_prs>: {key, kind, repo}",
    "observe[]<kind=github_release>.kind = github_release",
    "observe[]<kind=github_release>: {key, kind, repo}",
    "observe[]<kind=manual>.kind = manual",
    "observe[]<kind=manual>: {how, key, kind}",
    "observe[]<kind=npm_version>.kind = npm_version",
    "observe[]<kind=npm_version>: {key, kind, package}",
    "observe[]<kind=page_version>.kind = page_version",
    "observe[]<kind=page_version>: {key, kind, url}",
    "ratios[]: {denominator, id, label, numerator}",
    "stages.01: {look?, meaning, notes?}",
    "stages.02: {look?, meaning, notes?}",
    "stages.03: {look?, meaning, notes?}",
    "stages.04: {look?, meaning, notes?}",
    "stages.05: {look?, meaning, notes?}",
    "stages.06: {look?, meaning, notes?}",
    "stages: {01, 02, 03, 04, 05, 06}",
  ],
  "3": [
    "(top): {axis, board_version, components?, effort, lanes, measures?, observe?, ratios?, stages, title}",
    "axis.seed_review: {date, model}",
    "axis: {review_due_days, seed_review?, version}",
    "board_version = 1 | 2 | 3",
    "components.*.lane = -",
    "components.*: {lane, marker?, note?}",
    "effort.milestones[]: {date, label, ref}",
    "effort: {milestones?, start, time_zone?}",
    "lanes[]: {about?, id, name, notes?}",
    "measures[]<kind=dir_count>.kind = dir_count",
    "measures[]<kind=dir_count>: {at?, depth, exclude?, id, include?, kind, lane?, path, repo, unit}",
    "measures[]<kind=file_count>.kind = file_count",
    "measures[]<kind=file_count>: {at?, exclude?, id, include, kind, lane?, repo, unit}",
    "measures[]<kind=file_name>.kind = file_name",
    "measures[]<kind=file_name>.pick = first | last",
    "measures[]<kind=file_name>: {at?, exclude?, group?, id, include, kind, lane?, pattern?, pick, repo, unit}",
    "measures[]<kind=file_paths>.kind = file_paths",
    "measures[]<kind=file_paths>: {at?, exclude?, id, include, kind, lane?, repo, unit}",
    "measures[]<kind=json_length>.kind = json_length",
    "measures[]<kind=json_length>: {at?, file, id, kind, lane?, pointer, repo, unit}",
    "measures[]<kind=line_count>.kind = line_count",
    "measures[]<kind=line_count>: {at?, exclude?, id, include, kind, lane?, repo, unit}",
    "measures[]<kind=match_count>.kind = match_count",
    "measures[]<kind=match_count>.section.on_missing = null",
    "measures[]<kind=match_count>.section.on_missing = zero",
    "measures[]<kind=match_count>.section: {end?, on_missing, start}",
    "measures[]<kind=match_count>: {at?, exclude?, id, include, kind, lane?, pattern, repo, section?, unit}",
    "measures[]<kind=regex_capture>.kind = regex_capture",
    "measures[]<kind=regex_capture>.section.on_missing = null",
    "measures[]<kind=regex_capture>.section: {end?, on_missing, start}",
    "measures[]<kind=regex_capture>: {at?, file, group?, id, kind, lane?, pattern, repo, section?, unit}",
    "measures[]<kind=total>.kind = total",
    "measures[]<kind=total>: {id, kind, lane?, minus?, plus, unit}",
    "measures[]<kind=trail_count>.kind = trail_count",
    "measures[]<kind=trail_count>.of = decisions_all | decisions_live | tracks_open | tasks",
    "measures[]<kind=trail_count>.status = planned | in_progress | done | cancelled",
    "measures[]<kind=trail_count>: {id, kind, lane?, of, status?, unit}",
    "observe[]<kind=github_check>.kind = github_check",
    "observe[]<kind=github_check>: {branch?, check, key, kind, notes?, repo}",
    "observe[]<kind=github_ci>.kind = github_ci",
    "observe[]<kind=github_ci>: {branch?, key, kind, notes?, repo, workflow}",
    "observe[]<kind=github_open_issues>.kind = github_open_issues",
    "observe[]<kind=github_open_issues>: {key, kind, notes?, repo}",
    "observe[]<kind=github_open_prs>.kind = github_open_prs",
    "observe[]<kind=github_open_prs>: {key, kind, notes?, repo}",
    "observe[]<kind=github_release>.kind = github_release",
    "observe[]<kind=github_release>: {key, kind, notes?, repo}",
    "observe[]<kind=http>.kind = http",
    "observe[]<kind=http>: {capture_pattern?, count_pattern?, key, kind, notes?, url, words?}",
    "observe[]<kind=manual>.kind = manual",
    "observe[]<kind=manual>: {how, key, kind, notes?}",
    "observe[]<kind=npm_version>.kind = npm_version",
    "observe[]<kind=npm_version>: {key, kind, notes?, package}",
    "observe[]<kind=page_version>.kind = page_version",
    "observe[]<kind=page_version>: {key, kind, notes?, url}",
    "ratios[]: {denominator, id, label, numerator}",
    "stages.01: {look?, meaning, notes?}",
    "stages.02: {look?, meaning, notes?}",
    "stages.03: {look?, meaning, notes?}",
    "stages.04: {look?, meaning, notes?}",
    "stages.05: {look?, meaning, notes?}",
    "stages.06: {look?, meaning, notes?}",
    "stages: {01, 02, 03, 04, 05, 06}",
  ],
};

// What basou board record takes (board.md, 3).
const RECORD_INPUT_SHAPE: string[] = [
  "(top): {axis_review?, cells, judged_by, measure_digest, observed?, prose}",
  "axis_review.triggers[] = a | b | c | d | e",
  "axis_review: {summary, triggers}",
  "cells[].state = done | part | blocked | shelved | none | unverified",
  "cells[]: {lane, reason?, stage, state}",
  "judged_by.self_reported = true",
  "judged_by: {model, self_reported}",
  "observed.*: {error?, observed_at, source, value}",
  "prose.operator_turns[]: {source, text}",
  "prose: {footnotes?, lanes?, operator_turns?, summary}",
];
