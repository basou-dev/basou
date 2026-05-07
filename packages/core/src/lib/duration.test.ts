import { describe, expect, it } from "vitest";
import { parseDuration } from "./duration.js";

describe("parseDuration", () => {
  it("parses 30s as 30000 ms", () => {
    expect(parseDuration("30s")).toBe(30_000);
  });

  it("parses 5m as 300000 ms", () => {
    expect(parseDuration("5m")).toBe(300_000);
  });

  it("parses 1h as 3600000 ms", () => {
    expect(parseDuration("1h")).toBe(3_600_000);
  });

  it("parses 100ms as 100 ms", () => {
    expect(parseDuration("100ms")).toBe(100);
  });

  it("rejects a malformed input", () => {
    expect(() => parseDuration("invalid")).toThrow(
      "Invalid duration: invalid. Expected format: <positive-integer><unit> where unit is ms/s/m/h",
    );
  });

  it("rejects 0s (regex requires positive integer)", () => {
    expect(() => parseDuration("0s")).toThrow(/Invalid duration/);
  });

  it("rejects 030s (leading zero)", () => {
    expect(() => parseDuration("030s")).toThrow(/Invalid duration/);
  });

  it("rejects a value that overflows to Infinity", () => {
    // Number(string) returns Infinity once the literal exceeds ~309 digits
    // (Number.MAX_VALUE ≈ 1.79e308). Build a literal that forces overflow
    // even before the unit multiplier is applied.
    const overflowed = `${"9".repeat(309)}ms`;
    expect(() => parseDuration(overflowed)).toThrow(/Duration overflow/);
  });
});
