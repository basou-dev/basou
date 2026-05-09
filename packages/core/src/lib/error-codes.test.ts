import { describe, expect, it } from "vitest";
import { findErrorCode } from "./error-codes.js";

describe("findErrorCode", () => {
  it("matches the errno code directly on the error itself", () => {
    const err = Object.assign(new Error("direct"), { code: "ENOENT" });
    expect(findErrorCode(err, "ENOENT")).toBe(true);
    expect(findErrorCode(err, "EACCES")).toBe(false);
  });

  it("walks the cause chain and detects ENOENT at depth 2", () => {
    const innermost = Object.assign(new Error("inner"), { code: "ENOENT" });
    const middle = new Error("middle wrapping inner", { cause: innermost });
    const outer = new Error("outer", { cause: middle });
    expect(findErrorCode(outer, "ENOENT")).toBe(true);
    expect(findErrorCode(outer, "EACCES")).toBe(false);
    // depth 1 stops at outer (no code), so ENOENT at depth 2 is not reachable.
    expect(findErrorCode(outer, "ENOENT", 1)).toBe(false);
  });

  it("returns false for non-Error inputs", () => {
    expect(findErrorCode(undefined, "ENOENT")).toBe(false);
    expect(findErrorCode(null, "ENOENT")).toBe(false);
    expect(findErrorCode("string error", "ENOENT")).toBe(false);
    expect(findErrorCode({ code: "ENOENT" }, "ENOENT")).toBe(false);
  });
});
