import { isNode, isScalar, LineCounter, parseDocument, visit } from "yaml";
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
 *
 * Every version ever written is read: 1; 2, which adds what to observe
 * outside basou (`observe`) and what to look at when judging a stage
 * (`stages.<id>.look` and `.notes`); and 3, which adds the response to an
 * HTTP GET (`http`) and a check run by its name (`github_check`) as
 * observations, what to mind when making any observation (`notes`), the
 * name of a file (`file_name`), the paths of files (`file_paths`) and a sum
 * of integers and other measures (`total`) as measures, a measure drawn in
 * more than one lane (`lane` as a list), and a measure id and an observation
 * key of words joined by '.'.
 */
export const BOARD_VERSION = 3;

/** The board versions this basou reads. A version is added here, never removed. */
export const BOARD_VERSIONS = [1, 2, 3] as const;

/** The stage ids of every board. Their order is fixed; a board sets only their meanings. */
export const BOARD_STAGE_IDS = ["01", "02", "03", "04", "05", "06"] as const;

/** The flags every `pattern`, `start` and `end` of a declaration is compiled with. */
export const BOARD_REGEX_FLAGS = "u";

/** What `at` means when a measure omits it: the working tree, untracked files included. */
export const BOARD_DEFAULT_AT = "worktree";

/**
 * The capture group a `regex_capture` measure, or a `file_name` measure with
 * a `pattern`, takes when it omits `group`.
 */
export const BOARD_DEFAULT_CAPTURE_GROUP = 1;

const ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
// From version 3, a measure's id, and an observation's key, may be words of
// that shape joined by '.'. Not ':' or '/': the guide names working files by
// a key.
const DOTTED_ID_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// The C0 controls, DEL and the C1 controls.
function hasControlCharacter(s: string): boolean {
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

const nonEmptyText = z
  .string()
  .refine((s) => s.trim().length > 0, { error: "must be a non-empty string" });

const idText = z.string().regex(ID_PATTERN, {
  error: "must start with a lowercase letter and use only a-z, 0-9, '_' and '-'",
});

const DOTTED_ID_ERROR =
  "must start with a lowercase letter and use only a-z, 0-9, '_', '-' and '.', with a lowercase letter after each '.'";

const dottedIdText = z.string().regex(DOTTED_ID_PATTERN, { error: DOTTED_ID_ERROR });

/** Whether a text is a date of the calendar written as YYYY-MM-DD. */
export function isCalendarDate(s: string): boolean {
  const m = DATE_PATTERN.exec(s);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // setUTCFullYear, because Date.UTC reads the years 0 to 99 as 1900 to 1999.
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

const dateText = z
  .string()
  .refine(isCalendarDate, { error: "must be a calendar date written as YYYY-MM-DD" });

/**
 * Whether a board can declare a time zone: a name from the time zone
 * database. An offset such as +09:00 is refused although some Node versions
 * accept one, so a declaration reads the same on every version.
 */
export function isBoardTimeZone(s: string): boolean {
  if (/^[+-]\d/.test(s)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s });
    return true;
  } catch {
    return false;
  }
}

const timeZoneText = z.string().refine(isBoardTimeZone, {
  error: "must be a time zone name such as Asia/Tokyo, not an offset such as +09:00",
});

// A path or glob inside a repository. It may not leave the repository, so an
// absolute path and a `..` segment are refused; a leading ':' would be read
// as git pathspec magic, which the measures do not take from the declaration.
// Why a path or glob would leave the repository, or undefined.
function repoPathProblem(s: string): string | undefined {
  if (s.length === 0) return "must be a non-empty path";
  if (hasControlCharacter(s)) return "must not contain control characters";
  if (s.startsWith("/") || s.startsWith("\\")) return "must be relative to the repository";
  if (/^[A-Za-z]:/.test(s)) {
    return "must be relative to the repository (a leading 'x:' reads as a Windows drive)";
  }
  if (s.split(/[/\\]/).includes("..")) return "must not contain a '..' segment";
  if (s.startsWith(":")) return "must not start with ':' (pathspec magic)";
  return undefined;
}

const repoPath = z.string().superRefine((s, ctx) => {
  const problem = repoPathProblem(s);
  if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
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

// A measure's lane is read as a list, of one in a board of version 1 or 2,
// so a record holds the lanes of a measure in one shape whatever the version.
const measureCommon = {
  id: idText,
  unit: nonEmptyText,
  lane: idText.transform((lane) => [lane]).optional(),
};

// From version 3, a measure's id may hold '.', and it may be drawn in more
// than one lane: `lane` is one lane id or a list of them.
const measureCommonV3 = {
  id: dottedIdText,
  unit: nonEmptyText,
  lane: z
    .union([idText, z.array(idText).min(1, { error: "must list at least one lane id" })], {
      error: "must be a lane id or a non-empty list of lane ids",
    })
    .transform((lane) => (typeof lane === "string" ? [lane] : lane))
    .optional(),
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

// A dir_count's directory is a path, not a pattern: a wildcard would name
// several directories, and the count would silently use only its fixed part.
const directoryPath = z.string().superRefine((s, ctx) => {
  const problem =
    repoPathProblem(s) ??
    (/[*?[\\]/.test(s) ? "must be a directory path, without '*', '?', '[' or '\\'" : undefined);
  if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
});

const dirCountSchema = z.strictObject({
  kind: z.literal("dir_count"),
  ...measureCommon,
  ...fileScope,
  path: directoryPath,
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

/** Which file a `file_name` measure picks: the first or the last path, in byte order. */
export const BOARD_FILE_NAME_PICKS = ["first", "last"] as const;

/**
 * How many paths a `file_paths` measure holds; one that matches more is not
 * measured. Fixed with board_version 3: a measure has no method version, so
 * changing it would turn the same repository's value between null and a list
 * unseen.
 */
export const BOARD_FILE_PATHS_MAX = 1000;

// The name of the first or last file the patterns match, or what a group of
// `pattern` holds in it. `group` is filled in only when there is a pattern
// (see parseAs), and refused without one (see crossCheck).
const fileNameSchema = z.strictObject({
  kind: z.literal("file_name"),
  ...measureCommon,
  ...fileScope,
  include: globs,
  exclude: globs.optional(),
  pick: z.enum(BOARD_FILE_NAME_PICKS, { error: "must be first or last" }),
  pattern: regexText.optional(),
  group: z.number().int().min(0).optional(),
});

// The paths of the files the patterns match.
const filePathsSchema = z.strictObject({
  kind: z.literal("file_paths"),
  ...measureCommon,
  ...fileScope,
  include: globs,
  exclude: globs.optional(),
});

// A term of a total: an integer written in the declaration, or the id of a
// measure whose value is one.
const totalTerm = z
  .union([z.number(), z.string()], { error: "must be an integer or the id of a measure" })
  .superRefine((term, ctx) => {
    const problem =
      typeof term === "number"
        ? Number.isSafeInteger(term)
          ? undefined
          : "must be an integer"
        : DOTTED_ID_PATTERN.test(term)
          ? undefined
          : "must be an integer or the id of a measure, which starts with a lowercase letter and uses only a-z, 0-9, '_', '-' and '.', with a lowercase letter after each '.'";
    if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
  });

const totalTerms = z.array(totalTerm).min(1, {
  error: "must list at least one integer or measure id",
});

// What `plus` adds up less what `minus` adds up. A term may not be a total
// (see crossCheck), so totals are never chained and have no order to find.
const totalSchema = z.strictObject({
  kind: z.literal("total"),
  ...measureCommonV3,
  plus: totalTerms,
  minus: totalTerms.optional(),
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

const measureSchemaV1 = z.discriminatedUnion("kind", [
  fileCountSchema,
  dirCountSchema,
  lineCountSchema,
  matchCountSchema,
  regexCaptureSchema,
  jsonLengthSchema,
  trailCountSchema,
]);

// From version 3, a measure may take the name of a file, the paths of files
// or a total, and every measure takes the id and the lanes of version 3.
const measureSchemaV3 = z.discriminatedUnion("kind", [
  fileCountSchema.extend(measureCommonV3),
  dirCountSchema.extend(measureCommonV3),
  lineCountSchema.extend(measureCommonV3),
  matchCountSchema.extend(measureCommonV3),
  regexCaptureSchema.extend(measureCommonV3),
  jsonLengthSchema.extend(measureCommonV3),
  fileNameSchema.extend(measureCommonV3),
  filePathsSchema.extend(measureCommonV3),
  trailCountSchema.extend(measureCommonV3),
  totalSchema,
]);

/**
 * What a board can declare to observe outside basou. basou never makes these
 * observations (it sends nothing): the judge makes each and records what it
 * found under the same key.
 */
export const BOARD_OBSERVE_KINDS = [
  "npm_version",
  "github_release",
  "github_open_issues",
  "github_open_prs",
  "github_ci",
  "github_check",
  "page_version",
  "http",
  "manual",
] as const;

/** The branch a `github_ci` or `github_check` observation looks at when it names none. */
export const BOARD_DEFAULT_CI_BRANCH = "main";

/** How many characters a `github_check` observation's check name may have. */
export const BOARD_CHECK_NAME_MAX = 255;

/** How many redirects an `http` observation follows; one that needs more is not made. */
export const BOARD_HTTP_MAX_REDIRECTS = 10;

/**
 * The flags an `http` observation's `count_pattern` is matched with: every
 * match in the whole body, with no `m`, so `^` and `$` are the body's start
 * and end. A measure's `pattern` is matched line by line instead.
 */
export const BOARD_HTTP_COUNT_FLAGS = "gu";

/** The flags an `http` observation's `capture_pattern` is matched with: the first match in the whole body. */
export const BOARD_HTTP_CAPTURE_FLAGS = "u";

// The values of an observation are put into the commands a judge runs, each
// as one single-quoted shell word. Each is held to a shape that, quoted so,
// cannot end its quotation (no "'") or, where a command takes it as an
// argument, start an option (no leading '-'). A manual observation's `how` is
// words for a person, never a word of a command.

// An npm package name, scoped or not, in lowercase.
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const npmPackage = z.string().refine((s) => s.length <= 214 && NPM_PACKAGE.test(s), {
  error: "must be an npm package name such as name or @scope/name, in lowercase",
});

// A GitHub repository as owner/name.
// An owner may hold '_' (a managed user's handle does).
const GITHUB_REPO = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/[A-Za-z0-9._-]{1,100}$/;
const githubRepo = z.string().refine((s) => GITHUB_REPO.test(s) && !/\/\.{1,2}$/.test(s), {
  error: "must be a GitHub repository written as owner/name",
});

// The file name of a workflow, as gh run list --workflow takes it.
const workflowFile = z
  .string()
  .refine((s) => s.length <= 255 && /^[A-Za-z0-9_][A-Za-z0-9._-]*\.ya?ml$/.test(s), {
    error: "must be the file name of a workflow, such as quality.yml",
  });

// A branch name without what a shell or git would read as something else. No
// part of it starts with '.': git takes no such branch, and GitHub reads
// `a/./b` in a path as `a/b`, another branch.
const branchName = z
  .string()
  .refine(
    (s) =>
      /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(s) &&
      !s.includes("..") &&
      !s.includes("//") &&
      !s.includes("/.") &&
      !/[/.]$/.test(s),
    {
      error: "must be a branch name such as main, using only A-Z, a-z, 0-9, '.', '_', '-' and '/'",
    },
  );

// Why a text is not an https:// URL a command can be given as it is, or undefined.
function httpsUrlProblem(s: string): string | undefined {
  if (!/^[\x21-\x7e]+$/.test(s)) return "must be printable ASCII with no spaces";
  if (/['"`\\<>]/.test(s)) return "must not contain quotes, backslashes, '<' or '>'";
  if (!s.startsWith("https://")) return "must be an https:// URL";
  // As written, not as the URL parser reads it: the parser drops a slash too
  // many and an empty user name, but the text is what a command is given.
  const authority = s.slice("https://".length).split(/[/?#]/)[0] ?? "";
  if (authority === "") return "must name a host";
  if (authority.includes("@")) return "must not carry a user name or a password";
  try {
    new URL(s);
  } catch {
    return "must be an https:// URL";
  }
  return undefined;
}

const httpsUrl = z.string().superRefine((s, ctx) => {
  const problem = httpsUrlProblem(s);
  if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
});

// Why a text cannot be given to a command as one argument, or undefined. It
// reaches the command after `--`, so it is never read as an option; a
// leading '-' is refused all the same, as for every value a command takes.
function argumentProblem(s: string, quoteHint = ""): string | undefined {
  if (s.length === 0) return "must be a non-empty string";
  if (hasControlCharacter(s)) return "must not contain control characters";
  if (s.startsWith("-")) return "must not start with '-'";
  if (s.includes("'")) return `must not contain "'"${quoteHint}`;
  return undefined;
}

// A word an `http` observation looks for in the body, as it is written.
const httpWord = z.string().superRefine((s, ctx) => {
  const problem = argumentProblem(s);
  if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
});

// Whether a pattern matches the empty string.
function matchesEmpty(pattern: string): boolean {
  try {
    return new RegExp(pattern, BOARD_HTTP_COUNT_FLAGS).test("");
  } catch {
    return false;
  }
}

// A pattern an `http` observation matches against the whole body, with the
// flags given. "'" is refused as in every value of a command; a pattern can
// match one as \x27.
const httpPattern = (flags: string, check: (s: string) => string | undefined) =>
  z.string().superRefine((s, ctx) => {
    let problem = argumentProblem(s, " (match one as \\x27)");
    if (problem === undefined) {
      try {
        new RegExp(s, flags);
        problem = check(s);
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : "invalid";
        problem = `is not a valid regular expression with the '${flags}' flags (${reason})`;
      }
    }
    if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
  });

const countPattern = httpPattern(BOARD_HTTP_COUNT_FLAGS, (s) =>
  matchesEmpty(s) ? "must not match the empty string: each match is counted" : undefined,
);

const capturePattern = httpPattern(BOARD_HTTP_CAPTURE_FLAGS, (s) =>
  (captureGroups(s) ?? 0) === 0
    ? "must have a capturing group: the value is what the first one holds"
    : undefined,
);

// The name of a check run, as the API takes it: it may hold spaces and ':'.
const checkName = z.string().superRefine((s, ctx) => {
  const problem =
    argumentProblem(s) ??
    ([...s].length > BOARD_CHECK_NAME_MAX
      ? `must be at most ${BOARD_CHECK_NAME_MAX} characters`
      : undefined);
  if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
});

const npmVersionObserve = z.strictObject({
  key: idText,
  kind: z.literal("npm_version"),
  package: npmPackage,
});
const githubReleaseObserve = z.strictObject({
  key: idText,
  kind: z.literal("github_release"),
  repo: githubRepo,
});
const githubOpenIssuesObserve = z.strictObject({
  key: idText,
  kind: z.literal("github_open_issues"),
  repo: githubRepo,
});
const githubOpenPrsObserve = z.strictObject({
  key: idText,
  kind: z.literal("github_open_prs"),
  repo: githubRepo,
});
const githubCiObserve = z.strictObject({
  key: idText,
  kind: z.literal("github_ci"),
  repo: githubRepo,
  workflow: workflowFile,
  branch: branchName.default(BOARD_DEFAULT_CI_BRANCH),
});
const pageVersionObserve = z.strictObject({
  key: idText,
  kind: z.literal("page_version"),
  url: httpsUrl,
});

const manualObserve = z.strictObject({ key: idText, kind: z.literal("manual"), how: nonEmptyText });

// The latest check run of that name on the head commit of the branch.
const githubCheckObserve = z.strictObject({
  key: idText,
  kind: z.literal("github_check"),
  repo: githubRepo,
  check: checkName,
  branch: branchName.default(BOARD_DEFAULT_CI_BRANCH),
});

// GET only: a HEAD is answered differently by many servers, and is another command.
const httpObserve = z.strictObject({
  key: idText,
  kind: z.literal("http"),
  url: httpsUrl,
  words: z.array(httpWord).min(1, { error: "must list at least one word" }).optional(),
  count_pattern: countPattern.optional(),
  capture_pattern: capturePattern.optional(),
});

const observeSchemaV2 = z.discriminatedUnion("kind", [
  npmVersionObserve,
  githubReleaseObserve,
  githubOpenIssuesObserve,
  githubOpenPrsObserve,
  githubCiObserve,
  pageVersionObserve,
  manualObserve,
]);

// From version 3, every observation may say what to mind when making it, in
// the shape of a stage's or a lane's `notes`, and its key may hold '.'.
const observeV3 = { key: dottedIdText, notes: z.array(nonEmptyText).optional() };

const observeSchemaV3 = z.discriminatedUnion("kind", [
  npmVersionObserve.extend(observeV3),
  githubReleaseObserve.extend(observeV3),
  githubOpenIssuesObserve.extend(observeV3),
  githubOpenPrsObserve.extend(observeV3),
  githubCiObserve.extend(observeV3),
  githubCheckObserve.extend(observeV3),
  pageVersionObserve.extend(observeV3),
  httpObserve.extend(observeV3),
  manualObserve.extend(observeV3),
]);

const stageSchemaV1 = z.strictObject({ meaning: nonEmptyText });

const stageSchemaV2 = z.strictObject({
  meaning: nonEmptyText,
  look: z.array(nonEmptyText).optional(),
  notes: z.array(nonEmptyText).optional(),
});

const stagesOf = <S extends z.ZodType>(stage: S) =>
  z.strictObject({ "01": stage, "02": stage, "03": stage, "04": stage, "05": stage, "06": stage });

// The versions this basou reads, as a sentence says them: "1, 2 or 3".
const READ_VERSIONS = `${BOARD_VERSIONS.slice(0, -1).join(", ")} or ${BOARD_VERSIONS.at(-1)}`;

const boardVersionText = z.literal(BOARD_VERSIONS, {
  error: `must be a board version this basou reads (${READ_VERSIONS})`,
});

// The keys every version has after its stages, in the order a problem with
// them is reported, with the measures the version reads and the id a ratio
// names a measure by.
const boardFieldsOf = <M extends z.ZodType>(measure: M, measureRef: z.ZodString) => ({
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
  measures: z.array(measure).default([]),
  ratios: z
    .array(
      z.strictObject({
        id: idText,
        label: nonEmptyText,
        numerator: measureRef,
        denominator: measureRef,
      }),
    )
    .default([]),
  components: z
    .record(
      // An empty key is reported by the cross-check, which can say what it is.
      z.string(),
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

const boardSchemaV1 = z.strictObject({
  board_version: boardVersionText,
  title: nonEmptyText,
  stages: stagesOf(stageSchemaV1),
  ...boardFieldsOf(measureSchemaV1, idText),
});

const boardSchemaV2 = z.strictObject({
  board_version: boardVersionText,
  title: nonEmptyText,
  stages: stagesOf(stageSchemaV2),
  ...boardFieldsOf(measureSchemaV1, idText),
  observe: z.array(observeSchemaV2).default([]),
});

const boardSchemaV3 = z.strictObject({
  board_version: boardVersionText,
  title: nonEmptyText,
  stages: stagesOf(stageSchemaV2),
  ...boardFieldsOf(measureSchemaV3, dottedIdText),
  observe: z.array(observeSchemaV3).default([]),
});

/**
 * A declaration as read, whatever its version: one of version 1 has no
 * observations and no stage has `look` or `notes`, and one of version 1 or 2
 * has no `http` or `github_check` observation, no observation with `notes`,
 * no `file_name`, `file_paths` or `total` measure, no measure of more than
 * one lane, and no measure id or observation key with '.'. A measure's
 * `lane` is a list whatever the version.
 */
export type BoardDeclaration = z.output<typeof boardSchemaV3>;
export type BoardMeasure = BoardDeclaration["measures"][number];
export type BoardMeasureKind = BoardMeasure["kind"];
/** One entry of `observe`: what to observe outside basou, and the key it is recorded under. */
export type BoardObserve = BoardDeclaration["observe"][number];
export type BoardObserveKind = BoardObserve["kind"];

/**
 * The declaration a board was measured by, as parsed (its defaults filled
 * in), without `board_version`, which the measurement holds itself. A record
 * keeps it, and a measurement's digest covers it, so a record keeps the
 * declaration its judgement saw.
 */
export type BoardDeclarationSnapshot = Omit<BoardDeclaration, "board_version">;

/** The snapshot of a declaration: every key but `board_version`. */
export function boardDeclarationSnapshot(d: BoardDeclaration): BoardDeclarationSnapshot {
  return {
    title: d.title,
    stages: d.stages,
    lanes: d.lanes,
    measures: d.measures,
    ratios: d.ratios,
    components: d.components,
    axis: d.axis,
    effort: d.effort,
    observe: d.observe,
  };
}

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
 * The text is read as YAML 1.2 only. A problem in the YAML itself (a syntax
 * error, a duplicate key, a tag it cannot resolve, a `%YAML` directive for
 * another version, a key that is not a string) stops the reading, and each
 * such error starts with `not valid YAML:` and gives the line and column when
 * the parser knows them.
 *
 * An unknown `board_version` stops the reading at once, naming the version,
 * because the rest of the file may follow a shape this basou does not know.
 * Otherwise every problem found is returned together: the shape of each key,
 * and what one key says about another (a duplicate id, a lane or measure
 * that does not exist, a repo the manifest does not declare). Each of these
 * starts with where it is, such as `measures[2].include[0]`.
 */
export function parseBoardDeclaration(
  text: string,
  context: BoardDeclarationContext,
): BoardDeclarationResult {
  const lineCounter = new LineCounter();
  // logLevel "error": the parser would otherwise print its warnings to stderr.
  const doc = parseDocument(text, {
    version: "1.2",
    uniqueKeys: true,
    prettyErrors: true,
    logLevel: "error",
    lineCounter,
  });
  if (doc.errors.length > 0) {
    return { ok: false, errors: doc.errors.map((e) => `not valid YAML: ${firstLine(e.message)}`) };
  }
  // A directive overrides the version passed in, and YAML 1.1 reads dates,
  // yes/no and 010 differently, so only 1.2 is taken.
  if (doc.directives?.yaml.version !== "1.2") {
    return {
      ok: false,
      errors: [
        `not valid YAML: a board is read as YAML 1.2; remove the %YAML ${doc.directives?.yaml.version} directive`,
      ],
    };
  }
  let raw: unknown;
  try {
    raw = doc.toJS({ maxAliasCount: 100 });
  } catch (error: unknown) {
    return {
      ok: false,
      errors: [
        `not valid YAML: ${error instanceof Error ? firstLine(error.message) : "unreadable"}`,
      ],
    };
  }
  if (!isRecord(raw)) {
    return { ok: false, errors: ["(top level): must be a mapping of keys to values"] };
  }
  // Before the warnings and the keys: a file in a newer shape may use what
  // this basou does not know, and the version is what it should be told.
  const version = raw.board_version;
  if (typeof version === "number" && !(BOARD_VERSIONS as readonly number[]).includes(version)) {
    return {
      ok: false,
      errors: [`board_version: this basou reads board_version ${READ_VERSIONS}, not ${version}`],
    };
  }
  const yamlErrors = [
    ...doc.warnings.map((w) => `not valid YAML: ${firstLine(w.message)}`),
    ...nonStringKeys(doc, text, lineCounter),
  ];
  if (yamlErrors.length > 0) return { ok: false, errors: yamlErrors };

  const errors: string[] = [];
  // A file with no version, or one that is not a number, is held to the
  // newest shape.
  const parsed = parseAs(version, raw);
  if (!parsed.ok) {
    errors.push(
      ...(version === BOARD_VERSION || typeof version !== "number"
        ? parsed.issues.map(formatIssue)
        : formatOlderIssues(raw, version, parsed.issues)),
    );
  }
  errors.push(...crossCheck(raw, context));
  if (errors.length > 0 || !parsed.ok) return { ok: false, errors };
  return { ok: true, declaration: parsed.declaration };
}

// The schema of each version this basou reads.
function schemaOf(version: number) {
  return version === 1 ? boardSchemaV1 : version === 2 ? boardSchemaV2 : boardSchemaV3;
}

function parseAs(
  version: unknown,
  raw: unknown,
): { ok: true; declaration: BoardDeclaration } | { ok: false; issues: Issue[] } {
  if (version === 1) {
    const parsed = boardSchemaV1.safeParse(raw);
    return parsed.success
      ? { ok: true, declaration: { ...parsed.data, observe: [] } }
      : { ok: false, issues: parsed.error.issues };
  }
  const parsed = (version === 2 ? boardSchemaV2 : boardSchemaV3).safeParse(raw);
  return parsed.success
    ? { ok: true, declaration: { ...parsed.data, measures: parsed.data.measures.map(withGroup) } }
    : { ok: false, issues: parsed.error.issues };
}

// A file_name measure with a pattern takes group 1 when it names none; one
// without a pattern has no group, so its snapshot holds none.
function withGroup(measure: BoardMeasure): BoardMeasure {
  return measure.kind === "file_name" &&
    measure.pattern !== undefined &&
    measure.group === undefined
    ? { ...measure, group: BOARD_DEFAULT_CAPTURE_GROUP }
    : measure;
}

// The problems of a file of an older version, where a later version reads
// what is written told apart from what no version reads: a key, a kind, a
// value of a form a later version takes. Each is put down to the first
// version that reads that part of the file as it is written, with no problem
// at it, inside it or around it. A key no version reads so is put down to
// the first version that takes the key, whatever is wrong inside it, or to a
// later one when what is wrong inside it is what a later version reads (a
// kind of version 3 under a key of version 2).
function formatOlderIssues(raw: unknown, version: number, issues: readonly Issue[]): string[] {
  const later = BOARD_VERSIONS.filter((v) => v > version).map((v) => ({
    version: v,
    issues: schemaOf(v).safeParse(raw).error?.issues ?? [],
  }));
  const readsAsWritten = (path: readonly PropertyKey[], after = version): number | undefined =>
    later.find(
      (l) =>
        l.version > after &&
        !l.issues.some((issue) => issuePaths(issue).some((p) => related(p, path))),
    )?.version;
  const takesKey = (path: readonly PropertyKey[], after = version): number | undefined =>
    later.find(
      (l) =>
        l.version > after &&
        !l.issues.some((issue) =>
          issuePaths(issue).some(
            (p) =>
              (p.length < path.length ||
                (p.length === path.length && issue.code === "unrecognized_keys")) &&
              related(p, path),
          ),
        ),
    )?.version;
  const keyFrom = (path: readonly PropertyKey[]): number | undefined => {
    const taken = takesKey(path);
    if (taken === undefined) return undefined;
    let from = taken;
    for (const issue of later.find((l) => l.version === taken)?.issues ?? []) {
      for (const p of issuePaths(issue)) {
        if (p.length <= path.length || !related(p, path)) continue;
        const inside =
          readsAsWritten(p, taken) ??
          (issue.code === "unrecognized_keys" ? takesKey(p, taken) : undefined);
        if (inside !== undefined && inside > from) from = inside;
      }
    }
    return from;
  };
  const readFrom = (path: readonly PropertyKey[], isKey: boolean): number | undefined =>
    readsAsWritten(path) ?? (isKey ? keyFrom(path) : undefined);
  const readFromLine = (path: readonly PropertyKey[], what: string, from: number) =>
    `${formatPath(path)}: ${what} read from board_version ${from} on; this file is board_version ${version}`;
  const out: string[] = [];
  for (const issue of issues) {
    if (issue.code !== "unrecognized_keys") {
      const from = readFrom(issue.path, false);
      out.push(
        from === undefined
          ? formatIssue(issue)
          : readFromLine(issue.path, `${writtenValue(valueAt(raw, issue.path))} is`, from),
      );
      continue;
    }
    const others: string[] = [];
    const byVersion = new Map<number, string[]>();
    for (const key of issue.keys) {
      const from = readFrom([...issue.path, key], true);
      if (from === undefined) others.push(key);
      else byVersion.set(from, [...(byVersion.get(from) ?? []), key]);
    }
    if (others.length > 0) out.push(formatIssue({ ...issue, keys: others }));
    for (const [from, keys] of [...byVersion].sort(([a], [b]) => a - b)) {
      const named = keys.map((k) => `'${k}'`).join(", ");
      out.push(readFromLine(issue.path, `${named} ${keys.length === 1 ? "is" : "are"}`, from));
    }
  }
  return out;
}

// The parts of the file an issue is about: the key itself, for a key no
// shape takes.
function issuePaths(issue: Issue): (readonly PropertyKey[])[] {
  return issue.code === "unrecognized_keys"
    ? issue.keys.map((k) => [...issue.path, k])
    : [issue.path];
}

// Whether one path is the other or holds it.
function related(a: readonly PropertyKey[], b: readonly PropertyKey[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

function valueAt(raw: unknown, path: readonly PropertyKey[]): unknown {
  let value = raw;
  for (const key of path) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) {
      return undefined;
    }
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value;
}

// A value as a problem names it: a short plain one as it is written.
function writtenValue(value: unknown): string {
  return typeof value === "string" && /^[\x21-\x26\x28-\x7e]{1,40}$/.test(value)
    ? `'${value}'`
    : "what is written here";
}

// The first line of a parser message, without the ':' that introduces the
// excerpt prettyErrors appends.
function firstLine(message: string): string {
  return (message.split("\n")[0] ?? "").replace(/:\s*$/, "");
}

// Every mapping key that is not a string. The parser would turn it into one
// (01 into "1", a list into "[ a, b ]") and the declaration would then name
// something else than what was written.
function nonStringKeys(
  doc: ReturnType<typeof parseDocument>,
  text: string,
  lineCounter: LineCounter,
): string[] {
  const errors: string[] = [];
  visit(doc, {
    Pair(_, pair) {
      const key = pair.key;
      if (isScalar(key) && typeof key.value === "string") return;
      const range = isNode(key) ? key.range : undefined;
      let where = "";
      let written = "";
      if (range) {
        const pos = lineCounter.linePos(range[0]);
        where = ` at line ${pos.line}, column ${pos.col}`;
        written = text.slice(range[0], range[1]);
      }
      const shown = written.length > 40 ? `${written.slice(0, 40)}...` : written;
      errors.push(
        isScalar(key)
          ? `not valid YAML: the key ${shown === "" ? "(empty)" : shown}${where} is not a string; write it in quotes`
          : `not valid YAML: the key${where} is a list or a mapping; a key must be a string`,
      );
    },
  });
  return errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatPath(path: readonly PropertyKey[]): string {
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

export function formatIssue(issue: Issue): string {
  if (issue.code === "unrecognized_keys") {
    const keys = issue.keys.map((k) => `'${k}'`).join(", ");
    return `${formatPath(issue.path)}: unknown key${issue.keys.length > 1 ? "s" : ""} ${keys}`;
  }
  return `${formatPath(issue.path)}: ${issue.message}`;
}

// The entries of a list in the raw document with their indexes, or undefined
// when the key does not hold a list (the shape check reports that).
function entries(
  raw: Record<string, unknown>,
  key: string,
): [number, Record<string, unknown>][] | undefined {
  const list = raw[key];
  if (!Array.isArray(list)) return undefined;
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

// An id as the shape check accepts it. A reference that fails this is
// reported there, so the cross-check does not look it up as well.
function isId(value: string | undefined): value is string {
  return value !== undefined && ID_PATTERN.test(value);
}

// A measure's id as a version 3 board accepts it. In a board of version 1 or
// 2, one with '.' is reported by the shape check as read from version 3 on,
// and is looked up all the same.
function isMeasureId(value: string | undefined): value is string {
  return value !== undefined && DOTTED_ID_PATTERN.test(value);
}

// The kinds of measure that read a repository.
const REPO_KINDS = new Set([
  "file_count",
  "dir_count",
  "line_count",
  "match_count",
  "regex_capture",
  "json_length",
  "file_name",
  "file_paths",
]);

// The kinds of measure whose value is not a number, so neither a ratio nor a
// total takes them.
const NOT_NUMBER_KINDS = new Set(["regex_capture", "file_name", "file_paths"]);

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
// reported even when the shape check found problems elsewhere. Anything the
// shape check already refuses is skipped here: a list that is not a list, a
// key the kind does not take, a value of the wrong type or form.
function crossCheck(raw: Record<string, unknown>, context: BoardDeclarationContext): string[] {
  const errors: string[] = [];

  // The ids of a list, reporting duplicates; undefined when it is not a list.
  const idsOf = (key: string, what: string, field = "id"): Set<string> | undefined => {
    const list = entries(raw, key);
    if (list === undefined) return undefined;
    const seen = new Map<string, number>();
    for (const [i, entry] of list) {
      const id = stringAt(entry, field);
      if (id === undefined) continue;
      const first = seen.get(id);
      if (first === undefined) seen.set(id, i);
      else
        errors.push(
          `${key}[${i}].${field}: duplicate ${what} ${field} '${id}' (first at ${key}[${first}])`,
        );
    }
    return new Set(seen.keys());
  };
  const laneIds = idsOf("lanes", "lane");
  const measureIds = idsOf("measures", "measure");
  idsOf("ratios", "ratio");
  // A version 1 file has no observations: its `observe` is refused as a key.
  if (raw.board_version !== 1) {
    idsOf("observe", "observation", "key");
    // The value holds one answer for each word, in the order declared.
    for (const [i, o] of entries(raw, "observe") ?? []) {
      if (o.kind !== "http" || !Array.isArray(o.words)) continue;
      const seen = new Map<string, number>();
      o.words.forEach((word: unknown, j) => {
        if (typeof word !== "string") return;
        const first = seen.get(word);
        if (first === undefined) seen.set(word, j);
        else errors.push(`observe[${i}].words[${j}]: duplicate word (first at words[${first}])`);
      });
    }
  }

  const repoPaths = new Set(context.manifestRepoPaths);
  const declared =
    context.manifestRepoPaths.length === 0
      ? "the manifest declares no repos"
      : `the manifest declares ${context.manifestRepoPaths.map((p) => `'${p}'`).join(", ")}`;
  const measureKinds = new Map<string, unknown>();
  for (const [i, measure] of entries(raw, "measures") ?? []) {
    const at = `measures[${i}]`;
    const id = stringAt(measure, "id");
    if (id !== undefined && !measureKinds.has(id)) measureKinds.set(id, measure.kind);
    const repo = stringAt(measure, "repo");
    if (
      typeof measure.kind === "string" &&
      REPO_KINDS.has(measure.kind) &&
      repo !== undefined &&
      repo.trim() !== "" &&
      !repoPaths.has(repo)
    ) {
      errors.push(`${at}.repo: '${repo}' is not a repo path in the manifest (${declared})`);
    }
    const lane = stringAt(measure, "lane");
    if (laneIds !== undefined && isId(lane) && !laneIds.has(lane)) {
      errors.push(`${at}.lane: no lane has the id '${lane}'`);
    }
    if (laneIds !== undefined && Array.isArray(measure.lane)) {
      const seen = new Set<string>();
      measure.lane.forEach((id: unknown, j) => {
        if (typeof id !== "string" || !isId(id)) return;
        if (seen.has(id)) errors.push(`${at}.lane[${j}]: '${id}' is listed twice`);
        else if (!laneIds.has(id)) errors.push(`${at}.lane[${j}]: no lane has the id '${id}'`);
        seen.add(id);
      });
    }
    if (
      measure.kind === "file_name" &&
      measure.pattern === undefined &&
      measure.group !== undefined
    ) {
      errors.push(`${at}.group: a file_name takes a group only with a pattern`);
    }
    if (
      measure.kind === "regex_capture" ||
      (measure.kind === "file_name" && measure.pattern !== undefined)
    ) {
      const pattern = stringAt(measure, "pattern");
      const group = measure.group ?? BOARD_DEFAULT_CAPTURE_GROUP;
      const groups = pattern === undefined || pattern === "" ? undefined : captureGroups(pattern);
      if (
        Number.isInteger(group) &&
        typeof group === "number" &&
        groups !== undefined &&
        group > groups
      ) {
        errors.push(
          `${at}.group: the pattern has ${groups} capturing group${groups === 1 ? "" : "s"}, so group ${group} does not exist`,
        );
      }
    }
    if (
      measure.kind === "trail_count" &&
      measure.status !== undefined &&
      (BOARD_TRAIL_COUNTS as readonly unknown[]).includes(measure.of) &&
      measure.of !== "tasks"
    ) {
      errors.push(`${at}.status: only a trail_count of 'tasks' takes a status`);
    }
  }

  if (measureIds !== undefined) {
    // Why a ratio or a total cannot take the measure `ref` names, or undefined.
    const notTaken = (ref: string, inTotal: boolean): string | undefined => {
      if (!measureIds.has(ref)) return `no measure has the id '${ref}'`;
      const kind = measureKinds.get(ref);
      if (typeof kind !== "string") return undefined;
      if (NOT_NUMBER_KINDS.has(kind)) return `'${ref}' is a ${kind}, which is not a number`;
      if (inTotal && kind === "total") return `'${ref}' is a total, which no total takes`;
      return undefined;
    };
    for (const [i, ratio] of entries(raw, "ratios") ?? []) {
      for (const side of ["numerator", "denominator"] as const) {
        const ref = stringAt(ratio, side);
        if (!isMeasureId(ref)) continue;
        const problem = notTaken(ref, false);
        if (problem !== undefined) errors.push(`ratios[${i}].${side}: ${problem}`);
      }
    }
    for (const [i, measure] of entries(raw, "measures") ?? []) {
      if (measure.kind !== "total") continue;
      for (const side of ["plus", "minus"] as const) {
        const terms = measure[side];
        if (!Array.isArray(terms)) continue;
        terms.forEach((term: unknown, j) => {
          if (typeof term !== "string" || !isMeasureId(term)) return;
          const problem = notTaken(term, true);
          if (problem !== undefined) errors.push(`measures[${i}].${side}[${j}]: ${problem}`);
        });
      }
    }
  }

  const components = raw.components;
  if (isRecord(components)) {
    for (const [key, component] of Object.entries(components)) {
      const at = formatPath(["components", key]);
      // The schema check skips this key, so nothing else would report it.
      if (key === "__proto__") {
        errors.push(`${at}: a component cannot be named __proto__`);
        continue;
      }
      if (key.trim() === "") errors.push(`${at}: a component key must be a non-empty path`);
      if (!isRecord(component)) continue;
      if (component.lane === "-" && component.note === undefined) {
        errors.push(`${at}.note: a component with lane '-' needs a note saying why`);
      }
      if (laneIds !== undefined && Array.isArray(component.lane)) {
        const seen = new Set<string>();
        component.lane.forEach((lane, j) => {
          if (typeof lane !== "string" || !isId(lane)) return;
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
