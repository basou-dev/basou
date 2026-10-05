import { parseDocument } from "yaml";
import { z } from "zod";
import { TaskStatusSchema } from "../schemas/task.schema.js";

/**
 * The declaration file of a progress board (`board.yaml`): which lanes and
 * stages the board has, and what to measure for it. The board commands are
 * experimental (docs/spec/compatibility.md lists them), so this shape is not
 * a guaranteed surface and has no published JSON Schema. It still carries a
 * version that moves with every change of shape, so a record written under
 * one shape is never read as another.
 *
 * The file is user-written and is read strictly: an unknown key anywhere is
 * an error, so a typo is refused instead of silently ignored, and every
 * problem the reader can see is reported at once.
 */
export const BOARD_VERSION = 1;

/** The stage ids of every board. Their order is fixed; a board sets only their meanings. */
export const BOARD_STAGE_IDS = ["01", "02", "03", "04", "05", "06"] as const;

/** The flags every `pattern`, `start` and `end` of a declaration is compiled with. */
export const BOARD_REGEX_FLAGS = "u";

/** What `at` means when a measure omits it: the working tree, untracked files included. */
export const BOARD_DEFAULT_AT = "worktree";

/** The capture group a `regex_capture` measure takes when it omits `group`. */
export const BOARD_DEFAULT_CAPTURE_GROUP = 1;

const ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function hasControlCharacter(s: string): boolean {
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const nonEmptyText = z
  .string()
  .refine((s) => s.trim().length > 0, { error: "must be a non-empty string" });

const idText = z.string().regex(ID_PATTERN, {
  error: "must start with a lowercase letter and use only a-z, 0-9, '_' and '-'",
});

function isCalendarDate(s: string): boolean {
  const m = DATE_PATTERN.exec(s);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

const dateText = z
  .string()
  .refine(isCalendarDate, { error: "must be a calendar date written as YYYY-MM-DD" });

function isTimeZone(s: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s });
    return true;
  } catch {
    return false;
  }
}

const timeZoneText = z
  .string()
  .refine(isTimeZone, { error: "must be a time zone name such as Asia/Tokyo" });

// A path or glob inside a repository. It may not leave the repository, so an
// absolute path and a `..` segment are refused; a leading ':' would be read
// as git pathspec magic, which the measures do not take from the declaration.
const repoPath = z.string().superRefine((s, ctx) => {
  if (s.length === 0) {
    ctx.addIssue({ code: "custom", message: "must be a non-empty path" });
  } else if (hasControlCharacter(s)) {
    ctx.addIssue({ code: "custom", message: "must not contain control characters" });
  } else if (s.startsWith("/") || s.startsWith("\\") || /^[A-Za-z]:/.test(s)) {
    ctx.addIssue({ code: "custom", message: "must be relative to the repository" });
  } else if (s.split(/[/\\]/).includes("..")) {
    ctx.addIssue({ code: "custom", message: "must not contain a '..' segment" });
  } else if (s.startsWith(":")) {
    ctx.addIssue({ code: "custom", message: "must not start with ':' (pathspec magic)" });
  }
});

const regexText = z.string().superRefine((s, ctx) => {
  if (s.length === 0) {
    ctx.addIssue({ code: "custom", message: "must be a non-empty regular expression" });
    return;
  }
  try {
    new RegExp(s, BOARD_REGEX_FLAGS);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "invalid";
    ctx.addIssue({
      code: "custom",
      message: `is not a valid regular expression with the '${BOARD_REGEX_FLAGS}' flag (${reason})`,
    });
  }
});

// `worktree`, or a git revision. A leading '-' would reach git as an option,
// whitespace and ':' would split the `<rev>:<path>` the measures build.
const atText = z
  .string()
  .refine((s) => s.length > 0 && !/^-|[\s:]/.test(s) && !hasControlCharacter(s), {
    error: "must be 'worktree' or a git revision with no leading '-', whitespace or ':'",
  });

const jsonPointer = z
  .string()
  .refine((s) => s === "" || (s.startsWith("/") && !/~(?![01])/.test(s)), {
    error: "must be a JSON pointer (RFC 6901): empty, or '/' tokens with '~' only as '~0' or '~1'",
  });

const sectionSchema = z.strictObject({
  start: regexText,
  end: regexText.optional(),
  on_missing: z.union([z.literal("zero"), z.null()], { error: "must be zero or null" }),
});

// A string measure has no zero, so a missing section can only be "not measured".
const captureSectionSchema = z.strictObject({
  start: regexText,
  end: regexText.optional(),
  on_missing: z.null({ error: "must be null for regex_capture (a string has no zero)" }),
});

const measureCommon = {
  id: idText,
  unit: nonEmptyText,
  lane: idText.optional(),
};

const fileScope = {
  repo: nonEmptyText,
  at: atText.default(BOARD_DEFAULT_AT),
};

const globs = z.array(repoPath).min(1, { error: "must list at least one path" });

const fileCountSchema = z.strictObject({
  kind: z.literal("file_count"),
  ...measureCommon,
  ...fileScope,
  include: globs,
  exclude: globs.optional(),
});

const dirCountSchema = z.strictObject({
  kind: z.literal("dir_count"),
  ...measureCommon,
  ...fileScope,
  path: repoPath,
  depth: z.number().int().min(1),
  include: globs.optional(),
  exclude: globs.optional(),
});

const lineCountSchema = z.strictObject({
  kind: z.literal("line_count"),
  ...measureCommon,
  ...fileScope,
  include: globs,
  exclude: globs.optional(),
});

const matchCountSchema = z.strictObject({
  kind: z.literal("match_count"),
  ...measureCommon,
  ...fileScope,
  include: globs,
  exclude: globs.optional(),
  pattern: regexText,
  section: sectionSchema.optional(),
});

const regexCaptureSchema = z.strictObject({
  kind: z.literal("regex_capture"),
  ...measureCommon,
  ...fileScope,
  file: repoPath,
  pattern: regexText,
  group: z.number().int().min(0).default(BOARD_DEFAULT_CAPTURE_GROUP),
  section: captureSectionSchema.optional(),
});

const jsonLengthSchema = z.strictObject({
  kind: z.literal("json_length"),
  ...measureCommon,
  ...fileScope,
  file: repoPath,
  pointer: jsonPointer,
});

/** What a `trail_count` measure counts in the workspace's own trail. */
export const BOARD_TRAIL_COUNTS = [
  "decisions_all",
  "decisions_live",
  "tracks_open",
  "tasks",
] as const;

const trailCountSchema = z.strictObject({
  kind: z.literal("trail_count"),
  ...measureCommon,
  of: z.enum(BOARD_TRAIL_COUNTS),
  status: TaskStatusSchema.optional(),
});

const measureSchema = z.discriminatedUnion("kind", [
  fileCountSchema,
  dirCountSchema,
  lineCountSchema,
  matchCountSchema,
  regexCaptureSchema,
  jsonLengthSchema,
  trailCountSchema,
]);

const stageSchema = z.strictObject({ meaning: nonEmptyText });

const boardSchema = z.strictObject({
  board_version: z.literal(BOARD_VERSION),
  title: nonEmptyText,
  stages: z.strictObject({
    "01": stageSchema,
    "02": stageSchema,
    "03": stageSchema,
    "04": stageSchema,
    "05": stageSchema,
    "06": stageSchema,
  }),
  lanes: z
    .array(
      z.strictObject({
        id: idText,
        name: nonEmptyText,
        about: nonEmptyText.optional(),
        notes: z.array(nonEmptyText).optional(),
      }),
    )
    .min(1, { error: "must list at least one lane" }),
  measures: z.array(measureSchema).default([]),
  ratios: z
    .array(
      z.strictObject({
        id: idText,
        label: nonEmptyText,
        numerator: idText,
        denominator: idText,
      }),
    )
    .default([]),
  components: z
    .record(
      nonEmptyText,
      z.strictObject({
        lane: z.union(
          [
            z.literal("-"),
            z.array(idText).min(1, { error: "must list at least one lane id, or be '-'" }),
          ],
          {
            error: "must be '-' or a non-empty list of lane ids",
          },
        ),
        note: nonEmptyText.optional(),
      }),
    )
    .default({}),
  axis: z.strictObject({
    version: z.number().int().min(1),
    review_due_days: z.number().int().min(1),
    seed_review: z.strictObject({ date: dateText, model: nonEmptyText }).optional(),
  }),
  effort: z.strictObject({
    start: dateText,
    time_zone: timeZoneText.optional(),
    milestones: z
      .array(z.strictObject({ date: dateText, label: nonEmptyText, ref: nonEmptyText }))
      .optional(),
  }),
});

export type BoardDeclaration = z.output<typeof boardSchema>;
export type BoardMeasure = BoardDeclaration["measures"][number];
export type BoardMeasureKind = BoardMeasure["kind"];

/** What the reader needs from outside the file. */
export type BoardDeclarationContext = {
  /** The `path` of each entry of the manifest's `repos:`, as written there. */
  manifestRepoPaths: readonly string[];
};

export type BoardDeclarationResult =
  | { ok: true; declaration: BoardDeclaration }
  | { ok: false; errors: string[] };

/**
 * Parse and check the text of a `board.yaml`. Nothing is read from disk.
 *
 * An unknown `board_version` stops the reading at once, naming the version,
 * because the rest of the file may follow a shape this basou does not know.
 * Otherwise every problem found is returned together: the shape of each key,
 * and what one key says about another (a duplicate id, a lane or measure
 * that does not exist, a repo the manifest does not declare). Each error
 * starts with where it is, such as `measures[2].include[0]`.
 */
export function parseBoardDeclaration(
  text: string,
  context: BoardDeclarationContext,
): BoardDeclarationResult {
  const doc = parseDocument(text, { version: "1.2", uniqueKeys: true, prettyErrors: true });
  const yamlProblems = [...doc.errors, ...doc.warnings];
  if (yamlProblems.length > 0) {
    return {
      ok: false,
      errors: yamlProblems.map((p) => `not valid YAML: ${p.message.split("\n")[0]}`),
    };
  }
  let raw: unknown;
  try {
    raw = doc.toJS({ maxAliasCount: 100 });
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : "unreadable";
    return { ok: false, errors: [`not valid YAML: ${reason}`] };
  }
  if (!isRecord(raw)) {
    return { ok: false, errors: ["(top level): must be a mapping of keys to values"] };
  }
  const version = raw.board_version;
  if (typeof version === "number" && version !== BOARD_VERSION) {
    return {
      ok: false,
      errors: [`board_version: this basou reads board_version ${BOARD_VERSION}, not ${version}`],
    };
  }

  const errors: string[] = [];
  const parsed = boardSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors.push(formatIssue(issue));
  }
  errors.push(...crossCheck(raw, context));
  if (errors.length > 0 || !parsed.success) return { ok: false, errors };
  return { ok: true, declaration: parsed.data };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "(top level)";
  let out = "";
  for (const key of path) {
    if (typeof key === "number") out += `[${key}]`;
    else if (/^[A-Za-z0-9_-]+$/.test(String(key)))
      out += out === "" ? String(key) : `.${String(key)}`;
    else out += `[${JSON.stringify(String(key))}]`;
  }
  return out;
}

type Issue = z.ZodError["issues"][number];

function formatIssue(issue: Issue): string {
  if (issue.code === "unrecognized_keys") {
    const keys = issue.keys.map((k) => `'${k}'`).join(", ");
    return `${formatPath(issue.path)}: unknown key${issue.keys.length > 1 ? "s" : ""} ${keys}`;
  }
  return `${formatPath(issue.path)}: ${issue.message}`;
}

// Read a list from the raw document, keeping each entry's index.
function entries(raw: Record<string, unknown>, key: string): [number, Record<string, unknown>][] {
  const list = raw[key];
  if (!Array.isArray(list)) return [];
  const out: [number, Record<string, unknown>][] = [];
  list.forEach((entry, i) => {
    if (isRecord(entry)) out.push([i, entry]);
  });
  return out;
}

function stringAt(entry: Record<string, unknown>, key: string): string | undefined {
  const value = entry[key];
  return typeof value === "string" ? value : undefined;
}

// How many capturing groups a pattern has, or undefined when it does not compile.
function captureGroups(pattern: string): number | undefined {
  try {
    const match = new RegExp(`${pattern}|`, BOARD_REGEX_FLAGS).exec("");
    return match === null ? undefined : match.length - 1;
  } catch {
    return undefined;
  }
}

// What one key says about another. Run on the raw document, so these are
// reported even when the shape check found problems elsewhere; a value of the
// wrong type is skipped here because the shape check already reports it.
function crossCheck(raw: Record<string, unknown>, context: BoardDeclarationContext): string[] {
  const errors: string[] = [];

  const stages = raw.stages;
  if (isRecord(stages) && Object.keys(stages).some((k) => /^[1-6]$/.test(k))) {
    errors.push(
      'stages: write the stage ids in quotes ("01" to "06"); unquoted, 01 is read as the number 1',
    );
  }

  const firstSeen = (key: string, what: string): Set<string> => {
    const seen = new Map<string, number>();
    for (const [i, entry] of entries(raw, key)) {
      const id = stringAt(entry, "id");
      if (id === undefined) continue;
      const first = seen.get(id);
      if (first === undefined) seen.set(id, i);
      else errors.push(`${key}[${i}].id: duplicate ${what} id '${id}' (first at ${key}[${first}])`);
    }
    return new Set(seen.keys());
  };
  const laneIds = firstSeen("lanes", "lane");
  const measureIds = firstSeen("measures", "measure");
  firstSeen("ratios", "ratio");

  const repoPaths = new Set(context.manifestRepoPaths);
  const declared =
    context.manifestRepoPaths.length === 0
      ? "the manifest declares no repos"
      : `the manifest declares ${context.manifestRepoPaths.map((p) => `'${p}'`).join(", ")}`;
  const measureKinds = new Map<string, unknown>();
  for (const [i, measure] of entries(raw, "measures")) {
    const at = `measures[${i}]`;
    const id = stringAt(measure, "id");
    if (id !== undefined && !measureKinds.has(id)) measureKinds.set(id, measure.kind);
    const repo = stringAt(measure, "repo");
    if (repo !== undefined && !repoPaths.has(repo)) {
      errors.push(`${at}.repo: '${repo}' is not a repo path in the manifest (${declared})`);
    }
    const lane = stringAt(measure, "lane");
    if (lane !== undefined && !laneIds.has(lane)) {
      errors.push(`${at}.lane: no lane has the id '${lane}'`);
    }
    if (measure.kind === "regex_capture") {
      const pattern = stringAt(measure, "pattern");
      const group = measure.group ?? BOARD_DEFAULT_CAPTURE_GROUP;
      const groups = pattern === undefined ? undefined : captureGroups(pattern);
      if (typeof group === "number" && groups !== undefined && group > groups) {
        errors.push(
          `${at}.group: the pattern has ${groups} capturing group${groups === 1 ? "" : "s"}, so group ${group} does not exist`,
        );
      }
    }
    if (measure.kind === "trail_count" && measure.status !== undefined && measure.of !== "tasks") {
      errors.push(`${at}.status: only a trail_count of 'tasks' takes a status`);
    }
  }

  for (const [i, ratio] of entries(raw, "ratios")) {
    for (const side of ["numerator", "denominator"] as const) {
      const ref = stringAt(ratio, side);
      if (ref === undefined) continue;
      if (!measureIds.has(ref)) {
        errors.push(`ratios[${i}].${side}: no measure has the id '${ref}'`);
      } else if (measureKinds.get(ref) === "regex_capture") {
        errors.push(`ratios[${i}].${side}: '${ref}' is a regex_capture, which is not a number`);
      }
    }
  }

  const components = raw.components;
  if (isRecord(components)) {
    for (const [key, component] of Object.entries(components)) {
      if (!isRecord(component)) continue;
      const at = formatPath(["components", key]);
      if (component.lane === "-" && component.note === undefined) {
        errors.push(`${at}.note: a component with lane '-' needs a note saying why`);
      }
      if (Array.isArray(component.lane)) {
        const seen = new Set<string>();
        component.lane.forEach((lane, j) => {
          if (typeof lane !== "string") return;
          if (seen.has(lane)) errors.push(`${at}.lane[${j}]: '${lane}' is listed twice`);
          else if (!laneIds.has(lane))
            errors.push(`${at}.lane[${j}]: no lane has the id '${lane}'`);
          seen.add(lane);
        });
      }
    }
  }

  return errors;
}
