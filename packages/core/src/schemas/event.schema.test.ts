import { describe, expect, it } from "vitest";
import {
  EventSchema,
  type TaskArchivedEvent,
  type TaskDeletedEvent,
  type TaskLinkageRefreshedEvent,
  type TaskReconciledEvent,
} from "./event.schema.js";

const BASE = {
  schema_version: "0.1.0",
  id: "evt_01HXABCDEF1234567890ABCDEF",
  session_id: "ses_01HXABCDEF1234567890ABCDEF",
  occurred_at: "2026-05-04T09:00:00+09:00",
  source: "claude-code-adapter",
} as const;

const FIXTURES = [
  { ...BASE, type: "session_started" as const },
  { ...BASE, type: "session_ended" as const, exit_code: 0 },
  { ...BASE, type: "session_status_changed" as const, from: "initialized", to: "running" },
  {
    ...BASE,
    type: "approval_requested" as const,
    approval_id: "appr_01HXABCDEF1234567890ABCDEF",
    expires_at: null,
    risk_level: "medium" as const,
    action: { kind: "shell_command", command: "rm -rf foo" },
    reason: "destructive operation",
    status: "pending" as const,
  },
  {
    ...BASE,
    type: "approval_approved" as const,
    approval_id: "appr_01HXABCDEF1234567890ABCDEF",
    resolver: "local-cli",
  },
  {
    ...BASE,
    type: "approval_rejected" as const,
    approval_id: "appr_01HXABCDEF1234567890ABCDEF",
    resolver: "local-cli",
    reason: "too risky",
  },
  {
    ...BASE,
    type: "approval_expired" as const,
    approval_id: "appr_01HXABCDEF1234567890ABCDEF",
  },
  {
    ...BASE,
    type: "command_executed" as const,
    command: "ls",
    args: ["-la"],
    cwd: "/tmp/example",
    exit_code: 0,
    duration_ms: 12,
  },
  {
    ...BASE,
    type: "git_snapshot" as const,
    head: "abc1234",
    branch: "main",
    dirty: false,
    staged: [],
    unstaged: [],
    untracked: [],
  },
  {
    ...BASE,
    type: "file_changed" as const,
    path: "src/foo.ts",
    change_type: "modified" as const,
  },
  {
    ...BASE,
    type: "decision_recorded" as const,
    decision_id: "decision_01HXABCDEF1234567890ABCDEF",
    title: "Use zod v4",
  },
  {
    ...BASE,
    type: "task_created" as const,
    task_id: "task_01HXABCDEF1234567890ABCDEF",
    title: "Implement schema",
  },
  {
    ...BASE,
    type: "task_status_changed" as const,
    task_id: "task_01HXABCDEF1234567890ABCDEF",
    from: "open",
    to: "done",
  },
  {
    ...BASE,
    type: "note_added" as const,
    body: "memo",
  },
  {
    ...BASE,
    type: "adapter_output" as const,
    stream: "stdout" as const,
    summary: "Build succeeded in 4ms",
    raw_ref: ".basou/raw/ses_01HXABCDEF1234567890ABCDEF/0001.txt",
  },
];

describe("EventSchema (happy paths)", () => {
  it.each(FIXTURES)("parses a $type event", (fixture) => {
    const parsed = EventSchema.parse(fixture);
    expect(parsed.type).toBe(fixture.type);
  });

  it("defaults approval_requested.expires_at to null when omitted", () => {
    const parsed = EventSchema.parse({
      ...BASE,
      type: "approval_requested",
      approval_id: "appr_01HXABCDEF1234567890ABCDEF",
      risk_level: "medium",
      action: { kind: "shell_command" },
      reason: "test",
      status: "pending",
    });
    if (parsed.type !== "approval_requested") {
      throw new Error("expected approval_requested");
    }
    expect(parsed.expires_at).toBe(null);
  });

  it("accepts git_snapshot without ahead / behind", () => {
    const fixture = {
      ...BASE,
      type: "git_snapshot",
      head: "abc1234",
      branch: "main",
      dirty: true,
      staged: ["a.ts"],
      unstaged: [],
      untracked: ["new.ts"],
    };
    expect(EventSchema.safeParse(fixture).success).toBe(true);
  });
});

describe("EventSchema (rejections)", () => {
  it("rejects an unknown event type", () => {
    expect(EventSchema.safeParse({ ...BASE, type: "unknown_event" }).success).toBe(false);
  });

  it("rejects command_executed missing the required `command` field", () => {
    expect(
      EventSchema.safeParse({
        ...BASE,
        type: "command_executed",
        exit_code: 0,
        duration_ms: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects file_changed with an invalid change_type", () => {
    expect(
      EventSchema.safeParse({
        ...BASE,
        type: "file_changed",
        path: "src/foo.ts",
        change_type: "wat",
      }).success,
    ).toBe(false);
  });

  it("rejects adapter_output with an invalid stream", () => {
    expect(
      EventSchema.safeParse({
        ...BASE,
        type: "adapter_output",
        stream: "stdin",
        summary: "x",
        raw_ref: "y",
      }).success,
    ).toBe(false);
  });

  it("rejects adapter_output that includes a raw `content` field (.strict())", () => {
    expect(
      EventSchema.safeParse({
        ...BASE,
        type: "adapter_output",
        stream: "stdout",
        summary: "x",
        raw_ref: "y",
        content: "raw body should not be here",
      }).success,
    ).toBe(false);
  });

  it("rejects an event whose id has the wrong prefix", () => {
    expect(
      EventSchema.safeParse({
        ...BASE,
        id: "ses_01HXABCDEF1234567890ABCDEF",
        type: "session_started",
      }).success,
    ).toBe(false);
  });

  it("rejects an event whose session_id has the wrong prefix", () => {
    expect(
      EventSchema.safeParse({
        ...BASE,
        session_id: "evt_01HXABCDEF1234567890ABCDEF",
        type: "session_started",
      }).success,
    ).toBe(false);
  });

  it("rejects an event with a malformed occurred_at timestamp", () => {
    expect(
      EventSchema.safeParse({
        ...BASE,
        occurred_at: "2026-05-04 09:00:00",
        type: "session_started",
      }).success,
    ).toBe(false);
  });

  it("rejects an event with an empty source string", () => {
    expect(
      EventSchema.safeParse({
        ...BASE,
        source: "",
        type: "session_started",
      }).success,
    ).toBe(false);
  });
});

describe("EventSchema (discriminator narrowing)", () => {
  it("narrows to AdapterOutputEvent shape via the type literal", () => {
    const fixture = FIXTURES.find((e) => e.type === "adapter_output");
    if (!fixture) {
      throw new Error("adapter_output fixture missing");
    }
    const parsed = EventSchema.parse(fixture);
    if (parsed.type === "adapter_output") {
      expect(parsed.raw_ref.startsWith(".basou/raw/")).toBe(true);
      expect(parsed.stream).toBe("stdout");
    } else {
      throw new Error("expected adapter_output narrowing");
    }
  });
});

describe("TaskReconciledEventSchema", () => {
  const BASE_RECONCILED = {
    ...BASE,
    type: "task_reconciled" as const,
    task_id: "task_01HXABCDEF1234567890ABCDEF",
  };

  // 23
  it("parses a minimum payload with all three optional fields defaulted", () => {
    const result = EventSchema.safeParse(BASE_RECONCILED);
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.type !== "task_reconciled") {
      throw new Error("expected task_reconciled narrowing");
    }
    expect(result.data.removed_created_in_session).toBeNull();
    expect(result.data.created_in_session_replacement).toBeNull();
    expect(result.data.removed_linked_sessions).toEqual([]);
  });

  // 24
  it("parses a full payload with all three optional fields specified", () => {
    const result = EventSchema.safeParse({
      ...BASE_RECONCILED,
      removed_created_in_session: "ses_01HXABCDEF1234567890ABCBR1",
      created_in_session_replacement: "ses_01HXABCDEF1234567890ABCRC1",
      removed_linked_sessions: ["ses_01HXABCDEF1234567890ABCBR1"],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.type !== "task_reconciled") {
      throw new Error("expected task_reconciled narrowing");
    }
    expect(result.data.removed_created_in_session).toBe("ses_01HXABCDEF1234567890ABCBR1");
    expect(result.data.created_in_session_replacement).toBe("ses_01HXABCDEF1234567890ABCRC1");
    expect(result.data.removed_linked_sessions).toEqual(["ses_01HXABCDEF1234567890ABCBR1"]);
  });

  // 25
  it("rejects an extra field (`.strict()` contract)", () => {
    // Probe via safeParse with an unknown property — `.strict()` should reject
    // it so a buggy core can't quietly drop audit data on the floor.
    const result = EventSchema.safeParse({
      ...BASE_RECONCILED,
      rationale: "operator note",
    });
    expect(result.success).toBe(false);
  });

  // 26
  it("parses a partial payload (only removed_linked_sessions specified)", () => {
    const result = EventSchema.safeParse({
      ...BASE_RECONCILED,
      removed_linked_sessions: ["ses_01HXABCDEF1234567890ABCBR1"],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.type !== "task_reconciled") {
      throw new Error("expected task_reconciled narrowing");
    }
    expect(result.data.removed_created_in_session).toBeNull();
    expect(result.data.created_in_session_replacement).toBeNull();
    expect(result.data.removed_linked_sessions).toEqual(["ses_01HXABCDEF1234567890ABCBR1"]);
  });

  // 27
  it("narrows the EventSchema union to TaskReconciledEvent via the type literal", () => {
    const parsed = EventSchema.parse(BASE_RECONCILED);
    if (parsed.type !== "task_reconciled") {
      throw new Error("expected task_reconciled narrowing");
    }
    // TypeScript-level check: this assignment compiles only if the discriminated
    // narrowing also exports a usable TaskReconciledEvent type.
    const narrowed: TaskReconciledEvent = parsed;
    expect(narrowed.task_id).toBe("task_01HXABCDEF1234567890ABCDEF");
  });
});

describe("TaskLinkageRefreshedEventSchema", () => {
  const BASE_REFRESHED = {
    ...BASE,
    type: "task_linkage_refreshed" as const,
    task_id: "task_01HXABCDEF1234567890ABCDEF",
  };

  it("parses a minimum payload with array defaults applied", () => {
    const result = EventSchema.safeParse(BASE_REFRESHED);
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.type !== "task_linkage_refreshed") {
      throw new Error("expected task_linkage_refreshed narrowing");
    }
    expect(result.data.added_linked_sessions).toEqual([]);
    expect(result.data.removed_linked_sessions).toEqual([]);
    expect(result.data.final_count).toBeUndefined();
  });

  it("parses a full payload with added / removed / final_count", () => {
    const result = EventSchema.safeParse({
      ...BASE_REFRESHED,
      added_linked_sessions: ["ses_01HXABCDEF1234567890ABCAD1"],
      removed_linked_sessions: ["ses_01HXABCDEF1234567890ABCRM1"],
      final_count: 3,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.type !== "task_linkage_refreshed") {
      throw new Error("expected task_linkage_refreshed narrowing");
    }
    expect(result.data.added_linked_sessions).toEqual(["ses_01HXABCDEF1234567890ABCAD1"]);
    expect(result.data.removed_linked_sessions).toEqual(["ses_01HXABCDEF1234567890ABCRM1"]);
    expect(result.data.final_count).toBe(3);
  });

  it("rejects an extra field (`.strict()` contract)", () => {
    const result = EventSchema.safeParse({
      ...BASE_REFRESHED,
      rationale: "operator note",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative final_count", () => {
    const result = EventSchema.safeParse({
      ...BASE_REFRESHED,
      final_count: -1,
    });
    expect(result.success).toBe(false);
  });

  it("narrows the EventSchema union to TaskLinkageRefreshedEvent", () => {
    const parsed = EventSchema.parse(BASE_REFRESHED);
    if (parsed.type !== "task_linkage_refreshed") {
      throw new Error("expected task_linkage_refreshed narrowing");
    }
    const narrowed: TaskLinkageRefreshedEvent = parsed;
    expect(narrowed.task_id).toBe("task_01HXABCDEF1234567890ABCDEF");
  });
});

describe("TaskDeletedEventSchema", () => {
  const BASE_DELETED = {
    ...BASE,
    type: "task_deleted" as const,
    task_id: "task_01HXABCDEF1234567890ABCDEF",
    title: "the deleted task",
  };

  it("parses a valid task_deleted payload", () => {
    const result = EventSchema.safeParse(BASE_DELETED);
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.type !== "task_deleted") {
      throw new Error("expected task_deleted narrowing");
    }
    expect(result.data.task_id).toBe("task_01HXABCDEF1234567890ABCDEF");
    expect(result.data.title).toBe("the deleted task");
  });

  it("rejects an empty title (non-empty string contract)", () => {
    const result = EventSchema.safeParse({ ...BASE_DELETED, title: "" });
    expect(result.success).toBe(false);
  });

  it("rejects an extra field (`.strict()` contract)", () => {
    const result = EventSchema.safeParse({ ...BASE_DELETED, reason: "operator note" });
    expect(result.success).toBe(false);
  });

  it("narrows the EventSchema union to TaskDeletedEvent", () => {
    const parsed = EventSchema.parse(BASE_DELETED);
    if (parsed.type !== "task_deleted") {
      throw new Error("expected task_deleted narrowing");
    }
    const narrowed: TaskDeletedEvent = parsed;
    expect(narrowed.title).toBe("the deleted task");
  });
});

describe("TaskArchivedEventSchema", () => {
  const BASE_ARCHIVED = {
    ...BASE,
    type: "task_archived" as const,
    task_id: "task_01HXABCDEF1234567890ABCDEF",
    title: "the archived task",
  };

  it("parses a valid task_archived payload", () => {
    const result = EventSchema.safeParse(BASE_ARCHIVED);
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.type !== "task_archived") {
      throw new Error("expected task_archived narrowing");
    }
    expect(result.data.title).toBe("the archived task");
  });

  it("rejects an empty title (non-empty string contract)", () => {
    const result = EventSchema.safeParse({ ...BASE_ARCHIVED, title: "" });
    expect(result.success).toBe(false);
  });

  it("rejects an extra field (`.strict()` contract)", () => {
    const result = EventSchema.safeParse({ ...BASE_ARCHIVED, reason: "operator note" });
    expect(result.success).toBe(false);
  });

  it("narrows the EventSchema union to TaskArchivedEvent", () => {
    const parsed = EventSchema.parse(BASE_ARCHIVED);
    if (parsed.type !== "task_archived") {
      throw new Error("expected task_archived narrowing");
    }
    const narrowed: TaskArchivedEvent = parsed;
    expect(narrowed.task_id).toBe("task_01HXABCDEF1234567890ABCDEF");
  });
});

// ============================================================================
// Decision rich fields
// ============================================================================

describe("DecisionRecordedEventSchema (rich fields)", () => {
  const BASE_DECISION = {
    ...BASE,
    type: "decision_recorded" as const,
    decision_id: "decision_01HXABCDEF1234567890ABCDEF",
    title: "Use zod v4",
  };

  it("accepts a v0.1-shape payload with only the 4 core fields", () => {
    const result = EventSchema.safeParse(BASE_DECISION);
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.type !== "decision_recorded") throw new Error("narrowing failed");
    expect(result.data.rationale).toBeUndefined();
    expect(result.data.alternatives).toBeUndefined();
    expect(result.data.rejected_reason).toBeUndefined();
    expect(result.data.linked_events).toBeUndefined();
    expect(result.data.linked_files).toBeUndefined();
  });

  it("accepts every rich field populated", () => {
    const result = EventSchema.safeParse({
      ...BASE_DECISION,
      rationale: "TypeScript と統合できる",
      alternatives: ["yup", "joi", "手書きバリデーション"],
      rejected_reason: "yup は TypeScript 統合がやや弱い",
      linked_events: ["evt_01HXABCDEF1234567890ABCDR1", "evt_01HXABCDEF1234567890ABCDR2"],
      linked_files: ["src/components/ContactForm.tsx"],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.type !== "decision_recorded") throw new Error("narrowing failed");
    expect(result.data.rationale).toBe("TypeScript と統合できる");
    expect(result.data.alternatives).toEqual(["yup", "joi", "手書きバリデーション"]);
    expect(result.data.rejected_reason).toBe("yup は TypeScript 統合がやや弱い");
    expect(result.data.linked_events).toHaveLength(2);
    expect(result.data.linked_files).toEqual(["src/components/ContactForm.tsx"]);
  });

  it("accepts rationale=null explicitly (= operator cleared the field)", () => {
    const result = EventSchema.safeParse({
      ...BASE_DECISION,
      rationale: null,
      rejected_reason: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts kind: "track" and kind: "decision"', () => {
    for (const kind of ["track", "decision"] as const) {
      const result = EventSchema.safeParse({ ...BASE_DECISION, kind });
      expect(result.success).toBe(true);
      if (!result.success) continue;
      if (result.data.type !== "decision_recorded") throw new Error("narrowing failed");
      expect(result.data.kind).toBe(kind);
    }
  });

  it("leaves kind undefined on a payload that omits it (default = plain decision)", () => {
    const result = EventSchema.safeParse(BASE_DECISION);
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.type !== "decision_recorded") throw new Error("narrowing failed");
    expect(result.data.kind).toBeUndefined();
  });

  it("rejects an unknown kind value", () => {
    const result = EventSchema.safeParse({ ...BASE_DECISION, kind: "roadmap" });
    expect(result.success).toBe(false);
  });

  it("rejects an alternatives entry that is an empty string", () => {
    const result = EventSchema.safeParse({
      ...BASE_DECISION,
      alternatives: ["yup", ""],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a linked_event with the wrong prefix", () => {
    const result = EventSchema.safeParse({
      ...BASE_DECISION,
      linked_events: ["ses_01HXABCDEF1234567890ABCDR1"],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a linked_event id that does not exist in the workspace (opaque reference)", () => {
    // The schema only validates the SHAPE; the renderer marks unresolvable
    // ids as `(missing)` at render time. This keeps round-trips across
    // workspaces safe.
    const result = EventSchema.safeParse({
      ...BASE_DECISION,
      linked_events: ["evt_01HXABCDEF0000000000NEVER1"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a linked_file that is the empty string", () => {
    const result = EventSchema.safeParse({
      ...BASE_DECISION,
      linked_files: ["src/x.ts", ""],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a linked_file path that exceeds the 4096-char cap", () => {
    const long = `${"a/".repeat(2049)}b.ts`;
    const result = EventSchema.safeParse({
      ...BASE_DECISION,
      linked_files: [long],
    });
    expect(result.success).toBe(false);
  });

  it("round-trips a JSON serialization with rich fields intact", () => {
    const original = {
      ...BASE_DECISION,
      rationale: "x",
      alternatives: ["a", "b"],
      rejected_reason: "y",
      linked_events: ["evt_01HXABCDEF1234567890ABCDR1"],
      linked_files: ["src/x.ts", "src/y.ts"],
    };
    const json = JSON.stringify(original);
    const parsed = EventSchema.parse(JSON.parse(json));
    if (parsed.type !== "decision_recorded") throw new Error("narrowing failed");
    expect(parsed.rationale).toBe("x");
    expect(parsed.alternatives).toEqual(["a", "b"]);
    expect(parsed.linked_events).toEqual(["evt_01HXABCDEF1234567890ABCDR1"]);
  });
});
