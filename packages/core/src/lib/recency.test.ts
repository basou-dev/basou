import { describe, expect, it } from "vitest";
import {
  DECISION_TRAILING_ACTIVITY_GAP_MS,
  isTrailingStale,
  pickLatestSubstantiveEntry,
} from "./recency.js";

describe("isTrailingStale", () => {
  const recorded = "2026-05-08T12:00:00.000Z";

  it("is false when there is no activity tail", () => {
    expect(isTrailingStale(null, recorded)).toBe(false);
  });

  it("is false when activity is within the gap (and at the exact boundary)", () => {
    const within = new Date(Date.parse(recorded) + DECISION_TRAILING_ACTIVITY_GAP_MS).toISOString();
    expect(isTrailingStale(within, recorded)).toBe(false); // boundary is not "more than"
    const justUnder = new Date(
      Date.parse(recorded) + DECISION_TRAILING_ACTIVITY_GAP_MS - 1,
    ).toISOString();
    expect(isTrailingStale(justUnder, recorded)).toBe(false);
  });

  it("is true when activity trails by more than the gap", () => {
    const beyond = new Date(
      Date.parse(recorded) + DECISION_TRAILING_ACTIVITY_GAP_MS + 1,
    ).toISOString();
    expect(isTrailingStale(beyond, recorded)).toBe(true);
  });

  it("is false when activity precedes the record", () => {
    expect(isTrailingStale("2026-05-08T10:00:00.000Z", recorded)).toBe(false);
  });
});

describe("pickLatestSubstantiveEntry", () => {
  const entry = (id: string, startedAt: string, files: string[]) => ({
    sessionId: id,
    session: { session: { started_at: startedAt, related_files: files } },
  });

  it("returns undefined for an empty list", () => {
    expect(pickLatestSubstantiveEntry([])).toBeUndefined();
  });

  it("prefers a substantive (file-touching) session over a newer empty one", () => {
    const work = entry("work", "2026-05-08T09:00:00Z", ["src/a.ts"]);
    const resume = entry("resume", "2026-05-08T11:00:00Z", []); // newer but empty
    expect(pickLatestSubstantiveEntry([resume, work])?.sessionId).toBe("work");
  });

  it("breaks ties between substantive sessions by recency", () => {
    const older = entry("older", "2026-05-08T09:00:00Z", ["a"]);
    const newer = entry("newer", "2026-05-08T10:00:00Z", ["b"]);
    expect(pickLatestSubstantiveEntry([older, newer])?.sessionId).toBe("newer");
  });

  it("falls back to the most recent session when none touched files", () => {
    const a = entry("a", "2026-05-08T09:00:00Z", []);
    const b = entry("b", "2026-05-08T10:00:00Z", []);
    expect(pickLatestSubstantiveEntry([a, b])?.sessionId).toBe("b");
  });

  it("treats a missing related_files field as non-substantive", () => {
    const noField = {
      sessionId: "x",
      session: { session: { started_at: "2026-05-08T11:00:00Z" } },
    };
    const work = entry("work", "2026-05-08T09:00:00Z", ["a"]);
    expect(pickLatestSubstantiveEntry([noField, work])?.sessionId).toBe("work");
  });

  it("does not mutate the input array order", () => {
    const a = entry("a", "2026-05-08T09:00:00Z", []);
    const b = entry("b", "2026-05-08T10:00:00Z", ["x"]);
    const input = [a, b];
    pickLatestSubstantiveEntry(input);
    expect(input[0]?.sessionId).toBe("a");
    expect(input[1]?.sessionId).toBe("b");
  });
});
