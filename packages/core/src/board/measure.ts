import { createHash } from "node:crypto";
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
import { compileGlob, compileGlobs } from "./glob.js";
import { openRepoScope, type RepoScope, type RepoScopeResult } from "./scope.js";

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
 * What `basou board measure` reports. A value is `null` only when it could
 * not be measured, and then `not_found` says why and `complete` is false: a
 * missing repository, revision or file is never counted as zero.
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
  measures: Record<string, BoardMeasureValue>;
  ratios: Record<string, BoardRatioValue>;
};

export type MeasureBoardInput = {
  declaration: BoardDeclaration;
  /** The absolute root the manifest's repo paths are relative to. */
  root: string;
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
    measures,
    ratios,
  };
  const { board_version, title, measured_at, measured_with, complete, not_found } = body;
  return {
    board_version,
    title,
    measured_at,
    measured_with,
    complete,
    not_found,
    digest: boardDigest(body),
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

// The directory a pattern's fixed part names, when it has a wildcard after
// one; "" when it starts with a wildcard. A pattern with no wildcard is its
// own fixed part.
function fixedPart(pattern: string): { wildcard: boolean; fixed: string } {
  let p = pattern.replace(/\/{2,}/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  if (p.endsWith("/")) p = p.slice(0, -1);
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "\\") i++;
    else if (p[i] === "*" || p[i] === "?" || p[i] === "[") {
      const slash = p.lastIndexOf("/", i);
      return { wildcard: true, fixed: slash === -1 ? "" : p.slice(0, slash) };
    }
  }
  return { wildcard: false, fixed: p === "." ? "" : p };
}

// An include that cannot match because what it names is not there is not
// measured, rather than counted as zero: a pattern with no wildcard that
// matches nothing, or one whose fixed directory holds nothing.
function missingInclude(scope: RepoScope, include: readonly string[]): string | undefined {
  const paths = [...scope.entries.keys()];
  for (const pattern of include) {
    const { wildcard, fixed } = fixedPart(pattern);
    if (!wildcard) {
      const m = compileGlob(pattern);
      if (fixed !== "" && !paths.some(m)) return `'${pattern}' matches no file ${where(scope)}`;
    } else if (fixed !== "" && !paths.some((p) => p.startsWith(`${fixed}/`))) {
      return `nothing is under '${fixed}' ${where(scope)}`;
    }
  }
  return undefined;
}

function outsideAmong(scope: RepoScope, paths: readonly string[]): string | undefined {
  const leaving = paths.find((p) => scope.entries.get(p)?.kind === "outside");
  return leaving === undefined ? undefined : `'${leaving}' is a symlink to outside the repository`;
}

function linesOf(content: Buffer): string[] {
  const text = content.toString("utf8");
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
    if (trail.events === undefined)
      return fail(trail.eventsProblem ?? "the trail could not be read");
    return { value: trail.events[measure.of] };
  }

  const opened = await scopeOf(measure.repo, measure.at);
  if (!opened.ok) {
    const at = measure.at === BOARD_DEFAULT_AT ? "" : ` (at '${measure.at}')`;
    return fail(`the repo '${measure.repo}'${at} ${opened.reason}`);
  }
  const scope = opened.scope;

  if (measure.kind === "regex_capture" || measure.kind === "json_length") {
    const entry = scope.entries.get(measure.file);
    if (entry === undefined) return fail(`'${measure.file}' is not a file ${where(scope)}`);
    if (entry.kind === "outside")
      return fail(`'${measure.file}' is a symlink to outside the repository`);
    const content = (await scope.read([measure.file])).get(measure.file);
    if (content === undefined) return fail(`'${measure.file}' could not be read ${where(scope)}`);
    if (measure.kind === "json_length") {
      let document: unknown;
      try {
        document = JSON.parse(content.toString("utf8").replace(/^\uFEFF/, ""));
      } catch {
        return fail(`'${measure.file}' is not valid JSON ${where(scope)}`);
      }
      const target = pointAt(document, measure.pointer);
      if (Array.isArray(target)) return { value: target.length };
      if (target !== null && typeof target === "object")
        return { value: Object.keys(target).length };
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
    const base = fixedPart(measure.path).fixed;
    const under = (p: string) => base === "" || p.startsWith(`${base}/`);
    const all = [...scope.entries.keys()].filter(under);
    if (all.length === 0) return fail(`nothing is under '${measure.path}' ${where(scope)}`);
    const missing =
      measure.include === undefined ? undefined : missingInclude(scope, measure.include);
    if (missing !== undefined) return fail(missing);
    const matched = all.filter(compileGlobs(measure.include, measure.exclude));
    const leaving = outsideAmong(scope, matched);
    if (leaving !== undefined) return fail(leaving);
    const dirs = new Set<string>();
    for (const p of matched) {
      const segments = (base === "" ? p : p.slice(base.length + 1)).split("/");
      if (segments.length > measure.depth) dirs.add(segments.slice(0, measure.depth).join("/"));
    }
    return { value: dirs.size };
  }

  const missing = missingInclude(scope, measure.include);
  if (missing !== undefined) return fail(missing);
  const matched = [...scope.entries.keys()].filter(compileGlobs(measure.include, measure.exclude));
  const leaving = outsideAmong(scope, matched);
  if (leaving !== undefined) return fail(leaving);
  if (measure.kind === "file_count") return { value: matched.length };

  const contents = await scope.read(matched);
  if (measure.kind === "line_count") {
    let total = 0;
    for (const content of contents.values()) total += linesOf(content).length;
    return { value: total };
  }

  const pattern = new RegExp(measure.pattern, BOARD_REGEX_FLAGS);
  let total = 0;
  for (const [path, content] of contents) {
    const lines = sectionOf(linesOf(content), measure.section);
    if (lines === undefined) {
      if (measure.section?.on_missing === null) {
        return fail(`no line of '${path}' matches the section start`);
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

// The workspace's own trail: its decisions, open tracks and tasks.
async function readTrail(input: MeasureBoardInput): Promise<Trail> {
  const trail: Trail = {};
  try {
    const recorded: { id: string; track: boolean }[] = [];
    const voided = new Set<string>();
    for (const sessionId of await enumerateSessionDirs(input.paths)) {
      const events = await readAllEvents(join(input.paths.sessions, sessionId), {
        onWarning: (warning) => input.onReplayWarning?.(warning, sessionId),
      });
      for (const event of events) {
        if (event.type === "decision_recorded") {
          recorded.push({ id: event.decision_id, track: event.kind === "track" });
        } else if (event.type === "decision_voided") {
          voided.add(event.decision_id);
        }
      }
    }
    trail.events = {
      decisions_all: recorded.length,
      decisions_live: recorded.filter((d) => !voided.has(d.id)).length,
      tracks_open: recorded.filter((d) => d.track && !voided.has(d.id)).length,
    };
  } catch {
    trail.eventsProblem = "the sessions of the workspace could not be read";
  }
  try {
    let skipped = 0;
    const tasks = await loadTaskEntries(input.paths, {
      onSkip: (taskId, reason) => {
        skipped++;
        input.onTaskSkip?.(taskId, reason);
      },
    });
    if (skipped > 0)
      trail.tasksProblem = `${skipped} task${skipped === 1 ? "" : "s"} could not be read`;
    else trail.tasks = tasks.map((doc) => doc.task.task.status);
  } catch {
    trail.tasksProblem = "the tasks of the workspace could not be read";
  }
  return trail;
}
