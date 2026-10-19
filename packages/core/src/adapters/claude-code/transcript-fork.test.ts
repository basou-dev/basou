import { describe, expect, it } from "vitest";
import { claudeTranscriptOwnRecords, claudeTranscriptRecordUuid } from "./transcript-fork.js";
import {
  type ClaudeTranscriptRecord,
  claudeTranscriptToImportPayload,
} from "./transcript-importer.js";

const WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;

function user(uuid: string, timestamp: string, text: string): ClaudeTranscriptRecord {
  return {
    type: "user",
    uuid,
    timestamp,
    cwd: "/work/project",
    sessionId: "fork",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function bash(
  uuid: string,
  timestamp: string,
  command: string,
  messageId: string,
  outputTokens: number,
): ClaudeTranscriptRecord {
  return {
    type: "assistant",
    uuid,
    timestamp,
    cwd: "/work/project",
    sessionId: "fork",
    message: {
      id: messageId,
      usage: { output_tokens: outputTokens },
      content: [{ type: "tool_use", name: "Bash", input: { command } }],
    },
  };
}

function queued(timestamp: string): ClaudeTranscriptRecord {
  return { type: "queue-operation", operation: "enqueue", timestamp, sessionId: "fork" };
}

// A transcript forked from another: two metadata lines, the copied records (a
// queue-operation among them, as Claude Code writes beside a prompt), then what
// the fork added.
const COPIES = [
  queued("2026-10-01T12:00:00.050Z"),
  user("u-1", "2026-10-01T12:00:00.000Z", "start"),
  bash("u-2", "2026-10-01T12:00:05.000Z", "git status", "m-1", 100),
  queued("2026-10-01T12:30:00.000Z"),
  user("u-3", "2026-10-01T12:30:00.010Z", "next"),
  bash("u-4", "2026-10-01T12:30:05.000Z", "pnpm test", "m-2", 200),
];
const OWN = [
  queued("2026-10-01T14:00:00.000Z"),
  user("f-1", "2026-10-01T14:00:00.010Z", "forked task"),
  bash("f-2", "2026-10-01T14:00:05.000Z", "pnpm build", "m-3", 300),
];
const FORK: ClaudeTranscriptRecord[] = [
  { type: "custom-title", customTitle: "Basou", sessionId: "fork" },
  { type: "agent-name", agentName: "Basou", sessionId: "fork" },
  ...COPIES,
  ...OWN,
];
const COPIED_UUIDS = new Set(["u-1", "u-2", "u-3", "u-4", "u-unrelated"]);

describe("claudeTranscriptRecordUuid", () => {
  it("reads a non-empty string uuid and nothing else", () => {
    expect(claudeTranscriptRecordUuid({ uuid: "abc" })).toBe("abc");
    expect(claudeTranscriptRecordUuid({ uuid: "" })).toBeUndefined();
    expect(claudeTranscriptRecordUuid({ uuid: 7 })).toBeUndefined();
    expect(claudeTranscriptRecordUuid({ type: "queue-operation" })).toBeUndefined();
  });
});

describe("claudeTranscriptOwnRecords", () => {
  it("leaves out the copies and every record before the last one, and keeps what the fork added", () => {
    expect(claudeTranscriptOwnRecords(FORK, { copiedUuids: COPIED_UUIDS })).toEqual(OWN);
  });

  it("returns every record when nothing was copied and no bound is given", () => {
    expect(claudeTranscriptOwnRecords(FORK, {})).toEqual(FORK);
    expect(claudeTranscriptOwnRecords(FORK, { copiedUuids: new Set() })).toEqual(FORK);
  });

  it("keeps a record with its own uuid even when it sits among the copies", () => {
    const own = user("f-0", "2026-10-01T12:15:00.000Z", "interleaved");
    const records = [COPIES[1], own, COPIES[2]] as ClaudeTranscriptRecord[];
    expect(claudeTranscriptOwnRecords(records, { copiedUuids: COPIED_UUIDS })).toEqual([own]);
  });

  it("leaves out what is timestamped before notBefore, and keeps what carries no time", () => {
    const records: ClaudeTranscriptRecord[] = [
      { type: "custom-title", customTitle: "Basou" },
      ...COPIES,
      ...OWN,
    ];
    expect(claudeTranscriptOwnRecords(records, { notBefore: "2026-10-01T14:00:00.000Z" })).toEqual([
      { type: "custom-title", customTitle: "Basou" },
      ...OWN,
    ]);
  });

  it("does not modify its input", () => {
    const copy = structuredClone(FORK);
    claudeTranscriptOwnRecords(FORK, {
      copiedUuids: COPIED_UUIDS,
      notBefore: "2026-10-01T13:00:00.000Z",
    });
    expect(FORK).toEqual(copy);
  });

  it("gives a session that begins after the fork and counts only the fork's commands and tokens", () => {
    const whole = claudeTranscriptToImportPayload(FORK, { workspaceId: WS_ID, externalId: "fork" });
    const own = claudeTranscriptToImportPayload(
      claudeTranscriptOwnRecords(FORK, { copiedUuids: COPIED_UUIDS }),
      { workspaceId: WS_ID, externalId: "fork" },
    );
    expect(whole?.session.started_at).toBe("2026-10-01T12:00:00.000Z");
    expect(whole?.session.metrics?.output_tokens).toBe(600);
    expect(own?.session.started_at).toBe("2026-10-01T14:00:00.000Z");
    expect(own?.session.metrics?.output_tokens).toBe(300);
    const commands = (own?.events ?? []).filter((e) => e.type === "command_executed");
    expect(commands.map((e) => (e.type === "command_executed" ? e.args[1] : ""))).toEqual([
      "pnpm build",
    ]);
  });
});
