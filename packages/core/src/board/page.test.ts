import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boardPage } from "./page.js";

// Names in the order a ULID sorts in, written at 1, 2 and 3 ms after the epoch.
const [A, B, C] = [
  "00000000010000000000000000",
  "00000000020000000000000000",
  "00000000030000000000000000",
];

const STAGES = Object.fromEntries(
  ["01", "02", "03", "04", "05", "06"].map((id) => [id, { meaning: `stage ${id}` }]),
);

function cells(states: Record<string, string[]>) {
  return Object.entries(states).flatMap(([lane, list]) =>
    list.map((state, i) => ({
      lane,
      stage: `0${i + 1}`,
      state,
      ...(state === "blocked" || state === "shelved" || state === "unverified"
        ? { reason: `why ${lane} 0${i + 1}` }
        : {}),
    })),
  );
}

// A record as basou board record writes it, cut to what the page reads and a
// little more.
function record(over: Record<string, unknown> = {}) {
  return {
    record_version: 1,
    recorded_at: "2026-10-07T00:00:00.000Z",
    recorded_with: { basou: "0.65.0", build: null },
    declaration: {
      title: "Test board",
      // Out of order, as an object may hold them.
      stages: { "06": STAGES["06"], ...STAGES },
      lanes: [
        { id: "core", name: "Core", about: "the core" },
        { id: "docs", name: "Docs", notes: ["a note"] },
      ],
      measures: [
        { id: "src", kind: "line_count", unit: "lines", lane: "core" },
        { id: "test", kind: "line_count", unit: "lines" },
      ],
      ratios: [{ id: "r", label: "Tests to source", numerator: "test", denominator: "src" }],
      components: {},
      axis: { version: 2, review_due_days: 60 },
      effort: {
        start: "2026-04-28",
        milestones: [{ date: "2026-05-04", label: "Started", ref: "abc1234" }],
      },
    },
    measure: {
      board_version: 1,
      measured_with: { basou: "0.65.0", build: "abcdef0" },
      complete: false,
      not_found: [{ at: "measures.test", reason: "no such file" }],
      digest: `sha256:${"a".repeat(64)}`,
      methods: { repos: 1, trail: 1, integrity: 1, components: 2, axis: 2 },
      measures: {
        src: { value: 100, unit: "lines", lane: "core" },
        test: { value: null, unit: "lines" },
      },
      ratios: { r: { value: null, numerator: "test", denominator: "src" } },
      trail: {
        decisions_all: 9,
        decisions_live: 8,
        tracks_open: [{ id: "decision_X", title: "X" }],
      },
      integrity: { by_status: { verified: 10, unchained: 2 }, not_verified: 2 },
      effort: {
        start: "2026-04-28",
        time_zone: "Asia/Tokyo",
        elapsed_days: 162,
        active_ms: { union: 7_200_000, claude: 7_000_000, codex: null },
        output_tokens: 1000,
        sessions_without_tokens: 1,
        commits: { ".": 12, "../basou": 34 },
        daily: [],
      },
      components: { found: {}, unacknowledged: [], gone: [], kind_changed: null },
      axis: {
        version: 2,
        review_needed: false,
        reasons: [],
        unjudged: [],
        last_review: { date: "2026-09-28", model: "Claude Opus 5.5", from: "seed" },
      },
    },
    observed: {
      npm: { value: "0.65.0", observed_at: "2026-10-07", source: "registry" },
      site: { value: null, observed_at: "2026-10-07", source: "site", error: "timeout" },
    },
    cells: cells({
      core: ["done", "done", "part", "blocked", "none", "none"],
      docs: ["done", "done", "done", "done", "done", "done"],
    }),
    prose: {
      summary: "All is `fine`.",
      lanes: { core: "Core is moving." },
      operator_turns: [{ text: "Decide X", source: "decision_X" }],
      footnotes: ["Measured with care."],
    },
    judged_by: { model: "Claude Opus 5.5", self_reported: true },
    axis_review: null,
    order_anomalies: [],
    ...over,
  };
}

describe("boardPage", () => {
  let dir: string;
  let records: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "basou-board-page-"));
    records = join(dir, "records");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const place = (id: string, value: unknown) =>
    writeFile(
      join(records, `${id}.json`),
      typeof value === "string" ? value : JSON.stringify(value),
    );

  it("has nothing to draw with no records, and lists the records it has by when they were written", async () => {
    expect(await boardPage(records)).toEqual({
      status: "unavailable",
      why: "no_records",
      detail: "",
      records: [],
    });
    await mkdir(records);
    await writeFile(join(records, ".record-1.tmp"), "{");
    expect((await boardPage(records)).status).toBe("unavailable");
    await place(A, record());
    await place(B, record());
    const page = await boardPage(records);
    expect(page.records).toEqual([
      { id: A, at: "1970-01-01T00:00:00.001Z" },
      { id: B, at: "1970-01-01T00:00:00.002Z" },
    ]);
    expect(page).toMatchObject({ status: "ok", id: B, older: A, newer: null });
    expect(await boardPage(records, A)).toMatchObject({
      status: "ok",
      id: A,
      older: null,
      newer: B,
    });
    expect(await boardPage(records, C)).toMatchObject({
      status: "unavailable",
      why: "not_found",
      detail: C,
    });
  });

  it("draws the heading, the tiles and the observations from the record", async () => {
    await mkdir(records);
    await place(A, record());
    const page = await boardPage(records);
    if (page.status !== "ok") throw new Error(page.detail);
    const b = page.board;
    expect(b.heading).toEqual({
      title: "Test board",
      recorded_at: "2026-10-07T00:00:00.000Z",
      model: "Claude Opus 5.5",
      complete: false,
      not_found: 1,
    });
    expect(b.summary.text).toBe("All is `fine`.");
    expect(b.summary.tiles).toEqual([
      { key: "live_lanes", value: 1, detail: 2, reported: true },
      { key: "blocked", value: 1, reported: true },
      { key: "unverified", value: 0, reported: true },
      { key: "open_tracks", value: 1, reported: false },
      { key: "sessions", value: 12, detail: 2, reported: false },
      { key: "turns", value: 1, reported: true },
    ]);
    // A lane in operation is one whose last stage is done, not begun or blocked.
    await place(
      B,
      record({
        cells: cells({
          core: ["done", "done", "done", "done", "done", "part"],
          docs: ["done", "done", "done", "done", "done", "blocked"],
        }),
      }),
    );
    const latest = await boardPage(records);
    if (latest.status !== "ok") throw new Error(latest.detail);
    expect(latest.board.summary.tiles[0]).toEqual({
      key: "live_lanes",
      value: 0,
      detail: 2,
      reported: true,
    });
    // The first record has no previous one to take a value from.
    expect(b.summary.observed).toEqual([
      { name: "npm", value: "0.65.0", observed_at: "2026-10-07", source: "registry" },
      {
        name: "site",
        value: null,
        observed_at: "2026-10-07",
        source: "site",
        error: "timeout",
        previous: { status: "none" },
      },
    ]);
  });

  it("takes an observation not made from the previous record, and marks the cells that moved", async () => {
    await mkdir(records);
    await place(
      A,
      record({
        observed: { site: { value: "0.64.0", observed_at: "2026-10-01", source: "site" } },
        cells: cells({
          core: ["done", "part", "none", "none", "none", "none"],
          docs: ["done", "done", "done", "done", "done", "done"],
        }),
      }),
    );
    await place(B, record());
    const page = await boardPage(records);
    if (page.status !== "ok") throw new Error(page.detail);
    expect(page.board.summary.observed[1]?.previous).toEqual({ status: "value", value: "0.64.0" });
    const core = page.board.matrix.lanes[0];
    expect(core?.cells.map((c) => c.moved_from ?? "")).toEqual([
      "",
      "part",
      "none",
      "none",
      "",
      "",
    ]);
    expect(core?.cells[3]).toEqual({
      stage: "04",
      state: "blocked",
      reason: "why core 04",
      moved_from: "none",
    });
    // A cell the previous record did not have has not moved, and a value it
    // did not observe either is no previous value.
    await place(
      A,
      record({
        observed: { site: { value: null, observed_at: "2026-10-01", source: "site", error: "x" } },
        cells: cells({ core: ["done", "part", "none", "none", "none", "none"] }),
      }),
    );
    const fresh = await boardPage(records);
    if (fresh.status !== "ok") throw new Error(fresh.detail);
    expect(fresh.board.summary.observed[1]?.previous).toEqual({ status: "none" });
    expect(fresh.board.matrix.lanes[1]?.cells.some((c) => "moved_from" in c)).toBe(false);
    expect(fresh.board.matrix.lanes[0]?.cells[1]?.moved_from).toBe("part");
    // With the previous record unreadable, nothing is marked and the value is not known.
    await place(A, "{ not json");
    const unread = await boardPage(records);
    if (unread.status !== "ok") throw new Error(unread.detail);
    expect(unread.board.summary.observed[1]?.previous).toEqual({ status: "unreadable" });
    expect(unread.board.matrix.lanes[0]?.cells.some((c) => c.moved_from !== undefined)).toBe(false);
  });

  it("draws the matrix by the stages the record holds, and each lane where it is", async () => {
    await mkdir(records);
    await place(
      A,
      record({ order_anomalies: [{ lane: "core", stage: "05", state: "none", before: "06" }] }),
    );
    const page = await boardPage(records);
    if (page.status !== "ok") throw new Error(page.detail);
    const b = page.board;
    expect(b.matrix.stages.map((s) => s.id)).toEqual(["01", "02", "03", "04", "05", "06"]);
    expect(b.matrix.anomalies).toEqual([
      { lane: "core", stage: "05", state: "none", before: "06" },
    ]);
    expect(b.lanes).toEqual([
      {
        id: "core",
        name: "Core",
        about: "the core",
        now: { stage: "03", meaning: "stage 03", state: "part" },
        attention: [{ stage: "04", state: "blocked", reason: "why core 04" }],
        prose: "Core is moving.",
        measures: [{ id: "src", value: 100, unit: "lines" }],
        flags: { live: false, blocked: true, unverified: false },
      },
      {
        id: "docs",
        name: "Docs",
        notes: ["a note"],
        now: { stage: "06", meaning: "stage 06", state: "done" },
        attention: [],
        prose: null,
        measures: [],
        flags: { live: true, blocked: false, unverified: false },
      },
    ]);
  });

  it("draws the composition, the effort, the turns and the footnotes from the record", async () => {
    await mkdir(records);
    await place(A, record());
    const page = await boardPage(records);
    if (page.status !== "ok") throw new Error(page.detail);
    const b = page.board;
    expect(b.composition).toEqual([
      {
        id: "r",
        label: "Tests to source",
        value: null,
        numerator: { id: "test", value: null, unit: "lines" },
        denominator: { id: "src", value: 100, unit: "lines" },
      },
    ]);
    expect(b.effort).toEqual({
      start: "2026-04-28",
      time_zone: "Asia/Tokyo",
      elapsed_days: 162,
      active_ms: { union: 7_200_000, claude: 7_000_000, codex: null },
      output_tokens: 1000,
      sessions_without_tokens: 1,
      commits: [
        { repo: ".", count: 12 },
        { repo: "../basou", count: 34 },
      ],
      milestones: [{ date: "2026-05-04", label: "Started", ref: "abc1234" }],
    });
    expect(b.turns).toEqual([{ text: "Decide X", source: "decision_X" }]);
    expect(b.footnotes).toEqual({
      notes: ["Measured with care."],
      axis: {
        version: 2,
        review_needed: false,
        last_review: { date: "2026-09-28", model: "Claude Opus 5.5", from: "seed" },
      },
      model: "Claude Opus 5.5",
      not_found: [{ at: "measures.test", reason: "no such file" }],
      measured_with: { basou: "0.65.0", build: "abcdef0" },
    });
  });

  it("does not draw a record it cannot read, of a version it does not know, or not in the shape of one", async () => {
    await mkdir(records);
    await place(A, "{ not json");
    expect(await boardPage(records)).toMatchObject({
      status: "unavailable",
      why: "unreadable",
      detail: `the record ${A} could not be read as JSON`,
    });
    await place(A, record({ record_version: 2 }));
    expect(await boardPage(records)).toMatchObject({
      why: "unreadable",
      detail: `the record ${A} is of record_version 2, which this basou does not draw`,
    });
    await place(A, record({ prose: { summary: 1 } }));
    expect(await boardPage(records)).toMatchObject({
      why: "unreadable",
      detail: `the record ${A} is not in the shape of a record`,
    });
    // A key the page does not draw is let through.
    await place(A, record({ later: { added: true } }));
    expect((await boardPage(records)).status).toBe("ok");
  });

  it("does not read a records/ that is a link", async () => {
    const elsewhere = join(dir, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, records);
    expect(await boardPage(records)).toMatchObject({ status: "unavailable", why: "unreadable" });
  });
});
