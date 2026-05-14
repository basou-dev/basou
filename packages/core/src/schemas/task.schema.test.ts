import { describe, expect, it } from "vitest";
import { TaskSchema, TaskStatusSchema } from "./task.schema.js";

const VALID_TASK_ID = "task_01HXABCDEF1234567890ABCDET";
const VALID_SESSION_ID = "ses_01HXABCDEF1234567890ABCSES";
const VALID_WORKSPACE_ID = "ws_01HXABCDEF1234567890ABCWS1";

function makeValidTask(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema_version: "0.1.0",
    task: {
      id: VALID_TASK_ID,
      title: "WordPress LP の問い合わせフォーム改修",
      status: "planned",
      created_at: "2026-05-04T09:00:00+09:00",
      updated_at: "2026-05-04T09:00:00+09:00",
      workspace_id: VALID_WORKSPACE_ID,
      created_in_session: VALID_SESSION_ID,
      ...overrides,
    },
  };
}

describe("TaskStatusSchema", () => {
  it("accepts the four canonical lifecycle states", () => {
    for (const status of ["planned", "in_progress", "done", "cancelled"]) {
      expect(TaskStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it("rejects values outside the enum", () => {
    for (const bad of ["pending", "waiting", "DONE", "", "in-progress", "archived"]) {
      expect(TaskStatusSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("TaskSchema", () => {
  it("parses a valid front matter document with default linked_sessions", () => {
    const result = TaskSchema.safeParse(makeValidTask());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.task.linked_sessions).toEqual([]);
      expect(result.data.task.label).toBeUndefined();
    }
  });

  it("preserves explicit linked_sessions and label", () => {
    const linked = [VALID_SESSION_ID];
    const result = TaskSchema.safeParse(
      makeValidTask({ linked_sessions: linked, label: "contact-form" }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.task.linked_sessions).toEqual(linked);
      expect(result.data.task.label).toBe("contact-form");
    }
  });

  it("rejects an empty title", () => {
    const result = TaskSchema.safeParse(makeValidTask({ title: "" }));
    expect(result.success).toBe(false);
  });

  it("rejects an unknown task id prefix", () => {
    const result = TaskSchema.safeParse(makeValidTask({ id: "ses_01HXABCDEF1234567890ABCSES" }));
    expect(result.success).toBe(false);
  });

  it("rejects a created_at without timezone offset", () => {
    const result = TaskSchema.safeParse(makeValidTask({ created_at: "2026-05-04T09:00:00" }));
    expect(result.success).toBe(false);
  });

  it("rejects a missing workspace_id", () => {
    const bad = {
      schema_version: "0.1.0",
      task: {
        id: VALID_TASK_ID,
        title: "no workspace",
        status: "planned",
        created_at: "2026-05-04T09:00:00+09:00",
        updated_at: "2026-05-04T09:00:00+09:00",
        created_in_session: VALID_SESSION_ID,
      },
    };
    expect(TaskSchema.safeParse(bad).success).toBe(false);
  });
});
