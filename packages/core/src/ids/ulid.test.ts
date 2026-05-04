import { describe, expect, it } from "vitest";
import { ID_PREFIXES, isValidPrefixedId, prefixedUlid, ulid } from "./ulid.js";

// ULID first char is 0-7 (48-bit timestamp / 5-bit Crockford symbols);
// the remaining 25 chars use full Crockford alphabet excluding I, L, O, U.
const ULID_REGEX = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const PREFIXED_ULID_REGEX_SES = /^ses_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

describe("ulid()", () => {
  it("returns a 26-char Crockford Base32 ULID", () => {
    expect(ulid()).toMatch(ULID_REGEX);
  });

  it("returns lexicographically sortable, unique values across many calls (strict monotonicity)", () => {
    const ids = Array.from({ length: 1000 }, () => ulid());
    expect(new Set(ids).size).toBe(ids.length);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    for (let i = 1; i < ids.length; i++) {
      const previous = ids[i - 1];
      const current = ids[i];
      if (previous === undefined || current === undefined) {
        throw new Error(`unexpected undefined at index ${i}`);
      }
      expect(previous < current).toBe(true);
    }
  });

  it("returns strictly increasing values for the same seedTime via monotonic factory", () => {
    // NOTE: seedTime is not deterministic - the factory increments on each call.
    const seed = 1_700_000_000_000;
    const a = ulid(seed);
    const b = ulid(seed);
    expect(a).not.toBe(b);
    expect(a < b).toBe(true);
  });
});

describe("prefixedUlid()", () => {
  it("produces an ID matching the prefix and 26-char ULID body", () => {
    expect(prefixedUlid("ses")).toMatch(PREFIXED_ULID_REGEX_SES);
  });

  it.each(ID_PREFIXES)("supports prefix '%s' with correct length and shape", (prefix) => {
    const id = prefixedUlid(prefix);
    expect(id.startsWith(`${prefix}_`)).toBe(true);
    expect(id.length).toBe(prefix.length + 1 + 26);
  });
});

describe("ID_PREFIXES", () => {
  it("contains exactly the six canonical prefixes in documented order", () => {
    expect(ID_PREFIXES).toEqual(["ws", "task", "ses", "evt", "appr", "decision"]);
  });
});

describe("isValidPrefixedId()", () => {
  it("accepts a freshly generated prefixed ULID for every known prefix", () => {
    for (const prefix of ID_PREFIXES) {
      expect(isValidPrefixedId(prefixedUlid(prefix))).toBe(true);
    }
  });

  it("rejects an unknown prefix even if the body is a valid ULID", () => {
    // Body is generated via known prefix to guarantee a valid ULID body.
    const validId = prefixedUlid("ses");
    const body = validId.slice("ses_".length);
    expect(isValidPrefixedId(`unknown_${body}`)).toBe(false);
  });

  it("rejects a Crockford-alphabet body that is not a valid ULID (length too long)", () => {
    // Alphabet-valid (no I/L/O/U) but ULID-invalid (27 chars instead of 26).
    expect(isValidPrefixedId("ses_01HXABCDEF1234567890ABCDEFG")).toBe(false);
  });

  it.each(["8", "9"])("rejects a body whose first char is outside ULID range (%s)", (firstChar) => {
    // Crockford alphabet permits 8-9 but ULID timestamp cap is 0-7.
    expect(isValidPrefixedId(`ses_${firstChar}1HXABCDEF1234567890ABCDEF`)).toBe(false);
  });

  it("rejects a body containing characters outside Crockford alphabet (I/L/O/U)", () => {
    expect(isValidPrefixedId("ses_01HXABCDEFI234567890ABCDEF")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidPrefixedId("")).toBe(false);
  });

  it("rejects a string with no underscore", () => {
    expect(isValidPrefixedId("ses01HXABCDEF1234567890ABCDEF")).toBe(false);
  });

  it("rejects a string with empty prefix", () => {
    expect(isValidPrefixedId("_01HXABCDEF1234567890ABCDEF")).toBe(false);
  });

  it("rejects a string with empty body", () => {
    expect(isValidPrefixedId("ses_")).toBe(false);
  });
});
