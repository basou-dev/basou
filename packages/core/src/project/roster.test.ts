import { describe, expect, it } from "vitest";
import { summarizeRosterDrift } from "./roster.js";

describe("summarizeRosterDrift", () => {
  it("flags a declared repo missing from source_roots as a gap (the bio class)", () => {
    const s = summarizeRosterDrift({
      repos: [
        { path: ".", visibility: "private" },
        { path: "../takuhon", visibility: "public" },
        { path: "../takashimatsuyama-bio", visibility: "public" },
      ],
      sourceRoots: [".", "../takuhon"], // bio declared but not captured
    });
    expect(s.ok).toBe(false);
    expect(s.gaps.map((g) => g.path)).toEqual(["../takashimatsuyama-bio"]);
    expect(s.gaps[0]?.visibility).toBe("public");
    expect(s.matched).toEqual([".", "../takuhon"]);
  });

  it("is ok when every declared repo is captured; an extra captured path is not a gap", () => {
    const s = summarizeRosterDrift({
      repos: [{ path: "../takuhon" }],
      // the workspace view is a capture source but not a declared repo
      sourceRoots: ["../takuhon", "../takuhon-workspace"],
    });
    expect(s.ok).toBe(true);
    expect(s.gaps).toHaveLength(0);
    expect(s.extra).toEqual(["../takuhon-workspace"]);
  });

  it("normalizes trailing slashes and self ('.') so they compare equal", () => {
    const s = summarizeRosterDrift({
      repos: [{ path: "../x/" }, { path: "." }],
      sourceRoots: ["../x", "./"],
    });
    expect(s.ok).toBe(true);
    expect(s.gaps).toHaveLength(0);
    expect(s.matched).toEqual([".", "../x"]);
  });

  it("with no declared roster: no gaps, every captured path is extra", () => {
    const s = summarizeRosterDrift({ sourceRoots: [".", "../takuhon"] });
    expect(s.declaredCount).toBe(0);
    expect(s.ok).toBe(true);
    expect(s.gaps).toHaveLength(0);
    expect(s.extra).toEqual([".", "../takuhon"]);
  });

  it("with no source_roots: every declared repo is a gap", () => {
    const s = summarizeRosterDrift({ repos: [{ path: "../a" }, { path: "../b" }] });
    expect(s.ok).toBe(false);
    expect(s.gaps.map((g) => g.path).sort()).toEqual(["../a", "../b"]);
    expect(s.matched).toHaveLength(0);
  });

  it("reports counts of distinct declared and captured paths", () => {
    const s = summarizeRosterDrift({
      repos: [{ path: "../a" }, { path: "../a/" }], // same after normalize -> 1 distinct
      sourceRoots: ["../a", "../b"],
    });
    expect(s.declaredCount).toBe(1);
    expect(s.capturedCount).toBe(2);
    expect(s.ok).toBe(true);
    expect(s.extra).toEqual(["../b"]);
  });
});
