import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DecisionGap, DecisionGapsSummary } from "@basou/core";
import {
  basouPaths,
  createManifest,
  DECISION_GAPS_EPOCH,
  ensureBasouDirectory,
  LOCAL_CLI_EVENT_SOURCE,
  writeManifest,
  writeYamlFile,
} from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GAP_LIMIT,
  doRunDecisionGaps,
  parseLimit,
  parseSince,
  renderDecisionGaps,
} from "./decision-gaps.js";

const execFileAsync = promisify(execFile);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
const WS = "ws_01HXABCDEF1234567890ABCDEF";
const NOW = new Date("2026-09-20T00:00:00.000Z");
const SES = "ses_01HXABCDEF1234567890ABC001";
const DEC = "decision_01HXABCDEF1234567890ABC001";
const TASK = "task_01HXABCDEF1234567890ABC001";
/** After {@link DECISION_GAPS_EPOCH}, so the fixture lands inside the shipped population. */
const RECORDED_AT = "2026-09-19T00:00:00.000Z";

let tmpRepo: string | undefined;
beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-dg-cli-"));
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: tmpRepo, env: ENV });
});
afterEach(async () => {
  if (tmpRepo !== undefined) await rm(tmpRepo, { recursive: true, force: true });
  tmpRepo = undefined;
  process.exitCode = 0;
  vi.restoreAllMocks();
});
function repo(): string {
  if (tmpRepo === undefined) throw new Error("tmpRepo not initialized");
  return tmpRepo;
}

/** Every file under `dir`, with the size and mtime that a write would change. */
async function snapshotTree(dir: string): Promise<string[]> {
  const names = await readdir(dir, { recursive: true });
  const out: string[] = [];
  for (const name of names) {
    const full = join(dir, name);
    const s = await stat(full);
    out.push(s.isFile() ? `${full} ${s.size} ${s.mtimeMs}` : `${full}/`);
  }
  return out.sort();
}

async function setupWorkspace(): Promise<void> {
  const paths = await ensureBasouDirectory(repo());
  await writeManifest(paths, createManifest({ workspaceName: "ws", now: NOW, workspaceId: WS }));
}

async function placeDecisionSession(source = LOCAL_CLI_EVENT_SOURCE): Promise<void> {
  const paths = basouPaths(repo());
  const dir = join(paths.sessions, SES);
  await mkdir(dir, { recursive: true });
  await writeYamlFile(join(dir, "session.yaml"), {
    schema_version: "0.1.0",
    session: {
      id: SES,
      label: "decision fixture",
      task_id: null,
      workspace_id: WS,
      source: { kind: "human", version: "0.1.0" },
      started_at: RECORDED_AT,
      status: "completed",
      working_directory: "/tmp/fixture",
      invocation: { command: "basou", args: [], exit_code: null },
      related_files: [],
      events_log: "events.jsonl",
    },
  });
  await writeFile(
    join(dir, "events.jsonl"),
    `${JSON.stringify({
      schema_version: "0.3.0",
      id: "evt_01HXABCDEF1234567890AB0001",
      session_id: SES,
      occurred_at: RECORDED_AT,
      source,
      type: "decision_recorded",
      decision_id: DEC,
      title: "ship the thing",
    })}\n`,
  );
}

describe("parseSince", () => {
  it("resolves a duration against the supplied clock", () => {
    expect(parseSince("7d", NOW)).toBe("2026-09-13T00:00:00.000Z");
    expect(parseSince("36h", NOW)).toBe("2026-09-18T12:00:00.000Z");
    expect(parseSince("90m", NOW)).toBe("2026-09-19T22:30:00.000Z");
  });

  it("accepts an ISO instant and normalises it", () => {
    expect(parseSince("2026-09-01T09:00:00+09:00", NOW)).toBe("2026-09-01T00:00:00.000Z");
  });

  it("rejects text that is neither", () => {
    expect(() => parseSince("last tuesday", NOW)).toThrow(/ISO timestamp or a duration/u);
  });

  it("rejects a bare number rather than reading it as a two-digit year", () => {
    // `Date.parse("5")` is the year 2005, which would put the whole history in
    // scope — from dropping one character of "5d".
    for (const v of ["5", "12", "0"]) {
      expect(() => parseSince(v, NOW)).toThrow(/needs a unit/u);
    }
  });
});

describe("parseLimit", () => {
  it("accepts a non-negative integer and rejects anything else", () => {
    expect(parseLimit("0")).toBe(0);
    expect(parseLimit("25")).toBe(25);
    expect(() => parseLimit("-1")).toThrow(/non-negative integer/u);
    expect(() => parseLimit("2.5")).toThrow(/non-negative integer/u);
    // `Number` would accept all of these; none is a count a reader typed.
    for (const v of ["1e2", "0x10", "", " "]) {
      expect(() => parseLimit(v)).toThrow(/non-negative integer/u);
    }
  });
});

describe("doRunDecisionGaps", () => {
  it("returns the decision as a gap when no task carries it", async () => {
    await setupWorkspace();
    await placeDecisionSession();

    const summary = await doRunDecisionGaps(
      { json: true },
      { cwd: repo(), nowProvider: () => NOW },
    );
    expect(summary.gaps.map((g) => g.decisionId)).toEqual([DEC]);
    expect(summary.populationCount).toBe(1);
    expect(summary.scope.start).toBe(DECISION_GAPS_EPOCH);
  });

  it("drops the gap once a task file names the decision id", async () => {
    await setupWorkspace();
    await placeDecisionSession();
    const paths = basouPaths(repo());
    await mkdir(paths.tasks, { recursive: true });
    await writeFile(join(paths.tasks, `${TASK}.md`), `covers ${DEC}\n`);

    const summary = await doRunDecisionGaps(
      { json: true },
      { cwd: repo(), nowProvider: () => NOW },
    );
    expect(summary.gaps).toEqual([]);
    expect(summary.carried).toBe(1);
  });

  it("honours --since, overriding the shipped start", async () => {
    await setupWorkspace();
    await placeDecisionSession();

    // The fixture is one day before NOW, so a 12h window must exclude it while
    // the shipped epoch includes it — the flag, not the constant, decided.
    const narrow = await doRunDecisionGaps(
      { json: true, since: "12h" },
      { cwd: repo(), nowProvider: () => NOW },
    );
    expect(narrow.populationCount).toBe(0);
    expect(narrow.excluded.byStart).toBe(1);
    expect(narrow.scope.start).toBe("2026-09-19T12:00:00.000Z");
  });

  it("caps the list by default and lists everything under --limit 0", async () => {
    await setupWorkspace();
    await placeDecisionSession();

    const capped = await doRunDecisionGaps(
      { json: true, limit: 0 },
      { cwd: repo(), nowProvider: () => NOW },
    );
    // 0 means no limit, which is not the same as the default cap.
    expect(capped.gaps).toHaveLength(1);
    expect(capped.truncated).toBe(0);
    expect(DEFAULT_GAP_LIMIT).toBeGreaterThan(0);
  });

  it("prints JSON under --json and the rendered report otherwise", async () => {
    await setupWorkspace();
    await placeDecisionSession();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await doRunDecisionGaps({}, { cwd: repo(), nowProvider: () => NOW });
    await doRunDecisionGaps({ json: true }, { cwd: repo(), nowProvider: () => NOW });

    expect(log.mock.calls[0]?.[0]).toContain("# Decision gaps");
    expect(() => JSON.parse(String(log.mock.calls[1]?.[0]))).not.toThrow();
  });

  it("writes nothing to the workspace", async () => {
    await setupWorkspace();
    await placeDecisionSession();
    const paths = basouPaths(repo());
    await mkdir(paths.tasks, { recursive: true });
    vi.spyOn(console, "log").mockImplementation(() => {});

    // Compared against a snapshot taken from the filesystem itself, not against
    // an expectation this test wrote: every path under `.basou`, with each
    // file's size and mtime. A command that touched anything moves one of them.
    const before = await snapshotTree(paths.root);
    await doRunDecisionGaps({ json: true }, { cwd: repo(), nowProvider: () => NOW });
    expect(await snapshotTree(paths.root)).toEqual(before);
    expect(before.length).toBeGreaterThan(0);
  });
});

const gap = (over: Partial<DecisionGap> = {}): DecisionGap => ({
  decisionId: DEC,
  title: "ship the thing",
  recordedAt: RECORDED_AT,
  sessionId: SES,
  ...over,
});

const summaryOf = (
  gaps: DecisionGap[],
  over: Partial<DecisionGapsSummary> = {},
): DecisionGapsSummary => ({
  generatedAt: NOW.toISOString(),
  scope: { start: DECISION_GAPS_EPOCH, source: LOCAL_CLI_EVENT_SOURCE },
  gaps,
  truncated: 0,
  carried: 0,
  populationCount: gaps.length,
  excluded: { byStart: 0, bySource: 0, track: 0, voided: 0 },
  incomplete: { sessions: 0, tasks: 0, unknownReferences: 0 },
  tasksScanned: 0,
  ...over,
});

describe("renderDecisionGaps", () => {
  it("lists a gap with its full decision id and states the scope", () => {
    const out = renderDecisionGaps(summaryOf([gap()]));
    expect(out).toContain("Open decisions no task carries: 1 of 1 in scope");
    expect(out).toContain("ship the thing");
    // The whole id: it is what the reader pastes into `basou task new`.
    expect(out).toContain(DEC);
    expect(out).toContain(DECISION_GAPS_EPOCH);
    // `decision record` stamps the same source as `decision capture`, so naming
    // only one of them would tell a reader the list does not cover them.
    expect(out).toContain("recorded by running basou");
    expect(out).not.toContain("i.e. by `basou decision capture`");
  });

  it("names the four exclusion grounds in the order they are applied", () => {
    const out = renderDecisionGaps(
      summaryOf([gap()], {
        excluded: { byStart: 1400, bySource: 30, track: 12, voided: 5 },
      }),
    );
    expect(out).toContain(
      "1400 recorded earlier, then 30 recorded by something other than basou itself, then 12 tracks (already shown every session by `basou orient` until closed), then 5 closed with `basou decision void`",
    );
  });

  it("shows the remainder as a count when the list is capped", () => {
    const out = renderDecisionGaps(summaryOf([gap()], { truncated: 41, populationCount: 42 }));
    expect(out).toContain("Open decisions no task carries: 42 of 42 in scope");
    expect(out).toContain("... +41 more");
  });

  it("states the zero case as what was checked, not as a clear", () => {
    const empty = renderDecisionGaps(summaryOf([], { populationCount: 0 }));
    expect(empty).toContain("there is nothing to check yet");
    expect(empty).not.toContain("✅");

    const clean = renderDecisionGaps(summaryOf([], { populationCount: 3, carried: 3 }));
    // Hedged: the answer rests on hand-editable task files, so it reports the
    // scope of the check rather than asserting nothing is waiting.
    expect(clean).toContain("Within what was checked");
    expect(clean).toContain("3 open decisions in scope");
  });

  it("warns when a session could not be read, because the numbers are then incomplete", () => {
    const out = renderDecisionGaps(
      summaryOf([gap()], { incomplete: { sessions: 2, tasks: 0, unknownReferences: 0 } }),
    );
    expect(out).toContain("2 sessions could not be read in full");
    // Hedged: a log that fails partway has already yielded some events, so what
    // was lost is not knowable from here.
    expect(out).toContain("may be missing from these numbers");
  });

  it("warns when a task file could not be read, because a listed gap may be wrong", () => {
    const out = renderDecisionGaps(
      summaryOf([gap()], {
        tasksScanned: 4,
        incomplete: { sessions: 0, tasks: 1, unknownReferences: 0 },
      }),
    );
    expect(out).toContain("1 task file could not be read");
    expect(out).toContain("listed above as if nothing did");
  });

  it("reports an id a task names that no decision has", () => {
    const out = renderDecisionGaps(
      summaryOf([gap()], { incomplete: { sessions: 0, tasks: 0, unknownReferences: 2 } }),
    );
    expect(out).toContain("2 decision ids named by a task match no decision in this store");
    expect(out).toContain("not counted as carrying anything");
  });

  it("omits the incomplete warning when everything was read", () => {
    const out = renderDecisionGaps(summaryOf([gap()], { tasksScanned: 4 }));
    expect(out).not.toContain("could not be read");
    expect(out).not.toContain("match no decision in this store");
    // The only warning left is the gaps header itself, not an incomplete-read note.
    expect(out.split("\n").filter((l) => l.startsWith("- ⚠️"))).toEqual([]);
  });

  it("says so when a record's clock is ahead, rather than calling it recent", () => {
    const out = renderDecisionGaps(summaryOf([gap({ recordedAt: "2026-09-21T00:00:00.000Z" })]));
    expect(out).toContain("clock ahead");
  });

  it("flattens a multi-line title so it cannot restructure the report", () => {
    const out = renderDecisionGaps(summaryOf([gap({ title: "first\n## injected heading" })]));
    expect(out).not.toContain("\n## injected heading");
    expect(out).toContain("first ## injected heading");
  });
});
