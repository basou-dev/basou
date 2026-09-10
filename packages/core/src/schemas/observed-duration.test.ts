import { describe, expect, it } from "vitest";
import type { CommandExecutedEvent } from "./event.schema.js";
import { DURATION_OBSERVED_SINCE, readObservedDuration } from "./observed-duration.js";

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
  it("reads null as an absent observation on every version", () => {
    expect(readObservedDuration(commandEvent("0.1.0", null))).toBeNull();
    expect(readObservedDuration(commandEvent("0.2.0", null))).toBeNull();
  });

  it("reads a 0.1.0 zero as UNOBSERVED: the field could not be null there", () => {
    // The whole reason for the bump. Every Claude Code transcript command was
    // written as 0 under 0.1.0, and the transcript carries no timing at all.
    expect(readObservedDuration(commandEvent("0.1.0", 0))).toBeNull();
  });

  it("reads a 0.2.0 zero as an OBSERVED zero", () => {
    // Codex reports `Wall time: 0.0000 seconds` for most per-command calls;
    // folding that into "unrecorded" discards what the source did say.
    expect(readObservedDuration(commandEvent("0.2.0", 0))).toBe(0);
  });

  it("passes a non-zero duration through on either version", () => {
    expect(readObservedDuration(commandEvent("0.1.0", 1500))).toBe(1500);
    expect(readObservedDuration(commandEvent("0.2.0", 1500))).toBe(1500);
  });

  it("treats a version above the cutoff as observing zero", () => {
    expect(readObservedDuration(commandEvent("0.2.1", 0))).toBe(0);
    expect(readObservedDuration(commandEvent("0.10.0", 0))).toBe(0);
  });

  it("reads an unparseable version conservatively, as pre-0.2.0", () => {
    // basou reports no observation it cannot back.
    expect(readObservedDuration(commandEvent("garbage", 0))).toBeNull();
    expect(readObservedDuration(commandEvent("0.2", 0))).toBeNull();
    // A real value still survives; only the ambiguous zero is withheld.
    expect(readObservedDuration(commandEvent("garbage", 42))).toBe(42);
  });

  it("names the version the convention changed on", () => {
    expect(DURATION_OBSERVED_SINCE).toBe("0.2.0");
  });
});
