import { describe, expect, it } from "vitest";
import { classifyRetrofit, type RetrofitFacts } from "./retrofit.js";

/** A relocatable baseline: declared, reachable, non-anchor, regular-file AGENTS.md, free canonical. */
function baseFacts(overrides: Partial<RetrofitFacts> = {}): RetrofitFacts {
  return {
    path: "../foo",
    declared: true,
    isAnchor: false,
    reachable: true,
    canonicalName: "foo",
    agentsState: "regular-file",
    canonicalExists: false,
    regularSpokes: [],
    ...overrides,
  };
}

describe("classifyRetrofit", () => {
  it("relocates a regular-file AGENTS.md into a free canonical slot", () => {
    const plan = classifyRetrofit(baseFacts());
    expect(plan.action).toBe("relocate");
    expect(plan.reason).toBe("ok");
    expect(plan.canonicalPath).toBe("agents/foo/AGENTS.md");
    expect(plan.regularSpokes).toEqual([]);
  });

  it("refuses an undeclared repo (precedence: checked before anything else)", () => {
    // Even with otherwise-relocatable facts, an undeclared path is refused first.
    const plan = classifyRetrofit(baseFacts({ declared: false }));
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toBe("not-declared");
    expect(plan.canonicalPath).toBeUndefined();
  });

  it("refuses the anchor (it owns the canonical directly — nothing to relocate)", () => {
    const plan = classifyRetrofit(baseFacts({ path: ".", canonicalName: ".", isAnchor: true }));
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toBe("anchor");
  });

  it("refuses a self repo (its AGENTS.md stays in the repo — retrofit does not apply)", () => {
    // Even with otherwise-relocatable facts, a self repo is refused.
    const plan = classifyRetrofit(baseFacts({ self: true }));
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toBe("self");
    expect(plan.canonicalPath).toBeUndefined();
  });

  it("precedence: the anchor refusal wins over self when both apply", () => {
    const plan = classifyRetrofit(
      baseFacts({ path: ".", canonicalName: ".", isAnchor: true, self: true }),
    );
    expect(plan.reason).toBe("anchor");
  });

  it("refuses an unreachable repo (path unresolved / not a git repo)", () => {
    const plan = classifyRetrofit(baseFacts({ reachable: false }));
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toBe("unreachable");
  });

  it("refuses an uninspectable AGENTS.md (blocked, never mistaken for relocatable)", () => {
    const plan = classifyRetrofit(baseFacts({ agentsState: "blocked" }));
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toBe("blocked");
  });

  it("refuses when the destination canonical already exists (would clobber)", () => {
    const plan = classifyRetrofit(baseFacts({ canonicalExists: true }));
    expect(plan.action).toBe("refuse");
    expect(plan.reason).toBe("canonical-exists");
    expect(plan.canonicalPath).toBeUndefined();
  });

  it("skips an already-wired symlink (idempotent)", () => {
    const plan = classifyRetrofit(baseFacts({ agentsState: "symlink", canonicalExists: true }));
    expect(plan.action).toBe("skip");
    expect(plan.reason).toBe("already-symlink");
  });

  it("skips when there is no AGENTS.md to relocate", () => {
    const plan = classifyRetrofit(baseFacts({ agentsState: "absent" }));
    expect(plan.action).toBe("skip");
    expect(plan.reason).toBe("absent");
  });

  it("echoes regular-file spokes in the plan (advisory; never blocks the move)", () => {
    const plan = classifyRetrofit(
      baseFacts({ regularSpokes: ["CLAUDE.md", ".github/copilot-instructions.md"] }),
    );
    expect(plan.action).toBe("relocate");
    expect(plan.regularSpokes).toEqual(["CLAUDE.md", ".github/copilot-instructions.md"]);
  });

  it("orders refusals deterministically: anchor before unreachable before blocked", () => {
    // All three refusal conditions hold at once; precedence picks `anchor`.
    const plan = classifyRetrofit(
      baseFacts({ isAnchor: true, reachable: false, agentsState: "blocked" }),
    );
    expect(plan.reason).toBe("anchor");
  });

  it("a free-canonical relocate beats a present-canonical refuse only when the file is regular", () => {
    // A symlink with a present canonical is the steady state → skip, not refuse.
    const steady = classifyRetrofit(baseFacts({ agentsState: "symlink", canonicalExists: true }));
    expect(steady.action).toBe("skip");
  });
});
