import { describe, expect, it } from "vitest";
import { pathBasename, planRename } from "./rename.js";

describe("pathBasename", () => {
  it("returns the last segment of a normalized relative path", () => {
    expect(pathBasename("../takuhon")).toBe("takuhon");
    expect(pathBasename("../a/x")).toBe("x");
    expect(pathBasename("../takuhon/")).toBe("takuhon");
    expect(pathBasename(".")).toBe(".");
  });

  it("collapses a trailing dot-segment so the basename is the real leaf, not '.'", () => {
    expect(pathBasename("../a/x/.")).toBe("x"); // was wrongly "." before the shared normalizer
    expect(pathBasename("../b/.")).toBe("b");
    expect(pathBasename("a/../..")).toBe(".."); // collapses to "..", whose leaf is ".."
  });
});

describe("planRename", () => {
  const roster = [
    { path: ".", visibility: "private" as const },
    { path: "../takuhon", visibility: "public" as const, language: "en" as const },
    { path: "../takuhon-site", visibility: "private" as const },
  ];

  it("re-paths the roster entry and source_roots, preserving other fields and order", () => {
    const p = planRename({
      repos: roster,
      sourceRoots: [".", "../takuhon", "../takuhon-site", "../view"],
      oldPath: "../takuhon",
      newPath: "../takuhon-cli",
    });
    expect(p.found).toBe(true);
    expect(p.collision).toBe(false);
    expect(p.reposChanged).toBe(true);
    expect(p.nextRepos).toEqual([
      { path: ".", visibility: "private" },
      { path: "../takuhon-cli", visibility: "public", language: "en" },
      { path: "../takuhon-site", visibility: "private" },
    ]);
    expect(p.sourceRootRenamed).toBe("../takuhon");
    expect(p.nextSourceRoots).toEqual([".", "../takuhon-cli", "../takuhon-site", "../view"]);
    expect(p.basenameChanged).toBe(true);
  });

  it("is a no-op when old and new normalize to the same path", () => {
    const p = planRename({ repos: roster, oldPath: "../takuhon", newPath: "../takuhon/" });
    expect(p.noop).toBe(true);
    expect(p.reposChanged).toBe(false);
    expect(p.nextRepos).toEqual(roster);
  });

  it("refuses to rename the anchor (.)", () => {
    const p = planRename({ repos: roster, oldPath: ".", newPath: "../root" });
    expect(p.isAnchor).toBe(true);
    expect(p.reposChanged).toBe(false);
    expect(p.nextRepos).toEqual(roster);
  });

  it("refuses an anchor the caller resolved by realpath even when not declared as '.'", () => {
    const p = planRename({
      repos: [{ path: "../anchor" }],
      oldPath: "../anchor",
      newPath: "../x",
      oldIsAnchor: true,
    });
    expect(p.isAnchor).toBe(true);
    expect(p.reposChanged).toBe(false);
  });

  it("reports found:false for a source not in the roster", () => {
    const p = planRename({ repos: roster, oldPath: "../ghost", newPath: "../x" });
    expect(p.found).toBe(false);
    expect(p.reposChanged).toBe(false);
  });

  it("refuses a collision when the destination is already declared", () => {
    const p = planRename({ repos: roster, oldPath: "../takuhon", newPath: "../takuhon-site" });
    expect(p.collision).toBe(true);
    expect(p.reposChanged).toBe(false);
    expect(p.nextRepos).toEqual(roster);
  });

  it("does not touch source_roots when the source is not captured", () => {
    const p = planRename({
      repos: roster,
      sourceRoots: [".", "../takuhon"], // takuhon-site not captured
      oldPath: "../takuhon-site",
      newPath: "../site",
    });
    expect(p.found).toBe(true);
    expect(p.sourceRootRenamed).toBeUndefined();
    expect(p.nextSourceRoots).toBeUndefined();
    expect(p.nextRepos.map((r) => r.path)).toEqual([".", "../takuhon", "../site"]);
  });

  it("flags basenameChanged=false for a same-basename move", () => {
    const p = planRename({
      repos: [{ path: ".." + "/a/x" }, { path: "../y" }],
      oldPath: "../a/x",
      newPath: "../b/x",
    });
    expect(p.basenameChanged).toBe(false);
    expect(p.nextRepos.map((r) => r.path)).toEqual(["../b/x", "../y"]);
  });

  it("collapses a path declared twice to a single renamed entry", () => {
    const p = planRename({
      repos: [{ path: "../x" }, { path: "../x/" }, { path: "../y" }],
      sourceRoots: ["../x", "../x/"],
      oldPath: "../x",
      newPath: "../z",
    });
    expect(p.nextRepos.map((r) => r.path)).toEqual(["../z", "../y"]);
    expect(p.nextSourceRoots).toEqual(["../z"]);
  });

  it("collapses a doubly-declared path first-wins, and rosterEntry echoes that same (first) entry", () => {
    const p = planRename({
      repos: [
        { path: "../x", visibility: "private" },
        { path: "../x/", visibility: "public", language: "ja" },
      ],
      oldPath: "../x",
      newPath: "../z",
    });
    // The kept entry is the FIRST declaration (private), re-pathed.
    expect(p.nextRepos).toEqual([{ path: "../z", visibility: "private" }]);
    // The echoed rosterEntry is the SAME (first) entry — no report/manifest mismatch.
    expect(p.rosterEntry).toEqual({ path: "../x", visibility: "private" });
  });

  it("persists the CANONICAL form of a non-canonical destination (the one write-back site)", () => {
    const p = planRename({
      repos: [{ path: "../a" }],
      sourceRoots: ["../a"],
      oldPath: "../a",
      newPath: "../x/./y/..", // non-canonical spelling of ../x
    });
    expect(p.newTarget).toBe("../x"); // collapsed before being stored
    expect(p.nextRepos.map((r) => r.path)).toEqual(["../x"]);
    expect(p.nextSourceRoots).toEqual(["../x"]);
    expect(p.basenameChanged).toBe(true); // ../a -> ../x
  });

  it("refuses a collision when the destination is a dot-segment spelling of a declared entry", () => {
    const p = planRename({
      repos: [{ path: "../a" }, { path: "../b" }],
      oldPath: "../a",
      newPath: "../b/.", // dot-spelling of the already-declared ../b
    });
    expect(p.collision).toBe(true);
    expect(p.reposChanged).toBe(false);
  });
});
