import { describe, expect, it } from "vitest";
import { SessionImportPayloadSchema } from "../../schemas/session-import.schema.js";
import {
  CODEX_IMPORT_SOURCE,
  type CodexRolloutRecord,
  codexRolloutToImportPayload,
} from "./rollout-importer.js";

const WS_ID = "ws_01HXABCDEF1234567890ABCDEF";
const CWD = "/Users/x/projects/foo";
const SESSION_ID = "019df266-a7bf-77f3-bee4-4d7d27c9b847";

function sessionMeta(ts: string, cwd = CWD): CodexRolloutRecord {
  return { type: "session_meta", timestamp: ts, payload: { id: SESSION_ID, cwd, timestamp: ts } };
}

function execCall(ts: string, callId: string, cmd: string, workdir?: string): CodexRolloutRecord {
  const args: Record<string, unknown> = { cmd, yield_time_ms: 1000 };
  if (workdir !== undefined) args.workdir = workdir;
  return {
    type: "response_item",
    timestamp: ts,
    payload: {
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify(args),
      call_id: callId,
    },
  };
}

function execOutput(ts: string, callId: string, output: string): CodexRolloutRecord {
  return {
    type: "response_item",
    timestamp: ts,
    payload: { type: "function_call_output", call_id: callId, output },
  };
}

function eventMsg(ts: string, type: string): CodexRolloutRecord {
  return { type: "event_msg", timestamp: ts, payload: { type, message: "..." } };
}

function taskStarted(ts: string, turnId: string): CodexRolloutRecord {
  return { type: "event_msg", timestamp: ts, payload: { type: "task_started", turn_id: turnId } };
}

function taskComplete(ts: string, turnId: string, durationMs: number): CodexRolloutRecord {
  return {
    type: "event_msg",
    timestamp: ts,
    payload: { type: "task_complete", turn_id: turnId, duration_ms: durationMs },
  };
}

function transform(records: CodexRolloutRecord[]) {
  return codexRolloutToImportPayload(records, { workspaceId: WS_ID });
}

describe("codexRolloutToImportPayload", () => {
  it("derives session lifecycle + command_executed from exec_command calls", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-05-10T00:00:00.000Z"),
      execCall("2026-05-10T00:00:01.000Z", "call_1", "npm test", `${CWD}/pkg`),
      execOutput(
        "2026-05-10T00:00:02.000Z",
        "call_1",
        "Wall time: 1.5000 seconds\nProcess exited with code 0\nOutput:\nok",
      ),
      // A non-exec function call must be ignored (no clean command signal).
      {
        type: "response_item",
        timestamp: "2026-05-10T00:00:03.000Z",
        payload: { type: "function_call", name: "update_plan", arguments: "{}", call_id: "call_2" },
      },
    ];

    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;

    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(true);
    expect(payload.session.source.kind).toBe(CODEX_IMPORT_SOURCE);
    expect(payload.session.started_at).toBe("2026-05-10T00:00:00.000Z");
    // The last record's timestamp ends the session, even when it is not a command.
    expect(payload.session.ended_at).toBe("2026-05-10T00:00:03.000Z");
    expect(payload.session.working_directory).toBe(CWD);
    expect(payload.session.workspace_id).toBe(WS_ID);
    expect(payload.session.source.external_id).toBe(SESSION_ID);
    expect(payload.session.invocation.command).toBe("codex");
    // File changes are deferred for Codex, so related_files stays empty.
    expect(payload.session.related_files).toEqual([]);
    expect(payload.session.label).toBe("codex 2026-05-10: 1 command");

    expect(payload.events.map((e) => e.type)).toEqual([
      "session_started",
      "command_executed",
      "session_ended",
    ]);

    const command = payload.events[1];
    if (command?.type !== "command_executed") throw new Error("expected command_executed");
    expect(command.command).toBe("bash");
    expect(command.args).toEqual(["-c", "npm test"]);
    // workdir from the call arguments wins over the session cwd.
    expect(command.cwd).toBe(`${CWD}/pkg`);
    expect(command.exit_code).toBe(0);
    expect(command.duration_ms).toBe(1500);
  });

  it("parses a negative (signal) exit code and falls back to the session cwd", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-05-10T00:00:00.000Z"),
      // No workdir in arguments -> command_executed.cwd falls back to session cwd.
      execCall("2026-05-10T00:00:01.000Z", "call_1", "sleep 100"),
      execOutput(
        "2026-05-10T00:00:02.000Z",
        "call_1",
        "Wall time: 0.0000 seconds\nProcess exited with code -1\nOutput:\n",
      ),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    const command = payload.events[1];
    if (command?.type !== "command_executed") throw new Error("expected command_executed");
    expect(command.exit_code).toBe(-1);
    expect(command.cwd).toBe(CWD);
    expect(command.duration_ms).toBe(0);
  });

  it("records a null exit code when the output has no completion line", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-05-10T00:00:00.000Z"),
      // A command that yielded before completing: no paired output at all.
      execCall("2026-05-10T00:00:01.000Z", "call_1", "tail -f log"),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    const command = payload.events[1];
    if (command?.type !== "command_executed") throw new Error("expected command_executed");
    expect(command.exit_code).toBeNull();
    expect(command.duration_ms).toBe(0);
  });

  it("orders output even when records are not timestamp-sorted on disk", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-05-10T00:00:00.000Z"),
      execCall("2026-05-10T00:00:05.000Z", "call_2", "second"),
      execCall("2026-05-10T00:00:01.000Z", "call_1", "first"),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(true);
    expect(payload.session.started_at).toBe("2026-05-10T00:00:00.000Z");
    expect(payload.session.ended_at).toBe("2026-05-10T00:00:05.000Z");
    for (let i = 1; i < payload.events.length; i++) {
      const prevEvent = payload.events[i - 1];
      const currEvent = payload.events[i];
      if (prevEvent === undefined || currEvent === undefined) continue;
      expect(Date.parse(currEvent.occurred_at)).toBeGreaterThanOrEqual(
        Date.parse(prevEvent.occurred_at),
      );
    }
    const commands = payload.events.filter((e) => e.type === "command_executed");
    expect(commands).toHaveLength(2);
    if (commands[0]?.type === "command_executed") {
      expect(commands[0].args).toEqual(["-c", "first"]);
    }
  });

  it("prefers the provided externalId over the session_meta id", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-05-10T00:00:00.000Z"),
      execCall("2026-05-10T00:00:01.000Z", "call_1", "ls"),
    ];
    const payload = codexRolloutToImportPayload(records, {
      workspaceId: WS_ID,
      externalId: "from-option",
    });
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect(payload.session.source.external_id).toBe("from-option");
    expect(payload.session.label).not.toContain("from-option");
    expect(payload.session.label).toMatch(/^codex \d{4}-\d{2}-\d{2}: \d+ command/);
  });

  it("returns null when no exec_command exists", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-05-10T00:00:00.000Z"),
      {
        type: "response_item",
        timestamp: "2026-05-10T00:00:01.000Z",
        payload: { type: "reasoning", summary: [] },
      },
      {
        type: "response_item",
        timestamp: "2026-05-10T00:00:02.000Z",
        payload: { type: "function_call", name: "update_plan", arguments: "{}", call_id: "c" },
      },
    ];
    expect(transform(records)).toBeNull();
  });

  it("returns null for an empty rollout", () => {
    expect(transform([])).toBeNull();
  });

  it("skips malformed-shaped records without throwing", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-05-10T00:00:00.000Z"),
      { type: "response_item", timestamp: "2026-05-10T00:00:01.000Z", payload: "not-an-object" },
      // exec_command with unparseable arguments is skipped.
      {
        type: "response_item",
        timestamp: "2026-05-10T00:00:02.000Z",
        payload: { type: "function_call", name: "exec_command", arguments: "{bad", call_id: "c0" },
      },
      execCall("2026-05-10T00:00:03.000Z", "call_1", "echo hi"),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect(payload.events.map((e) => e.type)).toEqual([
      "session_started",
      "command_executed",
      "session_ended",
    ]);
    expect(payload.session.working_directory).toBe(CWD);
  });

  it("captures the last cumulative token_count into session.metrics", () => {
    const tokenEvent = (ts: string, total: Record<string, number>): CodexRolloutRecord => ({
      type: "event_msg",
      timestamp: ts,
      payload: { type: "token_count", info: { total_token_usage: total } },
    });
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-05-10T00:00:00.000Z"),
      tokenEvent("2026-05-10T00:00:01.000Z", { input_tokens: 100, output_tokens: 50 }),
      execCall("2026-05-10T00:00:02.000Z", "call_1", "ls"),
      // The later cumulative value is the session total.
      tokenEvent("2026-05-10T00:00:03.000Z", {
        input_tokens: 19524,
        cached_input_tokens: 5504,
        output_tokens: 768,
        reasoning_output_tokens: 462,
      }),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect(payload.session.metrics).toEqual({
      input_tokens: 19524,
      cached_input_tokens: 5504,
      output_tokens: 768,
      reasoning_output_tokens: 462,
    });
  });

  it("omits metrics when no token_count and too few turns are present", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-05-10T00:00:00.000Z"),
      execCall("2026-05-10T00:00:01.000Z", "call_1", "ls"),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect(payload.session.metrics).toBeUndefined();
  });

  it("captures engaged time from conversation + exec, excluding token_count heartbeats", () => {
    const tokenEvent = (ts: string): CodexRolloutRecord => ({
      type: "event_msg",
      timestamp: ts,
      payload: { type: "token_count", info: { total_token_usage: { output_tokens: 1 } } },
    });
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-05-10T00:00:00.000Z"),
      eventMsg("2026-05-10T00:00:00.000Z", "user_message"),
      execCall("2026-05-10T00:01:00.000Z", "call_1", "ls"),
      eventMsg("2026-05-10T00:02:00.000Z", "agent_message"),
      // A token_count heartbeat 6 min after the last turn: if it were part of
      // the engagement series it would add a capped 5-min interval. It must not.
      tokenEvent("2026-05-10T00:08:00.000Z"),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(true);
    // user(00:00) -> exec(00:01) -> agent(00:02): two sub-cap gaps = 2 minutes.
    expect(payload.session.metrics?.active_time_ms).toBe(2 * 60 * 1000);
    expect(payload.session.metrics?.active_gap_cap_ms).toBe(5 * 60 * 1000);
    expect(payload.session.metrics?.active_time_method).toBe("engaged-turns");
    expect(payload.session.metrics?.active_intervals).toEqual([
      { start: "2026-05-10T00:00:00.000Z", end: "2026-05-10T00:02:00.000Z" },
    ]);
    // The token_count is still captured as token usage, just not as engagement.
    expect(payload.session.metrics?.output_tokens).toBe(1);
    // No task records: in-turn time stays gap-capped and machine time is absent.
    expect(payload.session.metrics?.machine_active_time_ms).toBeUndefined();
  });

  it("uses real task intervals (uncapped in-turn) and captures machine compute", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-05-10T00:00:00.000Z"),
      eventMsg("2026-05-10T00:00:00.000Z", "user_message"),
      taskStarted("2026-05-10T00:00:00.000Z", "t1"),
      // The only intermediate engagement point; the gap to task_complete is far
      // over the cap, so the gap-capped series alone would credit < the turn.
      execCall("2026-05-10T00:00:30.000Z", "call_1", "ls"),
      taskComplete("2026-05-10T00:10:00.000Z", "t1", 10 * 60 * 1000),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(true);
    // The full 10-min turn span is credited (not the ~5.5 min the 5-min gap cap
    // over the points would give), and the method is labeled accordingly.
    expect(payload.session.metrics?.active_time_ms).toBe(10 * 60 * 1000);
    expect(payload.session.metrics?.active_time_method).toBe("turn-intervals");
    expect(payload.session.metrics?.active_intervals).toEqual([
      { start: "2026-05-10T00:00:00.000Z", end: "2026-05-10T00:10:00.000Z" },
    ]);
    // Machine compute = summed task_complete.duration_ms.
    expect(payload.session.metrics?.machine_active_time_ms).toBe(10 * 60 * 1000);
  });

  it("bridges a sub-cap inter-turn gap but not an over-cap idle, and sums machine", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-05-10T00:00:00.000Z"),
      taskStarted("2026-05-10T00:00:00.000Z", "t1"),
      execCall("2026-05-10T00:00:30.000Z", "call_1", "ls"),
      taskComplete("2026-05-10T00:01:00.000Z", "t1", 60 * 1000),
      // 9-min idle before the next turn: over the 5-min cap, so not bridged.
      taskStarted("2026-05-10T00:10:00.000Z", "t2"),
      execCall("2026-05-10T00:10:30.000Z", "call_2", "ls"),
      taskComplete("2026-05-10T00:11:00.000Z", "t2", 60 * 1000),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(true);
    // Turn 1 [00:00,00:01] extends to 00:06 (5-min post-turn human-engaged
    // credit from the gap cap), then idle; turn 2 [00:10,00:11] stands alone.
    expect(payload.session.metrics?.active_intervals).toEqual([
      { start: "2026-05-10T00:00:00.000Z", end: "2026-05-10T00:06:00.000Z" },
      { start: "2026-05-10T00:10:00.000Z", end: "2026-05-10T00:11:00.000Z" },
    ]);
    expect(payload.session.metrics?.active_time_ms).toBe(7 * 60 * 1000);
    expect(payload.session.metrics?.machine_active_time_ms).toBe(2 * 60 * 1000);
  });

  it("reconstructs the turn start from duration when task_started is absent", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-05-10T00:00:00.000Z"),
      // A session that began mid-turn: only task_complete is present.
      execCall("2026-05-10T00:05:00.000Z", "call_1", "ls"),
      taskComplete("2026-05-10T00:10:00.000Z", "t1", 10 * 60 * 1000),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(true);
    // start = completion (00:10) - duration (10 min) = 00:00, even though the
    // earliest engagement point is the exec at 00:05.
    expect(payload.session.metrics?.active_intervals).toEqual([
      { start: "2026-05-10T00:00:00.000Z", end: "2026-05-10T00:10:00.000Z" },
    ]);
    expect(payload.session.metrics?.active_time_method).toBe("turn-intervals");
    expect(payload.session.metrics?.machine_active_time_ms).toBe(10 * 60 * 1000);
  });

  it("de-duplicates a repeated task_complete so machine stays a subset of active", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-05-10T00:00:00.000Z"),
      taskStarted("2026-05-10T00:00:00.000Z", "t1"),
      execCall("2026-05-10T00:00:30.000Z", "call_1", "ls"),
      taskComplete("2026-05-10T00:10:00.000Z", "t1", 10 * 60 * 1000),
      // A duplicate completion for the same turn must not double-count machine.
      taskComplete("2026-05-10T00:10:00.000Z", "t1", 10 * 60 * 1000),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    const m = payload.session.metrics;
    expect(m?.machine_active_time_ms).toBe(10 * 60 * 1000);
    expect(m?.machine_active_time_ms).toBeLessThanOrEqual(m?.active_time_ms ?? 0);
  });

  it("omits machine compute when only some completions carry a duration", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-05-10T00:00:00.000Z"),
      taskStarted("2026-05-10T00:00:00.000Z", "t1"),
      execCall("2026-05-10T00:00:30.000Z", "call_1", "ls"),
      taskComplete("2026-05-10T00:01:00.000Z", "t1", 60 * 1000),
      taskStarted("2026-05-10T00:02:00.000Z", "t2"),
      execCall("2026-05-10T00:02:30.000Z", "call_2", "ls"),
      // Second turn carries no duration_ms (older format); machine is then
      // partial and must be omitted rather than reported as complete.
      {
        type: "event_msg",
        timestamp: "2026-05-10T00:03:00.000Z",
        payload: { type: "task_complete", turn_id: "t2" },
      },
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    // Active time is still derived from the turn intervals.
    expect(payload.session.metrics?.active_time_method).toBe("turn-intervals");
    expect(payload.session.metrics?.active_time_ms).toBeGreaterThan(0);
    expect(payload.session.metrics?.machine_active_time_ms).toBeUndefined();
  });

  it("clamps a reconstructed turn start to the session floor", () => {
    const records: CodexRolloutRecord[] = [
      // Session first becomes visible at 00:05; the only turn completed at 00:10
      // reporting a 10-min duration, so its reconstructed start (00:00) precedes
      // the session and must be clamped to 00:05.
      sessionMeta("2026-05-10T00:05:00.000Z"),
      execCall("2026-05-10T00:05:00.000Z", "call_1", "ls"),
      taskComplete("2026-05-10T00:10:00.000Z", "t1", 10 * 60 * 1000),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect(payload.session.metrics?.active_intervals).toEqual([
      { start: "2026-05-10T00:05:00.000Z", end: "2026-05-10T00:10:00.000Z" },
    ]);
    expect(payload.session.metrics?.active_time_ms).toBe(5 * 60 * 1000);
    // Machine is bounded to the in-session span (5 min), not the full 10-min
    // duration, so it stays a subset of active time.
    expect(payload.session.metrics?.machine_active_time_ms).toBe(5 * 60 * 1000);
  });
});
