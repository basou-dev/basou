import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPreviousRecords } from "./previous.js";

// Names in the order a ULID sorts in.
const [A, B, C] = [
  "01M4A00000000000000000000A",
  "01M4A00000000000000000000B",
  "01M4A00000000000000000000C",
];

function record(over: Record<string, unknown> = {}) {
  return {
    record_version: 1,
    recorded_at: "2026-10-07T00:00:00.000Z",
    measure: {
      methods: { components: 2 },
      components: { found: { ws: { kinds: ["manifest"], status: "known" } } },
    },
    observed: {},
    cells: [{ lane: "core", stage: "01", state: "done" }],
    judged_by: { model: "Claude Opus 5.5", self_reported: true },
    axis_review: null,
    ...over,
  };
}

const REVIEW = { triggers: ["b"], summary: "looked again" };

describe("readPreviousRecords", () => {
  let dir: string;
  let records: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "basou-board-previous-"));
    records = join(dir, "records");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const place = (name: string, value: unknown) =>
    writeFile(join(records, name), typeof value === "string" ? value : JSON.stringify(value));

  it("finds none where there is no records directory, or nothing in it named as a record", async () => {
    expect(await readPreviousRecords(records)).toEqual({
      last: { status: "none" },
      lastReview: { status: "none" },
    });
    await mkdir(records);
    await place(".record-1234.tmp", "{ part");
    await place(`${A}.json.orig`, record());
    await place(`${A.toLowerCase()}.json`, record());
    await place("notes.json", record());
    expect(await readPreviousRecords(records)).toEqual({
      last: { status: "none" },
      lastReview: { status: "none" },
    });
  });

  it("reads a record of version 2 after one of version 1", async () => {
    await mkdir(records);
    await place(`${A}.json`, record({ axis_review: REVIEW }));
    await place(`${B}.json`, record({ record_version: 2 }));
    const read = await readPreviousRecords(records);
    expect(read.last).toMatchObject({ status: "found", id: B, record: { record_version: 2 } });
    expect(read.lastReview).toMatchObject({
      status: "found",
      id: A,
      record: { record_version: 1 },
    });
  });

  it("takes the last by name as the previous record, and the last with an axis review", async () => {
    await mkdir(records);
    await place(`${A}.json`, record({ axis_review: REVIEW, judged_by: { model: "Old Model" } }));
    await place(`${C}.json`, record({ recorded_at: "2026-10-09T00:00:00.000Z" }));
    await place(`${B}.json`, record());
    const read = await readPreviousRecords(records);
    expect(read.last).toMatchObject({
      status: "found",
      id: C,
      record: { recorded_at: "2026-10-09T00:00:00.000Z" },
    });
    expect(read.lastReview).toMatchObject({
      status: "found",
      id: A,
      record: { judged_by: { model: "Old Model" } },
    });
  });

  it("keeps a component named __proto__ as a key of its own", async () => {
    await mkdir(records);
    await place(
      `${A}.json`,
      JSON.stringify(record()).replace('"ws":', '"__proto__":{"kinds":["ci"]},"ws":'),
    );
    const read = await readPreviousRecords(records);
    if (read.last.status !== "found") throw new Error("not found");
    const found = read.last.record.measure.components.found ?? {};
    expect(Object.keys(found)).toEqual(["__proto__", "ws"]);
  });

  it("never takes a record it cannot read as no record, nor reads past it", async () => {
    await mkdir(records);
    await place(`${A}.json`, record({ axis_review: REVIEW }));
    await place(`${B}.json`, "{ not json");
    await place(`${C}.json`, record());
    const read = await readPreviousRecords(records);
    expect(read.last).toMatchObject({ status: "found", id: C });
    expect(read.lastReview).toEqual({
      status: "unreadable",
      reason: `the record ${B} could not be read as JSON`,
    });
    await place(`${C}.json`, record({ record_version: 3 }));
    const unread = {
      status: "unreadable",
      reason: `the record ${C} is of record_version 3, which this basou does not read`,
    };
    expect(await readPreviousRecords(records)).toEqual({ last: unread, lastReview: unread });
    await place(`${C}.json`, record({ cells: "all done" }));
    expect((await readPreviousRecords(records)).last).toEqual({
      status: "unreadable",
      reason: `the record ${C} is not in the shape of a record`,
    });
    await place(`${C}.json`, record({ recorded_at: "yesterday" }));
    expect((await readPreviousRecords(records)).last).toEqual({
      status: "unreadable",
      reason: `the record ${C} is not in the shape of a record`,
    });
  });

  it("cannot read a records/ that is a link or a file", async () => {
    const elsewhere = join(dir, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, `${A}.json`), JSON.stringify(record()));
    await symlink(elsewhere, records);
    const reason = "the records/ beside the board is not a directory (a symlink or a file)";
    const unreadable = {
      last: { status: "unreadable", reason },
      lastReview: { status: "unreadable", reason },
    };
    expect(await readPreviousRecords(records)).toEqual(unreadable);
    await rm(records);
    await writeFile(records, "not a directory\n");
    expect(await readPreviousRecords(records)).toEqual(unreadable);
  });
});
