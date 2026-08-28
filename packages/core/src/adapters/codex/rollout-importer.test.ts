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

/**
 * A scripted tool call, the shape a newer Codex CLI writes: one
 * `custom_tool_call` whose `input` is a JS program calling the tools.
 */
function scriptCall(ts: string, callId: string, input: string, name = "exec"): CodexRolloutRecord {
  return {
    type: "response_item",
    timestamp: ts,
    payload: {
      type: "custom_tool_call",
      name,
      status: "completed",
      call_id: callId,
      input,
    },
  };
}

/** A scripted tool call's output: content PARTS, not a plain string. */
function scriptOutput(ts: string, callId: string, ...texts: string[]): CodexRolloutRecord {
  return {
    type: "response_item",
    timestamp: ts,
    payload: {
      type: "custom_tool_call_output",
      call_id: callId,
      output: texts.map((text) => ({ type: "input_text", text })),
    },
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
    // The rollout carries no per-call shell, and codex in fact runs through
    // `/bin/zsh -lc`, so `bash` was wrong rather than merely unobserved.
    expect(command.command).toBeNull();
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

  it("labels a day-spanning session with a start..end date range", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-05-10T22:00:00.000Z"),
      execCall("2026-05-10T22:30:00.000Z", "call_1", "ls"),
      // Work continues past midnight; ended_at lands on the next day.
      execOutput("2026-05-11T01:00:00.000Z", "call_1", "Process exited with code 0\nOutput:\nok"),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect(payload.session.started_at).toBe("2026-05-10T22:00:00.000Z");
    expect(payload.session.ended_at).toBe("2026-05-11T01:00:00.000Z");
    // The label surfaces the most recent day instead of burying it under the start.
    expect(payload.session.label).toBe("codex 2026-05-10..2026-05-11: 1 command");
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

describe("codexRolloutToImportPayload (scripted tool calls)", () => {
  it("derives command_executed from a scripted exec_command call", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-07-31T00:00:00.000Z"),
      scriptCall(
        "2026-07-31T00:00:01.000Z",
        "call_1",
        `const r = await tools.exec_command({cmd:"npm test",workdir:"${CWD}/pkg",yield_time_ms:10000}); text(r.output)\n`,
      ),
      // The script's output banner has no colon after "Wall time" and arrives as
      // content parts rather than a string.
      scriptOutput(
        "2026-07-31T00:00:03.000Z",
        "call_1",
        "Script completed\nWall time 1.5 seconds\nOutput:\n",
        "ok",
      ),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    expect(SessionImportPayloadSchema.safeParse(payload).success).toBe(true);
    expect(payload.events.map((e) => e.type)).toEqual([
      "session_started",
      "command_executed",
      "session_ended",
    ]);
    const command = payload.events[1];
    if (command?.type !== "command_executed") throw new Error("expected command_executed");
    expect(command.args).toEqual(["-c", "npm test"]);
    expect(command.cwd).toBe(`${CWD}/pkg`);
    expect(command.duration_ms).toBe(1500);
    // This format records no per-command exit code: unknown, not zero.
    expect(command.exit_code).toBeNull();
  });

  it("derives one command per exec_command call when a script runs several", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-07-31T00:00:00.000Z"),
      scriptCall(
        "2026-07-31T00:00:01.000Z",
        "call_1",
        `const results = await Promise.all([
  tools.exec_command({ cmd: "git -C ${CWD} diff", workdir: "${CWD}" }),
  tools.exec_command({ "cmd": "wc -l README.md" }),
]);`,
      ),
      scriptOutput("2026-07-31T00:00:04.000Z", "call_1", "Script completed\nWall time 2.0 seconds"),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    const commands = payload.events.filter((e) => e.type === "command_executed");
    expect(commands.length).toBe(2);
    const [first, second] = commands;
    if (first?.type !== "command_executed" || second?.type !== "command_executed") {
      throw new Error("expected command_executed");
    }
    expect(first.args).toEqual(["-c", `git -C ${CWD} diff`]);
    expect(first.cwd).toBe(CWD);
    // A quoted key is read like a bare one; no workdir falls back to session cwd.
    expect(second.args).toEqual(["-c", "wc -l README.md"]);
    expect(second.cwd).toBe(CWD);
    // One wall time covers the whole script, so it is not credited to each
    // command (that would report 2s twice for a 2s script).
    expect(first.duration_ms).toBe(0);
    expect(second.duration_ms).toBe(0);
    expect(payload.session.label).toBe("codex 2026-07-31: 2 commands");
  });

  it("decodes escapes and reads a command containing braces and quotes", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-07-31T00:00:00.000Z"),
      scriptCall(
        "2026-07-31T00:00:01.000Z",
        "call_1",
        // Escaped quotes, an escaped backslash, and a shell brace group that must
        // not be mistaken for the end of the argument object.
        `await tools.exec_command({cmd:"rg -n \\"foo|bar\\" . | awk '{print \\$1}' | sed 's/\\\\s//'",workdir:"${CWD}"});`,
      ),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    const command = payload.events[1];
    if (command?.type !== "command_executed") throw new Error("expected command_executed");
    expect(command.args).toEqual(["-c", `rg -n "foo|bar" . | awk '{print $1}' | sed 's/\\s//'`]);
    // The workdir after the brace group is still found, so the command binds to
    // its repo rather than the session cwd.
    expect(command.cwd).toBe(CWD);
  });

  it("reads a back-quoted command and keeps an unresolved interpolation verbatim", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-07-31T00:00:00.000Z"),
      scriptCall(
        "2026-07-31T00:00:01.000Z",
        "call_1",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the template literal belongs to the captured script text, not to this file
        "await tools.exec_command({ cmd: `node -e '${script}'` });",
      ),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    const command = payload.events[1];
    if (command?.type !== "command_executed") throw new Error("expected command_executed");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the placeholder survives verbatim requires writing it out
    expect(command.args).toEqual(["-c", "node -e '${script}'"]);
  });

  it("ignores scripted calls with no readable command", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-07-31T00:00:00.000Z"),
      // A non-shell tool.
      scriptCall(
        "2026-07-31T00:00:01.000Z",
        "call_1",
        'const p = await tools.update_plan({plan:[{step:"read",status:"pending"}]});',
      ),
      // A command passed by variable cannot be resolved without running the
      // script, so it is skipped rather than guessed.
      scriptCall(
        "2026-07-31T00:00:02.000Z",
        "call_2",
        `const cmd = "ls"; await tools.exec_command({ cmd, workdir: "${CWD}" });`,
      ),
    ];
    // Nothing observable ran, so the session carries no provenance worth
    // importing — the same verdict as a rollout with no tool calls at all.
    expect(transform(records)).toBeNull();
  });

  it("keeps a readable command whose workdir is not readable, recording the directory as unknown", () => {
    // This used to discard the whole call: `cmd` is a plain literal and was
    // observed, but the directory came from a variable, and the only way to
    // record a command was to name a directory for it. 15 real commands were
    // lost to that. `cwd: null` says what is true about the directory and keeps
    // what is true about the command.
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-07-31T00:00:00.000Z"),
      scriptCall(
        "2026-07-31T00:00:01.000Z",
        "call_1",
        `const dir = "${CWD}/pkg"; await tools.exec_command({ cmd: "npm test", workdir: dir });`,
      ),
      // Shorthand, an expression, and a duplicate are the same problem.
      scriptCall(
        "2026-07-31T00:00:02.000Z",
        "call_2",
        `const workdir = "${CWD}"; await tools.exec_command({ cmd: "git status", workdir });`,
      ),
      scriptCall(
        "2026-07-31T00:00:03.000Z",
        "call_3",
        `await tools.exec_command({ cmd: "git log", workdir: "${CWD}" + "/pkg" });`,
      ),
      scriptCall(
        "2026-07-31T00:00:04.000Z",
        "call_4",
        `await tools.exec_command({ cmd: "git diff", workdir: "${CWD}", workdir: "${CWD}/pkg" });`,
      ),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    const commands = payload.events.filter((e) => e.type === "command_executed");
    expect(
      commands.map((e) => (e.type === "command_executed" ? [e.args[1], e.cwd] : null)),
    ).toEqual([
      ["npm test", null],
      ["git status", null],
      ["git log", null],
      ["git diff", null],
    ]);
  });

  it("still discards a call whose COMMAND is unreadable, workdir or not", () => {
    // The asymmetry is the point: an unknown directory is a field the event can
    // express, an unknown command is not — there would be nothing to record.
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-07-31T00:00:00.000Z"),
      scriptCall(
        "2026-07-31T00:00:01.000Z",
        "call_1",
        `const cmd = "ls"; await tools.exec_command({ cmd, workdir: "${CWD}" });`,
      ),
      // A spread AFTER the explicit `cmd` can still override it, so the text
      // naming one proves nothing about which command ran.
      scriptCall(
        "2026-07-31T00:00:02.000Z",
        "call_2",
        `await tools.exec_command({ cmd: "git status", ...job });`,
      ),
    ];
    expect(transform(records)).toBeNull();
  });

  it("reads a command written AFTER a spread, because the later property is the one JS uses", () => {
    // Measured against a real object literal: `{...job, cmd: "git status"}` has
    // cmd === "git status" whatever `job` holds, because the explicit property
    // comes last. Discarding this call threw away an observed command to avoid
    // misplacing its directory — and the directory is now expressible as null,
    // so there is nothing left to trade.
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-07-31T00:00:00.000Z"),
      scriptCall(
        "2026-07-31T00:00:01.000Z",
        "call_1",
        'await tools.exec_command({ ...job, cmd: "git status" });',
      ),
      // Both explicit and both after the spread: the directory is known too.
      scriptCall(
        "2026-07-31T00:00:02.000Z",
        "call_2",
        `await tools.exec_command({ ...job, cmd: "git log", workdir: "${CWD}/pkg" });`,
      ),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    const commands = payload.events.filter((e) => e.type === "command_executed");
    expect(
      commands.map((e) => (e.type === "command_executed" ? [e.args[1], e.cwd] : null)),
    ).toEqual([
      // The spread could still have carried a `workdir`, so that stays unknown…
      ["git status", null],
      // …but an explicit one written after it wins, exactly as JS resolves it.
      ["git log", `${CWD}/pkg`],
    ]);
  });

  it("keeps the session cwd when a call names NO workdir, which is not the same as an unreadable one", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-07-31T00:00:00.000Z"),
      scriptCall(
        "2026-07-31T00:00:01.000Z",
        "call_1",
        'await tools.exec_command({ cmd: "git status" });',
      ),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    const command = payload.events.find((e) => e.type === "command_executed");
    expect(command?.type === "command_executed" ? command.cwd : "missing").toBe(CWD);
  });

  it("does not read a non-script custom tool as a program, even when its body quotes an exec call", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-07-31T00:00:00.000Z"),
      // `apply_patch` shares the scripted envelope but its input is a patch body.
      // A patch that ADDS a line of example code must not derive a command: the
      // text was written into a file, it never ran.
      scriptCall(
        "2026-07-31T00:00:01.000Z",
        "call_1",
        `*** Begin Patch\n*** Update File: docs/adapter.md\n+await tools.exec_command({cmd:"rm -rf build"});\n*** End Patch`,
        "apply_patch",
      ),
    ];
    expect(transform(records)).toBeNull();
  });

  it("ignores exec calls that are string content or commented out, not code", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-07-31T00:00:00.000Z"),
      scriptCall(
        "2026-07-31T00:00:01.000Z",
        "call_1",
        [
          // A heredoc written INTO a file: the inner call never ran.
          `await tools.exec_command({cmd:"cat > note.md <<'EOF'\\nawait tools.exec_command({cmd:\\"rm -rf /\\"});\\nEOF"});`,
          // A commented-out call, whose apostrophe must not open a string and
          // swallow the real call that follows it.
          `// don't use tools.exec_command({cmd:"stale"}) here`,
          '/* tools.exec_command({cmd:"also stale"}) */',
          `await tools.exec_command({cmd:"git status"});`,
        ].join("\n"),
      ),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    const commands = payload.events.filter((e) => e.type === "command_executed");
    expect(commands.map((e) => (e.type === "command_executed" ? e.args[1] : null))).toEqual([
      `cat > note.md <<'EOF'\nawait tools.exec_command({cmd:"rm -rf /"});\nEOF`,
      "git status",
    ]);
  });

  it("reads a call whose argument object is preceded by a comment", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-07-31T00:00:00.000Z"),
      scriptCall(
        "2026-07-31T00:00:01.000Z",
        "call_1",
        'await tools.exec_command(/* why */ {cmd:"ls"});',
      ),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    const command = payload.events[1];
    if (command?.type !== "command_executed") throw new Error("expected command_executed");
    expect(command.args).toEqual(["-c", "ls"]);
  });

  it("skips a call whose effective cmd is decided outside the text", () => {
    const cases = [
      // A spread hands the choice to JS: `opts.cmd` may override the literal.
      'await tools.exec_command({cmd:"literal", ...opts});',
      // Built by an expression: the recorded text would be a partial command.
      'await tools.exec_command({cmd:"git " + verb});',
      // Given twice: JS keeps the last, so picking either is a guess.
      'await tools.exec_command({cmd:"first", cmd:"second"});',
      // A nested object also carrying `cmd` must not answer for the real one.
      'await tools.exec_command({env:{cmd:"nested"}});',
    ];
    for (const input of cases) {
      const records: CodexRolloutRecord[] = [
        sessionMeta("2026-07-31T00:00:00.000Z"),
        scriptCall("2026-07-31T00:00:01.000Z", "call_1", input),
      ];
      expect(transform(records), input).toBeNull();
    }
  });

  it("survives a malformed escape instead of aborting the import", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-07-31T00:00:00.000Z"),
      // An out-of-range code point and a truncated \u would both crash a naive
      // decoder (String.fromCodePoint throws), taking the whole refresh with them.
      scriptCall(
        "2026-07-31T00:00:01.000Z",
        "call_1",
        String.raw`await tools.exec_command({cmd:"echo \u{110000} \u12 \u{} é"});`,
      ),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    const command = payload.events[1];
    if (command?.type !== "command_executed") throw new Error("expected command_executed");
    // Every invalid escape keeps its literal text, backslash included, so the
    // recorded line still shows what the script contained; the valid one decodes.
    expect(command.args).toEqual(["-c", String.raw`echo \u{110000} \u12 \u{} é`]);
  });

  it("reads a command nested in another tool call's arguments", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-07-31T00:00:00.000Z"),
      // The inner command runs before the outer call receives its arguments.
      scriptCall(
        "2026-07-31T00:00:01.000Z",
        "call_1",
        'await tools.update_plan({plan:[{step:(await tools.exec_command({cmd:"pwd"})).output,status:"completed"}]});',
      ),
      scriptOutput("2026-07-31T00:00:02.000Z", "call_1", "Script completed\nWall time 1.0 seconds"),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    const command = payload.events[1];
    if (command?.type !== "command_executed") throw new Error("expected command_executed");
    expect(command.args).toEqual(["-c", "pwd"]);
    // Two tool calls ran, so the script's single wall time is not the command's.
    expect(command.duration_ms).toBe(0);
  });

  it("ignores a call site that merely ends a longer identifier", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-07-31T00:00:00.000Z"),
      scriptCall(
        "2026-07-31T00:00:01.000Z",
        "call_1",
        'mytools.exec_command({cmd:"echo phantom"});',
      ),
    ];
    expect(transform(records)).toBeNull();
  });

  it("stops at a truncated script instead of rescanning it, keeping what it read", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-07-31T00:00:00.000Z"),
      // A log cut mid-record: the first call is complete, the rest is not. A
      // script that RAN cannot have an unterminated bracket, so scanning stops
      // rather than re-walking the tail from every later call site.
      scriptCall(
        "2026-07-31T00:00:01.000Z",
        "call_1",
        `await tools.exec_command({cmd:"ls"});\n${'await tools.exec_command({cmd:"x"'.repeat(200)}`,
      ),
    ];
    const started = Date.now();
    const payload = transform(records);
    expect(Date.now() - started).toBeLessThan(500);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    const commands = payload.events.filter((e) => e.type === "command_executed");
    expect(commands.map((e) => (e.type === "command_executed" ? e.args[1] : null))).toEqual(["ls"]);
  });

  it("survives a script pathological enough to exhaust the stack", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-07-31T00:00:00.000Z"),
      scriptCall(
        "2026-07-31T00:00:01.000Z",
        "call_1",
        `await tools.exec_command({cmd:\`${"${`".repeat(20000)}${"`}".repeat(20000)}\`});`,
      ),
    ];
    // No throw: the record is skipped, the import continues.
    expect(() => transform(records)).not.toThrow();
  });

  it("does not credit a command with a script's time when the script did other work", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-07-31T00:00:00.000Z"),
      scriptCall(
        "2026-07-31T00:00:01.000Z",
        "call_1",
        'await tools.web__run({search_query:[{q:"x"}]});\nawait tools.exec_command({cmd:"ls"});',
      ),
      scriptOutput(
        "2026-07-31T00:00:31.000Z",
        "call_1",
        "Script completed\nWall time 30.0 seconds",
      ),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    const command = payload.events[1];
    if (command?.type !== "command_executed") throw new Error("expected command_executed");
    // The 30s belong to the web search, not to `ls`.
    expect(command.duration_ms).toBe(0);
  });

  it("reads both call formats in one rollout (a CLI upgrade mid-history)", () => {
    const records: CodexRolloutRecord[] = [
      sessionMeta("2026-07-31T00:00:00.000Z"),
      execCall("2026-07-31T00:00:01.000Z", "call_1", "git status"),
      execOutput(
        "2026-07-31T00:00:02.000Z",
        "call_1",
        "Wall time: 0.2000 seconds\nProcess exited with code 0\nOutput:\n",
      ),
      scriptCall(
        "2026-07-31T00:00:03.000Z",
        "call_2",
        'await tools.exec_command({cmd:"git commit -m x"});',
      ),
    ];
    const payload = transform(records);
    expect(payload).not.toBeNull();
    if (payload === null) return;
    const commands = payload.events.filter((e) => e.type === "command_executed");
    expect(commands.map((e) => (e.type === "command_executed" ? e.args[1] : null))).toEqual([
      "git status",
      "git commit -m x",
    ]);
  });
});
