import { describe, expect, it } from "vitest";
import { EventSchema } from "./event.schema.js";

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
