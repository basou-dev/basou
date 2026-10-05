import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ReplayWarning, readAllEvents } from "../events/event-replay.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import { enumerateSessionDirs } from "../storage/sessions.js";
import { loadTaskEntries, type TaskSkipReason } from "../storage/tasks.js";
import {
  BOARD_DEFAULT_AT,
  BOARD_REGEX_FLAGS,
  type BoardDeclaration,
  type BoardMeasure,
} from "./declaration.js";
import {
  compileGlob,
  compileGlobs,
  literalLength,
  mayMatchUnder,
  normalizePathspec,
  toBytes,
} from "./glob.js";
import { BOARD_REPOS_METHOD, type BoardRepo, measureRepos } from "./repos.js";
import {
  blockedAmong,
  openRepoScope,
  type RepoScope,
  type RepoScopeResult,
  reaches,
  shownPath,
  unreadReaching,
} from "./scope.js";

/** One thing that could not be measured, and why. */
export type BoardNotFound = { at: string; reason: string };

export type BoardMeasureValue = {
  value: number | string | null;
  unit: string;
  lane?: string;
};

export type BoardRatioValue = {
  value: number | null;
  numerator: string;
  denominator: string;
};

/**
 * What `basou board measure` reports. A value is `null` when it could not be
 * measured, and then `not_found` says why and `complete` is false: a missing
 * repository, revision or file is never counted as zero. The one exception is
 * the three nulls of the repos section that mean something of their own (a
 * detached HEAD, no commit yet, no origin/main; see {@link BoardRepo}), which
 * have no entry and leave `complete` as it is.
 */
export type BoardMeasurement = {
  board_version: number;
  title: string;
  measured_at: string;
  measured_with: { basou: string; build: string | null };
  complete: boolean;
  not_found: BoardNotFound[];
  /**
   * `sha256:` and the hex digest of the measurement without `measured_at` and
   * `digest`, serialized with its keys sorted. Two measurements with the same
   * values have the same digest whenever they were taken.
   */
  digest: string;
  /** The version of how each built-in section measures (see `BOARD_REPOS_METHOD`). */
  methods: { repos: number };
  /** Each repository the manifest declares, in its order. */
  repos: BoardRepo[];
  measures: Record<string, BoardMeasureValue>;
  ratios: Record<string, BoardRatioValue>;
};

export type MeasureBoardInput = {
  declaration: BoardDeclaration;
  /** The absolute root the manifest's repo paths are relative to. */
  root: string;
  /** The paths of the manifest's repos, in its order. */
  repos: readonly string[];
  paths: BasouPaths;
  now: Date;
  measuredWith: { basou: string; build: string | null };
  onReplayWarning?: (warning: ReplayWarning, sessionId: string) => void;
  onTaskSkip?: (taskId: string, reason: TaskSkipReason) => void;
};

type Outcome = { value: number | string | null; reason?: string };

const fail = (reason: string): Outcome => ({ value: null, reason });

/** Measure what a board declares. Reads, never writes. */
export async function measureBoard(input: MeasureBoardInput): Promise<BoardMeasurement> {
  const { declaration } = input;
  const notFound: BoardNotFound[] = [];
  const scopes = new Map<string, Promise<RepoScopeResult>>();
  const scopeOf = (repo: string, at: string): Promise<RepoScopeResult> => {
    const key = `${repo}\0${at}`;
    let scope = scopes.get(key);
    if (scope === undefined) {
      scope = openRepoScope(resolve(input.root, repo), at);
      scopes.set(key, scope);
    }
    return scope;
  };
  let trail: Promise<Trail> | undefined;
  const trailOf = (): Promise<Trail> => {
    trail ??= readTrail(input);
    return trail;
  };

  const repos = await measureRepos(input.repos, input.root, (repo) =>
    scopeOf(repo, BOARD_DEFAULT_AT),
  );
  notFound.push(...repos.notFound);

  const measures: Record<string, BoardMeasureValue> = {};
  for (const measure of declaration.measures) {
    const outcome = await measureOne(measure, scopeOf, trailOf);
    if (outcome.reason !== undefined) {
      notFound.push({ at: `measures.${measure.id}`, reason: outcome.reason });
    }
    measures[measure.id] = {
      value: outcome.value,
      unit: measure.unit,
      ...(measure.lane === undefined ? {} : { lane: measure.lane }),
    };
  }

  const ratios: Record<string, BoardRatioValue> = {};
  for (const ratio of declaration.ratios) {
    const numerator = measures[ratio.numerator]?.value;
    const denominator = measures[ratio.denominator]?.value;
    let value: number | null = null;
    if (typeof numerator === "number" && typeof denominator === "number") {
      if (denominator === 0) {
        notFound.push({ at: `ratios.${ratio.id}`, reason: `'${ratio.denominator}' is 0` });
      } else {
        value = numerator / denominator;
      }
    }
    ratios[ratio.id] = { value, numerator: ratio.numerator, denominator: ratio.denominator };
  }

  const body = {
    board_version: declaration.board_version,
    title: declaration.title,
    measured_at: input.now.toISOString(),
    measured_with: input.measuredWith,
    complete: notFound.length === 0,
    not_found: notFound,
    methods: { repos: BOARD_REPOS_METHOD },
    repos: repos.repos,
    measures,
    ratios,
  };
  const { board_version, title, measured_at, measured_with, complete, not_found, methods } = body;
  return {
    board_version,
    title,
    measured_at,
    measured_with,
    complete,
    not_found,
    digest: boardDigest(body),
    methods,
    repos: body.repos,
    measures,
    ratios,
  };
}

/**
 * The digest of a measurement: sha256 over the measurement without
 * `measured_at` and `digest`, with every object's keys sorted.
 */
export function boardDigest(measurement: object): string {
  const hashed = Object.fromEntries(
    Object.entries(measurement).filter(([key]) => key !== "measured_at" && key !== "digest"),
  );
  return `sha256:${createHash("sha256").update(canonicalJson(hashed)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function where(scope: RepoScope): string {
  return scope.at === BOARD_DEFAULT_AT ? "in the working tree" : `at '${scope.at}'`;
}

// The directory a pattern names before its first wildcard, with escapes
// undone, and whether it has a wildcard or an escape at all (then git
// matches it whole). Both are byte strings.
function fixedPart(pattern: string): { wildcard: boolean; fixed: string } {
  const p = normalizePathspec(toBytes(pattern));
  if (literalLength(p) === p.length) return { wildcard: false, fixed: p.replace(/\/$/, "") };
  let literal = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i] as string;
    if (ch === "\\") {
      literal += p[i + 1] ?? "";
      i++;
    } else if (ch === "*" || ch === "?" || ch === "[") {
      const slash = literal.lastIndexOf("/");
      return { wildcard: true, fixed: slash === -1 ? "" : literal.slice(0, slash) };
    } else {
      literal += ch;
    }
  }
  const slash = literal.lastIndexOf("/");
  return { wildcard: true, fixed: slash === -1 ? "" : literal.slice(0, slash) };
}

// An include that cannot match because what it names is not there is not
// measured, rather than counted as zero: a pattern with no wildcard that
// matches nothing, or one whose fixed directory holds nothing.
function missingInclude(scope: RepoScope, include: readonly string[]): string | undefined {
  const paths = [...scope.entries.keys()];
  for (const pattern of include) {
    const { wildcard, fixed } = fixedPart(pattern);
    if (!wildcard) {
      if (fixed !== "" && !paths.some(compileGlob(pattern))) {
        return `'${pattern}' matches no file ${where(scope)}`;
      }
    } else if (fixed !== "" && !paths.some((p) => p.startsWith(`${fixed}/`))) {
      return `nothing is under '${shownPath(fixed)}' ${where(scope)}`;
    }
  }
  return undefined;
}

function linesOf(content: Buffer): string[] {
  const text = content.toString("utf8").replace(/^\uFEFF/, "");
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

// The lines a section covers: after the first line matching `start`, up to
// the next line matching `end` (searched from the line after `start`).
// undefined when `start` is not found.
function sectionOf(
  lines: readonly string[],
  section: { start: string; end?: string | undefined } | undefined,
): readonly string[] | undefined {
  if (section === undefined) return lines;
  const start = new RegExp(section.start, BOARD_REGEX_FLAGS);
  const from = lines.findIndex((line) => start.test(line));
  if (from === -1) return undefined;
  const rest = lines.slice(from + 1);
  if (section.end === undefined) return rest;
  const end = new RegExp(section.end, BOARD_REGEX_FLAGS);
  const to = rest.findIndex((line) => end.test(line));
  return to === -1 ? rest : rest.slice(0, to);
}

// The value a JSON pointer (RFC 6901) points at, or undefined.
function pointAt(document: unknown, pointer: string): unknown {
  if (pointer === "") return document;
  let current: unknown = document;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) return undefined;
      current = current[Number(token)];
    } else if (current !== null && typeof current === "object") {
      if (!Object.hasOwn(current, token)) return undefined;
      current = (current as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return current;
}

async function measureOne(
  measure: BoardMeasure,
  scopeOf: (repo: string, at: string) => Promise<RepoScopeResult>,
  trailOf: () => Promise<Trail>,
): Promise<Outcome> {
  if (measure.kind === "trail_count") {
    const trail = await trailOf();
    if (measure.of === "tasks") {
      if (trail.tasks === undefined) return fail(trail.tasksProblem ?? "tasks could not be read");
      const tasks =
        measure.status === undefined
          ? trail.tasks
          : trail.tasks.filter((status) => status === measure.status);
      return { value: tasks.length };
    }
    if (trail.events === undefined) {
      return fail(trail.eventsProblem ?? "the trail could not be read");
    }
    return { value: trail.events[measure.of] };
  }

  const opened = await scopeOf(measure.repo, measure.at);
  if (!opened.ok) {
    const at = measure.at === BOARD_DEFAULT_AT ? "" : ` (at '${measure.at}')`;
    return fail(`the repo '${measure.repo}'${at} ${opened.reason}`);
  }
  const scope = opened.scope;

  if (measure.kind === "regex_capture" || measure.kind === "json_length") {
    const file = normalizePathspec(toBytes(measure.file));
    const entry = scope.entries.get(file);
    if (entry === undefined) {
      return fail(
        unreadReaching(scope, (dir) => reaches(file, dir)) ??
          `'${measure.file}' is not a file ${where(scope)}`,
      );
    }
    const blocked = blockedAmong(scope, [file]);
    if (blocked !== undefined) return fail(blocked);
    const read = await scope.read([file]);
    const content = read.contents.get(file);
    if (content === undefined) {
      return fail(`'${measure.file}' ${read.unreadable.get(file) ?? "could not be read"}`);
    }
    if (measure.kind === "json_length") {
      let document: unknown;
      try {
        document = JSON.parse(content.toString("utf8").replace(/^\uFEFF/, ""));
      } catch {
        return fail(`'${measure.file}' is not valid JSON ${where(scope)}`);
      }
      const target = pointAt(document, measure.pointer);
      if (Array.isArray(target)) return { value: target.length };
      if (target !== null && typeof target === "object") {
        return { value: Object.keys(target).length };
      }
      return fail(
        target === undefined
          ? `'${measure.pointer}' points at nothing in '${measure.file}'`
          : `'${measure.pointer}' in '${measure.file}' is not an array or an object`,
      );
    }
    const lines = sectionOf(linesOf(content), measure.section);
    if (lines === undefined) return fail(`no line of '${measure.file}' matches the section start`);
    const pattern = new RegExp(measure.pattern, BOARD_REGEX_FLAGS);
    for (const line of lines) {
      const match = pattern.exec(line);
      if (match === null) continue;
      const captured = match[measure.group];
      return typeof captured === "string"
        ? { value: captured }
        : fail(`group ${measure.group} took no part in the first match in '${measure.file}'`);
    }
    return fail(`no line of '${measure.file}' matches the pattern`);
  }

  if (measure.kind === "dir_count") {
    const base = normalizePathspec(toBytes(measure.path)).replace(/\/$/, "");
    const under = (p: string) => base === "" || p.startsWith(`${base}/`);
    const include = measure.include;
    const unread = unreadReaching(
      scope,
      (dir) =>
        reaches(base, dir) &&
        (include === undefined || include.some((pattern) => mayMatchUnder(pattern, dir))),
    );
    const all = [...scope.entries.keys()].filter(under);
    if (all.length === 0)
      return fail(unread ?? `nothing is under '${measure.path}' ${where(scope)}`);
    const missing =
      unread !== undefined || measure.include === undefined
        ? undefined
        : missingInclude(scope, measure.include);
    if (missing !== undefined) return fail(missing);
    const matched = all.filter(compileGlobs(measure.include, measure.exclude));
    const blocked = blockedAmong(scope, matched);
    if (blocked !== undefined) return fail(blocked);
    if (unread !== undefined) return fail(unread);
    const dirs = new Set<string>();
    for (const p of matched) {
      const segments = (base === "" ? p : p.slice(base.length + 1)).split("/");
      if (segments.length > measure.depth) dirs.add(segments.slice(0, measure.depth).join("/"));
    }
    return { value: dirs.size };
  }

  // A directory git could not list in full may hold what the patterns match,
  // so nothing under it is known to be missing, and the count is not known.
  const include = measure.include;
  const unread = unreadReaching(scope, (dir) =>
    include.some((pattern) => mayMatchUnder(pattern, dir)),
  );
  const missing = unread === undefined ? missingInclude(scope, measure.include) : undefined;
  if (missing !== undefined) return fail(missing);
  const matched = [...scope.entries.keys()].filter(compileGlobs(measure.include, measure.exclude));
  const blocked = blockedAmong(scope, matched);
  if (blocked !== undefined) return fail(blocked);
  if (unread !== undefined) return fail(unread);
  if (measure.kind === "file_count") return { value: matched.length };

  const read = await scope.read(matched);
  const [unreadable] = read.unreadable;
  if (unreadable !== undefined) return fail(`'${shownPath(unreadable[0])}' ${unreadable[1]}`);
  if (measure.kind === "line_count") {
    let total = 0;
    for (const content of read.contents.values()) total += linesOf(content).length;
    return { value: total };
  }

  const pattern = new RegExp(measure.pattern, BOARD_REGEX_FLAGS);
  let total = 0;
  for (const [path, content] of read.contents) {
    const lines = sectionOf(linesOf(content), measure.section);
    if (lines === undefined) {
      if (measure.section?.on_missing === null) {
        return fail(`no line of '${shownPath(path)}' matches the section start`);
      }
      continue; // on_missing: zero
    }
    total += lines.filter((line) => pattern.test(line)).length;
  }
  return { value: total };
}

type Trail = {
  events?: { decisions_all: number; decisions_live: number; tracks_open: number };
  eventsProblem?: string;
  /** The status of every task that is not archived. */
  tasks?: string[];
  tasksProblem?: string;
};

// Event lines that were not read as events. A torn last line is a write in
// progress, not a recorded event, and a retired zero-duration line is not a
// decision; anything else may have been one.
const LOST_LINES = new Set<ReplayWarning["kind"]>(["malformed_json", "schema_violation"]);

// Whether line `lineNo` of an events log is its last line with no newline
// after it: a write that has not finished, which replay reports as malformed
// when it is cut in the middle of the JSON.
async function isTornTail(eventsLog: string, lineNo: number): Promise<boolean> {
  let body: Buffer;
  try {
    body = await readFile(eventsLog);
  } catch {
    return false;
  }
  if (body.length === 0 || body[body.length - 1] === 0x0a) return false;
  let newlines = 0;
  for (const byte of body) if (byte === 0x0a) newlines++;
  return lineNo === newlines + 1;
}

// The workspace's own trail: its decisions, open tracks and tasks. Read only:
// the task index is not rebuilt.
async function readTrail(input: MeasureBoardInput): Promise<Trail> {
  const trail: Trail = {};
  try {
    const recorded: { id: string; track: boolean }[] = [];
    const voided = new Set<string>();
    let lost = 0;
    for (const sessionId of await enumerateSessionDirs(input.paths)) {
      const sessionDir = join(input.paths.sessions, sessionId);
      const lostLines: number[] = [];
      const events = await readAllEvents(sessionDir, {
        onWarning: (warning) => {
          if (LOST_LINES.has(warning.kind)) lostLines.push(warning.line);
          input.onReplayWarning?.(warning, sessionId);
        },
      });
      for (const lineNo of lostLines) {
        if (!(await isTornTail(join(sessionDir, "events.jsonl"), lineNo))) lost++;
      }
      for (const event of events) {
        if (event.type === "decision_recorded") {
          recorded.push({ id: event.decision_id, track: event.kind === "track" });
        } else if (event.type === "decision_voided") {
          voided.add(event.decision_id);
        }
      }
    }
    if (lost > 0) {
      trail.eventsProblem = `${lost} event line${lost === 1 ? "" : "s"} could not be read, so decisions may be missing`;
    } else {
      trail.events = {
        decisions_all: recorded.length,
        decisions_live: recorded.filter((d) => !voided.has(d.id)).length,
        tracks_open: recorded.filter((d) => d.track && !voided.has(d.id)).length,
      };
    }
  } catch {
    trail.eventsProblem = "the sessions of the workspace could not be read";
  }
  try {
    let skipped = 0;
    const tasks = await loadTaskEntries(input.paths, {
      rebuildIndex: false,
      onSkip: (taskId, reason) => {
        skipped++;
        input.onTaskSkip?.(taskId, reason);
      },
    });
    if (skipped > 0) {
      trail.tasksProblem = `${skipped} task${skipped === 1 ? "" : "s"} could not be read`;
    } else {
      trail.tasks = tasks.map((doc) => doc.task.task.status);
    }
  } catch {
    trail.tasksProblem = "the tasks of the workspace could not be read";
  }
  return trail;
}
