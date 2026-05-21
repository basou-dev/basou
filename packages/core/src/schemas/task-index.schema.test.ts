import { describe, expect, it } from "vitest";
import {
  TASK_INDEX_SCHEMA_VERSION,
  TaskIndexEntrySchema,
  TaskIndexSchema,
} from "./task-index.schema.js";

const VALID_ID = "task_01HXABCDEF1234567890ABCDEF";
const VALID_AT = "2026-05-21T12:34:56.789Z";

describe("TaskIndexEntrySchema", () => {
  it("accepts the minimal valid shape (no label)", () => {
    const parsed = TaskIndexEntrySchema.parse({
      id: VALID_ID,
      status: "planned",
      updated_at: VALID_AT,
    });
    expect(parsed.id).toBe(VALID_ID);
    expect(parsed.label).toBeUndefined();
  });

  it("accepts an optional label", () => {
    const parsed = TaskIndexEntrySchema.parse({
      id: VALID_ID,
      status: "in_progress",
      label: "Refactor",
      updated_at: VALID_AT,
    });
    expect(parsed.label).toBe("Refactor");
  });

  it("rejects an unknown status value", () => {
    expect(() =>
      TaskIndexEntrySchema.parse({
        id: VALID_ID,
        status: "blocked",
        updated_at: VALID_AT,
      }),
    ).toThrow();
  });

  it("rejects extra fields (strict mode)", () => {
    expect(() =>
      TaskIndexEntrySchema.parse({
        id: VALID_ID,
        status: "planned",
        updated_at: VALID_AT,
        extra: "no",
      }),
    ).toThrow();
  });

  it("rejects an empty-string label", () => {
    expect(() =>
      TaskIndexEntrySchema.parse({
        id: VALID_ID,
        status: "planned",
        label: "",
        updated_at: VALID_AT,
      }),
    ).toThrow();
  });
});

describe("TaskIndexSchema", () => {
  it("accepts a valid envelope", () => {
    const parsed = TaskIndexSchema.parse({
      schema_version: TASK_INDEX_SCHEMA_VERSION,
      tasks: [{ id: VALID_ID, status: "planned", updated_at: VALID_AT }],
      last_rebuilt_at: VALID_AT,
    });
    expect(parsed.schema_version).toBe(TASK_INDEX_SCHEMA_VERSION);
    expect(parsed.tasks).toHaveLength(1);
  });

  it("accepts an empty task list", () => {
    const parsed = TaskIndexSchema.parse({
      schema_version: TASK_INDEX_SCHEMA_VERSION,
      tasks: [],
      last_rebuilt_at: VALID_AT,
    });
    expect(parsed.tasks).toEqual([]);
  });

  it("rejects an envelope missing schema_version", () => {
    expect(() =>
      TaskIndexSchema.parse({
        tasks: [],
        last_rebuilt_at: VALID_AT,
      }),
    ).toThrow();
  });

  it("rejects an envelope missing last_rebuilt_at", () => {
    expect(() =>
      TaskIndexSchema.parse({
        schema_version: TASK_INDEX_SCHEMA_VERSION,
        tasks: [],
      }),
    ).toThrow();
  });
});
