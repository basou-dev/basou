import { describe, expect, it } from "vitest";
import { type ExistingViewLink, planWorkspaceView, type ViewRepoFact } from "./workspace-view.js";

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

  it("defaults to no strays when the view contents are not supplied (create-only plan)", () => {
    const p = planWorkspaceView([fact({ path: "../basou", linkName: "basou" })]);
    expect(p.toPrune).toEqual([]);
    expect(p.strayUnknown).toEqual([]);
    expect(p.ok).toBe(true);
  });

  it("flags a repo-shaped view link the roster no longer backs as prunable (and not ok)", () => {
    const existing: ExistingViewLink[] = [
      { name: "basou", target: "../basou", kind: "repo" }, // current roster link
      { name: "old", target: "../old", kind: "repo" }, // de-rostered, still on disk
    ];
    const p = planWorkspaceView([fact({ path: "../basou", linkName: "basou" })], existing);
    expect(p.toPrune).toEqual([{ name: "old", target: "../old" }]);
    expect(p.strayUnknown).toEqual([]);
    expect(p.ok).toBe(false);
  });

  it("never prunes the link of a declared-but-unreachable repo (rosterNames protects it by name)", () => {
    // The repo is in the roster but its path did not resolve at scan time
    // (reachable:false, so it contributes no linkName via facts). Its basename is
    // still supplied in rosterNames, so its live on-disk link must not be a stray.
    const existing: ExistingViewLink[] = [{ name: "old", target: "../old", kind: "repo" }];
    const p = planWorkspaceView(
      [fact({ path: "../mount/old", linkName: "old", reachable: false })],
      existing,
      ["old"],
    );
    expect(p.toPrune).toEqual([]);
    expect(p.strayUnknown).toEqual([]);
  });

  it("never prunes a link a reachable roster repo owns, even a colliding one", () => {
    const existing: ExistingViewLink[] = [{ name: "pub", target: "../x/pub", kind: "repo" }];
    // Two repos collide on "pub"; neither is auto-wired, but "pub" is still owned
    // by the roster and must not be pruned.
    const p = planWorkspaceView(
      [
        fact({ path: "../x/pub", linkName: "pub", state: "missing" }),
        fact({ path: "../y/pub", linkName: "pub", state: "missing" }),
      ],
      existing,
    );
    expect(p.toPrune).toEqual([]);
    expect(p.strayUnknown).toEqual([]);
  });

  it("routes broken / non-repo / absolute strays to strayUnknown, never to toPrune", () => {
    const existing: ExistingViewLink[] = [
      { name: "dead", target: "../dead", kind: "broken" },
      { name: "plain", target: "../plain", kind: "non-repo" },
      { name: "abs", target: "/elsewhere", kind: "absolute" },
    ];
    const p = planWorkspaceView([], existing);
    expect(p.toPrune).toEqual([]);
    expect(p.strayUnknown).toEqual([
      { name: "dead", target: "../dead", reason: "broken" },
      { name: "plain", target: "../plain", reason: "non-repo" },
      { name: "abs", target: "/elsewhere", reason: "absolute" },
    ]);
    expect(p.ok).toBe(false);
  });
});
