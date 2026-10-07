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
  });

  it("refuses an observation of no value with no error, a bad date, and prose of a lane the board lacks", () => {
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
      "observed.b.observed_at: must be a date (YYYY-MM-DD) or a date and time with its offset",
    ]);
    expect(
      refused(
        input({
          prose: { summary: "x", lanes: { web: "y" } },
          axis_review: { triggers: ["a", "a"], summary: "s" },
        }),
      ),
    ).toEqual([
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

describe("orderAnomalies", () => {
  it("finds a stage not started, blocked or shelved before one done or begun, not counting unverified", () => {
    const parsed = parseRecordInput(
      input({
        cells: cells({
          core: ["done", "none", "unverified", "part", "blocked", "done"],
          docs: ["none", "unverified", "none", "none", "none", "none"],
        }).map((c) =>
          c.state === "blocked" || c.state === "unverified" ? { ...c, reason: "r" } : c,
        ),
      }),
      declaration(),
    );
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    expect(orderAnomalies(parsed.input, declaration())).toEqual([
      { lane: "core", stage: "02", state: "none", before: "04" },
      { lane: "core", stage: "05", state: "blocked", before: "06" },
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

  it("keeps the declaration as read, the measurement and the input, and writes it whole under a ULID", async () => {
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
    expect(r.declaration.lanes.map((lane) => lane.id)).toEqual(["core", "docs"]);
    const records = join(dir, "records");
    const name = await writeRecord(records, r);
    expect(name).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}\.json$/);
    expect(await readdir(records)).toEqual([name]);
    expect(JSON.parse(await readFile(join(records, name), "utf8"))).toEqual(r);
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
});
