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
    expect(payload.session.label).toContain("from-option");
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
});
