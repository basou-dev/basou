import { describe, expect, it } from "vitest";
import { planArchive } from "./archive.js";

describe("planArchive", () => {
  const roster = [
    { path: ".", visibility: "private" as const },
    { path: "../takuhon", visibility: "public" as const },
    { path: "../takuhon-site", visibility: "private" as const },
  ];

  it("removes the target from the roster and prunes its source_roots entry", () => {
    const p = planArchive({
      repos: roster,
      sourceRoots: [".", "../takuhon", "../takuhon-site", "../workspace-view"],
      target: "../takuhon",
    });
    expect(p.found).toBe(true);
    expect(p.isAnchor).toBe(false);
    expect(p.rosterEntry?.path).toBe("../takuhon");
    expect(p.nextRepos.map((r) => r.path)).toEqual([".", "../takuhon-site"]);
    expect(p.sourceRootRemoval).toBe("../takuhon");
    // The view source-root and the host `.` are preserved — only the exact target is pruned.
    expect(p.nextSourceRoots).toEqual([".", "../takuhon-site", "../workspace-view"]);
    expect(p.remainingCount).toBe(2);
    expect(p.becomesSolo).toBe(false);
    expect(p.reposEmptied).toBe(false);
  });

  it("refuses to archive the anchor (`.`) and changes nothing", () => {
    const p = planArchive({ repos: roster, sourceRoots: [".", "../takuhon"], target: "." });
    expect(p.isAnchor).toBe(true);
    expect(p.nextRepos).toEqual(roster);
    expect(p.sourceRootRemoval).toBeUndefined();
    expect(p.nextSourceRoots).toBeUndefined();
  });

  it("refuses a target the caller resolved to the anchor even when not declared as `.`", () => {
    const p = planArchive({
      repos: [{ path: "../anchor", visibility: "private" }],
      target: "../anchor",
      targetIsAnchor: true,
    });
    expect(p.isAnchor).toBe(true);
    expect(p.nextRepos.map((r) => r.path)).toEqual(["../anchor"]);
  });

  it("reports found:false for a target not in the roster (no change)", () => {
    const p = planArchive({ repos: roster, sourceRoots: [".", "../takuhon"], target: "../ghost" });
    expect(p.found).toBe(false);
    expect(p.nextRepos).toEqual(roster);
    expect(p.sourceRootRemoval).toBeUndefined();
  });

  it("flags reposEmptied when archiving the last member repo (the project closes)", () => {
    const p = planArchive({
      repos: [{ path: "../solo", visibility: "public" }],
      sourceRoots: ["../solo"],
      target: "../solo",
    });
    expect(p.found).toBe(true);
    expect(p.nextRepos).toEqual([]);
    expect(p.reposEmptied).toBe(true);
    expect(p.remainingCount).toBe(0);
    expect(p.becomesSolo).toBe(false);
    expect(p.nextSourceRoots).toEqual([]);
  });

  it("flags becomesSolo when exactly one repo remains (the view is no longer needed)", () => {
    const p = planArchive({
      repos: [{ path: "." }, { path: "../x" }],
      target: "../x",
    });
    expect(p.remainingCount).toBe(1);
    expect(p.becomesSolo).toBe(true);
    expect(p.reposEmptied).toBe(false);
  });

  it("does not prune source_roots when the target is not captured", () => {
    const p = planArchive({
      repos: roster,
      sourceRoots: [".", "../takuhon"], // takuhon-site not captured
      target: "../takuhon-site",
    });
    expect(p.found).toBe(true);
    expect(p.sourceRootRemoval).toBeUndefined();
    expect(p.nextSourceRoots).toBeUndefined();
  });

  it("handles an absent source_roots (solo default) without a prune", () => {
    const p = planArchive({ repos: [{ path: "." }, { path: "../x" }], target: "../x" });
    expect(p.found).toBe(true);
    expect(p.sourceRootRemoval).toBeUndefined();
    expect(p.nextSourceRoots).toBeUndefined();
    expect(p.nextRepos.map((r) => r.path)).toEqual(["."]);
  });

  it("removes every entry matching the normalized target (a path declared twice)", () => {
    const p = planArchive({
      repos: [{ path: "../x" }, { path: "../x/" }, { path: "../y" }],
      sourceRoots: ["../x", "../x/"],
      target: "../x",
    });
    expect(p.nextRepos.map((r) => r.path)).toEqual(["../y"]);
    expect(p.nextSourceRoots).toEqual([]);
  });

  it("matches the target by normalized path (trailing slash tolerant)", () => {
    const p = planArchive({ repos: roster, target: "../takuhon/" });
    expect(p.found).toBe(true);
    expect(p.target).toBe("../takuhon");
    expect(p.nextRepos.map((r) => r.path)).toEqual([".", "../takuhon-site"]);
  });

  it("matches a dot-segment spelling of a declared target and prunes its dot-spelled source-root", () => {
    const p = planArchive({
      repos: roster,
      sourceRoots: ["../takuhon/."], // dot-segment spelling of ../takuhon
      target: "./../takuhon/.", // dot-segment spelling of the same target
    });
    expect(p.found).toBe(true);
    expect(p.target).toBe("../takuhon"); // canonicalized
    expect(p.nextRepos.map((r) => r.path)).toEqual([".", "../takuhon-site"]);
    expect(p.nextSourceRoots).toEqual([]); // the dot-spelled source-root was pruned
  });
});
