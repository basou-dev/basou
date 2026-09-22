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
  /** Every session's events replayed cleanly. */
  const noUnmeasured: ReadonlySet<string> = new Set();
  const commands = (pairs: Record<string, number>): ReadonlyMap<string, number> =>
    new Map(Object.entries(pairs));

  it("returns undefined for an empty list", () => {
    expect(pickLatestSubstantiveEntry([], noCommands, noUnmeasured)).toBeUndefined();
  });

  it("prefers a substantive (file-touching) session over a newer empty one", () => {
    const work = entry("work", "2026-05-08T09:00:00Z", ["src/a.ts"]);
    const resume = entry("resume", "2026-05-08T11:00:00Z", []); // newer but empty
    expect(pickLatestSubstantiveEntry([resume, work], noCommands, noUnmeasured)?.sessionId).toBe(
      "work",
    );
  });

  it("breaks ties between substantive sessions by recency", () => {
    const older = entry("older", "2026-05-08T09:00:00Z", ["a"]);
    const newer = entry("newer", "2026-05-08T10:00:00Z", ["b"]);
    expect(pickLatestSubstantiveEntry([older, newer], noCommands, noUnmeasured)?.sessionId).toBe(
      "newer",
    );
  });

  it("falls back to the most recent session when none touched files", () => {
    const a = entry("a", "2026-05-08T09:00:00Z", []);
    const b = entry("b", "2026-05-08T10:00:00Z", []);
    expect(pickLatestSubstantiveEntry([a, b], noCommands, noUnmeasured)?.sessionId).toBe("b");
  });

  // The defect this ranking was widened to fix: an agent that edits through the
  // shell records commands and no related_files, so the files-only rule ranked a
  // release-cutting session below a two-day-old one that happened to touch a file.
  it("prefers a newer command-running session over an older file-touching one", () => {
    const old = entry("old", "2026-05-06T09:00:00Z", ["scripts/x.mjs"]);
    const shellWork = entry("shell", "2026-05-08T09:00:00Z", []);
    const counts = commands({ old: 386, shell: 224 });
    expect(pickLatestSubstantiveEntry([old, shellWork], counts, noUnmeasured)?.sessionId).toBe(
      "shell",
    );
  });

  it("does not let a one-command wrapper session displace real work", () => {
    const work = entry("work", "2026-05-08T09:00:00Z", []);
    const wrapper = entry("wrapper", "2026-05-08T11:00:00Z", []); // newer
    const counts = commands({ work: 224, wrapper: 1 });
    expect(pickLatestSubstantiveEntry([work, wrapper], counts, noUnmeasured)?.sessionId).toBe(
      "work",
    );
  });

  it("does not let a bookkeeping session (no commands, no files) displace real work", () => {
    const work = entry("work", "2026-05-08T09:00:00Z", []);
    const note = entry("note", "2026-05-08T11:00:00Z", []); // newer, `basou note`
    const counts = commands({ work: 224 });
    expect(pickLatestSubstantiveEntry([work, note], counts, noUnmeasured)?.sessionId).toBe("work");
  });

  // A subagent invocation is imported as its own session and is newer than the
  // session that launched it, so recency alone hands "where am I" to the child.
  const span = (id: string, startedAt: string, endedAt?: string) => ({
    sessionId: id,
    session: {
      session: {
        started_at: startedAt,
        ...(endedAt !== undefined ? { ended_at: endedAt } : {}),
        related_files: [] as string[],
      },
    },
  });

  it("skips a session that ran entirely inside another working session", () => {
    const parent = span("parent", "2026-05-08T10:00:00Z", "2026-05-08T14:00:00Z");
    const child = span("child", "2026-05-08T10:50:00Z", "2026-05-08T10:52:00Z"); // newer start
    const counts = commands({ parent: 262, child: 3 });
    expect(pickLatestSubstantiveEntry([parent, child], counts, noUnmeasured)?.sessionId).toBe(
      "parent",
    );
  });

  it("keeps a session that only overlaps -- containment must be total", () => {
    const first = span("first", "2026-05-08T10:00:00Z", "2026-05-08T12:00:00Z");
    const overlapping = span("overlapping", "2026-05-08T11:00:00Z", "2026-05-08T13:00:00Z");
    const counts = commands({ first: 262, overlapping: 5 });
    expect(pickLatestSubstantiveEntry([first, overlapping], counts, noUnmeasured)?.sessionId).toBe(
      "overlapping",
    );
  });

  it("does not let two identical windows exclude each other", () => {
    const a = span("a", "2026-05-08T10:00:00Z", "2026-05-08T12:00:00Z");
    const b = span("b", "2026-05-08T10:00:00Z", "2026-05-08T12:00:00Z");
    // An older, disjoint session that must NOT win. Without it the fallback
    // ("no outermost -> rank the working set") returns a or b either way, and
    // the assertion would hold even if identical windows did exclude each other.
    const older = span("older", "2026-05-08T08:00:00Z", "2026-05-08T09:00:00Z");
    const counts = commands({ a: 10, b: 10, older: 300 });
    expect(["a", "b"]).toContain(
      pickLatestSubstantiveEntry([a, b, older], counts, noUnmeasured)?.sessionId,
    );
  });

  it("does not drop a still-live session, whose end is unknown", () => {
    const earlier = span("earlier", "2026-05-08T08:00:00Z", "2026-05-08T14:00:00Z");
    // Newest, and its window would sit inside `earlier` if an unknown end were
    // read as "ended within". It must still win.
    const live = span("live", "2026-05-08T10:00:00Z");
    const counts = commands({ earlier: 300, live: 262 });
    expect(pickLatestSubstantiveEntry([earlier, live], counts, noUnmeasured)?.sessionId).toBe(
      "live",
    );
  });

  it("a still-live session does not contain a session that ended inside it", () => {
    const live = span("live", "2026-05-08T10:00:00Z");
    const later = span("later", "2026-05-08T10:50:00Z", "2026-05-08T10:52:00Z");
    const counts = commands({ live: 262, later: 3 });
    // `live` has no known end, so it cannot be shown to contain anything.
    expect(pickLatestSubstantiveEntry([live, later], counts, noUnmeasured)?.sessionId).toBe(
      "later",
    );
  });

  // Review finding: with only the strictly-inside case covered, mutating the
  // final `||` to `&&` passed every test. One shared bound is still containment.
  it("contains a child that shares the parent's end", () => {
    const parent = span("parent", "2026-05-08T10:00:00Z", "2026-05-08T14:00:00Z");
    const child = span("child", "2026-05-08T12:00:00Z", "2026-05-08T14:00:00Z");
    const counts = commands({ parent: 262, child: 3 });
    expect(pickLatestSubstantiveEntry([parent, child], counts, noUnmeasured)?.sessionId).toBe(
      "parent",
    );
  });

  it("contains a child that shares the parent's start", () => {
    const parent = span("parent", "2026-05-08T10:00:00Z", "2026-05-08T14:00:00Z");
    const child = span("child", "2026-05-08T10:00:00Z", "2026-05-08T12:00:00Z");
    const counts = commands({ parent: 262, child: 3 });
    // The child starts at the same instant, so recency alone cannot separate
    // them; containment must.
    expect(pickLatestSubstantiveEntry([parent, child], counts, noUnmeasured)?.sessionId).toBe(
      "parent",
    );
  });

  // Review finding: a NaN bound makes every comparison false, so the rejection
  // never fires and one `oStart < start` establishes containment on its own.
  it("does not let an unparseable bound establish containment", () => {
    const broken = span("broken", "2026-05-08T08:00:00Z", "not-a-timestamp");
    const real = span("real", "2026-05-08T10:00:00Z", "2026-05-08T12:00:00Z");
    const counts = commands({ broken: 2, real: 2 });
    expect(pickLatestSubstantiveEntry([broken, real], counts, noUnmeasured)?.sessionId).toBe(
      "real",
    );
  });

  it("does not let its own unparseable bound exclude a session", () => {
    // The guard on the ENTRY's bounds, not the container's: without it, a NaN
    // end makes the rejection comparisons false and `wide` appears to contain
    // `broken`, dropping the newest session from the candidates.
    const wide = span("wide", "2026-05-08T09:00:00Z", "2026-05-08T20:00:00Z");
    const broken = span("broken", "2026-05-08T10:00:00Z", "not-a-timestamp");
    const counts = commands({ wide: 300, broken: 2 });
    expect(pickLatestSubstantiveEntry([wide, broken], counts, noUnmeasured)?.sessionId).toBe(
      "broken",
    );
  });

  // Review finding: an unreadable events.jsonl leaves no count, which must not
  // be read as "ran nothing" -- the absence of a record is not a fact.
  it("does not demote a session whose events could not be read", () => {
    const older = entry("older", "2026-05-08T09:00:00Z", ["a"]);
    const unreadable = entry("unreadable", "2026-05-08T10:00:00Z", []);
    const counts = commands({ older: 300 });
    const unmeasured: ReadonlySet<string> = new Set(["unreadable"]);
    expect(pickLatestSubstantiveEntry([older, unreadable], counts, unmeasured)?.sessionId).toBe(
      "unreadable",
    );
  });

  it("keeps a standalone session that no other session contains", () => {
    const earlier = span("earlier", "2026-05-08T08:00:00Z", "2026-05-08T09:00:00Z");
    const standalone = span("standalone", "2026-05-08T10:00:00Z", "2026-05-08T11:00:00Z");
    const counts = commands({ earlier: 262, standalone: 4 });
    expect(pickLatestSubstantiveEntry([earlier, standalone], counts, noUnmeasured)?.sessionId).toBe(
      "standalone",
    );
  });

  // Review finding: `> 1` had no boundary case, so mutating it to `> 2` passed
  // every test. Exactly two commands is the smallest count that counts as work.
  it("counts exactly two commands as work", () => {
    const older = entry("older", "2026-05-08T09:00:00Z", ["a"]);
    const twoCommands = entry("two", "2026-05-08T10:00:00Z", []);
    const counts = commands({ older: 300, two: 2 });
    expect(pickLatestSubstantiveEntry([older, twoCommands], counts, noUnmeasured)?.sessionId).toBe(
      "two",
    );
  });

  it("does not count exactly one command as work", () => {
    const older = entry("older", "2026-05-08T09:00:00Z", ["a"]);
    const oneCommand = entry("one", "2026-05-08T10:00:00Z", []);
    const counts = commands({ older: 300, one: 1 });
    expect(pickLatestSubstantiveEntry([older, oneCommand], counts, noUnmeasured)?.sessionId).toBe(
      "older",
    );
  });

  it("keeps a file-touching session substantive even with no command count", () => {
    const files = entry("files", "2026-05-08T09:00:00Z", ["a"]);
    const newer = entry("newer", "2026-05-08T11:00:00Z", []);
    const counts = commands({ newer: 1 });
    expect(pickLatestSubstantiveEntry([files, newer], counts, noUnmeasured)?.sessionId).toBe(
      "files",
    );
  });

  it("treats a missing related_files field as non-substantive", () => {
    const noField = {
      sessionId: "x",
      session: { session: { started_at: "2026-05-08T11:00:00Z" } },
    };
    const work = entry("work", "2026-05-08T09:00:00Z", ["a"]);
    expect(pickLatestSubstantiveEntry([noField, work], noCommands, noUnmeasured)?.sessionId).toBe(
      "work",
    );
  });

  it("does not mutate the input array order", () => {
    const a = entry("a", "2026-05-08T09:00:00Z", []);
    const b = entry("b", "2026-05-08T10:00:00Z", ["x"]);
    const input = [a, b];
    pickLatestSubstantiveEntry(input, noCommands, noUnmeasured);
    expect(input[0]?.sessionId).toBe("a");
    expect(input[1]?.sessionId).toBe("b");
  });
});
