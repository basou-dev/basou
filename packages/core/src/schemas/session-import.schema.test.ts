import { describe, expect, it } from "vitest";
import { SessionImportPayloadSchema } from "./session-import.schema.js";

const SESSION_ID = "ses_01HXABCDEF1234567890ABCDEF";

const VALID_INNER = {
  workspace_id: "ws_01HXABCDEF1234567890ABCDEF",
  source: { kind: "claude-code-adapter", version: "0.1.0" },
  started_at: "2026-05-04T09:00:00+09:00",
  status: "completed",
  working_directory: "/srv/example-project",
  invocation: { command: "claude", args: [], exit_code: 0 },
  related_files: [],
};

const VALID_EVENT = {
  schema_version: "0.1.0",
  type: "session_started",
  id: "evt_01HXABCDEF1234567890ABCDEF",
  session_id: SESSION_ID,
  occurred_at: "2026-05-04T09:00:00+09:00",
  source: "claude-code-adapter",
};

const buildPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema_version: "0.1.0",
  session: VALID_INNER,
  events: [VALID_EVENT],
  ...overrides,
});

const buildSession = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...VALID_INNER,
  ...overrides,
});

describe("SessionImportPayloadSchema", () => {
  it("accepts a minimal payload with no optional fields", () => {
    expect(SessionImportPayloadSchema.safeParse(buildPayload()).success).toBe(true);
  });

  it("accepts a full payload with every optional field populated", () => {
    const full = buildPayload({
      session: buildSession({
        id: SESSION_ID,
        label: "round-trip fixture",
        task_id: "task_01HXABCDEF1234567890ABCDEF",
        ended_at: "2026-05-04T10:30:00+09:00",
        related_files: ["src/foo.ts", "src/bar.ts"],
        events_log: "events.jsonl",
        summary: "imported from external dump",
      }),
    });
    expect(SessionImportPayloadSchema.safeParse(full).success).toBe(true);
  });

  it("accepts a payload with zero events", () => {
    const empty = buildPayload({ events: [] });
    expect(SessionImportPayloadSchema.safeParse(empty).success).toBe(true);
  });

  it("accepts a payload with many events", () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      ...VALID_EVENT,
      type: "command_executed",
      command: "echo",
      args: [String(i)],
      cwd: "/srv/example-project",
      exit_code: 0,
      duration_ms: 10 + i,
      occurred_at: `2026-05-04T09:00:0${i}+09:00`,
    }));
    expect(SessionImportPayloadSchema.safeParse(buildPayload({ events })).success).toBe(true);
  });

  it("accepts task_id explicitly null", () => {
    const payload = buildPayload({
      session: buildSession({ task_id: null }),
    });
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("accepts summary explicitly null", () => {
    const payload = buildPayload({
      session: buildSession({ summary: null }),
    });
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("accepts label omitted", () => {
    // No label key on the inner session; SessionInnerImportSchema.label is
    // optional and conditional-spread maintains the omit downstream.
    expect(SessionImportPayloadSchema.safeParse(buildPayload()).success).toBe(true);
  });

  it("rejects unknown top-level keys (strict envelope)", () => {
    const payload = { ...buildPayload(), extra: "nope" };
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects when schema_version is missing", () => {
    const { schema_version: _omit, ...rest } = buildPayload();
    expect(SessionImportPayloadSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects when events is missing", () => {
    const { events: _omit, ...rest } = buildPayload();
    expect(SessionImportPayloadSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects when session is missing", () => {
    const { session: _omit, ...rest } = buildPayload();
    expect(SessionImportPayloadSchema.safeParse(rest).success).toBe(false);
  });

  // schema_version is z.string() so the orchestrator owns the K3 reject for
  // mismatched literals; the schema layer only filters non-strings.
  it("accepts schema_version '0.2.0' (K3 reject deferred to orchestrator)", () => {
    expect(
      SessionImportPayloadSchema.safeParse(buildPayload({ schema_version: "0.2.0" })).success,
    ).toBe(true);
  });

  it("accepts schema_version '' (K3 reject deferred to orchestrator)", () => {
    expect(SessionImportPayloadSchema.safeParse(buildPayload({ schema_version: "" })).success).toBe(
      true,
    );
  });

  it("rejects schema_version when it is not a string (e.g. number)", () => {
    expect(
      SessionImportPayloadSchema.safeParse(buildPayload({ schema_version: 123 })).success,
    ).toBe(false);
  });

  it("rejects an unknown session.status enum value", () => {
    const payload = buildPayload({
      session: buildSession({ status: "unknown" }),
    });
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects an unknown session.source.kind enum value", () => {
    const payload = buildPayload({
      session: buildSession({
        source: { kind: "unknown-source", version: "0.1.0" },
      }),
    });
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects workspace_id without ws_ prefix", () => {
    const payload = buildPayload({
      session: buildSession({ workspace_id: "01HXABCDEF1234567890ABCDEF" }),
    });
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects task_id without task_ prefix", () => {
    const payload = buildPayload({
      session: buildSession({ task_id: "foo" }),
    });
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("accepts task_id null", () => {
    const payload = buildPayload({
      session: buildSession({ task_id: null }),
    });
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("accepts task_id omitted", () => {
    const { task_id: _omit, ...inner } = buildSession({
      task_id: null,
    });
    const payload = buildPayload({ session: inner });
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("rejects an events[].type outside the 15-variant union", () => {
    const payload = buildPayload({
      events: [{ ...VALID_EVENT, type: "foo" }],
    });
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects events[].id without evt_ prefix", () => {
    const payload = buildPayload({
      events: [{ ...VALID_EVENT, id: "ses_01HXABCDEF1234567890ABCDEF" }],
    });
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects events[].session_id without ses_ prefix", () => {
    const payload = buildPayload({
      events: [{ ...VALID_EVENT, session_id: "evt_01HXABCDEF1234567890ABCDEF" }],
    });
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects command_executed event without args", () => {
    const { source: _src, ...base } = VALID_EVENT;
    const payload = buildPayload({
      events: [
        {
          ...base,
          source: "terminal-recording",
          type: "command_executed",
          command: "echo",
          // args intentionally omitted
          cwd: "/srv/example-project",
          exit_code: 0,
          duration_ms: 1,
        },
      ],
    });
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects adapter_output event with extra 'body' key (.strict() variant)", () => {
    const payload = buildPayload({
      events: [
        {
          ...VALID_EVENT,
          type: "adapter_output",
          stream: "stdout",
          summary: "hello",
          raw_ref: "raw/foo.txt",
          body: "should-not-be-here",
        },
      ],
    });
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(false);
  });

  // 'critical' is a valid RiskLevelSchema enum value; the plan example was
  // mis-stated. Use a clearly out-of-enum value instead.
  it("rejects approval_requested event with unknown risk_level", () => {
    const payload = buildPayload({
      events: [
        {
          ...VALID_EVENT,
          type: "approval_requested",
          approval_id: "appr_01HXABCDEF1234567890ABCDEF",
          risk_level: "urgent",
          action: { kind: "shell_command" },
          reason: "needs approval",
          status: "pending",
        },
      ],
    });
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(false);
  });
});
