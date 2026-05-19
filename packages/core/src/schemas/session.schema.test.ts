import { describe, expect, it } from "vitest";
import { SessionSchema } from "./session.schema.js";

const VALID_SESSION = {
  schema_version: "0.1.0",
  session: {
    id: "ses_01HXABCDEF1234567890ABCDEF",
    label: "2026-05-04 morning claude-code",
    task_id: null,
    workspace_id: "ws_01HXABCDEF1234567890ABCDEF",
    source: {
      kind: "claude-code-adapter",
      version: "0.1.0",
    },
    started_at: "2026-05-04T09:00:00+09:00",
    ended_at: "2026-05-04T10:30:00+09:00",
    status: "completed",
    working_directory: "/srv/example-project",
    invocation: {
      command: "claude",
      args: ["--mode", "interactive"],
      exit_code: 0,
    },
    related_files: [],
    events_log: "events.jsonl",
    summary: null,
  },
};

describe("SessionSchema", () => {
  it("accepts the minimal session example", () => {
    expect(SessionSchema.safeParse(VALID_SESSION).success).toBe(true);
  });

  it("accepts task_id omitted entirely", () => {
    const { task_id: _task_id, ...inner } = VALID_SESSION.session;
    const variant = { ...VALID_SESSION, session: inner };
    expect(SessionSchema.safeParse(variant).success).toBe(true);
  });

  it("rejects an unknown status", () => {
    const variant = {
      ...VALID_SESSION,
      session: { ...VALID_SESSION.session, status: "unknown" },
    };
    expect(SessionSchema.safeParse(variant).success).toBe(false);
  });

  it("rejects an empty working_directory", () => {
    const variant = {
      ...VALID_SESSION,
      session: { ...VALID_SESSION.session, working_directory: "" },
    };
    expect(SessionSchema.safeParse(variant).success).toBe(false);
  });

  it("accepts ended_at omitted (initialized / running session)", () => {
    const { ended_at: _ended_at, ...inner } = VALID_SESSION.session;
    const variant = {
      ...VALID_SESSION,
      session: { ...inner, status: "running" },
    };
    expect(SessionSchema.safeParse(variant).success).toBe(true);
  });
});
