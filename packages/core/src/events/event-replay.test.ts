import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ReplayWarning, readAllEvents, replayEvents } from "./event-replay.js";

const SES = "ses_01HXABCDEF1234567890ABCDEF";
const EVT_BASE = {
  schema_version: "0.1.0" as const,
  session_id: SES,
  occurred_at: "2026-05-07T12:00:00+09:00",
  source: "terminal-recording" as const,
};

// Helper to construct a valid prefixed ULID by reusing the spec sample's
// 26-char body and varying the trailing character (still in Crockford base32).
function evtId(seq: string): string {
  return `evt_01HXABCDEF1234567890ABCD${seq}`;
}

function startedLine(seq: string): string {
  return `${JSON.stringify({
    ...EVT_BASE,
    id: evtId(seq),
    type: "session_started",
  })}\n`;
}

function endedLine(seq: string, exit?: number): string {
  return `${JSON.stringify({
    ...EVT_BASE,
    id: evtId(seq),
    type: "session_ended",
    ...(exit !== undefined ? { exit_code: exit } : {}),
  })}\n`;
}

function captureWarnings(): { warnings: ReplayWarning[]; onWarning: (w: ReplayWarning) => void } {
  const warnings: ReplayWarning[] = [];
  return { warnings, onWarning: (w) => warnings.push(w) };
}

describe("replayEvents", () => {
  let sessionDir: string;

  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), "basou-event-replay-"));
  });

  afterEach(async () => {
    await rm(sessionDir, { recursive: true, force: true });
  });

  it("yields nothing without warning when events.jsonl is missing (ENOENT)", async () => {
    const { warnings, onWarning } = captureWarnings();
    const events = await readAllEvents(sessionDir, { onWarning });
    expect(events).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("yields nothing without warning when events.jsonl is empty (0 bytes)", async () => {
    await writeFile(join(sessionDir, "events.jsonl"), "");
    const { warnings, onWarning } = captureWarnings();
    const events = await readAllEvents(sessionDir, { onWarning });
    expect(events).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("yields a single valid event", async () => {
    await writeFile(join(sessionDir, "events.jsonl"), startedLine("01"));
    const events = await readAllEvents(sessionDir);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("session_started");
  });

  it("yields multiple valid events preserving order", async () => {
    const body = `${startedLine("01")}${JSON.stringify({
      ...EVT_BASE,
      id: evtId("02"),
      type: "command_executed",
      command: "ls",
      args: [],
      cwd: "/tmp",
      exit_code: 0,
      duration_ms: 1,
    })}\n${endedLine("03", 0)}`;
    await writeFile(join(sessionDir, "events.jsonl"), body);
    const events = await readAllEvents(sessionDir);
    expect(events.map((e) => e.type)).toEqual([
      "session_started",
      "command_executed",
      "session_ended",
    ]);
  });

  it("skips blank lines silently", async () => {
    const body = `\n${startedLine("01")}\n\n${endedLine("02")}\n`;
    await writeFile(join(sessionDir, "events.jsonl"), body);
    const { warnings, onWarning } = captureWarnings();
    const events = await readAllEvents(sessionDir, { onWarning });
    expect(events.map((e) => e.type)).toEqual(["session_started", "session_ended"]);
    expect(warnings).toEqual([]);
  });

  it("skips malformed JSON with a malformed_json warning", async () => {
    const body = `${startedLine("01")}{not valid json\n${endedLine("03")}`;
    await writeFile(join(sessionDir, "events.jsonl"), body);
    const { warnings, onWarning } = captureWarnings();
    const events = await readAllEvents(sessionDir, { onWarning });
    expect(events.map((e) => e.type)).toEqual(["session_started", "session_ended"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ kind: "malformed_json", line: 2 });
  });

  it("skips schema-violating JSON with a schema_violation warning", async () => {
    // Valid JSON but missing the discriminator `type`.
    const body = `${startedLine("01")}${JSON.stringify({ ...EVT_BASE, id: evtId("99") })}\n${endedLine("03")}`;
    await writeFile(join(sessionDir, "events.jsonl"), body);
    const { warnings, onWarning } = captureWarnings();
    const events = await readAllEvents(sessionDir, { onWarning });
    expect(events.map((e) => e.type)).toEqual(["session_started", "session_ended"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ kind: "schema_violation", line: 2 });
  });

  it("rejects adapter_output with an unknown extra key (strict variant)", async () => {
    const adapterLine = `${JSON.stringify({
      ...EVT_BASE,
      id: evtId("99"),
      source: "claude-code-adapter",
      type: "adapter_output",
      stream: "stdout",
      summary: "x",
      raw_ref: ".basou/raw/x.log",
      unknown_extra: "should be rejected",
    })}\n`;
    await writeFile(join(sessionDir, "events.jsonl"), adapterLine);
    const { warnings, onWarning } = captureWarnings();
    const events = await readAllEvents(sessionDir, { onWarning });
    expect(events).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe("schema_violation");
  });

  it("warns and drops a valid-JSON trailing line that lacks a final newline (case 9a)", async () => {
    const lastEvent = JSON.stringify({
      ...EVT_BASE,
      id: evtId("02"),
      type: "session_started",
    });
    // First line newline-terminated, second line valid JSON but unterminated.
    const body = `${startedLine("01")}${lastEvent}`;
    await writeFile(join(sessionDir, "events.jsonl"), body);
    const { warnings, onWarning } = captureWarnings();
    const events = await readAllEvents(sessionDir, { onWarning });
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(evtId("01"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ kind: "partial_trailing_line", line: 2 });
  });

  it("warns when the trailing line is invalid JSON without a final newline (case 9b)", async () => {
    // Either malformed_json OR partial_trailing_line is acceptable per the
    // plan; the implementation surfaces malformed_json because the JSON layer
    // rejects the line first and the line number is meaningful for callers.
    const body = `${startedLine("01")}{incomplete`;
    await writeFile(join(sessionDir, "events.jsonl"), body);
    const { warnings, onWarning } = captureWarnings();
    const events = await readAllEvents(sessionDir, { onWarning });
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(evtId("01"));
    expect(warnings).toHaveLength(1);
    const w = warnings[0];
    expect(w?.kind === "malformed_json" || w?.kind === "partial_trailing_line").toBe(true);
  });

  it("yields earlier terminated events even when later content is unterminated and malformed", async () => {
    // Regression guard: do not drop a properly-terminated event because a
    // subsequent (different) trailing line was unterminated.
    const body = `${startedLine("01")}{still bad`;
    await writeFile(join(sessionDir, "events.jsonl"), body);
    const { warnings, onWarning } = captureWarnings();
    const events = await readAllEvents(sessionDir, { onWarning });
    expect(events.map((e) => e.id)).toEqual([evtId("01")]);
    expect(warnings.some((w) => w.kind === "malformed_json")).toBe(true);
  });

  it("throws Failed to read events.jsonl with cause attached on I/O error", async () => {
    // Provoke EACCES on read by stripping read permission. Skip when running
    // as root because chmod cannot block the superuser.
    if (process.getuid?.() === 0) return;
    const filePath = join(sessionDir, "events.jsonl");
    await writeFile(filePath, startedLine("01"));
    await chmod(filePath, 0o000);
    let captured: unknown;
    try {
      await readAllEvents(sessionDir);
    } catch (error: unknown) {
      captured = error;
    } finally {
      await chmod(filePath, 0o644).catch(() => undefined);
    }
    expect(captured).toBeInstanceOf(Error);
    const err = captured as Error;
    expect(err.message).toBe("Failed to read events.jsonl");
    expect(err.cause).toBeInstanceOf(Error);
  });

  it("forwards warnings from replayEvents through readAllEvents", async () => {
    const body = `${startedLine("01")}{bad\n${endedLine("03")}`;
    await writeFile(join(sessionDir, "events.jsonl"), body);
    const { warnings, onWarning } = captureWarnings();
    const events = await readAllEvents(sessionDir, { onWarning });
    expect(events.map((e) => e.type)).toEqual(["session_started", "session_ended"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe("malformed_json");
  });

  it("can be consumed lazily via the async generator without buffering", async () => {
    const body = `${startedLine("01")}${endedLine("02")}`;
    await writeFile(join(sessionDir, "events.jsonl"), body);
    const seen: string[] = [];
    for await (const ev of replayEvents(sessionDir)) {
      seen.push(ev.type);
    }
    expect(seen).toEqual(["session_started", "session_ended"]);
  });
});
