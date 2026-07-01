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

  it("preserves an unknown top-level field (forward-compatible; loose, not strip)", () => {
    // A future 0.x session may add fields this basou does not know. The loose
    // schema must PRESERVE them so a read+rewrite (finalizeSessionYaml) does not
    // silently drop them — this is what makes accepting a higher minor safe.
    const withFuture = { ...VALID_SESSION, future_field: { note: "added in a later 0.x" } };
    const parsed = SessionSchema.parse(withFuture);
    expect((parsed as Record<string, unknown>).future_field).toEqual({
      note: "added in a later 0.x",
    });
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

  it("accepts metrics with machine_active_time_ms", () => {
    const variant = {
      ...VALID_SESSION,
      session: {
        ...VALID_SESSION.session,
        metrics: {
          output_tokens: 768,
          active_time_ms: 600000,
          active_intervals: [
            { start: "2026-05-04T09:00:00+09:00", end: "2026-05-04T09:10:00+09:00" },
          ],
          active_gap_cap_ms: 300000,
          active_time_method: "turn-intervals",
          machine_active_time_ms: 420000,
        },
      },
    };
    expect(SessionSchema.safeParse(variant).success).toBe(true);
  });

  it("rejects a negative machine_active_time_ms", () => {
    const variant = {
      ...VALID_SESSION,
      session: {
        ...VALID_SESSION.session,
        metrics: { machine_active_time_ms: -1 },
      },
    };
    expect(SessionSchema.safeParse(variant).success).toBe(false);
  });
});
