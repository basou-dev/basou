import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { locateRelative } from "./relative-location.js";

describe("locateRelative", () => {
  it("reads an empty result as the base itself", () => {
    expect(locateRelative("")).toBe("self");
  });

  it("reads `..` and a `../` prefix as outside", () => {
    for (const rel of ["..", "../x", "../..", "../../a/b"]) {
      expect(locateRelative(rel), rel).toBe("outside");
    }
  });

  it("reads a name that begins, ends or contains two dots as inside", () => {
    for (const rel of ["..notes", "..\\x", "...", "..cache/x.ts", "x..", "a../b", "x"]) {
      expect(locateRelative(rel), rel).toBe("inside");
    }
  });

  it("agrees with path.relative on a trailing slash either side", () => {
    expect(locateRelative(posix.relative("/a/b", "/a/b/"))).toBe("self");
    expect(locateRelative(posix.relative("/a/b/", "/a/b"))).toBe("self");
    expect(locateRelative(posix.relative("/a/b/", "/a/b/c"))).toBe("inside");
    expect(locateRelative(posix.relative("/a/b/", "/a"))).toBe("outside");
  });
});
