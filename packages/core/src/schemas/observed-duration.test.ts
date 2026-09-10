import { describe, expect, it } from "vitest";
import type { CommandExecutedEvent } from "./event.schema.js";
import { readObservedDuration, writeObservedDuration } from "./observed-duration.js";

function commandEvent(schemaVersion: string, durationMs: number | null): CommandExecutedEvent {
  return {
    schema_version: schemaVersion,
    id: "evt_01HXABCDEF1234567890ABCDEF",
    session_id: "ses_01HXABCDEF1234567890ABCDEF",
    occurred_at: "2026-09-10T00:00:00.000Z",
    source: "codex-import",
    type: "command_executed",
    command: "bash",
    args: ["-c", "ls"],
    cwd: "/tmp/fixture",
    exit_code: 0,
    duration_ms: durationMs,
  } as CommandExecutedEvent;
}

describe("readObservedDuration", () => {
  it("reads null as an absent observation", () => {
    expect(readObservedDuration(commandEvent("0.1.0", null))).toBeNull();
    expect(readObservedDuration(commandEvent("0.2.0", null))).toBeNull();
  });

  it("reads 0 as unobserved on EVERY version, so the rule needs no version branch", () => {
    // Under 0.1.0 the field could not be null, so 0 was the floor a writer
    // stored with nothing to report. Under 0.2.0 a writer never emits 0 at all.
    // A spawned process cannot run in under half a millisecond either way.
    for (const version of ["0.1.0", "0.2.0", "0.2.1", "0.10.0", "0.0.9", "garbage"]) {
      expect(readObservedDuration(commandEvent(version, 0))).toBeNull();
    }
  });

  it("passes a positive duration through on every version", () => {
    expect(readObservedDuration(commandEvent("0.1.0", 1500))).toBe(1500);
    expect(readObservedDuration(commandEvent("0.2.0", 1500))).toBe(1500);
    expect(readObservedDuration(commandEvent("garbage", 42))).toBe(42);
  });
});

describe("writeObservedDuration", () => {
  it("keeps a positive measurement", () => {
    expect(writeObservedDuration(1500)).toBe(1500);
    expect(writeObservedDuration(1)).toBe(1);
  });

  it("records a non-positive measurement as unobserved, never as 0", () => {
    // basou's own live capture has only ever measured 0 on an ENOENT spawn,
    // where the process never ran.
    expect(writeObservedDuration(0)).toBeNull();
    expect(writeObservedDuration(-5)).toBeNull();
    expect(writeObservedDuration(null)).toBeNull();
  });

  it("records a non-finite measurement as unobserved", () => {
    expect(writeObservedDuration(Number.NaN)).toBeNull();
    expect(writeObservedDuration(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("rounds to whole milliseconds, and a sub-half-millisecond value is not an observation", () => {
    // The schema is an integer field; 0.4ms would otherwise round to 0 and
    // re-enter the ambiguous value this release removes from new writes.
    expect(writeObservedDuration(1500.6)).toBe(1501);
    expect(writeObservedDuration(0.4)).toBeNull();
    expect(writeObservedDuration(0.6)).toBe(1);
  });
});
