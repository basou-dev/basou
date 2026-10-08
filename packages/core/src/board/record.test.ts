import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { type BoardDeclaration, parseBoardDeclaration } from "./declaration.js";
import type { BoardMeasurement } from "./measure.js";
import { buildRecord, orderAnomalies, parseRecordInput, writeRecord } from "./record.js";

// Pass-through so one test can make the first name a record already has.
vi.mock("../ids/ulid.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ids/ulid.js")>();
  return { ...actual, ulid: vi.fn(actual.ulid) };
});
const { ulid } = await import("../ids/ulid.js");

// Pass-through so one test can make a write fail after it has begun.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

const STAGES = ["01", "02", "03", "04", "05", "06"];

function declaration(): BoardDeclaration {
  const result = parseBoardDeclaration(
    stringify({
      board_version: 1,
      title: "Test board",
      stages: Object.fromEntries(STAGES.map((id) => [id, { meaning: `stage ${id}` }])),
      lanes: [
        { id: "core", name: "Core" },
        { id: "docs", name: "Docs" },
      ],
      components: { "ws/app": { lane: ["core"], note: "the app" } },
      axis: { version: 1, review_due_days: 60 },
      effort: { start: "2026-04-28", time_zone: "UTC" },
    }),
    { manifestRepoPaths: [] },
  );
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.declaration;
}

// A board of version 2 that declares two observations.
function observingDeclaration(): BoardDeclaration {
  const result = parseBoardDeclaration(
    stringify({
      board_version: 2,
      title: "Test board",
      stages: Object.fromEntries(
        STAGES.map((id) => [id, { meaning: `stage ${id}`, look: [`what ${id} needs`] }]),
      ),
      lanes: [
        { id: "core", name: "Core" },
        { id: "docs", name: "Docs" },
      ],
      observe: [
        { key: "npm_cli", kind: "npm_version", package: "@scope/cli" },
        { key: "users", kind: "manual", how: "ask the operator" },
      ],
      axis: { version: 1, review_due_days: 60 },
      effort: { start: "2026-04-28", time_zone: "UTC" },
    }),
    { manifestRepoPaths: [] },
  );
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.declaration;
}

const DIGEST = `sha256:${"a".repeat(64)}`;

function cells(states: Record<string, string[]> = {}) {
  return ["core", "docs"].flatMap((lane) =>
    STAGES.map((stage, i) => ({ lane, stage, state: states[lane]?.[i] ?? "none" })),
  );
}

function input(over: Record<string, unknown> = {}) {
  return {
    measure_digest: DIGEST,
    cells: cells(),
    prose: { summary: "fine" },
    judged_by: { model: "Claude Opus 5.5", self_reported: true },
    ...over,
  };
}

function refused(value: unknown): string[] {
  const result = parseRecordInput(value, declaration());
  if (result.ok) throw new Error("accepted");
  return result.errors;
}

describe("parseRecordInput", () => {
  it("takes a whole input, filling what may be left out", () => {
    const result = parseRecordInput(input(), declaration());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.observed).toEqual({});
    expect(result.input.prose).toEqual({
      summary: "fine",
      lanes: {},
      operator_turns: [],
      footnotes: [],
    });
    expect(result.input.axis_review).toBeNull();
  });

  it("refuses an unknown key anywhere but the names of observations, and says where", () => {
    const value = input({
      extra: 1,
      judged_by: { model: "m", self_reported: true, by: "x" },
      observed: { anything: { value: 1, observed_at: "2026-10-07", source: "s" } },
    });
    (value.cells as Record<string, unknown>[])[0] = { ...cells()[0], note: "x" };
    expect(refused(value)).toEqual([
      "cells[0]: unknown key 'note'",
      "judged_by: unknown key 'by'",
      "(top level): unknown key 'extra'",
    ]);
  });

  it("refuses a digest, state, judge or trigger it does not know", () => {
    const value = input({
      measure_digest: "sha256:xyz",
      judged_by: { model: " ", self_reported: false },
      axis_review: { triggers: ["f"], summary: "s" },
    });
    (value.cells as Record<string, unknown>[])[1] = { lane: "core", stage: "02", state: "maybe" };
    expect(refused(value)).toEqual([
      "measure_digest: must be the digest of a measurement (sha256: and 64 hex digits)",
      "cells[1].state: must be one of done, part, blocked, shelved, none, unverified",
      "judged_by.model: must be a non-empty string",
      "judged_by.self_reported: must be true: basou cannot tell which model judged",
      "axis_review.triggers[0]: must be one of a, b, c, d, e",
    ]);
  });

  it("refuses cells that are not every lane at every stage, once, and a missing reason", () => {
    const list = cells({ core: ["done", "blocked", "shelved", "unverified", "none", "none"] });
    list[2] = { ...list[2], reason: "waiting on x" } as (typeof list)[number];
    list.push({ lane: "core", stage: "01", state: "done" });
    list.push({ lane: "web", stage: "07", state: "none" });
    const value = input({ cells: list.filter((c) => !(c.lane === "docs" && c.stage === "06")) });
    expect(refused(value)).toEqual([
      "cells[1].reason: a cell that is blocked needs a reason",
      "cells[3].reason: a cell that is unverified needs a reason",
      "cells[11]: lane 'core' at stage '01' is given more than once",
      "cells[12].lane: 'web' is not a lane of the board",
      "cells[12].stage: '07' is not a stage (01, 02, 03, 04, 05, 06)",
      "cells: lane 'docs' has no cell at stage '06'",
    ]);
    expect(refused(input({ cells: cells({ docs: ["shelved"] }) }))).toEqual([
      "cells[6].reason: a cell that is shelved needs a reason",
    ]);
  });

  it("holds each part whose shape is right against the board, whatever else is wrong", () => {
    const list = cells({ core: ["blocked"] }).filter(
      (c) => !(c.lane === "docs" && c.stage === "06"),
    );
    const observed = { " ": { value: 1, observed_at: "2026-10-07", source: "s" } };
    expect(
      refused(
        input({ extra: true, observed, cells: list, prose: { summary: "x", lanes: { web: "y" } } }),
      ),
    ).toEqual([
      "(top level): unknown key 'extra'",
      'observed[" "]: is not a name it can have',
      "cells[0].reason: a cell that is blocked needs a reason",
      "cells: lane 'docs' has no cell at stage '06'",
      "prose.lanes.web: is not a lane of the board",
    ]);
    const value = JSON.parse(
      JSON.stringify(input({ cells: cells().slice(1) })).replace(
        '"measure_digest"',
        '"observed":{"__proto__":{"value":1,"observed_at":"2026-10-07","source":"s"}},"measure_digest"',
      ),
    );
    expect(refused(value)).toEqual([
      "observed.__proto__: is not a name it can have",
      "cells: lane 'core' has no cell at stage '01'",
    ]);
    // A part whose shape is wrong is reported once, not held against the board too.
    const broken = cells();
    broken[0] = { lane: "core", stage: "01", state: "maybe" };
    expect(refused(input({ cells: broken }))).toEqual([
      "cells[0].state: must be one of done, part, blocked, shelved, none, unverified",
    ]);
  });

  it("keeps an observation's value as JSON.parse read it, and refuses what is not a JSON value", () => {
    const nested = (n: number) => `${"[".repeat(n)}${"]".repeat(n)}`;
    const at = '"observed_at":"2026-10-07","source":"s"';
    const observed = JSON.parse(
      `{"a":{"value":{"k":[1,{"__proto__":5}],"__proto__":{"x":1}},${at}},` +
        `"b":{"value":1e400,${at}},"c":{"value":${nested(101)},${at}},` +
        `"d":{"value":${nested(100)},${at}},"e":{${at}}}`,
    );
    expect(refused(input({ observed }))).toEqual([
      "observed.a.value.k[1].__proto__: is not a name it can have",
      "observed.a.value.__proto__: is not a name it can have",
      "observed.b.value: is a number too large to be held",
      `observed.c.value${"[0]".repeat(100)}: nests more than 100 deep`,
      "observed.e.value: must be given (null, with an error, when nothing was observed)",
    ]);
    expect(
      refused(
        input({ observed: { f: { value: [undefined], observed_at: "2026-10-07", source: "s" } } }),
      ),
    ).toEqual(["observed.f.value[0]: is not a JSON value"]);
    const result = parseRecordInput(
      input({
        observed: JSON.parse(
          `{"n":{"value":{"big":123456789012345678901234567890,"list":[1,"x",null,true],"deep":${nested(99)}},${at}}}`,
        ),
      }),
      declaration(),
    );
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.input.observed.n?.value).toEqual({
      big: 1.2345678901234568e29,
      list: [1, "x", null, true],
      // One level under the value: as deep as it may nest.
      deep: JSON.parse(nested(99)),
    });
  });

  it("takes the time of an observation only as a calendar date, or one with a time of day and its offset", () => {
    const takes = (observed_at: string) =>
      parseRecordInput(
        input({ observed: { n: { value: 1, observed_at, source: "s" } } }),
        declaration(),
      ).ok;
    for (const good of [
      "2026-10-07",
      "2026-02-28T00:00Z",
      "2028-02-29T23:59:59.5+09:00",
      "2026-10-07T12:00-23:59",
    ]) {
      expect(takes(good), good).toBe(true);
    }
    for (const bad of [
      "2026-02-31",
      "2026-13-01",
      "2027-02-29",
      "2026-10-07T24:00Z",
      "2026-10-07T23:60Z",
      "2026-10-07T23:59:60Z",
      "2026-10-07T12:00+24:00",
      "2026-10-07T12:00+09:60",
      "2026-10-07T12:00",
      "2026-10-07x",
      "x2026-10-07",
      "2026-10-07T12:00Zjunk",
    ]) {
      expect(takes(bad), bad).toBe(false);
    }
  });

  it("refuses an observation of no value with no error, a bad date, prose of a lane the board lacks and a trigger named twice, at once", () => {
    expect(
      refused(
        input({
          observed: {
            a: { value: null, observed_at: "2026-10-07", source: "s" },
            b: { value: 1, observed_at: "yesterday", source: "s" },
          },
          prose: { summary: "x", lanes: { web: "y" } },
          axis_review: { triggers: ["a", "a"], summary: "s" },
        }),
      ),
    ).toEqual([
      "observed.a.error: a value of null needs an error saying why it was not observed",
      "observed.b.observed_at: must be a calendar date (YYYY-MM-DD), or one with a time of day and its offset",
      "prose.lanes.web: is not a lane of the board",
      "axis_review.triggers: names a trigger more than once",
    ]);
  });

  it("refuses an observation or a lane's prose named __proto__, or with an empty name", () => {
    const value = JSON.parse(
      JSON.stringify(input({ prose: { summary: "x", lanes: { core: "y" } } }))
        .replace(
          '"measure_digest"',
          '"observed":{"__proto__":{"value":1,"observed_at":"2026-10-07","source":"s"}},"measure_digest"',
        )
        .replace('"lanes":{"core":"y"}', '"lanes":{"__proto__":"y"}'),
    );
    expect(refused(value)).toEqual([
      "observed.__proto__: is not a name it can have",
      "prose.lanes.__proto__: is not a name it can have",
    ]);
    expect(
      refused(input({ observed: { " ": { value: 1, observed_at: "2026-10-07", source: "s" } } })),
    ).toEqual(['observed[" "]: is not a name it can have']);
  });
});

describe("parseRecordInput: a board that declares what to observe", () => {
  const at = "2026-10-08T10:00:00+09:00";
  const made = { value: "1.0.0", observed_at: at, source: "npm view @scope/cli version" };
  const notMade = { value: null, observed_at: at, source: "the operator", error: "not asked" };

  it("takes exactly the observations the board declares, one not made as null with its error", () => {
    const result = parseRecordInput(
      input({ observed: { npm_cli: made, users: notMade } }),
      observingDeclaration(),
    );
    expect(result.ok).toBe(true);
  });

  it("refuses an observation the board declares but the input leaves out, and one it does not declare", () => {
    const result = parseRecordInput(
      input({ observed: { npm_cli: made, npm_cil: made } }),
      observingDeclaration(),
    );
    expect(result.ok ? [] : result.errors).toEqual([
      "observed.users: the board declares it, so it must be given (null, with an error, when it was not observed)",
      "observed.npm_cil: is not an observation the board declares",
    ]);
  });

  it("refuses every declared observation when observed is left out", () => {
    const result = parseRecordInput(input(), observingDeclaration());
    expect(result.ok ? [] : result.errors).toEqual([
      "observed.npm_cli: the board declares it, so it must be given (null, with an error, when it was not observed)",
      "observed.users: the board declares it, so it must be given (null, with an error, when it was not observed)",
    ]);
  });

  it("does not name an observation twice when its name is empty or __proto__", () => {
    const value = JSON.parse(
      `{"measure_digest":"${DIGEST}","cells":${JSON.stringify(cells())},"prose":{"summary":"x"},"judged_by":{"model":"m","self_reported":true},"observed":{"npm_cli":${JSON.stringify(made)},"users":${JSON.stringify(notMade)},"__proto__":${JSON.stringify(made)},"":${JSON.stringify(made)}}}`,
    );
    const result = parseRecordInput(value, observingDeclaration());
    expect(result.ok ? [] : result.errors).toEqual([
      "observed.__proto__: is not a name it can have",
      'observed[""]: is not a name it can have',
    ]);
  });

  it("leaves the names free on a board that declares nothing to observe", () => {
    const result = parseRecordInput(input({ observed: { anything: made } }), declaration());
    expect(result.ok).toBe(true);
  });

  it("keeps the observations and the stages' look in the record of a version 2 board", () => {
    const parsed = parseRecordInput(
      input({ observed: { npm_cli: made, users: notMade } }),
      observingDeclaration(),
    );
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    const r = buildRecord({
      declaration: observingDeclaration(),
      measurement: { digest: DIGEST } as BoardMeasurement,
      recordInput: parsed.input,
      recordedAt: new Date("2026-10-08T00:00:00.000Z"),
      recordedWith: { basou: "0.0.0-test", build: null },
    });
    expect(r.record_version).toBe(2);
    expect(r.declaration.observe).toEqual([
      { key: "npm_cli", kind: "npm_version", package: "@scope/cli" },
      { key: "users", kind: "manual", how: "ask the operator" },
    ]);
    expect(r.declaration.stages["04"]).toEqual({ meaning: "stage 04", look: ["what 04 needs"] });
    expect(r.observed).toEqual({ npm_cli: made, users: notMade });
  });
});

describe("orderAnomalies", () => {
  it("finds a stage not started, blocked or shelved before one done or begun, not counting unverified", () => {
    const parsed = parseRecordInput(
      input({
        cells: cells({
          core: ["done", "none", "unverified", "part", "blocked", "done"],
          docs: ["shelved", "unverified", "part", "none", "none", "none"],
        }).map((c) =>
          c.state === "blocked" || c.state === "shelved" || c.state === "unverified"
            ? { ...c, reason: "r" }
            : c,
        ),
      }),
      declaration(),
    );
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    expect(orderAnomalies(parsed.input, declaration())).toEqual([
      { lane: "core", stage: "02", state: "none", before: "04" },
      { lane: "core", stage: "05", state: "blocked", before: "06" },
      { lane: "docs", stage: "01", state: "shelved", before: "03" },
    ]);
  });
});

describe("buildRecord and writeRecord", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "basou-board-record-"));
  });
  afterEach(async () => {
    vi.mocked(ulid).mockReset();
    await rm(dir, { recursive: true, force: true });
  });

  function record() {
    const parsed = parseRecordInput(input(), declaration());
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    return buildRecord({
      declaration: declaration(),
      measurement: { digest: DIGEST } as BoardMeasurement,
      recordInput: parsed.input,
      recordedAt: new Date("2026-10-07T00:00:00.000Z"),
      recordedWith: { basou: "0.0.0-test", build: null },
    });
  }

  it("keeps the declaration as parsed, the measurement and the input, and writes it whole under a ULID", async () => {
    const r = record();
    expect(Object.keys(r)).toEqual([
      "record_version",
      "recorded_at",
      "recorded_with",
      "declaration",
      "measure",
      "observed",
      "cells",
      "prose",
      "judged_by",
      "axis_review",
      "order_anomalies",
    ]);
    const d = declaration();
    expect(r.declaration).toEqual({
      title: d.title,
      stages: d.stages,
      lanes: d.lanes,
      measures: [],
      ratios: [],
      components: { "ws/app": { lane: ["core"], note: "the app" } },
      axis: d.axis,
      effort: { start: "2026-04-28", time_zone: "UTC" },
      observe: [],
    });
    expect(r.record_version).toBe(2);
    expect(r.recorded_at).toBe("2026-10-07T00:00:00.000Z");
    const records = join(dir, "records");
    const name = await writeRecord(records, r);
    expect(name).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}\.json$/);
    expect(await readdir(records)).toEqual([name]);
    expect(JSON.parse(await readFile(join(records, name), "utf8"))).toEqual(r);
  });

  it("does not keep the measurement's diff, which the previous record derives", () => {
    const parsed = parseRecordInput(input(), declaration());
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    const r = buildRecord({
      declaration: declaration(),
      measurement: { digest: DIGEST, diff: { against: "X" } } as unknown as BoardMeasurement,
      recordInput: parsed.input,
      recordedAt: new Date("2026-10-07T00:00:00.000Z"),
      recordedWith: { basou: "0.0.0-test", build: null },
    });
    expect(r.measure).toEqual({ digest: DIGEST });
  });

  it("tries another name rather than replace a record, and leaves no other file", async () => {
    const records = join(dir, "records");
    const first = await writeRecord(records, record());
    vi.mocked(ulid).mockReturnValueOnce(first.replace(/\.json$/, ""));
    const second = await writeRecord(records, record());
    expect(second).not.toBe(first);
    expect((await readdir(records)).sort()).toEqual([first, second].sort());
  });

  it("refuses a records path that is not a directory, a link to one included, and writes nothing", async () => {
    const records = join(dir, "records");
    await writeFile(records, "not a directory\n");
    await expect(writeRecord(records, record())).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["records"]);
    await rm(records);
    const elsewhere = join(dir, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, records);
    await expect(writeRecord(records, record())).rejects.toThrow(
      "the records directory is not a directory",
    );
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it("leaves nothing behind when a write fails part of the way, not even a records directory it made", async () => {
    const failing = async (path: Parameters<typeof actualFs.writeFile>[0]) => {
      await actualFs.writeFile(path, "{ part of a record", { flag: "wx" });
      throw Object.assign(new Error("file too large"), { code: "EFBIG" });
    };
    const records = join(dir, "records");
    vi.mocked(writeFile).mockImplementationOnce(failing);
    await expect(writeRecord(records, record())).rejects.toThrow("file too large");
    expect(await readdir(dir)).toEqual([]);
    const first = await writeRecord(records, record());
    vi.mocked(writeFile).mockImplementationOnce(failing);
    await expect(writeRecord(records, record())).rejects.toThrow("file too large");
    expect(await readdir(records)).toEqual([first]);
  });
});
