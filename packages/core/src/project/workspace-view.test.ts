import { describe, expect, it } from "vitest";
import { planWorkspaceView, type ViewRepoFact } from "./workspace-view.js";

function fact(over: Partial<ViewRepoFact> & Pick<ViewRepoFact, "path" | "linkName">): ViewRepoFact {
  return {
    reachable: true,
    expectedTarget: `../${over.linkName}`,
    state: "correct",
    ...over,
  };
}

describe("planWorkspaceView", () => {
  it("is ok when every roster repo (anchor included) is already linked", () => {
    const p = planWorkspaceView([
      fact({ path: ".", linkName: "anchor", expectedTarget: "../anchor" }),
      fact({ path: "../basou", linkName: "basou" }),
      fact({ path: "../basou-site", linkName: "basou-site" }),
    ]);
    expect(p.ok).toBe(true);
    expect(p.toCreate).toEqual([]);
    expect(p.correctCount).toBe(3);
  });

  it("plans missing links, including the anchor's", () => {
    const p = planWorkspaceView([
      fact({
        path: ".",
        linkName: "anchor",
        state: "missing",
        expectedTarget: "../anchor",
      }),
      fact({ path: "../basou", linkName: "basou", state: "missing" }),
    ]);
    expect(p.ok).toBe(false);
    expect(p.toCreate).toEqual([
      { name: "anchor", target: "../anchor" },
      { name: "basou", target: "../basou" },
    ]);
  });

  it("reports a link pointing elsewhere as a mismatch conflict (never overwritten)", () => {
    const p = planWorkspaceView([
      fact({
        path: "../basou",
        linkName: "basou",
        state: "mismatch",
        actualTarget: "../elsewhere",
      }),
    ]);
    expect(p.toCreate).toEqual([]);
    expect(p.conflicts).toEqual([
      { name: "basou", reason: "mismatch", actualTarget: "../elsewhere" },
    ]);
    expect(p.ok).toBe(false);
  });

  it("reports occupied and blocked paths as conflicts (never overwritten)", () => {
    const p = planWorkspaceView([
      fact({ path: "../a", linkName: "a", state: "occupied" }),
      fact({ path: "../b", linkName: "b", state: "blocked" }),
    ]);
    expect(p.conflicts).toEqual([
      { name: "a", reason: "occupied" },
      { name: "b", reason: "blocked" },
    ]);
    expect(p.toCreate).toEqual([]);
    expect(p.ok).toBe(false);
  });

  it("degrades an unresolvable repo to unreachable without blanking the rest", () => {
    const p = planWorkspaceView([
      fact({ path: "../gone", linkName: "gone", reachable: false }),
      fact({ path: "../basou", linkName: "basou" }),
    ]);
    expect(p.unreachable).toEqual(["../gone"]);
    expect(p.correctCount).toBe(1);
    expect(p.ok).toBe(false);
  });

  it("surfaces two distinct repos sharing a basename as a collision and wires neither", () => {
    const p = planWorkspaceView([
      fact({ path: "../x/pub", linkName: "pub", state: "missing" }),
      fact({ path: "../y/pub", linkName: "pub", state: "missing" }),
    ]);
    expect(p.collisions).toEqual([{ linkName: "pub", repos: ["../x/pub", "../y/pub"] }]);
    expect(p.toCreate).toEqual([]);
    expect(p.ok).toBe(false);
  });

  it("dedupes a repo declared twice (one link)", () => {
    const p = planWorkspaceView([
      fact({ path: "../basou", linkName: "basou", state: "missing" }),
      fact({ path: "../basou", linkName: "basou", state: "missing" }),
    ]);
    expect(p.toCreate).toEqual([{ name: "basou", target: "../basou" }]);
  });

  it("counts correct links while still flagging a sibling conflict (no false-clear)", () => {
    const p = planWorkspaceView([
      fact({ path: "../basou", linkName: "basou" }),
      fact({ path: "../site", linkName: "site", state: "occupied" }),
    ]);
    expect(p.correctCount).toBe(1);
    expect(p.conflicts).toHaveLength(1);
    expect(p.ok).toBe(false);
  });

  it("is ok for an empty roster (nothing to aggregate)", () => {
    const p = planWorkspaceView([]);
    expect(p.ok).toBe(true);
    expect(p.toCreate).toEqual([]);
  });
});
