import { describe, expect, it } from "vitest";
import { sessionLabelDateSpan } from "./session-label.js";

describe("sessionLabelDateSpan", () => {
  it("renders a single date for a same-day session", () => {
    expect(sessionLabelDateSpan("2026-06-22T01:00:00+09:00", "2026-06-22T23:59:00+09:00")).toBe(
      "2026-06-22",
    );
  });

  it("renders start..end when the session spans a day boundary", () => {
    // The classic case: an evening session that runs past midnight. Using only
    // the start date would bury the work under the older day.
    expect(sessionLabelDateSpan("2026-06-21T23:00:00+09:00", "2026-06-22T08:08:00+09:00")).toBe(
      "2026-06-21..2026-06-22",
    );
  });

  it("uses the raw ISO date prefix without timezone normalization", () => {
    // start and end carry the same wall-clock date in their own offset → single.
    expect(sessionLabelDateSpan("2026-06-22T00:30:00+09:00", "2026-06-22T09:00:00+09:00")).toBe(
      "2026-06-22",
    );
  });

  it("orders the range earliest..latest even when offsets reverse the date strings", () => {
    // start instant (2026-06-21T22:00Z) precedes end (2026-06-21T23:00Z), but the
    // start's +09:00 offset puts its date string on the 22nd. The range must still
    // read earliest..latest by calendar date, not start-string..end-string.
    expect(sessionLabelDateSpan("2026-06-22T07:00:00+09:00", "2026-06-21T23:00:00Z")).toBe(
      "2026-06-21..2026-06-22",
    );
  });
});
