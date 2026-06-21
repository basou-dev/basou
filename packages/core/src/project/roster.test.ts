import { describe, expect, it } from "vitest";
import { planRosterAdoption, reconcileSourceRoots, summarizeRosterDrift } from "./roster.js";

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

describe("reconcileSourceRoots", () => {
  it("appends a declared repo missing from source_roots (the bio class), preserving existing entries", () => {
    const r = reconcileSourceRoots({
      repos: [
        { path: ".", visibility: "private" },
        { path: "../takuhon", visibility: "public" },
        { path: "../takashimatsuyama-bio", visibility: "public" },
      ],
      sourceRoots: [".", "../takuhon"], // bio declared but not captured
    });
    expect(r.unchanged).toBe(false);
    expect(r.added).toEqual(["../takashimatsuyama-bio"]);
    expect(r.next).toEqual([".", "../takuhon", "../takashimatsuyama-bio"]);
  });

  it("is unchanged when every declared repo is already captured", () => {
    const r = reconcileSourceRoots({
      repos: [{ path: "." }, { path: "../takuhon" }],
      sourceRoots: [".", "../takuhon"],
    });
    expect(r.unchanged).toBe(true);
    expect(r.added).toEqual([]);
    expect(r.next).toEqual([".", "../takuhon"]);
  });

  it("never removes an undeclared captured path (the workspace view is preserved)", () => {
    const r = reconcileSourceRoots({
      repos: [{ path: "../takuhon" }, { path: "../takuhon-bio" }],
      // view is captured but not a declared repo, and bio is the gap
      sourceRoots: ["../takuhon", "../takuhon-workspace"],
    });
    expect(r.added).toEqual(["../takuhon-bio"]);
    expect(r.next).toEqual(["../takuhon", "../takuhon-workspace", "../takuhon-bio"]);
  });

  it("normalizes appended paths and does not re-append a trailing-slash variant", () => {
    const r = reconcileSourceRoots({
      repos: [{ path: "../x/" }, { path: "../y/" }],
      sourceRoots: ["../x"], // ../x already captured; only ../y is missing
    });
    expect(r.added).toEqual(["../y"]); // normalized (no trailing slash)
    expect(r.next).toEqual(["../x", "../y"]);
  });

  it("preserves an existing entry byte-identical even when its variant is the appended form", () => {
    // existing "./" stays as-is; "." normalizes to it so nothing is appended
    const r = reconcileSourceRoots({
      repos: [{ path: "." }],
      sourceRoots: ["./"],
    });
    expect(r.unchanged).toBe(true);
    expect(r.next).toEqual(["./"]);
  });

  it("derives the full list when source_roots is absent", () => {
    const r = reconcileSourceRoots({ repos: [{ path: "." }, { path: "../a" }] });
    expect(r.unchanged).toBe(false);
    expect(r.added).toEqual([".", "../a"]);
    expect(r.next).toEqual([".", "../a"]);
  });

  it("dedupes repeated declared paths so each is appended at most once", () => {
    const r = reconcileSourceRoots({
      repos: [{ path: "../a" }, { path: "../a/" }, { path: "../b" }],
      sourceRoots: [],
    });
    expect(r.added).toEqual(["../a", "../b"]);
    expect(r.next).toEqual(["../a", "../b"]);
  });

  it("is unchanged with no declared roster (nothing to derive)", () => {
    const r = reconcileSourceRoots({ sourceRoots: [".", "../takuhon"] });
    expect(r.unchanged).toBe(true);
    expect(r.added).toEqual([]);
    expect(r.next).toEqual([".", "../takuhon"]);
  });
});

describe("planRosterAdoption", () => {
  it("keeps git repos as roster entries (path only, no visibility) and excludes non-repos", () => {
    const plan = planRosterAdoption([
      { path: ".", kind: "repo" },
      { path: "../takuhon", kind: "repo" },
      { path: "../takuhon-workspace", kind: "non-repo" }, // the view
      { path: "../basou-site", kind: "repo" },
    ]);
    expect(plan.repos).toEqual([{ path: "." }, { path: "../takuhon" }, { path: "../basou-site" }]);
    expect(plan.excluded).toEqual([{ path: "../takuhon-workspace", kind: "non-repo" }]);
  });

  it("excludes an unresolvable path with its reason", () => {
    const plan = planRosterAdoption([
      { path: ".", kind: "repo" },
      { path: "../moved-away", kind: "unresolved" },
    ]);
    expect(plan.repos).toEqual([{ path: "." }]);
    expect(plan.excluded).toEqual([{ path: "../moved-away", kind: "unresolved" }]);
  });

  it("dedupes repo paths by normalized form, preserving the first declared form and order", () => {
    const plan = planRosterAdoption([
      { path: "../a", kind: "repo" },
      { path: "../a/", kind: "repo" }, // same after normalize
      { path: "../b", kind: "repo" },
    ]);
    expect(plan.repos).toEqual([{ path: "../a" }, { path: "../b" }]);
  });

  it("returns an empty roster when no candidate is a repo", () => {
    const plan = planRosterAdoption([
      { path: "../view", kind: "non-repo" },
      { path: "../gone", kind: "unresolved" },
    ]);
    expect(plan.repos).toEqual([]);
    expect(plan.excluded).toHaveLength(2);
  });

  it("dedupes excluded paths too (a trailing-slash variant is not listed twice)", () => {
    const plan = planRosterAdoption([
      { path: "../view", kind: "non-repo" },
      { path: "../view/", kind: "non-repo" }, // same after normalize
      { path: "../gone", kind: "unresolved" },
      { path: "../gone/", kind: "unresolved" },
    ]);
    expect(plan.excluded).toEqual([
      { path: "../view", kind: "non-repo" },
      { path: "../gone", kind: "unresolved" },
    ]);
  });

  it("handles an empty candidate list", () => {
    const plan = planRosterAdoption([]);
    expect(plan.repos).toEqual([]);
    expect(plan.excluded).toEqual([]);
  });
});
