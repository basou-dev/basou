import { describe, expect, expectTypeOf, it } from "vitest";
import { type PrefixedId, prefixedUlid } from "../ids/ulid.js";
import {
  ApprovalIdSchema,
  DecisionIdSchema,
  EventIdSchema,
  IsoTimestampSchema,
  RiskLevelSchema,
  SchemaVersionSchema,
  SessionIdSchema,
  TaskIdSchema,
  WorkspaceIdSchema,
} from "./shared.schema.js";

describe("IsoTimestampSchema", () => {
  it("accepts an ISO 8601 timestamp with explicit `+09:00` offset", () => {
    expect(IsoTimestampSchema.safeParse("2026-05-04T09:00:00+09:00").success).toBe(true);
  });

  it("accepts an ISO 8601 timestamp with `Z` suffix", () => {
    expect(IsoTimestampSchema.safeParse("2026-05-04T09:00:00Z").success).toBe(true);
  });

  it("rejects a space-separated timestamp", () => {
    expect(IsoTimestampSchema.safeParse("2026-05-04 09:00:00+09:00").success).toBe(false);
  });

  // The accepted set is the published contract: it is what every JSON Schema
  // artifact carries as its `pattern`. The extension rules in
  // docs/spec/schemas.md gate widening behind a `schema_version` bump and
  // forbid narrowing outright, except where the narrowing refuses a set no
  // writer has ever produced -- which is the exception the seconds requirement
  // below landed under, and it moved every durable `$id`. So moving any
  // boundary here is a format change and not a refactor. Each case names the
  // boundary it holds rather than leaving the set implied by three examples.
  it.each([
    ["seconds are required", "2026-05-04T09:00Z", false],
    ["seconds are required with an offset too", "2026-05-04T09:00+09:00", false],
    ["fractional seconds are accepted", "2026-05-04T09:00:00.123456Z", true],
    ["a negative offset is accepted", "2026-05-04T09:00:00-05:00", true],
    ["an offset or Z is required", "2026-05-04T09:00:00", false],
    ["designators are uppercase only (t)", "2026-05-04t09:00:00Z", false],
    ["designators are uppercase only (z)", "2026-05-04T09:00:00z", false],
    ["a leap second is refused", "2026-12-31T23:59:60Z", false],
    ["the calendar day must exist", "2026-02-30T09:00:00Z", false],
    ["a non-leap year has no 29 February", "2026-02-29T09:00:00Z", false],
    ["a leap year does", "2024-02-29T09:00:00Z", true],
    ["the century rule holds (1900)", "1900-02-29T09:00:00Z", false],
    ["the 400-year rule holds (2000)", "2000-02-29T09:00:00Z", true],
    ["an offset hour past 23 is refused", "2026-05-04T09:00:00+24:00", false],
    ["basic format is refused", "20260504T090000Z", false],
    ["a trailing newline is refused", "2026-05-04T09:00:00Z\n", false],
    ["hour 24 is refused", "2026-05-04T24:00:00Z", false],
    ["minute 60 is refused", "2026-05-04T09:60:00Z", false],
    ["an offset minute past 59 is refused", "2026-05-04T09:00:00+09:60", false],
    ["day 32 is refused in a 31-day month", "2026-01-32T09:00:00Z", false],
    ["the expression is anchored at the start", "x2026-05-04T09:00:00Z", false],
    ["the time of day is required", "2026-05-04T", false],
    ["a leap year divisible by 4 with 0 in the tens (2008)", "2008-02-29T09:00:00Z", true],
    ["a leap year with an odd tens digit (2016)", "2016-02-29T09:00:00Z", true],
  ])("%s", (_boundary, value, accepted) => {
    expect(IsoTimestampSchema.safeParse(value).success).toBe(accepted);
  });
});

describe("Prefixed ID schemas", () => {
  const cases = [
    { schema: WorkspaceIdSchema, prefix: "ws" as const, label: "WorkspaceIdSchema" },
    { schema: TaskIdSchema, prefix: "task" as const, label: "TaskIdSchema" },
    { schema: SessionIdSchema, prefix: "ses" as const, label: "SessionIdSchema" },
    { schema: EventIdSchema, prefix: "evt" as const, label: "EventIdSchema" },
    { schema: ApprovalIdSchema, prefix: "appr" as const, label: "ApprovalIdSchema" },
    { schema: DecisionIdSchema, prefix: "decision" as const, label: "DecisionIdSchema" },
  ];

  for (const { schema, prefix, label } of cases) {
    it(`${label} accepts a freshly generated ${prefix}_<ULID>`, () => {
      expect(schema.safeParse(prefixedUlid(prefix)).success).toBe(true);
    });

    it(`${label} rejects a different prefix's ULID`, () => {
      const otherPrefix = prefix === "ws" ? "ses" : "ws";
      expect(schema.safeParse(prefixedUlid(otherPrefix)).success).toBe(false);
    });
  }

  it("preserves the template literal type for SessionIdSchema (compile-time)", () => {
    expectTypeOf<ReturnType<typeof SessionIdSchema.parse>>().toEqualTypeOf<PrefixedId<"ses">>();
  });

  it("preserves the template literal type for WorkspaceIdSchema (compile-time)", () => {
    expectTypeOf<ReturnType<typeof WorkspaceIdSchema.parse>>().toEqualTypeOf<PrefixedId<"ws">>();
  });
});

describe("RiskLevelSchema", () => {
  it.each(["low", "medium", "high", "critical"])("accepts %s", (value) => {
    expect(RiskLevelSchema.safeParse(value).success).toBe(true);
  });

  it("rejects an unknown risk level", () => {
    expect(RiskLevelSchema.safeParse("unknown").success).toBe(false);
  });
});

describe("SchemaVersionSchema", () => {
  it("accepts any same-major (0.x.y) format version — forward-compatible", () => {
    expect(SchemaVersionSchema.safeParse("0.1.0").success).toBe(true);
    expect(SchemaVersionSchema.safeParse("0.2.0").success).toBe(true);
    expect(SchemaVersionSchema.safeParse("0.99.5").success).toBe(true);
  });

  it("gates a higher/unknown major with an explicit upgrade message", () => {
    const result = SchemaVersionSchema.safeParse("1.0.0");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/upgrade basou/i);
    }
    expect(SchemaVersionSchema.safeParse("2.3.4").success).toBe(false);
  });

  it("rejects malformed version strings", () => {
    for (const bad of ["", "0.1", "0", "abc", "0.1.0-rc", "v0.1.0", "0.1.0.0"]) {
      expect(SchemaVersionSchema.safeParse(bad).success).toBe(false);
    }
  });
});
