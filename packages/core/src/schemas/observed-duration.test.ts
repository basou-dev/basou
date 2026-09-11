import { describe, expect, it } from "vitest";
import type { CommandExecutedEvent } from "./event.schema.js";
import {
  hasRetiredZeroDuration,
  readObservedDuration,
  writeObservedDuration,
  ZERO_DURATION_RETIRED_SINCE,
} from "./observed-duration.js";

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
    // A spawn costs real time and the runner measures at sub-millisecond
    // resolution, so a 0 or negative reaching here means the measurement is
    // unusable rather than that the command was instant.
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

describe("writeObservedDuration (out of range)", () => {
  it("records a value outside the schema's integer domain as unobserved", () => {
    // 2^53 milliseconds is 285,000 years, so this is not a duration -- and
    // letting it through failed validation deep inside a batch import and
    // aborted the candidates behind it.
    expect(writeObservedDuration(9007199254740992)).toBeNull();
    expect(writeObservedDuration(1e21)).toBeNull();
    expect(writeObservedDuration(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("hasRetiredZeroDuration", () => {
  it("flags a zero on a version whose writers never produce one", () => {
    expect(hasRetiredZeroDuration(commandEvent("0.2.0", 0))).toBe(true);
    expect(hasRetiredZeroDuration(commandEvent("0.2.1", 0))).toBe(true);
    expect(hasRetiredZeroDuration(commandEvent("0.10.0", 0))).toBe(true);
  });

  it("does not flag a zero on a pre-0.2.0 event: that was the floor a writer stored", () => {
    expect(hasRetiredZeroDuration(commandEvent("0.1.0", 0))).toBe(false);
    expect(hasRetiredZeroDuration(commandEvent("0.0.9", 0))).toBe(false);
  });

  it("does not flag null, a positive duration, or an unreadable version", () => {
    expect(hasRetiredZeroDuration(commandEvent("0.2.0", null))).toBe(false);
    expect(hasRetiredZeroDuration(commandEvent("0.2.0", 1500))).toBe(false);
    // An unparseable version sorts below every parseable one, so it is not
    // flagged: basou does not accuse an event whose version it cannot read.
    expect(hasRetiredZeroDuration(commandEvent("garbage", 0))).toBe(false);
    expect(hasRetiredZeroDuration(commandEvent("0.2", 0))).toBe(false);
  });

  it("ignores events that are not command_executed", () => {
    const note = {
      schema_version: "0.2.0",
      id: "evt_01HXABCDEF1234567890ABCDEF",
      session_id: "ses_01HXABCDEF1234567890ABCDEF",
      occurred_at: "2026-09-10T00:00:00.000Z",
      source: "human",
      type: "note_added",
      text: "hi",
    } as unknown as Parameters<typeof hasRetiredZeroDuration>[0];
    expect(hasRetiredZeroDuration(note)).toBe(false);
  });

  it("names the version the convention changed on", () => {
    expect(ZERO_DURATION_RETIRED_SINCE).toBe("0.2.0");
  });
});
