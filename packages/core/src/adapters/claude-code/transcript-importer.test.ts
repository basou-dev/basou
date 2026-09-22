import { describe, expect, it } from "vitest";
import { SessionImportPayloadSchema } from "../../schemas/session-import.schema.js";
import {
  CLAUDE_IMPORT_SOURCE,
  type ClaudeTranscriptRecord,
  claudeTranscriptToImportPayload,
  GIT_OBSERVED_SOURCE,
} from "./transcript-importer.js";

const WS_ID = "ws_01HXABCDEF1234567890ABCDEF";
const CWD = "/Users/x/projects/foo";

function transform(records: ClaudeTranscriptRecord[]) {
  return claudeTranscriptToImportPayload(records, { workspaceId: WS_ID });
}

describe("claudeTranscriptToImportPayload", () => {
  // Regression guard for the import boundary the timestamp narrowing made
  // mandatory (docs/spec/schemas.md §7.3). Without the normalizer call this
  // adapter would emit `occurred_at` values the event schema refuses, and the
  // lines would be DROPPED on read with a `schema_violation` rather than
  // reported -- which is the harm the rule exists to prevent. Deleting the
  // call from the adapter must fail a test, not pass quietly.
  it("normalizes a vendor timestamp that omits seconds, and keeps its offset", () => {
    const records: ClaudeTranscriptRecord[] = [
      { type: "user", timestamp: "2026-05-10T00:00+09:00", cwd: CWD, message: { content: [] } },
      {
        type: "assistant",
        timestamp: "2026-05-10T00:05+09:00",
        cwd: CWD,
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
      },
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;

    // The payload validates, which it would not if the seconds were missing.
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(true);
    expect(payload.events.every((e) => /T\d{2}:\d{2}:\d{2}/.test(e.occurred_at))).toBe(true);
    // The offset is preserved rather than folded to UTC.
    expect(payload.session.started_at).toBe("2026-05-10T00:00:00+09:00");
  });

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
    // The transcript says nothing about what ran the line, so the executor is
    // recorded as unobserved rather than as a plausible `bash`.
    expect(command.command).toBeNull();
    expect(command.args).toEqual(["-c", "npm test"]);
    expect(command.cwd).toBe(CWD);
    expect(command.exit_code).toBeNull();
    // The transcript carries no timing at all, so the duration is UNOBSERVED.
    expect(command.duration_ms).toBeNull();

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

  it("labels a day-spanning session with a start..end date range", () => {
    const records: ClaudeTranscriptRecord[] = [
      {
        type: "user",
        timestamp: "2026-05-10T22:00:00.000Z",
        cwd: CWD,
        sessionId: "abc-123",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      // Work continues past midnight; the last record dates the next day.
      {
        type: "assistant",
        timestamp: "2026-05-11T01:00:00.000Z",
        cwd: CWD,
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
        },
      },
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect(payload.session.started_at).toBe("2026-05-10T22:00:00.000Z");
    expect(payload.session.ended_at).toBe("2026-05-11T01:00:00.000Z");
    expect(payload.session.label).toBe("claude-code 2026-05-10..2026-05-11: 1 command, 0 files");
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

  it("derives a decision only for the SELECTED option, skipping a free-text 'Other' reply", () => {
    const records: ClaudeTranscriptRecord[] = [
      {
        type: "assistant",
        timestamp: "2026-05-10T00:00:01.000Z",
        cwd: CWD,
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_ask3",
              name: "AskUserQuestion",
              input: {
                questions: [
                  {
                    question: "Approach?",
                    header: "A",
                    options: [{ label: "Plan A" }, { label: "Plan B" }],
                  },
                  {
                    question: "Defer activity?",
                    header: "D",
                    options: [{ label: "Defer" }, { label: "Show now" }],
                  },
                ],
              },
            },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-05-10T00:00:02.000Z",
        cwd: CWD,
        // "Approach?" picked a real option; "Defer activity?" got a free-text
        // counter-question (operator chose "Other" and typed a meta reply).
        toolUseResult: {
          questions: [],
          answers: {
            "Approach?": "Plan B",
            "Defer activity?": "Did you actually run basou refresh this session?",
          },
        },
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_ask3", content: "ok" }] },
      },
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    const titles = payload.events.flatMap((e) => (e.type === "decision_recorded" ? [e.title] : []));
    // Only the confirmed selection becomes a decision; the meta reply is dropped.
    expect(titles).toEqual(["Approach? -> Plan B"]);
  });

  it("does NOT auto-derive a decision from a comma-joined answer that is not an exact label", () => {
    // Multi-select serialization is undocumented, so only an exact label match
    // counts. A comma-joined answer (or a meta reply that happens to list
    // label-like words) is deliberately NOT auto-derived — this prevents a
    // single-choice "Other" answer like "Auth, Billing" from becoming a false
    // decision. The agent can still record a real multi-select via capture.
    const records: ClaudeTranscriptRecord[] = [
      {
        type: "assistant",
        timestamp: "2026-05-10T00:00:01.000Z",
        cwd: CWD,
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_ask4",
              name: "AskUserQuestion",
              input: {
                questions: [
                  {
                    question: "Features?",
                    header: "F",
                    options: [{ label: "Auth" }, { label: "Billing" }, { label: "Search" }],
                  },
                ],
              },
            },
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-05-10T00:00:02.000Z",
        cwd: CWD,
        toolUseResult: { questions: [], answers: { "Features?": "Auth, Search" } },
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_ask4", content: "ok" }] },
      },
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect(payload.events.some((e) => e.type === "decision_recorded")).toBe(false);
    expect(payload.events.some((e) => e.type === "command_executed")).toBe(true);
  });

  it("skips an AskUserQuestion answer when the question offered no options", () => {
    const records: ClaudeTranscriptRecord[] = [
      {
        type: "assistant",
        timestamp: "2026-05-10T00:00:01.000Z",
        cwd: CWD,
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_ask5",
              name: "AskUserQuestion",
              input: { questions: [{ question: "Free?", header: "F", options: [] }] },
            },
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-05-10T00:00:02.000Z",
        cwd: CWD,
        toolUseResult: { questions: [], answers: { "Free?": "anything typed here" } },
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_ask5", content: "ok" }] },
      },
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect(payload.events.some((e) => e.type === "decision_recorded")).toBe(false);
    expect(payload.events.some((e) => e.type === "command_executed")).toBe(true);
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

describe("claudeTranscriptToImportPayload with git-observed files", () => {
  /** A session that ran one shell command and edited nothing with a tool. */
  const shellOnly: ClaudeTranscriptRecord[] = [
    { type: "user", timestamp: "2026-09-22T00:00:00.000Z", cwd: CWD, message: { content: [] } },
    {
      type: "assistant",
      timestamp: "2026-09-22T00:05:00.000Z",
      cwd: CWD,
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "python3 - <<'PY'\nopen('a.ts','w').write('x')\nPY" },
          },
        ],
      },
    },
  ];

  it("records a file the transcript could never name, under its own source", () => {
    const payload = claudeTranscriptToImportPayload(shellOnly, {
      workspaceId: WS_ID,
      observedFiles: [{ path: `${CWD}/a.ts`, change_type: "added" }],
    });
    expect(payload).not.toBeNull();
    if (payload === null) return;

    const changed = payload.events.filter((e) => e.type === "file_changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      path: `${CWD}/a.ts`,
      change_type: "added",
      source: GIT_OBSERVED_SOURCE,
    });
    expect(payload.session.related_files).toEqual([`${CWD}/a.ts`]);
    // The label counts it, which is what makes the session readable as work.
    expect(payload.session.label).toContain("1 file");
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("carries the statuses a transcript cannot express", () => {
    const payload = claudeTranscriptToImportPayload(shellOnly, {
      workspaceId: WS_ID,
      observedFiles: [
        { path: `${CWD}/gone.ts`, change_type: "deleted" },
        { path: `${CWD}/new.ts`, change_type: "renamed", old_path: `${CWD}/old.ts` },
      ],
    });
    if (payload === null) throw new Error("expected a payload");
    const changed = payload.events.filter((e) => e.type === "file_changed");
    expect(changed.map((e) => e.change_type).sort()).toEqual(["deleted", "renamed"]);
    expect(changed.find((e) => e.change_type === "renamed")).toMatchObject({
      old_path: `${CWD}/old.ts`,
    });
  });

  it("does not double-count a file a tool call already recorded", () => {
    const records: ClaudeTranscriptRecord[] = [
      { type: "user", timestamp: "2026-09-22T00:00:00.000Z", cwd: CWD, message: { content: [] } },
      {
        type: "assistant",
        timestamp: "2026-09-22T00:05:00.000Z",
        cwd: CWD,
        message: {
          content: [{ type: "tool_use", name: "Edit", input: { file_path: `${CWD}/a.ts` } }],
        },
      },
    ];
    const payload = claudeTranscriptToImportPayload(records, {
      workspaceId: WS_ID,
      observedFiles: [{ path: `${CWD}/a.ts`, change_type: "modified" }],
    });
    if (payload === null) throw new Error("expected a payload");
    const changed = payload.events.filter((e) => e.type === "file_changed");
    expect(changed).toHaveLength(1);
    // The tool-derived event survives: it names the edit, not the difference.
    expect(changed[0]?.source).toBe(CLAUDE_IMPORT_SOURCE);
    expect(payload.session.related_files).toEqual([`${CWD}/a.ts`]);
  });

  it("stamps observations at the session's end, keeping the stream in order", () => {
    const payload = claudeTranscriptToImportPayload(shellOnly, {
      workspaceId: WS_ID,
      observedFiles: [{ path: `${CWD}/a.ts`, change_type: "added" }],
    });
    if (payload === null) throw new Error("expected a payload");
    const times = payload.events.map((e) => Date.parse(e.occurred_at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const observed = payload.events.find((e) => e.source === GIT_OBSERVED_SOURCE);
    expect(observed?.occurred_at).toBe(payload.session.ended_at);
  });

  it("does not conjure a session out of observations alone", () => {
    const noToolUse: ClaudeTranscriptRecord[] = [
      { type: "user", timestamp: "2026-09-22T00:00:00.000Z", cwd: CWD, message: { content: [] } },
    ];
    expect(
      claudeTranscriptToImportPayload(noToolUse, {
        workspaceId: WS_ID,
        observedFiles: [{ path: `${CWD}/a.ts`, change_type: "added" }],
      }),
    ).toBeNull();
  });
});
