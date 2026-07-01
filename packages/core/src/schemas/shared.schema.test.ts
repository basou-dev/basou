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
