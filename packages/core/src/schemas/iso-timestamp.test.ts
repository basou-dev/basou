import { describe, expect, it } from "vitest";
import { normalizeIsoTimestamp } from "./iso-timestamp.js";
import { IsoTimestampSchema } from "./shared.schema.js";

describe("normalizeIsoTimestamp", () => {
  // The point of the boundary: a vendor that omits seconds must not have its
  // trace dropped as a schema violation. Each case below is stated as "what
  // goes in" -> "what the schema then says", because the pair is the contract,
  // not the string transformation on its own.
  it.each([
    ["a seconds-less UTC value gains :00", "2026-05-10T09:00Z", "2026-05-10T09:00:00Z"],
    [
      "a seconds-less offset value keeps its offset",
      "2026-05-10T09:00+09:00",
      "2026-05-10T09:00:00+09:00",
    ],
    [
      "a negative offset is preserved, not folded to UTC",
      "2026-05-10T09:00-05:00",
      "2026-05-10T09:00:00-05:00",
    ],
  ])("%s", (_label, raw, expected) => {
    expect(normalizeIsoTimestamp(raw)).toBe(expected);
    expect(IsoTimestampSchema.safeParse(normalizeIsoTimestamp(raw)).success).toBe(true);
  });

  it.each([
    ["an already-complete value is untouched", "2026-05-10T09:00:00.123Z"],
    ["seconds without fraction are untouched", "2026-05-10T09:00:00Z"],
  ])("%s", (_label, raw) => {
    expect(normalizeIsoTimestamp(raw)).toBe(raw);
  });

  // What it deliberately does NOT do. Widening the accepted set here rather
  // than through a `schema_version` would put the schema and the importer back
  // out of step, which is the drift the pinned pattern exists to prevent.
  it.each([
    ["lowercase designators stay outside the set", "2026-05-10t09:00z"],
    ["a leap second is not smuggled in", "2026-12-31T23:59:60Z"],
    ["a zone-less value is not given one", "2026-05-10T09:00:00"],
    ["a non-timestamp is returned as-is", "not a timestamp"],
  ])("%s", (_label, raw) => {
    expect(normalizeIsoTimestamp(raw)).toBe(raw);
    expect(IsoTimestampSchema.safeParse(normalizeIsoTimestamp(raw)).success).toBe(false);
  });

  it("adds seconds by shape alone, and does not make an impossible day possible", () => {
    // The normalizer reads the shape, not the calendar, so a day that does not
    // exist still gains its `:00`. That is deliberate: deciding which dates are
    // real is the schema's job, and doing it in two places is how the two drift
    // apart. What matters is that the value is still refused.
    expect(normalizeIsoTimestamp("2026-02-30T09:00Z")).toBe("2026-02-30T09:00:00Z");
    expect(IsoTimestampSchema.safeParse("2026-02-30T09:00:00Z").success).toBe(false);
  });

  it("is idempotent", () => {
    const once = normalizeIsoTimestamp("2026-05-10T09:00Z");
    expect(normalizeIsoTimestamp(once)).toBe(once);
  });
});
