import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { createManifest, ensureBasouDirectory, writeManifest } from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doRunBoardMeasure, doRunBoardRecord } from "./board.js";

// What basou board measure --json, basou board record --json and a record
// file hold, pinned key by key: a field taken away or renamed fails here. A
// field added is pinned here too, so that it is added on purpose. The shapes
// board.yaml and the record's input take are pinned in core's shapes test.

const execFileAsync = promisify(execFile);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
const NOW = new Date("2026-10-05T03:00:00.000Z");
const WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;

let tmp: string | undefined;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "basou-board-shapes-"));
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: tmp, env: ENV });
});

afterEach(async () => {
  if (tmp !== undefined) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
  process.exitCode = 0;
  vi.restoreAllMocks();
});

const ctx = (cwd: string) => ({
  cwd,
  nowProvider: () => NOW,
  portfolioConfigPath: join(cwd, ".portfolio.yaml"),
  claudeProjectsDir: join(cwd, ".claude-projects"),
  codexSessionsDir: join(cwd, ".codex-sessions"),
});

// What a command printed on stdout, read as the JSON it is.
async function printed<T>(run: () => Promise<T>): Promise<unknown> {
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await run();
  } finally {
    vi.restoreAllMocks();
  }
  return JSON.parse(out.join("\n"));
}

// The keys of each object a JSON value holds, as sorted lines `path: {key,
// key}`, merged over the objects at one path (a list's entries are at
// `path[]`). An object at a path in `maps` is a mapping whose keys are data
// (an id, a path, a status), and its values are at `path.*`.
function shapeLines(value: unknown, maps: readonly string[]): string[] {
  const keysAt = new Map<string, Set<string>>();
  const walk = (v: unknown, at: string): void => {
    if (Array.isArray(v)) {
      for (const entry of v) walk(entry, `${at}[]`);
      return;
    }
    if (typeof v !== "object" || v === null) return;
    const entries = Object.entries(v as Record<string, unknown>);
    if (maps.includes(at)) {
      for (const [, child] of entries) walk(child, `${at}.*`);
      return;
    }
    const keys = keysAt.get(at) ?? new Set<string>();
    keysAt.set(at, keys);
    for (const [key, child] of entries) {
      keys.add(key);
      walk(child, at === "" ? key : `${at}.${key}`);
    }
  };
  walk(value, "");
  return [...keysAt]
    .map(([at, keys]) => `${at === "" ? "(top)" : at}: {${[...keys].sort().join(", ")}}`)
    .sort();
}

const union = (...lists: string[][]): string[] => {
  const merged = new Map<string, Set<string>>();
  for (const line of lists.flat()) {
    const [at, keys] = line.split(": {") as [string, string];
    const set = merged.get(at) ?? new Set<string>();
    for (const key of keys.slice(0, -1).split(", ")) if (key !== "") set.add(key);
    merged.set(at, set);
  }
  return [...merged].map(([at, keys]) => `${at}: {${[...keys].sort().join(", ")}}`).sort();
};

// The mappings a measurement holds, whose keys are data.
const MEASUREMENT_MAPS = [
  "measures",
  "ratios",
  "integrity.by_status",
  "review_gaps.by_verdict",
  "effort.commits",
  "effort.daily[].commits",
  "components.found",
];

async function sessionWithTrack(repo: string): Promise<void> {
  const sessionId = "ses_01HXABCDEF1234567890ABCS01";
  const dir = join(repo, ".basou", "sessions", sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "session.yaml"),
    [
      'schema_version: "0.1.0"',
      "session:",
      `  id: ${sessionId}`,
      "  label: fixture",
      "  task_id: null",
      `  workspace_id: ${WS_ID}`,
      "  source: { kind: terminal, version: 0.1.0 }",
      "  started_at: 2026-10-01T00:00:00Z",
      "  status: completed",
      "  working_directory: /tmp/fixture",
      "  invocation: { command: echo, args: [], exit_code: 0 }",
      "  related_files: []",
      "  events_log: events.jsonl",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(dir, "events.jsonl"),
    `${JSON.stringify({
      schema_version: "0.1.0",
      id: "evt_01HXABCDEF1234567890ABCE01",
      session_id: sessionId,
      occurred_at: "2026-10-02T00:00:00Z",
      source: "local-cli",
      type: "decision_recorded",
      decision_id: "decision_01HXABCDEF1234567890ABCD01",
      title: "an open question",
      kind: "track",
    })}\n`,
  );
}

// A board of version 3 that declares one of every kind, so that every key of
// what is printed and recorded is there to be pinned.
function board(name: string): string {
  const stage = (id: string) => ({ meaning: `stage ${id}`, look: ["the work"], notes: ["mind"] });
  return JSON.stringify({
    board_version: 3,
    title: "Shapes",
    stages: Object.fromEntries(["01", "02", "03", "04", "05", "06"].map((id) => [id, stage(id)])),
    lanes: [{ id: "core", name: "Core", about: "the core", notes: ["a note"] }],
    measures: [
      {
        id: "files",
        kind: "file_count",
        repo: ".",
        include: ["*.md"],
        unit: "files",
        lane: "core",
      },
      { id: "dirs", kind: "dir_count", repo: ".", path: ".", depth: 1, unit: "dirs" },
      { id: "lines", kind: "line_count", repo: ".", include: ["*.md"], unit: "lines" },
      {
        id: "matches",
        kind: "match_count",
        repo: ".",
        include: ["*.md"],
        pattern: "a",
        section: { start: "^#", on_missing: "zero" },
        unit: "lines",
      },
      {
        id: "title",
        kind: "regex_capture",
        repo: ".",
        file: "README.md",
        pattern: "^# (.*)$",
        unit: "name",
      },
      {
        id: "keys",
        kind: "json_length",
        repo: ".",
        file: "package.json",
        pointer: "",
        unit: "keys",
      },
      { id: "decisions", kind: "trail_count", of: "decisions_all", unit: "decisions" },
      { id: "latest", kind: "file_name", repo: ".", include: ["*.md"], pick: "last", unit: "name" },
      { id: "docs.paths", kind: "file_paths", repo: ".", include: ["*.md"], unit: "files" },
      { id: "sum", kind: "total", plus: ["files", 1], minus: ["lines"], unit: "files" },
      { id: "missing", kind: "file_count", repo: ".", include: ["missing.md"], unit: "files" },
    ],
    ratios: [{ id: "per", label: "Lines per file", numerator: "lines", denominator: "files" }],
    observe: [
      { key: "npm", kind: "npm_version", package: "example-cli" },
      { key: "release", kind: "github_release", repo: "example/app" },
      { key: "issues", kind: "github_open_issues", repo: "example/app" },
      { key: "prs", kind: "github_open_prs", repo: "example/app" },
      { key: "ci", kind: "github_ci", repo: "example/app", workflow: "ci.yml" },
      { key: "check", kind: "github_check", repo: "example/app", check: "build" },
      { key: "page", kind: "page_version", url: "https://example.com/" },
      {
        key: "site.home",
        kind: "http",
        url: "https://example.com/",
        words: ["Install"],
        count_pattern: "a",
        capture_pattern: "v(\\d+)",
        notes: ["a note"],
      },
      { key: "asked", kind: "manual", how: "ask the operator" },
    ],
    components: {
      [name]: { lane: ["core"] },
      [`${name}/tools`]: { lane: "-", note: "tooling", marker: "**" },
      [`${name}/old`]: { lane: ["core"] },
    },
    axis: { version: 1, review_due_days: 60, seed_review: { date: "2026-09-01", model: "Old" } },
    effort: {
      start: "2026-10-01",
      time_zone: "UTC",
      milestones: [{ date: "2026-10-02", label: "Begun", ref: "abc1234" }],
    },
  });
}

function input(digest: string, first: boolean): Record<string, unknown> {
  const at = { observed_at: "2026-10-05T03:00:00Z" };
  return {
    measure_digest: digest,
    observed: {
      npm: { value: first ? "1.0.0" : "1.0.1", ...at, source: "npm view example-cli version" },
      release: { value: "v1.0.0", ...at, source: "gh release view" },
      issues: { value: 3, ...at, source: "gh issue list" },
      prs: { value: 1, ...at, source: "gh pr list" },
      ci: first
        ? { value: null, ...at, source: "gh run list", error: "no run yet" }
        : { value: "success", ...at, source: "gh run list" },
      check: { value: "success", ...at, source: "gh api" },
      page: { value: "v1.0.0", ...at, source: "https://example.com/" },
      "site.home": {
        value: {
          status: 200,
          redirects: 1,
          final_url: "https://example.com/",
          words: [true],
          count: 3,
          capture: "1",
        },
        ...at,
        source: "https://example.com/",
      },
      asked: { value: "yes", ...at, source: "the operator" },
    },
    cells: ["01", "02", "03", "04", "05", "06"].map((stage, i) => ({
      lane: "core",
      stage,
      // A stage left behind before one done, so that an anomaly is recorded.
      state: i === 1 ? "done" : i === 0 ? (first ? "none" : "blocked") : "none",
      ...(i === 0 && !first ? { reason: "waiting" } : {}),
    })),
    prose: {
      summary: "fine",
      lanes: { core: "moving" },
      operator_turns: [{ text: "Decide", source: "decision_01HXABCDEF1234567890ABCD01" }],
      footnotes: ["measured"],
    },
    judged_by: { model: "New Model", self_reported: true },
    axis_review: first ? { triggers: ["b", "d"], summary: "the first review" } : null,
  };
}

describe("the shapes basou board prints and records", () => {
  it("pins every key of measure --json, record --json and a record", async () => {
    const repo = await realpath(tmp as string);
    const name = basename(repo);
    const paths = await ensureBasouDirectory(repo);
    const manifest = createManifest({ workspaceName: "shapes", now: NOW, workspaceId: WS_ID });
    await writeManifest(paths, { ...manifest, repos: [{ path: ".", visibility: "private" }] });
    await writeFile(join(repo, "README.md"), "# Shapes\n\na line\n");
    await writeFile(join(repo, "NOTES.md"), "a\n");
    await writeFile(join(repo, "package.json"), '{ "name": "shapes" }\n');
    await mkdir(join(repo, "tools"));
    await writeFile(join(repo, "tools", "run.sh"), "echo\n");
    await sessionWithTrack(repo);
    await mkdir(join(repo, "board"));
    await writeFile(join(repo, "board", "board.yaml"), board(name));

    // Measured with no record yet and no model: the triggers not judged.
    const first = (await printed(() => doRunBoardMeasure({ json: true }, ctx(repo)))) as {
      digest: string;
    };
    const firstRecord = (await printed(() =>
      doRunBoardRecord(
        { json: true },
        { ...ctx(repo), readInput: async () => JSON.stringify(input(first.digest, true)) },
      ),
    )) as { record: string };

    // Moved since: a file added and one taken away, the kinds of a component,
    // a component not registered, and a method the previous record holds as
    // another.
    await writeFile(join(repo, "LATER.md"), "# later\n");
    await rm(join(repo, "NOTES.md"));
    await writeFile(join(repo, "Makefile"), "all:\n");
    await mkdir(join(repo, "svc"));
    await writeFile(join(repo, "svc", "Dockerfile"), "FROM x\n");
    const recordPath = join(repo, firstRecord.record);
    const held = JSON.parse(await readFile(recordPath, "utf8"));
    held.measure.methods.repos -= 1;
    await writeFile(recordPath, JSON.stringify(held, null, 2));

    const again = (await printed(() =>
      doRunBoardMeasure({ json: true, model: "New Model" }, ctx(repo)),
    )) as { digest: string };
    const second = (await printed(() =>
      doRunBoardRecord(
        { json: true },
        { ...ctx(repo), readInput: async () => JSON.stringify(input(again.digest, false)) },
      ),
    )) as { record: string };
    const recorded = JSON.parse(await readFile(join(repo, second.record), "utf8"));

    expect(union(shapeLines(first, MEASUREMENT_MAPS), shapeLines(again, MEASUREMENT_MAPS))).toEqual(
      MEASURE_JSON_SHAPE,
    );
    expect(
      union(
        shapeLines(firstRecord, prefixed("diff.measure", [])),
        shapeLines(second, prefixed("diff.measure", [])),
      ),
    ).toEqual(RECORD_JSON_SHAPE);
    expect(union(shapeLines(held, RECORD_MAPS), shapeLines(recorded, RECORD_MAPS))).toEqual(
      RECORD_FILE_SHAPE,
    );
  });
});

function prefixed(at: string, also: readonly string[]): string[] {
  return [...MEASUREMENT_MAPS.map((path) => `${at}.${path}`), ...also];
}

// The mappings a record holds, whose keys are data.
const RECORD_MAPS = prefixed("measure", ["declaration.components", "observed", "prose.lanes"]);

// What basou board measure --json prints (board.md, 5).
const MEASURE_JSON_SHAPE: string[] = [
  "(top): {axis, board_version, complete, components, diff, digest, effort, freshness, integrity, measured_at, measured_with, measures, methods, not_found, portfolio, ratios, repos, review_gaps, title, trail}",
  "axis.last_review: {date, from, model, record}",
  "axis.reasons[]: {detail, trigger}",
  "axis.unjudged[]: {trigger, why}",
  "axis: {last_review, reasons, review_needed, unjudged, version}",
  "components.found.*: {kinds, status}",
  "components.kind_changed[]: {after, before, key}",
  "components: {found, gone, kind_changed, unacknowledged}",
  "diff.added[]: {at, value}",
  "diff.methods[]: {after, before, section}",
  "diff.removed[]: {at, value}",
  "diff.values[]: {after, at, before, delta, method_changed}",
  "diff: {added, against, methods, removed, values}",
  "effort.active_ms: {claude, codex, union}",
  "effort.daily[].active_ms: {claude, codex, union}",
  "effort.daily[]: {active_ms, commits, date, output_tokens}",
  "effort: {active_ms, commits, daily, elapsed_days, output_tokens, sessions_without_tokens, start, time_zone}",
  "freshness.unimported: {new, unverifiable, updated}",
  "freshness: {newest_session_at, unimported}",
  "integrity: {by_status, not_verified}",
  "measured_with: {basou, build}",
  "measures.*: {lane, unit, value}",
  "methods: {axis, components, effort, freshness, integrity, portfolio, repos, review_gaps, trail}",
  "not_found[]: {at, reason}",
  "portfolio: {initialized, workspaces}",
  "ratios.*: {denominator, numerator, value}",
  "repos[]: {ahead, base, behind, branch, commits, fetched_at, files, head, last_commit, name, path, uncommitted}",
  "review_gaps: {by_verdict, gaps}",
  "trail.tracks_open[]: {id, title}",
  "trail: {decisions_all, decisions_live, tracks_open}",
];

// What basou board record --json prints (board.md, 3.6).
const RECORD_JSON_SHAPE: string[] = [
  "(top): {complete, diff, dry_run, not_found, order_anomalies, record}",
  "diff.cells[]: {after, before, lane, stage}",
  "diff.measure.added[]: {at, value}",
  "diff.measure.methods[]: {after, before, section}",
  "diff.measure.removed[]: {at, value}",
  "diff.measure.values[]: {after, at, before, delta, method_changed}",
  "diff.measure: {added, methods, removed, values}",
  "diff.observed[].after: {value}",
  "diff.observed[].before: {error, value}",
  "diff.observed[]: {after, before, name}",
  "diff: {against, cells, measure, observed}",
  "not_found[]: {at, reason}",
  "order_anomalies[]: {before, lane, stage, state}",
];

// What a record holds (board.md, 4).
const RECORD_FILE_SHAPE: string[] = [
  "(top): {axis_review, cells, declaration, judged_by, measure, observed, order_anomalies, prose, record_version, recorded_at, recorded_with}",
  "axis_review: {summary, triggers}",
  "cells[]: {lane, reason, stage, state}",
  "declaration.axis.seed_review: {date, model}",
  "declaration.axis: {review_due_days, seed_review, version}",
  "declaration.components.*: {lane, marker, note}",
  "declaration.effort.milestones[]: {date, label, ref}",
  "declaration.effort: {milestones, start, time_zone}",
  "declaration.lanes[]: {about, id, name, notes}",
  "declaration.measures[].section: {on_missing, start}",
  "declaration.measures[]: {at, depth, file, group, id, include, kind, lane, minus, of, path, pattern, pick, plus, pointer, repo, section, unit}",
  "declaration.observe[]: {branch, capture_pattern, check, count_pattern, how, key, kind, notes, package, repo, url, words, workflow}",
  "declaration.ratios[]: {denominator, id, label, numerator}",
  "declaration.stages.01: {look, meaning, notes}",
  "declaration.stages.02: {look, meaning, notes}",
  "declaration.stages.03: {look, meaning, notes}",
  "declaration.stages.04: {look, meaning, notes}",
  "declaration.stages.05: {look, meaning, notes}",
  "declaration.stages.06: {look, meaning, notes}",
  "declaration.stages: {01, 02, 03, 04, 05, 06}",
  "declaration: {axis, components, effort, lanes, measures, observe, ratios, stages, title}",
  "judged_by: {model, self_reported}",
  "measure.axis.last_review: {date, from, model, record}",
  "measure.axis.reasons[]: {detail, trigger}",
  "measure.axis.unjudged[]: {trigger, why}",
  "measure.axis: {last_review, reasons, review_needed, unjudged, version}",
  "measure.components.found.*: {kinds, status}",
  "measure.components.kind_changed[]: {after, before, key}",
  "measure.components: {found, gone, kind_changed, unacknowledged}",
  "measure.effort.active_ms: {claude, codex, union}",
  "measure.effort.daily[].active_ms: {claude, codex, union}",
  "measure.effort.daily[]: {active_ms, commits, date, output_tokens}",
  "measure.effort: {active_ms, commits, daily, elapsed_days, output_tokens, sessions_without_tokens, start, time_zone}",
  "measure.freshness.unimported: {new, unverifiable, updated}",
  "measure.freshness: {newest_session_at, unimported}",
  "measure.integrity: {by_status, not_verified}",
  "measure.measured_with: {basou, build}",
  "measure.measures.*: {lane, unit, value}",
  "measure.methods: {axis, components, effort, freshness, integrity, portfolio, repos, review_gaps, trail}",
  "measure.not_found[]: {at, reason}",
  "measure.portfolio: {initialized, workspaces}",
  "measure.ratios.*: {denominator, numerator, value}",
  "measure.repos[]: {ahead, base, behind, branch, commits, fetched_at, files, head, last_commit, name, path, uncommitted}",
  "measure.review_gaps: {by_verdict, gaps}",
  "measure.trail.tracks_open[]: {id, title}",
  "measure.trail: {decisions_all, decisions_live, tracks_open}",
  "measure: {axis, board_version, complete, components, digest, effort, freshness, integrity, measured_at, measured_with, measures, methods, not_found, portfolio, ratios, repos, review_gaps, title, trail}",
  "observed.*.value: {capture, count, final_url, redirects, status, words}",
  "observed.*: {error, observed_at, source, value}",
  "order_anomalies[]: {before, lane, stage, state}",
  "prose.operator_turns[]: {source, text}",
  "prose: {footnotes, lanes, operator_turns, summary}",
  "recorded_with: {basou, build}",
];
