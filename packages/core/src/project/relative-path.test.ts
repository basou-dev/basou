import { describe, expect, it } from "vitest";
import { normalizeRelativePath } from "./relative-path.js";

describe("normalizeRelativePath", () => {
  it("leaves an already-canonical relative path unchanged", () => {
    expect(normalizeRelativePath("../basou")).toBe("../basou");
    expect(normalizeRelativePath("a/b/c")).toBe("a/b/c");
    expect(normalizeRelativePath(".")).toBe(".");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeRelativePath("  ../basou  ")).toBe("../basou");
  });

  it("drops a trailing slash and collapses doubled internal separators", () => {
    expect(normalizeRelativePath("../basou/")).toBe("../basou");
    expect(normalizeRelativePath("a//b")).toBe("a/b");
    expect(normalizeRelativePath("a/b///c/")).toBe("a/b/c");
  });

  it("drops `.` segments anywhere", () => {
    expect(normalizeRelativePath("./a")).toBe("a");
    expect(normalizeRelativePath("../b/.")).toBe("../b");
    expect(normalizeRelativePath("./a/./b/.")).toBe("a/b");
  });

  it("resolves `..` against a preceding normal segment", () => {
    expect(normalizeRelativePath("a/../b")).toBe("b");
    expect(normalizeRelativePath("a/b/..")).toBe("a");
    expect(normalizeRelativePath("a/b/../..")).toBe(".");
  });

  it("preserves leading `..` that cannot be resolved away (a relative path may ascend)", () => {
    expect(normalizeRelativePath("..")).toBe("..");
    expect(normalizeRelativePath("../..")).toBe("../..");
    expect(normalizeRelativePath("../a")).toBe("../a");
    expect(normalizeRelativePath("a/../../b")).toBe("../b");
    expect(normalizeRelativePath("../../a/b")).toBe("../../a/b");
  });

  it("preserves whitespace inside a segment (a directory may be named with spaces)", () => {
    expect(normalizeRelativePath("../my repo")).toBe("../my repo");
    expect(normalizeRelativePath("a/ /b")).toBe("a/ /b"); // a segment that is a single space
    expect(normalizeRelativePath("a/ b /c")).toBe("a/ b /c");
  });

  it("yields `.` for empty / whitespace-only / all-dot input", () => {
    expect(normalizeRelativePath("")).toBe(".");
    expect(normalizeRelativePath("   ")).toBe(".");
    expect(normalizeRelativePath(".")).toBe(".");
    expect(normalizeRelativePath("./.")).toBe(".");
    expect(normalizeRelativePath("a/..")).toBe(".");
  });

  it("gives equivalent spellings of the same location ONE comparison key", () => {
    const key = normalizeRelativePath("../basou");
    for (const spelling of ["../basou", "../basou/", "../basou/.", "./../basou", "../x/../basou"]) {
      expect(normalizeRelativePath(spelling)).toBe(key);
    }
  });

  it("does NOT collide genuinely distinct paths", () => {
    expect(normalizeRelativePath("../a")).not.toBe(normalizeRelativePath("../b"));
    expect(normalizeRelativePath("a/b")).not.toBe(normalizeRelativePath("a b")); // slash vs space
    expect(normalizeRelativePath("../a")).not.toBe(normalizeRelativePath("../../a")); // one level vs two
    expect(normalizeRelativePath("a/b")).not.toBe(normalizeRelativePath("a/b/c"));
  });

  it("normalizes absolute input defensively (.. above root is dropped)", () => {
    expect(normalizeRelativePath("/a/b/../c")).toBe("/a/c");
    expect(normalizeRelativePath("/../a")).toBe("/a");
  });
});
