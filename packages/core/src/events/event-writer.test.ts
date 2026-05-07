import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent } from "./event-writer.js";

const BASE = {
  schema_version: "0.1.0" as const,
  id: "evt_01HXABCDEF1234567890ABCDEF",
  session_id: "ses_01HXABCDEF1234567890ABCDEF",
  occurred_at: "2026-05-07T12:00:00+09:00",
  source: "terminal-recording",
};

describe("appendEvent", () => {
  let sessionDir: string;

  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), "basou-event-writer-"));
  });

  afterEach(async () => {
    await rm(sessionDir, { recursive: true, force: true });
  });

  it("appends a valid command_executed event as a single JSONL line", async () => {
    await appendEvent(sessionDir, {
      ...BASE,
      type: "command_executed",
      command: "ls",
      args: ["-la"],
      cwd: "/tmp/example",
      exit_code: 0,
      duration_ms: 42,
    });

    const content = await readFile(join(sessionDir, "events.jsonl"), "utf8");
    expect(content.endsWith("\n")).toBe(true);
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    const first = lines[0];
    if (first === undefined) throw new Error("events.jsonl was empty");
    const parsed = JSON.parse(first);
    expect(parsed.type).toBe("command_executed");
    expect(parsed.command).toBe("ls");
    expect(parsed.args).toEqual(["-la"]);
  });

  it("appends two events as two JSONL lines preserving order", async () => {
    await appendEvent(sessionDir, { ...BASE, type: "session_started" });
    await appendEvent(sessionDir, {
      ...BASE,
      id: "evt_01HXABCDEF1234567890ABCDFG",
      type: "session_ended",
      exit_code: 0,
    });

    const content = await readFile(join(sessionDir, "events.jsonl"), "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    const [a, b] = lines;
    if (a === undefined || b === undefined)
      throw new Error("events.jsonl had fewer lines than expected");
    expect(JSON.parse(a).type).toBe("session_started");
    expect(JSON.parse(b).type).toBe("session_ended");
  });

  it("rejects an event with an unknown type and does not write", async () => {
    await expect(appendEvent(sessionDir, { ...BASE, type: "unknown_event" })).rejects.toThrow(
      "Invalid Basou event payload",
    );
    await expect(readFile(join(sessionDir, "events.jsonl"), "utf8")).rejects.toThrow();
  });

  it("rejects an event with a missing required field", async () => {
    await expect(
      appendEvent(sessionDir, {
        ...BASE,
        type: "command_executed",
        // command / args / cwd / exit_code / duration_ms missing
      }),
    ).rejects.toThrow("Invalid Basou event payload");
  });

  it("throws Failed to append event when sessionDir does not exist", async () => {
    const missingDir = join(sessionDir, "missing-subdir");
    await expect(appendEvent(missingDir, { ...BASE, type: "session_started" })).rejects.toThrow(
      "Failed to append event to events.jsonl",
    );
  });

  it("rejects an adapter_output event with an unknown extra key (strict variant)", async () => {
    await expect(
      appendEvent(sessionDir, {
        ...BASE,
        source: "claude-code-adapter",
        type: "adapter_output",
        stream: "stdout",
        summary: "x",
        raw_ref: ".basou/raw/x.log",
        unknown_extra: "should be rejected",
      }),
    ).rejects.toThrow("Invalid Basou event payload");
  });
});
