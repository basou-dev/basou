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
        // Sunday, then Monday to Wednesday; Tuesday's time not measured.
        daily: [
          {
            date: "2026-10-04",
            active_ms: { union: 60_000, claude: 60_000, codex: null },
            output_tokens: 1,
            commits: { ".": 1, "../basou": 2 },
          },
          {
            date: "2026-10-05",
            active_ms: { union: 180_000, claude: 120_000, codex: 90_000 },
            output_tokens: 1,
            commits: { ".": 0, "../basou": 3 },
          },
          {
            date: "2026-10-06",
            active_ms: { union: null, claude: null, codex: null },
            output_tokens: null,
            commits: { ".": null, "../basou": null },
          },
          {
            date: "2026-10-07",
            active_ms: { union: 0, claude: 0, codex: 0 },
            output_tokens: 0,
            commits: { ".": 0, "../basou": 0 },
          },
        ],
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
      records: [],
      id: null,
      older: null,
      newer: null,
    });
    await mkdir(records);
    await writeFile(join(records, ".record-1.tmp"), "{");
    expect((await boardPage(records)).status).toBe("unavailable");
    await place(A, record());
    await place(B, record({ recorded_at: "2026-10-08T09:30:00.000Z" }));
    const page = await boardPage(records);
    // Each by its own recorded_at, not by the time its name holds.
    expect(page.records).toEqual([
      { id: A, at: "2026-10-07T00:00:00.000Z" },
      { id: B, at: "2026-10-08T09:30:00.000Z" },
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
      id: C,
      older: null,
      newer: null,
    });
  });

  it("draws a record of version 2, which holds the observations declared, after one of version 1", async () => {
    await mkdir(records);
    await place(A, record());
    const v2 = record({ record_version: 2 });
    v2.declaration = {
      ...v2.declaration,
      observe: [{ key: "npm_cli", kind: "npm_version", package: "@scope/cli" }],
    } as typeof v2.declaration;
    await place(B, v2);
    const page = await boardPage(records);
    if (page.status !== "ok") throw new Error(page.why);
    expect(page.id).toBe(B);
    expect(page.board.heading.title).toBe("Test board");
    const older = await boardPage(records, A);
    expect(older.status).toBe("ok");
  });

  it("draws a record of version 3, which holds an http observation, its value as it is", async () => {
    await mkdir(records);
    await place(A, record({ record_version: 2 }));
    const v3 = record({
      record_version: 3,
      observed: {
        shop: {
          value: { status: 404, redirects: 0, final_url: "https://example.com/x", words: null },
          observed_at: "2026-10-07T00:00:00Z",
          source: "https://example.com/x",
        },
      },
    });
    v3.declaration = {
      ...v3.declaration,
      observe: [{ key: "shop", kind: "http", url: "https://example.com/x", words: ["in stock"] }],
    } as typeof v3.declaration;
    await place(B, v3);
    const page = await boardPage(records);
    if (page.status !== "ok") throw new Error(page.why);
    expect(page.id).toBe(B);
    expect(page.board.summary.observed).toEqual([
      {
        name: "shop",
        value: { status: 404, redirects: 0, final_url: "https://example.com/x", words: null },
        observed_at: "2026-10-07T00:00:00Z",
        source: "https://example.com/x",
        // Read as its parts: the body of a 404 is not read.
        http: { status: 404, redirects: 0, final_url: "https://example.com/x", body: null },
        kind: "http",
        looks_at: ["https://example.com/x"],
        // The record before it observed no such thing.
        moved: { status: "none" },
      },
    ]);
    expect((await boardPage(records, A)).status).toBe("ok");
  });

  it("pairs an http observation's words with those its record declares, when the value holds one for each", async () => {
    await mkdir(records);
    const value = (words: unknown) => ({
      status: 200,
      redirects: 1,
      final_url: "https://example.com/x/",
      words,
      count: 2,
    });
    const made = (v: unknown) => ({ value: v, observed_at: "2026-10-07T00:00:00Z", source: "s" });
    const v3 = record({
      record_version: 3,
      observed: {
        shop: made(value([true, false])),
        short: made(value([true])),
        long: made(value([true, false, true])),
        one: made(value([false])),
        page: made({ words: [true] }),
        list: made([true]),
        gone: { ...made(null), error: "timeout" },
      },
    });
    const http = (key: string, words: string[]) => ({
      key,
      kind: "http",
      url: "https://example.com/x",
      words,
    });
    v3.declaration = {
      ...v3.declaration,
      observe: [
        http("shop", ["in stock", "42"]),
        http("short", ["a", "b"]),
        http("long", ["a", "b"]),
        http("one", ["solo"]),
        // Words on another kind, which basou does not write, are not paired.
        { key: "page", kind: "page_version", url: "https://example.com/", words: ["a"] },
        http("list", ["a"]),
        http("gone", ["a"]),
      ],
    } as typeof v3.declaration;
    await place(A, v3);
    const page = await boardPage(records);
    if (page.status !== "ok") throw new Error(page.why);
    const observed = page.board.summary.observed;
    expect(observed.map((o) => o.name)).toEqual([
      "shop",
      "short",
      "long",
      "one",
      "page",
      "list",
      "gone",
    ]);
    expect(observed[0]?.words).toEqual([
      { word: "in stock", found: true },
      { word: "42", found: false },
    ]);
    // The value is kept as the record holds it.
    expect(observed[0]?.value).toEqual(value([true, false]));
    expect(observed[3]?.words).toEqual([{ word: "solo", found: false }]);
    for (const o of [observed[1], observed[2], ...observed.slice(4)]) {
      expect(Object.hasOwn(o as object, "words"), o?.name).toBe(false);
    }
  });

  it("does not pair the previous record's value of an observation this record did not make", async () => {
    await mkdir(records);
    const http = { key: "shop", kind: "http", url: "https://example.com/x", words: ["a"] };
    const at = (v: unknown) => {
      const r = record({
        record_version: 3,
        observed: { shop: { value: v, observed_at: "2026-10-07T00:00:00Z", source: "s" } },
      });
      r.declaration = { ...r.declaration, observe: [http] } as typeof r.declaration;
      return r;
    };
    await place(A, at({ status: 200, words: [true] }));
    await place(B, at(null));
    const page = await boardPage(records);
    if (page.status !== "ok") throw new Error(page.why);
    const [shop] = page.board.summary.observed;
    expect(shop?.previous).toEqual({ status: "value", value: { status: 200, words: [true] } });
    expect(Object.hasOwn(shop as object, "words")).toBe(false);
  });

  it("reads an http value in its shape as its parts, and draws one of another shape as it is", async () => {
    await mkdir(records);
    const made = (v: unknown) => ({ value: v, observed_at: "2026-10-07T00:00:00Z", source: "s" });
    const r = record({
      record_version: 3,
      observed: {
        shop: made({
          status: 200,
          redirects: 1,
          final_url: "https://example.com/x/",
          words: [true, false],
          count: 42,
          capture: "2.3",
        }),
        closed: made({
          status: 503,
          redirects: 0,
          final_url: "http://example.com/",
          words: null,
          count: null,
          capture: null,
        }),
        plain: made({ status: 301, redirects: 10, final_url: "https://example.com/y" }),
        nomatch: made({
          status: 200,
          redirects: 0,
          final_url: "https://a.example/",
          capture: null,
        }),
        // The last status of 2xx: its body was read.
        last: made({ status: 299, redirects: 0, final_url: "https://a.example/", words: [false] }),
        // As a record written before 0.72.0 may hold it.
        older: made({ status: 200, words: [true] }),
        asked: made({ status: 200, redirects: 0, final_url: "https://a.example/" }),
      },
    });
    const http = (key: string, more: Record<string, unknown> = {}) => ({
      key,
      kind: "http",
      url: `https://example.com/${key}`,
      ...more,
    });
    r.declaration = {
      ...r.declaration,
      observe: [
        http("shop", {
          words: ["in stock", "sold out"],
          count_pattern: "item",
          capture_pattern: "v(\\d)",
        }),
        http("closed", { words: ["a"], count_pattern: "b", capture_pattern: "(c)" }),
        http("plain"),
        http("nomatch", { capture_pattern: "(c)" }),
        http("last", { words: ["a"] }),
        http("older", { words: ["a"] }),
        { key: "asked", kind: "manual", how: "ask" },
      ],
    } as typeof r.declaration;
    await place(A, r);
    const page = await boardPage(records);
    if (page.status !== "ok") throw new Error(page.why);
    const byName = new Map(page.board.summary.observed.map((o) => [o.name, o]));
    expect(byName.get("shop")?.http).toEqual({
      status: 200,
      redirects: 1,
      final_url: "https://example.com/x/",
      body: {
        words: [
          { word: "in stock", found: true },
          { word: "sold out", found: false },
        ],
        count: 42,
        capture: "2.3",
      },
    });
    // Not 2xx: the body was not read.
    expect(byName.get("closed")?.http).toEqual({
      status: 503,
      redirects: 0,
      final_url: "http://example.com/",
      body: null,
    });
    // Nothing read off the body: no body at all.
    expect(byName.get("plain")?.http).toEqual({
      status: 301,
      redirects: 10,
      final_url: "https://example.com/y",
    });
    expect(byName.get("nomatch")?.http?.body).toEqual({ capture: null });
    expect(byName.get("last")?.http?.body).toEqual({ words: [{ word: "a", found: false }] });
    // Out of the shape its declaration gives it, or of a kind with no shape: as it is.
    expect(byName.get("older")?.http).toBeUndefined();
    expect(byName.get("older")?.words).toEqual([{ word: "a", found: true }]);
    expect(byName.get("asked")?.http).toBeUndefined();
    expect(byName.get("asked")?.kind).toBe("manual");
  });

  it("gives each observation its kind, what it looks at and its notes, as the record declares them", async () => {
    await mkdir(records);
    const made = { value: "x", observed_at: "2026-10-07", source: "s" };
    const r = record({
      record_version: 3,
      observed: { ci: made, check: made, npm: made, page: made, odd: made, undeclared: made },
    });
    r.declaration = {
      ...r.declaration,
      observe: [
        {
          key: "ci",
          kind: "github_ci",
          repo: "owner/app",
          workflow: "quality.yml",
          branch: "main",
          notes: ["the main branch", "`gh` must be signed in"],
        },
        {
          key: "check",
          kind: "github_check",
          repo: "owner/app",
          check: "Builds: app",
          branch: "main",
        },
        { key: "npm", kind: "npm_version", package: "@scope/cli" },
        { key: "page", kind: "page_version", url: "https://example.com/" },
        // A key not in its shape is left out, the rest of the entry kept.
        { key: "odd", kind: "github_release", repo: 1, notes: "not a list" },
      ],
    } as typeof r.declaration;
    await place(A, r);
    const page = await boardPage(records);
    if (page.status !== "ok") throw new Error(page.why);
    const drawn = page.board.summary.observed.map(({ name, kind, looks_at, notes }) => ({
      name,
      kind,
      looks_at,
      notes,
    }));
    expect(drawn).toEqual([
      {
        name: "ci",
        kind: "github_ci",
        looks_at: ["owner/app", "quality.yml"],
        notes: ["the main branch", "`gh` must be signed in"],
      },
      {
        name: "check",
        kind: "github_check",
        looks_at: ["owner/app", "Builds: app"],
        notes: undefined,
      },
      { name: "npm", kind: "npm_version", looks_at: ["@scope/cli"], notes: undefined },
      { name: "page", kind: "page_version", looks_at: ["https://example.com/"], notes: undefined },
      { name: "odd", kind: "github_release", looks_at: undefined, notes: undefined },
      { name: "undeclared", kind: undefined, looks_at: undefined, notes: undefined },
    ]);
    for (const o of page.board.summary.observed.slice(1)) {
      expect(Object.hasOwn(o, "notes"), o.name).toBe(false);
    }
  });

  it("marks an observation that moved since the previous record, with what that record held by its own declaration", async () => {
    await mkdir(records);
    const made = (v: unknown, error?: string) => ({
      value: v,
      observed_at: "2026-10-07",
      source: "s",
      ...(error === undefined ? {} : { error }),
    });
    const shop = (words: string[]) => ({
      key: "shop",
      kind: "http",
      url: "https://example.com/",
      words,
    });
    const at = (observed: Record<string, unknown>, words: string[]) => {
      const r = record({ record_version: 3, observed });
      r.declaration = { ...r.declaration, observe: [shop(words)] } as typeof r.declaration;
      return r;
    };
    const ok = (found: boolean) => ({
      status: 200,
      redirects: 0,
      final_url: "https://example.com/",
      words: [found],
    });
    await place(
      A,
      at(
        {
          npm: made("1.0.0"),
          same: made(3),
          flaky: made(3),
          count: made("12"),
          back: made(null, "timeout"),
          shop: made(ok(true)),
          gone: made(1),
          down: made("1.0.0"),
        },
        ["was"],
      ),
    );
    await place(
      B,
      at(
        {
          npm: made("1.1.0"),
          same: made(3),
          flaky: made(3, "partly"),
          count: made(12),
          back: made("ok"),
          shop: made(ok(false)),
          fresh: made(true),
          down: made(null, "timeout"),
        },
        ["is"],
      ),
    );
    const page = await boardPage(records);
    if (page.status !== "ok") throw new Error(page.why);
    expect(page.board.summary.previous_record).toBe("found");
    const moved = Object.fromEntries(page.board.summary.observed.map((o) => [o.name, o.moved]));
    expect(moved).toEqual({
      npm: { status: "value", value: "1.0.0" },
      same: undefined,
      // Its error moved, as record's diff says.
      flaky: { status: "value", value: 3 },
      count: { status: "value", value: "12" },
      back: { status: "value", value: null, error: "timeout" },
      // Drawn by the words the previous record declared, not this one's.
      shop: {
        status: "value",
        value: ok(true),
        words: [{ word: "was", found: true }],
        http: {
          status: 200,
          redirects: 0,
          final_url: "https://example.com/",
          body: { words: [{ word: "was", found: true }] },
        },
      },
      fresh: { status: "none" },
      // Not made now: drawn with its previous value, as before, unmarked.
      down: undefined,
    });
    const down = page.board.summary.observed.find((o) => o.name === "down");
    expect(down?.previous).toEqual({ status: "value", value: "1.0.0" });
    // The first record has no previous one, and marks nothing.
    const first = await boardPage(records, A);
    if (first.status !== "ok") throw new Error(first.why);
    expect(first.board.summary.previous_record).toBe("none");
    expect(first.board.summary.observed.some((o) => o.moved !== undefined)).toBe(false);
    // One that cannot be read marks nothing either, and says so.
    await place(A, "{ not json");
    const unread = await boardPage(records);
    if (unread.status !== "ok") throw new Error(unread.why);
    expect(unread.board.summary.previous_record).toBe("unreadable");
    expect(unread.board.summary.observed.some((o) => o.moved !== undefined)).toBe(false);
  });

  it("draws a record without marks when the previous record's observations are too deep to compare", async () => {
    await mkdir(records);
    const depth = 100_000;
    const deep = `${"[".repeat(depth)}"x"${"]".repeat(depth)}`;
    const made = (v: unknown) => ({ value: v, observed_at: "2026-10-07", source: "s" });
    const text = JSON.stringify(record({ observed: { npm: made("DEEP") } })).replace(
      '"DEEP"',
      deep,
    );
    await place(A, text);
    await place(
      B,
      record({
        observed: { npm: made("1.0.0") },
        cells: cells({
          core: ["done", "done", "done", "blocked", "none", "none"],
          docs: ["done", "done", "done", "done", "done", "done"],
        }),
      }),
    );
    const page = await boardPage(records);
    if (page.status !== "ok") throw new Error(page.why);
    expect(page.board.summary.previous_record).toBe("found");
    expect(page.board.summary.observed).toEqual([
      { name: "npm", value: "1.0.0", observed_at: "2026-10-07", source: "s" },
    ]);
    // The rest of what the previous record gives is still drawn.
    expect(page.board.matrix.lanes[0]?.cells[2]?.moved_from).toBe("part");
  });

  it("lists every measure, with the lanes it is drawn in and how much a number moved", async () => {
    await mkdir(records);
    const at = (values: Record<string, unknown>) => {
      const r = record({ record_version: 3 });
      r.declaration = {
        ...r.declaration,
        measures: [
          { id: "src", kind: "line_count", unit: "lines", lane: ["core", "docs"] },
          { id: "test", kind: "line_count", unit: "lines" },
          { id: "latest", kind: "file_name", unit: "name", lane: ["docs"] },
          { id: "mig", kind: "file_paths", unit: "files" },
          { id: "new", kind: "file_count", unit: "files" },
        ],
        ratios: [],
      } as typeof r.declaration;
      r.measure = {
        ...r.measure,
        measures: Object.fromEntries(
          Object.entries(values).map(([id, value]) => [id, { value, unit: "u" }]),
        ),
        ratios: {},
      } as unknown as typeof r.measure;
      return r;
    };
    await place(A, at({ src: 100, test: 40, latest: "a", mig: ["x"] }));
    await place(B, at({ src: 90, test: null, latest: "b", mig: ["x", "y"], new: 3 }));
    const page = await boardPage(records);
    if (page.status !== "ok") throw new Error(page.why);
    expect(page.board.measures).toEqual([
      { id: "src", value: 90, unit: "lines", lanes: ["Core", "Docs"], delta: -10 },
      { id: "test", value: null, unit: "lines", lanes: [], delta: null },
      { id: "latest", value: "b", unit: "name", lanes: ["Docs"], delta: null },
      { id: "mig", value: ["x", "y"], unit: "files", lanes: [], delta: null },
      // Not in the previous record.
      { id: "new", value: 3, unit: "files", lanes: [], delta: null },
    ]);
    // No previous record, or one that cannot be read: no change to give.
    const first = await boardPage(records, A);
    if (first.status !== "ok") throw new Error(first.why);
    expect(first.board.measures.map((m) => m.delta)).toEqual([null, null, null, null, null]);
    await place(A, "{ not json");
    const unread = await boardPage(records);
    if (unread.status !== "ok") throw new Error(unread.why);
    expect(unread.board.measures[0]?.delta).toBeNull();
    // A record of version 1 holds one lane id.
    await rm(join(records, `${B}.json`));
    await place(A, record());
    const v1 = await boardPage(records);
    if (v1.status !== "ok") throw new Error(v1.why);
    expect(v1.board.measures).toEqual([
      { id: "src", value: 100, unit: "lines", lanes: ["Core"], delta: null },
      { id: "test", value: null, unit: "lines", lanes: [], delta: null },
    ]);
  });

  it("draws the repos a record measured by its version", async () => {
    await mkdir(records);
    const repo = {
      path: ".",
      name: "app",
      head: "0123456789abcdef0123456789abcdef01234567",
      branch: "main",
      last_commit: "2026-10-06T12:00:00+09:00",
      commits: 12,
      files: 30,
      uncommitted: 1,
    };
    const v3 = record({ record_version: 3 });
    v3.measure = {
      ...v3.measure,
      repos: [
        {
          ...repo,
          base: "origin/main",
          behind: 2,
          ahead: 1,
          fetched_at: "2026-10-06T00:00:00.000Z",
        },
      ],
    } as typeof v3.measure;
    await place(A, v3);
    const page = await boardPage(records);
    if (page.status !== "ok") throw new Error(page.why);
    // Its files too, which a record of every version holds.
    const drawn = repo;
    expect(page.board.repos).toEqual({
      record_version: 3,
      base_measured: true,
      list: [
        {
          ...drawn,
          base: "origin/main",
          behind: 2,
          ahead: 1,
          fetched_at: "2026-10-06T00:00:00.000Z",
        },
      ],
    });
    // A record of version 1 or 2 counted the commits behind as behind_main,
    // and measured no base, ahead or fetch time. Files not measured are null.
    for (const version of [1, 2]) {
      const older = record({ record_version: version });
      older.measure = {
        ...older.measure,
        repos: [
          { ...repo, behind_main: 4 },
          { ...repo, path: "../lib", files: null, behind_main: null },
        ],
      } as typeof older.measure;
      await place(A, older);
      const read = await boardPage(records);
      if (read.status !== "ok") throw new Error(read.why);
      expect(read.board.repos).toEqual({
        record_version: version,
        base_measured: false,
        list: [
          { ...drawn, base: null, behind: 4, ahead: null, fetched_at: null },
          {
            ...drawn,
            path: "../lib",
            files: null,
            base: null,
            behind: null,
            ahead: null,
            fetched_at: null,
          },
        ],
      });
    }
    // None, or not in the shape of its version: drawn as none, the rest of the record drawn.
    const v3Repo = { ...repo, base: null, behind: 1, ahead: 0, fetched_at: null };
    for (const [version, repos] of [
      [3, undefined],
      [3, "x"],
      [3, [{ ...repo, behind_main: 4 }]],
      [3, [{ ...v3Repo, files: "30" }]],
      [2, [v3Repo]],
      [
        1,
        [
          { ...repo, behind_main: 4 },
          { ...repo, path: "../app" },
        ],
      ],
    ] as const) {
      const odd = record({ record_version: version });
      odd.measure = { ...odd.measure, repos } as typeof odd.measure;
      await place(A, odd);
      const read = await boardPage(records);
      if (read.status !== "ok") throw new Error(`${JSON.stringify(repos)}: ${read.why}`);
      expect(read.board.repos, `${version} ${JSON.stringify(repos)}`).toBeNull();
    }
  });

  it("draws the components a record found by the lanes its registry counts them in", async () => {
    await mkdir(records);
    const r = record({ record_version: 3 });
    r.declaration = {
      ...r.declaration,
      components: {
        "app/web": { lane: ["docs", "core"] },
        app: { lane: ["core"] },
        "app/db": { lane: ["core"] },
        "app/scripts": { lane: "-", note: "tooling, not a surface" },
      },
    } as typeof r.declaration;
    const found = JSON.parse(
      '{"app":{"kinds":["manifest"],"status":"known"},"app/web":{"kinds":["edge","manifest"],"status":"known"},"app/scripts":{"kinds":["marker"],"status":"known"},"app/new":{"kinds":["ci"],"status":"unacknowledged"},"__proto__":{"kinds":["build"],"status":"unacknowledged"}}',
    );
    r.measure = {
      ...r.measure,
      components: {
        found,
        unacknowledged: ["app/new", "__proto__"],
        gone: ["app/db", "app/old"],
        kind_changed: [{ key: "app/web", before: ["manifest"], after: ["edge", "manifest"] }],
      },
    } as unknown as typeof r.measure;
    await place(A, r);
    const page = await boardPage(records);
    if (page.status !== "ok") throw new Error(page.why);
    expect(page.board.components).toEqual({
      measured: true,
      reasons: [],
      lanes: [
        {
          id: "core",
          name: "Core",
          components: [
            { key: "app", kinds: ["manifest"] },
            { key: "app/db", kinds: null },
            {
              key: "app/web",
              kinds: ["edge", "manifest"],
              kind_changed: { before: ["manifest"], after: ["edge", "manifest"] },
            },
          ],
        },
        {
          id: "docs",
          name: "Docs",
          components: [
            {
              key: "app/web",
              kinds: ["edge", "manifest"],
              kind_changed: { before: ["manifest"], after: ["edge", "manifest"] },
            },
          ],
        },
      ],
      uncounted: [{ key: "app/scripts", kinds: ["marker"], note: "tooling, not a surface" }],
      unacknowledged: [
        { key: "__proto__", kinds: ["build"] },
        { key: "app/new", kinds: ["ci"] },
      ],
      gone: ["app/db", "app/old"],
    });
    // Not measured: why, from not_found.
    const unmeasured = record({ record_version: 3 });
    unmeasured.measure = {
      ...unmeasured.measure,
      not_found: [{ at: "components", reason: "two repos are in directories of the same name" }],
      components: { found: null, unacknowledged: null, gone: null, kind_changed: null },
    } as unknown as typeof unmeasured.measure;
    await place(A, unmeasured);
    const none = await boardPage(records);
    if (none.status !== "ok") throw new Error(none.why);
    expect(none.board.components).toEqual({
      measured: false,
      reasons: ["two repos are in directories of the same name"],
      lanes: [],
      uncounted: [],
      unacknowledged: [],
      gone: null,
    });
    // What was gone is not known when the record before could not be read.
    const unknown = record({ record_version: 3 });
    unknown.measure = {
      ...unknown.measure,
      components: { found: {}, unacknowledged: [], gone: null, kind_changed: null },
    } as unknown as typeof unknown.measure;
    await place(A, unknown);
    const notKnown = await boardPage(records);
    if (notKnown.status !== "ok") throw new Error(notKnown.why);
    expect(notKnown.board.components?.gone).toBeNull();
    // Not in its shape: drawn as none, the rest of the record drawn.
    for (const components of [undefined, "x", { found: { app: { kinds: "manifest" } } }]) {
      const odd = record({ record_version: 3 });
      odd.measure = { ...odd.measure, components } as unknown as typeof odd.measure;
      await place(A, odd);
      const read = await boardPage(records);
      if (read.status !== "ok") throw new Error(`${JSON.stringify(components)}: ${read.why}`);
      expect(read.board.components).toBeNull();
    }
  });

  it("draws a record whose declared observations are not in their shape, without their words", async () => {
    await mkdir(records);
    const words = { value: { words: [true] }, observed_at: "2026-10-07T00:00:00Z", source: "s" };
    const v3 = record({ record_version: 3, observed: { shop: words, good: words } });
    v3.declaration = {
      ...v3.declaration,
      // No kind: that one is drawn without its words, and the other with its.
      observe: [
        { key: "shop", words: ["a"] },
        { key: "good", kind: "http", url: "https://example.com/", words: ["b"] },
      ],
    } as typeof v3.declaration;
    await place(A, v3);
    const page = await boardPage(records);
    if (page.status !== "ok") throw new Error(page.why);
    const [shop, good] = page.board.summary.observed;
    expect(Object.hasOwn(shop as object, "words")).toBe(false);
    expect(good?.words).toEqual([{ word: "b", found: true }]);
    // Observations that are not a list: the record is still drawn, with no words.
    const listless = record({ record_version: 3, observed: { good: words } });
    listless.declaration = {
      ...listless.declaration,
      observe: "not a list",
    } as unknown as typeof listless.declaration;
    await place(B, listless);
    const later = await boardPage(records);
    if (later.status !== "ok") throw new Error(later.why);
    expect(later.id).toBe(B);
    expect(Object.hasOwn(later.board.summary.observed[0] as object, "words")).toBe(false);
  });

  it("draws a record of version 3 whose measures hold a name and the paths of files, in their lanes", async () => {
    await mkdir(records);
    const v3 = record({ record_version: 3 });
    v3.declaration = {
      ...v3.declaration,
      measures: [
        { id: "latest", kind: "file_name", unit: "name", lane: "core" },
        { id: "migrations", kind: "file_paths", unit: "files", lane: "core" },
      ],
      ratios: [],
    } as typeof v3.declaration;
    v3.measure = {
      ...v3.measure,
      measures: {
        latest: { value: "20260401", unit: "name", lane: "core" },
        migrations: { value: ["db/a.sql", "db/b.sql"], unit: "files", lane: "core" },
      },
      ratios: {},
    } as unknown as typeof v3.measure;
    await place(A, v3);
    const page = await boardPage(records);
    if (page.status !== "ok") throw new Error(page.why);
    expect(page.board.lanes[0]?.measures).toEqual([
      { id: "latest", value: "20260401", unit: "name" },
      { id: "migrations", value: ["db/a.sql", "db/b.sql"], unit: "files" },
    ]);
    // A list of anything but strings is not a measure's value.
    v3.measure = {
      ...v3.measure,
      measures: { migrations: { value: [1, 2], unit: "files" } },
    } as unknown as typeof v3.measure;
    await place(A, v3);
    expect(await boardPage(records)).toMatchObject({ why: "not_a_record" });
  });

  it("draws a measure of more than one lane in each of them, and one lane id of an older record in its lane", async () => {
    await mkdir(records);
    const v3 = record({ record_version: 3 });
    v3.declaration = {
      ...v3.declaration,
      measures: [
        { id: "site.pages", kind: "file_count", unit: "pages", lane: ["docs", "core"] },
        { id: "src", kind: "line_count", unit: "lines", lane: ["core"] },
        { id: "left", kind: "total", unit: "slots" },
      ],
      ratios: [],
    } as typeof v3.declaration;
    v3.measure = {
      ...v3.measure,
      measures: {
        "site.pages": { value: 12, unit: "pages", lane: ["docs", "core"] },
        src: { value: 100, unit: "lines", lane: ["core"] },
        left: { value: -3, unit: "slots" },
      },
      ratios: {},
    } as unknown as typeof v3.measure;
    await place(A, v3);
    const page = await boardPage(records);
    if (page.status !== "ok") throw new Error(page.why);
    expect(page.board.lanes.map((lane) => [lane.id, lane.measures])).toEqual([
      [
        "core",
        [
          { id: "site.pages", value: 12, unit: "pages" },
          { id: "src", value: 100, unit: "lines" },
        ],
      ],
      ["docs", [{ id: "site.pages", value: 12, unit: "pages" }]],
    ]);
    // A record of version 1 holds one lane id: it is the lane of that id,
    // not of every id it holds.
    const v1 = record();
    v1.declaration = {
      ...v1.declaration,
      lanes: [
        { id: "co", name: "Co" },
        { id: "core", name: "Core" },
      ],
    } as typeof v1.declaration;
    await place(B, v1);
    const older = await boardPage(records);
    if (older.status !== "ok") throw new Error(older.why);
    expect(older.board.lanes.map((lane) => [lane.id, lane.measures])).toEqual([
      ["co", []],
      ["core", [{ id: "src", value: 100, unit: "lines" }]],
    ]);
  });

  it("draws the heading, the tiles and the observations from the record", async () => {
    await mkdir(records);
    await place(A, record());
    const page = await boardPage(records);
    if (page.status !== "ok") throw new Error(page.why);
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
    if (latest.status !== "ok") throw new Error(latest.why);
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
    if (page.status !== "ok") throw new Error(page.why);
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
    if (fresh.status !== "ok") throw new Error(fresh.why);
    expect(fresh.board.summary.observed[1]?.previous).toEqual({ status: "none" });
    expect(fresh.board.matrix.lanes[1]?.cells.some((c) => "moved_from" in c)).toBe(false);
    expect(fresh.board.matrix.lanes[0]?.cells[1]?.moved_from).toBe("part");
    // With the previous record unreadable, nothing is marked and the value is not known.
    await place(A, "{ not json");
    const unread = await boardPage(records);
    if (unread.status !== "ok") throw new Error(unread.why);
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
    if (page.status !== "ok") throw new Error(page.why);
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
    if (page.status !== "ok") throw new Error(page.why);
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
      // Tuesday's time was not measured, so the days worked are not known.
      active_days: null,
      period_days: 4,
      daily: [
        {
          date: "2026-10-04",
          union: 60_000,
          claude: 60_000,
          not_claude: 0,
          cumulative: 60_000,
          commits: 3,
        },
        {
          date: "2026-10-05",
          union: 180_000,
          claude: 120_000,
          not_claude: 60_000,
          cumulative: 240_000,
          commits: 3,
        },
        {
          date: "2026-10-06",
          union: null,
          claude: null,
          not_claude: null,
          cumulative: null,
          commits: null,
        },
        { date: "2026-10-07", union: 0, claude: 0, not_claude: 0, cumulative: null, commits: 0 },
      ],
      weeks: [
        {
          week: "2026-09-28",
          union: 60_000,
          claude: 60_000,
          codex: null,
          active_days: 1,
          commits: 3,
        },
        // A week with a day not measured is not known as a whole.
        {
          week: "2026-10-05",
          union: null,
          claude: null,
          codex: null,
          active_days: null,
          commits: null,
        },
      ],
    });
    expect(b.turns).toEqual([{ text: "Decide X", source: "decision_X" }]);
    // A day one repo's commits of which were not measured has no total.
    const partly = record();
    partly.measure.effort.daily = [
      {
        date: "2026-10-04",
        active_ms: { union: 1, claude: 1, codex: 0 },
        output_tokens: 0,
        commits: { ".": 2, "../basou": null },
      },
      // A day with no time is not a day worked.
      {
        date: "2026-10-05",
        active_ms: { union: 0, claude: 0, codex: 0 },
        output_tokens: 0,
        commits: { ".": 0, "../basou": 0 },
      },
    ] as unknown as typeof partly.measure.effort.daily;
    await place(B, partly);
    const part = await boardPage(records);
    if (part.status !== "ok") throw new Error(part.why);
    expect(part.board.effort.daily?.[0]?.commits).toBeNull();
    expect(part.board.effort.weeks?.[0]).toMatchObject({ commits: null, active_days: 1 });
    expect(part.board.effort.active_days).toBe(1);
    // A day that is not a date of the calendar is not in the shape of a record.
    const undatedRow = record();
    (undatedRow.measure.effort.daily[0] as { date: string }).date = "x";
    await place(B, undatedRow);
    expect(await boardPage(records)).toMatchObject({
      status: "unavailable",
      why: "not_a_record",
      id: B,
    });
    // With no days measured there is nothing by day or by week, not none of them.
    const undated = record();
    undated.measure.effort.daily = null as unknown as typeof undated.measure.effort.daily;
    await place(B, undated);
    const noDays = await boardPage(records);
    if (noDays.status !== "ok") throw new Error(noDays.why);
    expect(noDays.board.effort).toMatchObject({
      active_days: null,
      period_days: null,
      daily: null,
      weeks: null,
    });
    await rm(join(records, `${B}.json`));
    expect(b.footnotes).toEqual({
      notes: ["Measured with care."],
      axis: {
        version: 2,
        review_needed: false,
        last_review: { date: "2026-09-28", model: "Claude Opus 5.5", from: "seed" },
        last_review_known: true,
        this_review: null,
      },
      model: "Claude Opus 5.5",
      not_found: [{ at: "measures.test", reason: "no such file" }],
      measured_with: { basou: "0.65.0", build: "abcdef0" },
    });
    expect(b.footnotes.axis.last_review_known).toBe(true);
    // A last review a record that could not be read may hold is not known, not none.
    const unknown = record();
    unknown.measure.axis.last_review = null as unknown as typeof unknown.measure.axis.last_review;
    unknown.measure.not_found = [
      { at: "axis.last_review", reason: "the last review is not known" },
    ];
    await place(A, unknown);
    const notKnown = await boardPage(records);
    if (notKnown.status !== "ok") throw new Error(notKnown.why);
    expect(notKnown.board.footnotes.axis).toMatchObject({
      last_review: null,
      last_review_known: false,
    });
    // A record that reviews the axis itself carries its review beside the one
    // measured before it was written.
    await place(
      A,
      record({ axis_review: { triggers: ["d", "b"], summary: "Moved `observe` in." } }),
    );
    const reviewed = await boardPage(records);
    if (reviewed.status !== "ok") throw new Error(reviewed.why);
    expect(reviewed.board.footnotes.axis).toEqual({
      version: 2,
      review_needed: false,
      last_review: { date: "2026-09-28", model: "Claude Opus 5.5", from: "seed" },
      last_review_known: true,
      this_review: { triggers: ["d", "b"], summary: "Moved `observe` in." },
    });
    // A record without the key at all is drawn as one that reviewed nothing.
    const bare: Record<string, unknown> = record();
    delete bare.axis_review;
    await place(A, bare);
    const withoutKey = await boardPage(records);
    if (withoutKey.status !== "ok") throw new Error(withoutKey.why);
    expect(withoutKey.board.footnotes.axis.this_review).toBeNull();
    // A review not in its shape is drawn as none; the record is still drawn.
    for (const axis_review of [
      { triggers: ["d"] },
      { triggers: ["d"], summary: null },
      { triggers: "d", summary: "s" },
      "d",
    ]) {
      await place(A, record({ axis_review }));
      const odd = await boardPage(records);
      if (odd.status !== "ok") throw new Error(`${JSON.stringify(axis_review)}: ${odd.why}`);
      expect(odd.board.footnotes.axis.this_review).toBeNull();
      expect(odd.board.footnotes.notes).toEqual(["Measured with care."]);
    }
  });

  it("lists a record by the recorded_at its head holds, and by its name's time when the head does not hold one", async () => {
    await mkdir(records);
    // As basou writes it, with an indent of 2.
    await place(A, JSON.stringify(record({ recorded_at: "2026-10-07T12:00:00.000Z" }), null, 2));
    // recorded_at not where basou writes it.
    const { recorded_at: _at, ...rest } = record();
    await place(B, JSON.stringify({ ...rest, recorded_at: "2026-10-09T00:00:00.000Z" }));
    // Not a time.
    await place(C, JSON.stringify(record({ recorded_at: "yesterday" })));
    expect((await boardPage(records)).records).toEqual([
      { id: A, at: "2026-10-07T12:00:00.000Z" },
      { id: B, at: "1970-01-01T00:00:00.002Z" },
      { id: C, at: "1970-01-01T00:00:00.003Z" },
    ]);
    const last = async () => (await boardPage(records)).records.at(-1);
    const byName = { id: C, at: "1970-01-01T00:00:00.003Z" };
    // Only the record's own, not one a part of it holds before it.
    await place(
      C,
      '{"x":{"record_version":1,"recorded_at":"2026-01-01T00:00:00.000Z"},"record_version":3,"recorded_at":"2026-02-02T00:00:00.000Z"}',
    );
    expect(await last()).toEqual(byName);
    // Only a time as basou writes it, in UTC to the millisecond: another form
    // would be read in the host's time zone.
    for (const recorded_at of ["1", "Oct 7", "2026-10-07T12:00:00", "2026-10-07T12:00:00+09:00"]) {
      await place(C, JSON.stringify(record({ recorded_at })));
      expect(await last(), recorded_at).toEqual(byName);
    }
    // Only a file is opened: a name that is a link (or a FIFO, which would
    // never answer) is listed by its name's time.
    await rm(join(records, `${C}.json`));
    await symlink(join(records, `${A}.json`), join(records, `${C}.json`));
    expect(await last()).toEqual(byName);
  });

  it("does not draw a record it cannot read, of a version it does not know, or not in the shape of one", async () => {
    await mkdir(records);
    await place(A, "{ not json");
    await place(B, record());
    // The records around the one asked for are still there to go to.
    expect(await boardPage(records, A)).toEqual({
      status: "unavailable",
      why: "not_json",
      // One that cannot be read is listed by the time its name holds.
      records: [
        { id: A, at: "1970-01-01T00:00:00.001Z" },
        { id: B, at: "2026-10-07T00:00:00.000Z" },
      ],
      id: A,
      older: null,
      newer: B,
    });
    await place(A, record({ record_version: 4 }));
    expect(await boardPage(records, A)).toMatchObject({
      why: "unknown_version",
      id: A,
      version: 4,
    });
    await place(A, record({ prose: { summary: 1 } }));
    expect(await boardPage(records, A)).toMatchObject({ why: "not_a_record", id: A });
    await rm(join(records, `${B}.json`));
    // A key the page does not draw is let through.
    await place(A, record({ later: { added: true } }));
    expect((await boardPage(records)).status).toBe("ok");
  });

  it("does not read a records/ that is a link", async () => {
    const elsewhere = join(dir, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, records);
    expect(await boardPage(records)).toMatchObject({
      status: "unavailable",
      why: "records_not_directory",
    });
  });
});
