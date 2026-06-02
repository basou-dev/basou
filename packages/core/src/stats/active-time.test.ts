import { describe, expect, it } from "vitest";
import {
  ACTIVE_GAP_CAP_MS,
  activeTimeFromTimestamps,
  intervalsIsoToMs,
  intervalsMsToIso,
  unionDurationMs,
} from "./active-time.js";

const CAP = ACTIVE_GAP_CAP_MS; // 5 minutes

describe("activeTimeFromTimestamps", () => {
  it("returns zero for empty or single-timestamp input", () => {
    expect(activeTimeFromTimestamps([], CAP)).toEqual({ ms: 0, intervals: [] });
    expect(activeTimeFromTimestamps([1000], CAP)).toEqual({ ms: 0, intervals: [] });
  });

  it("credits a sub-cap gap in full as one interval", () => {
    const r = activeTimeFromTimestamps([0, 60_000], CAP);
    expect(r.ms).toBe(60_000);
    expect(r.intervals).toEqual([[0, 60_000]]);
  });

  it("caps an over-cap gap at the cap", () => {
    const r = activeTimeFromTimestamps([0, 10 * 60_000], CAP);
    expect(r.ms).toBe(CAP);
    expect(r.intervals).toEqual([[0, CAP]]);
  });

  it("merges adjacent sub-cap runs and reproduces the gap-capped sum", () => {
    // 1s gap then a 30-min (over-cap) gap: 1s + capped 5m.
    const r = activeTimeFromTimestamps([0, 1000, 1000 + 30 * 60_000], CAP);
    expect(r.ms).toBe(1000 + CAP);
    expect(r.intervals).toEqual([[0, 1000 + CAP]]);
  });

  it("credits up to the cap after the last point before a long idle gap", () => {
    // [0, 1s] tight, then a 1-hour idle, then another tight pair. The point
    // before the idle still earns a capped 5-min tail; the idle beyond that is
    // dropped, so the two activity runs stay separate.
    const r = activeTimeFromTimestamps([0, 1000, 60 * 60_000, 60 * 60_000 + 1000], CAP);
    expect(r.intervals).toEqual([
      [0, 1000 + CAP],
      [60 * 60_000, 60 * 60_000 + 1000],
    ]);
    expect(r.ms).toBe(1000 + CAP + 1000);
  });

  it("skips non-positive gaps (duplicate timestamps)", () => {
    const r = activeTimeFromTimestamps([0, 0, 1000], CAP);
    expect(r.ms).toBe(1000);
    expect(r.intervals).toEqual([[0, 1000]]);
  });

  it("skips non-finite timestamps and sorts unsorted input", () => {
    expect(activeTimeFromTimestamps([1000, Number.NaN, 0], CAP)).toEqual({
      ms: 1000,
      intervals: [[0, 1000]],
    });
  });
});

describe("unionDurationMs", () => {
  it("sums disjoint intervals without merging", () => {
    const r = unionDurationMs([
      [0, 1000],
      [2000, 3000],
    ]);
    expect(r.ms).toBe(2000);
    expect(r.merged).toEqual([
      [0, 1000],
      [2000, 3000],
    ]);
  });

  it("merges overlapping intervals so wall-clock is not double-counted", () => {
    const r = unionDurationMs([
      [0, 2000],
      [1000, 3000],
    ]);
    expect(r.ms).toBe(3000);
    expect(r.merged).toEqual([[0, 3000]]);
  });

  it("merges adjacent intervals", () => {
    const r = unionDurationMs([
      [0, 1000],
      [1000, 2000],
    ]);
    expect(r.ms).toBe(2000);
    expect(r.merged).toEqual([[0, 2000]]);
  });
});

describe("interval ISO mapping", () => {
  it("round-trips ms intervals through ISO", () => {
    const iso = intervalsMsToIso([[0, 60_000]]);
    expect(iso).toEqual([{ start: "1970-01-01T00:00:00.000Z", end: "1970-01-01T00:01:00.000Z" }]);
    expect(intervalsIsoToMs(iso)).toEqual([[0, 60_000]]);
  });

  it("skips unparseable or reversed ISO ranges", () => {
    expect(
      intervalsIsoToMs([
        { start: "not-a-date", end: "2026-05-10T00:00:00.000Z" },
        { start: "2026-05-10T00:01:00.000Z", end: "2026-05-10T00:00:00.000Z" },
      ]),
    ).toEqual([]);
  });
});
