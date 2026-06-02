import { describe, expect, it } from "vitest";
import { SessionImportPayloadSchema } from "../../schemas/session-import.schema.js";
import {
  CLAUDE_IMPORT_SOURCE,
  type ClaudeTranscriptRecord,
  claudeTranscriptToImportPayload,
} from "./transcript-importer.js";

const WS_ID = "ws_01HXABCDEF1234567890ABCDEF";
const CWD = "/Users/x/projects/foo";

function transform(records: ClaudeTranscriptRecord[]) {
  return claudeTranscriptToImportPayload(records, { workspaceId: WS_ID });
}

describe("claudeTranscriptToImportPayload", () => {
  it("derives session lifecycle + command_executed + file_changed from tool uses", () => {
    const records: ClaudeTranscriptRecord[] = [
      {
        type: "user",
        timestamp: "2026-05-10T00:00:00.000Z",
        cwd: CWD,
        sessionId: "abc-123",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      {
        type: "assistant",
        timestamp: "2026-05-10T00:00:01.000Z",
        cwd: CWD,
        message: {
          content: [
            { type: "text", text: "running" },
            { type: "tool_use", name: "Bash", input: { command: "npm test", description: "test" } },
          ],
        },
      },
      {
        type: "assistant",
        timestamp: "2026-05-10T00:00:02.000Z",
        cwd: CWD,
        message: {
          content: [
            { type: "tool_use", name: "Edit", input: { file_path: `${CWD}/a.ts` } },
            { type: "tool_use", name: "Write", input: { file_path: `${CWD}/b.ts` } },
          ],
        },
      },
      // Read is not a captured action; the record must be ignored.
      {
        type: "assistant",
        timestamp: "2026-05-10T00:00:03.000Z",
        cwd: CWD,
        message: {
          content: [{ type: "tool_use", name: "Read", input: { file_path: `${CWD}/c.ts` } }],
        },
      },
    ];

    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;

    // Valid against the import payload contract.
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(true);

    expect(payload.session.source.kind).toBe(CLAUDE_IMPORT_SOURCE);
    expect(payload.session.started_at).toBe("2026-05-10T00:00:00.000Z");
    expect(payload.session.ended_at).toBe("2026-05-10T00:00:03.000Z");
    expect(payload.session.working_directory).toBe(CWD);
    expect(payload.session.workspace_id).toBe(WS_ID);
    expect(payload.session.related_files).toEqual([`${CWD}/a.ts`, `${CWD}/b.ts`]);
    // The transcript's own sessionId becomes the source external_id (dedup key).
    expect(payload.session.source.external_id).toBe("abc-123");
    // The label is a human-readable summary (date + counts), not an opaque id.
    expect(payload.session.label).toBe("claude-code 2026-05-10: 1 command, 2 files");

    const types = payload.events.map((e) => e.type);
    expect(types).toEqual([
      "session_started",
      "command_executed",
      "file_changed",
      "file_changed",
      "session_ended",
    ]);

    const command = payload.events[1];
    if (command?.type !== "command_executed") throw new Error("expected command_executed");
    expect(command.command).toBe("bash");
    expect(command.args).toEqual(["-c", "npm test"]);
    expect(command.cwd).toBe(CWD);
    expect(command.exit_code).toBeNull();
    expect(command.duration_ms).toBe(0);

    const edit = payload.events[2];
    if (edit?.type !== "file_changed") throw new Error("expected file_changed");
    expect(edit.change_type).toBe("modified");

    const write = payload.events[3];
    if (write?.type !== "file_changed") throw new Error("expected file_changed");
    expect(write.change_type).toBe("added");
  });

  it("emits events in non-decreasing chronological order", () => {
    const records: ClaudeTranscriptRecord[] = [
      { type: "user", timestamp: "2026-05-10T00:00:00.000Z", cwd: CWD, message: { content: [] } },
      {
        type: "assistant",
        timestamp: "2026-05-10T00:00:05.000Z",
        cwd: CWD,
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
      },
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    for (let i = 1; i < payload.events.length; i++) {
      const prevEvent = payload.events[i - 1];
      const currEvent = payload.events[i];
      if (prevEvent === undefined || currEvent === undefined) continue;
      expect(Date.parse(currEvent.occurred_at)).toBeGreaterThanOrEqual(
        Date.parse(prevEvent.occurred_at),
      );
    }
  });

  it("orders output even when transcript records are not timestamp-sorted on disk", () => {
    // Real transcripts interleave sidechain / async-written records, so file
    // order is not chronological. The transform must sort regardless.
    const records: ClaudeTranscriptRecord[] = [
      {
        type: "assistant",
        timestamp: "2026-05-10T00:00:05.000Z",
        cwd: CWD,
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "second" } }] },
      },
      {
        type: "assistant",
        timestamp: "2026-05-10T00:00:01.000Z",
        cwd: CWD,
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "first" } }] },
      },
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(true);
    expect(payload.session.started_at).toBe("2026-05-10T00:00:01.000Z");
    expect(payload.session.ended_at).toBe("2026-05-10T00:00:05.000Z");
    for (let i = 1; i < payload.events.length; i++) {
      const prevEvent = payload.events[i - 1];
      const currEvent = payload.events[i];
      if (prevEvent === undefined || currEvent === undefined) continue;
      expect(Date.parse(currEvent.occurred_at)).toBeGreaterThanOrEqual(
        Date.parse(prevEvent.occurred_at),
      );
    }
    // The earlier command must come first after sorting.
    const commands = payload.events.filter((e) => e.type === "command_executed");
    expect(commands).toHaveLength(2);
    if (commands[0]?.type === "command_executed") {
      expect(commands[0].args).toEqual(["-c", "first"]);
    }
  });

  it("prefers the provided externalId over the records' sessionId", () => {
    const records: ClaudeTranscriptRecord[] = [
      {
        type: "assistant",
        timestamp: "2026-05-10T00:00:01.000Z",
        cwd: CWD,
        sessionId: "from-records",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
      },
    ];
    const payload = claudeTranscriptToImportPayload(records, {
      workspaceId: WS_ID,
      externalId: "from-option",
    });
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect(payload.session.source.external_id).toBe("from-option");
    // The id lives in source.external_id; the label is a content summary, not the id.
    expect(payload.session.label).not.toContain("from-option");
    expect(payload.session.label).toMatch(/^claude-code \d{4}-\d{2}-\d{2}: \d+ command/);
  });

  it("returns null when no observable command / file action exists", () => {
    const records: ClaudeTranscriptRecord[] = [
      {
        type: "user",
        timestamp: "2026-05-10T00:00:00.000Z",
        cwd: CWD,
        message: { content: [{ type: "text", text: "just chatting" }] },
      },
      {
        type: "assistant",
        timestamp: "2026-05-10T00:00:01.000Z",
        cwd: CWD,
        message: {
          content: [{ type: "tool_use", name: "Read", input: { file_path: `${CWD}/x` } }],
        },
      },
    ];
    expect(transform(records)).toBeNull();
  });

  it("returns null for an empty transcript", () => {
    expect(transform([])).toBeNull();
  });

  it("skips malformed-shaped records without throwing", () => {
    const records: ClaudeTranscriptRecord[] = [
      { type: "queue-operation", operation: "enqueue" }, // no timestamp
      { type: "assistant", timestamp: "2026-05-10T00:00:01.000Z", message: "not-an-object" },
      {
        type: "assistant",
        timestamp: "2026-05-10T00:00:02.000Z",
        cwd: CWD,
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "echo hi" } }] },
      },
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect(payload.events.map((e) => e.type)).toEqual([
      "session_started",
      "command_executed",
      "session_ended",
    ]);
  });

  it("derives decision_recorded from AskUserQuestion, titled question -> chosen answer", () => {
    const records: ClaudeTranscriptRecord[] = [
      {
        type: "assistant",
        timestamp: "2026-05-10T00:00:01.000Z",
        cwd: CWD,
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_ask1",
              name: "AskUserQuestion",
              input: {
                questions: [
                  { question: "Which DB?", header: "DB", options: [{ label: "Postgres" }] },
                  { question: "Cache?", header: "Cache", options: [{ label: "Redis" }] },
                ],
              },
            },
          ],
        },
      },
      // The chosen answers arrive on the later result record, keyed by question.
      {
        type: "user",
        timestamp: "2026-05-10T00:00:02.000Z",
        cwd: CWD,
        toolUseResult: { questions: [], answers: { "Which DB?": "Postgres", "Cache?": "Redis" } },
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_ask1", content: "ok" }] },
      },
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    // A decisions-only transcript still carries provenance worth importing.
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(true);
    expect(payload.events.map((e) => e.type)).toEqual([
      "session_started",
      "decision_recorded",
      "decision_recorded",
      "session_ended",
    ]);
    const titles = payload.events.flatMap((e) => (e.type === "decision_recorded" ? [e.title] : []));
    expect(titles).toEqual(["Which DB? -> Postgres", "Cache? -> Redis"]);
    for (const e of payload.events) {
      if (e.type === "decision_recorded") expect(e.decision_id).toMatch(/^decision_/);
    }
  });

  it("skips AskUserQuestion decisions when no structured answer is recorded", () => {
    const records: ClaudeTranscriptRecord[] = [
      {
        type: "assistant",
        timestamp: "2026-05-10T00:00:01.000Z",
        cwd: CWD,
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_ask2",
              name: "AskUserQuestion",
              input: { questions: [{ question: "Q?", header: "Q", options: [] }] },
            },
            // A real action so the session is not skipped outright.
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
      // No result record carries answers for toolu_ask2.
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect(payload.events.some((e) => e.type === "decision_recorded")).toBe(false);
    expect(payload.events.some((e) => e.type === "command_executed")).toBe(true);
  });

  it("sums assistant message usage into session.metrics", () => {
    const records: ClaudeTranscriptRecord[] = [
      {
        type: "assistant",
        timestamp: "2026-05-10T00:00:01.000Z",
        cwd: CWD,
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
          usage: { output_tokens: 300, input_tokens: 10, cache_read_input_tokens: 5000 },
        },
      },
      {
        type: "assistant",
        timestamp: "2026-05-10T00:00:02.000Z",
        cwd: CWD,
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: "pwd" } }],
          usage: { output_tokens: 200, input_tokens: 4, cache_read_input_tokens: 6000 },
        },
      },
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    // Token fields are summed; engaged-time fields may also be present.
    expect(payload.session.metrics?.output_tokens).toBe(500);
    expect(payload.session.metrics?.input_tokens).toBe(14);
    expect(payload.session.metrics?.cached_input_tokens).toBe(11000);
  });

  it("counts usage once per message.id (split thinking/text/tool_use records)", () => {
    // A single assistant message split across 3 records, each repeating the
    // same id + usage; the token total must count it once, not thrice.
    const dupRecord = (text: string) => ({
      type: "assistant",
      timestamp: "2026-05-10T00:00:01.000Z",
      cwd: CWD,
      message: {
        id: "msg_duplicate",
        content: [{ type: "tool_use", name: "Bash", input: { command: text } }],
        usage: { output_tokens: 1000, input_tokens: 20 },
      },
    });
    const records: ClaudeTranscriptRecord[] = [dupRecord("a"), dupRecord("b"), dupRecord("c")];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect(payload.session.metrics).toEqual({ output_tokens: 1000, input_tokens: 20 });
  });

  it("omits metrics when no usage and too few turns are present", () => {
    const records: ClaudeTranscriptRecord[] = [
      {
        type: "assistant",
        timestamp: "2026-05-10T00:00:01.000Z",
        cwd: CWD,
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
      },
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect(payload.session.metrics).toBeUndefined();
  });

  it("captures engaged-time intervals from human and assistant turns", () => {
    const records: ClaudeTranscriptRecord[] = [
      {
        type: "user",
        timestamp: "2026-05-10T00:00:00.000Z",
        cwd: CWD,
        message: { content: [{ type: "text", text: "do X" }] },
      },
      {
        type: "assistant",
        timestamp: "2026-05-10T00:01:00.000Z",
        cwd: CWD,
        message: {
          id: "m1",
          content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
        },
      },
      {
        type: "assistant",
        timestamp: "2026-05-10T00:02:00.000Z",
        cwd: CWD,
        message: { id: "m2", content: [{ type: "text", text: "done" }] },
      },
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(true);
    // Two sub-cap 1-minute gaps merge into one 2-minute active interval.
    expect(payload.session.metrics?.active_time_ms).toBe(2 * 60 * 1000);
    expect(payload.session.metrics?.active_gap_cap_ms).toBe(5 * 60 * 1000);
    expect(payload.session.metrics?.active_time_method).toBe("engaged-turns");
    expect(payload.session.metrics?.active_intervals).toEqual([
      { start: "2026-05-10T00:00:00.000Z", end: "2026-05-10T00:02:00.000Z" },
    ]);
  });

  it("excludes tool_result-only user records from the engagement series", () => {
    const records: ClaudeTranscriptRecord[] = [
      {
        type: "user",
        timestamp: "2026-05-10T00:00:00.000Z",
        cwd: CWD,
        message: { content: [{ type: "text", text: "go" }] },
      },
      {
        type: "assistant",
        timestamp: "2026-05-10T00:01:00.000Z",
        cwd: CWD,
        message: {
          id: "m1",
          content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
        },
      },
      // Tool-feedback loop 9 min later: must not extend engaged time.
      {
        type: "user",
        timestamp: "2026-05-10T00:10:00.000Z",
        cwd: CWD,
        message: { content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] },
      },
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    // Only the human prompt -> assistant gap (1 min) is credited.
    expect(payload.session.metrics?.active_time_ms).toBe(60 * 1000);
  });

  it("excludes sidechain records from the engagement series", () => {
    const records: ClaudeTranscriptRecord[] = [
      {
        type: "user",
        timestamp: "2026-05-10T00:00:00.000Z",
        cwd: CWD,
        message: { content: [{ type: "text", text: "go" }] },
      },
      {
        type: "assistant",
        timestamp: "2026-05-10T00:01:00.000Z",
        cwd: CWD,
        message: {
          id: "m1",
          content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
        },
      },
      // A sub-agent sidechain turn 9 min later: concurrent, not human-driven.
      {
        type: "assistant",
        isSidechain: true,
        timestamp: "2026-05-10T00:10:00.000Z",
        cwd: CWD,
        message: { id: "side", content: [{ type: "text", text: "..." }] },
      },
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect(payload.session.metrics?.active_time_ms).toBe(60 * 1000);
  });
});
