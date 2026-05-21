import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TASK_INDEX_SCHEMA_VERSION } from "../schemas/task-index.schema.js";
import { basouPaths, ensureBasouDirectory } from "./basou-dir.js";
import { readTaskIndex, rebuildTaskIndex, taskIndexPath, updateTaskIndex } from "./task-index.js";

let workDir: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "basou-task-index-test-"));
  await ensureBasouDirectory(getWorkDir());
});

afterEach(async () => {
  if (workDir !== undefined) {
    await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function getWorkDir(): string {
  if (workDir === undefined) throw new Error("workDir not initialized");
  return workDir;
}

function paths() {
  return basouPaths(getWorkDir());
}

const ID_A: `task_${string}` = "task_01HXABCDEF1234567890ABCAAA";
const ID_B: `task_${string}` = "task_01HXABCDEF1234567890ABCBBB";
const ID_C: `task_${string}` = "task_01HXABCDEF1234567890ABCCCC";
const AT = "2026-05-21T12:00:00.000Z";

describe("taskIndexPath", () => {
  it("points at <paths.tasks>/index.json", () => {
    expect(taskIndexPath(paths())).toBe(join(paths().tasks, "index.json"));
  });
});

describe("readTaskIndex", () => {
  it("throws 'Task index not found' when the file is absent", async () => {
    await expect(readTaskIndex(paths())).rejects.toThrow("Task index not found");
  });

  it("throws 'Invalid task index' on malformed JSON", async () => {
    await writeFile(taskIndexPath(paths()), "{ not json", "utf8");
    await expect(readTaskIndex(paths())).rejects.toThrow("Invalid task index");
  });

  it("throws 'Invalid task index' when the schema_version mismatches", async () => {
    await writeFile(
      taskIndexPath(paths()),
      JSON.stringify({ schema_version: "9.9.9", tasks: [], last_rebuilt_at: AT }),
      "utf8",
    );
    await expect(readTaskIndex(paths())).rejects.toThrow("Invalid task index");
  });

  it("parses a valid index", async () => {
    await writeFile(
      taskIndexPath(paths()),
      JSON.stringify({
        schema_version: TASK_INDEX_SCHEMA_VERSION,
        tasks: [{ id: ID_A, status: "planned", updated_at: AT }],
        last_rebuilt_at: AT,
      }),
      "utf8",
    );
    const index = await readTaskIndex(paths());
    expect(index.tasks).toHaveLength(1);
    expect(index.tasks[0]?.id).toBe(ID_A);
  });
});

describe("rebuildTaskIndex", () => {
  it("writes a sorted, valid JSON envelope", async () => {
    const result = await rebuildTaskIndex(
      paths(),
      [
        { id: ID_C, status: "planned", updated_at: AT },
        { id: ID_A, status: "in_progress", updated_at: AT },
        { id: ID_B, status: "done", updated_at: AT },
      ],
      () => new Date(AT),
    );
    expect(result.tasks.map((t) => t.id)).toEqual([ID_A, ID_B, ID_C]);
    const onDisk = JSON.parse(await readFile(taskIndexPath(paths()), "utf8")) as {
      tasks: { id: string }[];
    };
    expect(onDisk.tasks.map((t) => t.id)).toEqual([ID_A, ID_B, ID_C]);
  });

  it("produces a byte-identical output on a second call with the same entries", async () => {
    const entries = [
      { id: ID_A, status: "planned" as const, updated_at: AT },
      { id: ID_B, status: "done" as const, updated_at: AT },
    ];
    await rebuildTaskIndex(paths(), entries, () => new Date(AT));
    const first = await readFile(taskIndexPath(paths()), "utf8");
    await rebuildTaskIndex(paths(), entries, () => new Date(AT));
    const second = await readFile(taskIndexPath(paths()), "utf8");
    expect(first).toBe(second);
  });
});

describe("updateTaskIndex", () => {
  it("'add' creates the index when absent", async () => {
    await updateTaskIndex(
      paths(),
      { kind: "add", entry: { id: ID_A, status: "planned", updated_at: AT } },
      { now: () => new Date(AT) },
    );
    const index = await readTaskIndex(paths());
    expect(index.tasks.map((t) => t.id)).toEqual([ID_A]);
  });

  it("'add' is idempotent (same id replaces existing entry)", async () => {
    await updateTaskIndex(
      paths(),
      { kind: "add", entry: { id: ID_A, status: "planned", updated_at: AT } },
      { now: () => new Date(AT) },
    );
    await updateTaskIndex(
      paths(),
      { kind: "add", entry: { id: ID_A, status: "in_progress", updated_at: AT } },
      { now: () => new Date(AT) },
    );
    const index = await readTaskIndex(paths());
    expect(index.tasks).toHaveLength(1);
    expect(index.tasks[0]?.status).toBe("in_progress");
  });

  it("'update' replaces an existing entry's status / label / updated_at", async () => {
    await updateTaskIndex(
      paths(),
      {
        kind: "add",
        entry: { id: ID_A, status: "planned", label: "L1", updated_at: AT },
      },
      { now: () => new Date(AT) },
    );
    const newAt = "2026-05-22T10:00:00.000Z";
    await updateTaskIndex(
      paths(),
      {
        kind: "update",
        entry: { id: ID_A, status: "done", label: "L2", updated_at: newAt },
      },
      { now: () => new Date(newAt) },
    );
    const index = await readTaskIndex(paths());
    expect(index.tasks[0]?.status).toBe("done");
    expect(index.tasks[0]?.label).toBe("L2");
    expect(index.tasks[0]?.updated_at).toBe(newAt);
  });

  it("'update' on a missing id falls through to add", async () => {
    await updateTaskIndex(
      paths(),
      { kind: "update", entry: { id: ID_A, status: "done", updated_at: AT } },
      { now: () => new Date(AT) },
    );
    const index = await readTaskIndex(paths());
    expect(index.tasks).toHaveLength(1);
    expect(index.tasks[0]?.id).toBe(ID_A);
  });

  it("'remove' deletes the named entry", async () => {
    await updateTaskIndex(
      paths(),
      { kind: "add", entry: { id: ID_A, status: "planned", updated_at: AT } },
      { now: () => new Date(AT) },
    );
    await updateTaskIndex(
      paths(),
      { kind: "add", entry: { id: ID_B, status: "planned", updated_at: AT } },
      { now: () => new Date(AT) },
    );
    await updateTaskIndex(paths(), { kind: "remove", id: ID_A }, { now: () => new Date(AT) });
    const index = await readTaskIndex(paths());
    expect(index.tasks.map((t) => t.id)).toEqual([ID_B]);
  });

  it("'remove' on a missing id is a no-op", async () => {
    await updateTaskIndex(
      paths(),
      { kind: "add", entry: { id: ID_A, status: "planned", updated_at: AT } },
      { now: () => new Date(AT) },
    );
    await updateTaskIndex(paths(), { kind: "remove", id: ID_B }, { now: () => new Date(AT) });
    const index = await readTaskIndex(paths());
    expect(index.tasks.map((t) => t.id)).toEqual([ID_A]);
  });

  it("rebuilds from empty when index is parse-broken", async () => {
    await writeFile(taskIndexPath(paths()), "{ broken json", "utf8");
    await updateTaskIndex(
      paths(),
      { kind: "add", entry: { id: ID_A, status: "planned", updated_at: AT } },
      { now: () => new Date(AT) },
    );
    const index = await readTaskIndex(paths());
    expect(index.tasks.map((t) => t.id)).toEqual([ID_A]);
  });

  it("rebuilds from empty when schema_version mismatches", async () => {
    await writeFile(
      taskIndexPath(paths()),
      JSON.stringify({
        schema_version: "0.0.0",
        tasks: [{ id: ID_B, status: "planned", updated_at: AT }],
        last_rebuilt_at: AT,
      }),
      "utf8",
    );
    await updateTaskIndex(
      paths(),
      { kind: "add", entry: { id: ID_A, status: "planned", updated_at: AT } },
      { now: () => new Date(AT) },
    );
    const index = await readTaskIndex(paths());
    // The broken entry from the 0.0.0 file is gone (= rebuild started empty).
    expect(index.tasks.map((t) => t.id)).toEqual([ID_A]);
  });
});
