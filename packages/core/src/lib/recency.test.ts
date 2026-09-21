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
  /** No session ran a command; the pre-command-count behaviour. */
  const noCommands: ReadonlyMap<string, number> = new Map();
  const commands = (pairs: Record<string, number>): ReadonlyMap<string, number> =>
    new Map(Object.entries(pairs));

  it("returns undefined for an empty list", () => {
    expect(pickLatestSubstantiveEntry([], noCommands)).toBeUndefined();
  });

  it("prefers a substantive (file-touching) session over a newer empty one", () => {
    const work = entry("work", "2026-05-08T09:00:00Z", ["src/a.ts"]);
    const resume = entry("resume", "2026-05-08T11:00:00Z", []); // newer but empty
    expect(pickLatestSubstantiveEntry([resume, work], noCommands)?.sessionId).toBe("work");
  });

  it("breaks ties between substantive sessions by recency", () => {
    const older = entry("older", "2026-05-08T09:00:00Z", ["a"]);
    const newer = entry("newer", "2026-05-08T10:00:00Z", ["b"]);
    expect(pickLatestSubstantiveEntry([older, newer], noCommands)?.sessionId).toBe("newer");
  });

  it("falls back to the most recent session when none touched files", () => {
    const a = entry("a", "2026-05-08T09:00:00Z", []);
    const b = entry("b", "2026-05-08T10:00:00Z", []);
    expect(pickLatestSubstantiveEntry([a, b], noCommands)?.sessionId).toBe("b");
  });

  // The defect this ranking was widened to fix: an agent that edits through the
  // shell records commands and no related_files, so the files-only rule ranked a
  // release-cutting session below a two-day-old one that happened to touch a file.
  it("prefers a newer command-running session over an older file-touching one", () => {
    const old = entry("old", "2026-05-06T09:00:00Z", ["scripts/x.mjs"]);
    const shellWork = entry("shell", "2026-05-08T09:00:00Z", []);
    const counts = commands({ old: 386, shell: 224 });
    expect(pickLatestSubstantiveEntry([old, shellWork], counts)?.sessionId).toBe("shell");
  });

  it("does not let a one-command wrapper session displace real work", () => {
    const work = entry("work", "2026-05-08T09:00:00Z", []);
    const wrapper = entry("wrapper", "2026-05-08T11:00:00Z", []); // newer
    const counts = commands({ work: 224, wrapper: 1 });
    expect(pickLatestSubstantiveEntry([work, wrapper], counts)?.sessionId).toBe("work");
  });

  it("does not let a bookkeeping session (no commands, no files) displace real work", () => {
    const work = entry("work", "2026-05-08T09:00:00Z", []);
    const note = entry("note", "2026-05-08T11:00:00Z", []); // newer, `basou note`
    const counts = commands({ work: 224 });
    expect(pickLatestSubstantiveEntry([work, note], counts)?.sessionId).toBe("work");
  });

  it("keeps a file-touching session substantive even with no command count", () => {
    const files = entry("files", "2026-05-08T09:00:00Z", ["a"]);
    const newer = entry("newer", "2026-05-08T11:00:00Z", []);
    const counts = commands({ newer: 1 });
    expect(pickLatestSubstantiveEntry([files, newer], counts)?.sessionId).toBe("files");
  });

  it("treats a missing related_files field as non-substantive", () => {
    const noField = {
      sessionId: "x",
      session: { session: { started_at: "2026-05-08T11:00:00Z" } },
    };
    const work = entry("work", "2026-05-08T09:00:00Z", ["a"]);
    expect(pickLatestSubstantiveEntry([noField, work], noCommands)?.sessionId).toBe("work");
  });

  it("does not mutate the input array order", () => {
    const a = entry("a", "2026-05-08T09:00:00Z", []);
    const b = entry("b", "2026-05-08T10:00:00Z", ["x"]);
    const input = [a, b];
    pickLatestSubstantiveEntry(input, noCommands);
    expect(input[0]?.sessionId).toBe("a");
    expect(input[1]?.sessionId).toBe("b");
  });
});
