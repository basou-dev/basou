import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeTime } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOARD_GLANCE_MAX_BYTES, glanceBoard } from "./glance.js";

describe("glanceBoard", () => {
  let dir: string;
  let yaml: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "basou-board-glance-"));
    await mkdir(join(dir, "board"));
    yaml = join(dir, "board", "board.yaml");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds no board where there is no board.yaml, or a directory of that name", async () => {
    expect(await glanceBoard(yaml)).toBeNull();
    await mkdir(yaml);
    expect(await glanceBoard(yaml)).toBeNull();
  });

  it("reads the axis version and when the last record was written, from its name", async () => {
    await writeFile(yaml, "board_version: 2\naxis: { version: 3, review_due_days: 60 }\n");
    expect(await glanceBoard(yaml)).toEqual({ lastRecordAt: null, axisVersion: 3 });
    const records = join(dir, "board", "records");
    await mkdir(records);
    expect(await glanceBoard(yaml)).toEqual({ lastRecordAt: null, axisVersion: 3 });
    await writeFile(join(records, "01M4A00000000000000000000A.json"), "{}");
    await writeFile(join(records, "01M4E6PAN7J2BJ5YK1NFPVAQAR.json"), "not even JSON");
    await writeFile(join(records, ".record-x.tmp"), "");
    await writeFile(join(records, "ZZZZ.json"), "");
    expect(await glanceBoard(yaml)).toEqual({
      lastRecordAt: "2026-10-08T16:49:07.751Z",
      axisVersion: 3,
    });
  });

  it("does not know the axis of a board.yaml it cannot read, and still finds its records", async () => {
    await mkdir(join(dir, "board", "records"));
    await writeFile(join(dir, "board", "records", "01M4A00000000000000000000A.json"), "{}");
    for (const text of [
      "axis: [",
      "axis: { version: 0 }",
      'axis: { version: "2" }',
      "axis: { version: 1.5 }",
      "- a list\n",
      "",
    ]) {
      await writeFile(yaml, text);
      const glance = await glanceBoard(yaml);
      expect(glance?.axisVersion).toBeNull();
      expect(glance?.lastRecordAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("does not know the axis of a board.yaml basou board would not read as YAML", async () => {
    for (const text of [
      "axis: { version: 2 }\nlanes: [\n",
      "axis: { version: 2 }\naxis: { version: 3 }\n",
      "%YAML 1.1\n---\naxis: { version: 010 }\n",
      "axis: !odd { version: 2 }\n",
    ]) {
      await writeFile(yaml, text);
      expect(await glanceBoard(yaml)).toEqual({ lastRecordAt: null, axisVersion: null });
    }
  });

  it("does not read a board.yaml too large to be written by hand", async () => {
    const head = "axis: { version: 2 }\n";
    await writeFile(yaml, head + "#".repeat(BOARD_GLANCE_MAX_BYTES - head.length));
    expect((await glanceBoard(yaml))?.axisVersion).toBe(2);
    await writeFile(yaml, head + "#".repeat(BOARD_GLANCE_MAX_BYTES - head.length + 1));
    expect((await glanceBoard(yaml))?.axisVersion).toBeNull();
  });

  it("does not count a directory that bears a record's name", async () => {
    await writeFile(yaml, "axis: { version: 1 }\n");
    const records = join(dir, "board", "records");
    await mkdir(join(records, "01M4E6PAN7J2BJ5YK1NFPVAQAR.json"), { recursive: true });
    await writeFile(join(records, "01M4A00000000000000000000A.json"), "{}");
    expect((await glanceBoard(yaml))?.lastRecordAt).toBe(
      new Date(decodeTime("01M4A00000000000000000000A")).toISOString(),
    );
  });

  it("cannot read records that are a file or a link", async () => {
    await writeFile(yaml, "axis: { version: 1 }\n");
    const records = join(dir, "board", "records");
    await writeFile(records, "");
    expect(await glanceBoard(yaml)).toEqual({ lastRecordAt: undefined, axisVersion: 1 });
    await rm(records);
    const elsewhere = join(dir, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, records);
    expect(await glanceBoard(yaml)).toEqual({ lastRecordAt: undefined, axisVersion: 1 });
  });
});
