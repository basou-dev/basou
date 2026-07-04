import { describe, expect, it } from "vitest";
import {
  type InstructionSymlinkFact,
  type InstructionSymlinkState,
  type RepoSymlinkFacts,
  summarizeSymlinkPlan,
} from "./symlinks.js";

/** The three instruction files with their hub-and-spoke targets for one sibling repo. */
function wiredFiles(
  states: Partial<Record<string, InstructionSymlinkState>> = {},
  actualTargets: Partial<Record<string, string>> = {},
): InstructionSymlinkFact[] {
  const specs: { name: string; expectedTarget: string }[] = [
    { name: "AGENTS.md", expectedTarget: "../anchor/agents/basou/AGENTS.md" },
    { name: "CLAUDE.md", expectedTarget: "AGENTS.md" },
    { name: ".github/copilot-instructions.md", expectedTarget: "../AGENTS.md" },
  ];
  return specs.map((s) => ({
    name: s.name,
    expectedTarget: s.expectedTarget,
    state: states[s.name] ?? "correct",
    ...(actualTargets[s.name] !== undefined ? { actualTarget: actualTargets[s.name] } : {}),
  }));
}

/**
 * The anchor's OWN spokes (self-style): only CLAUDE.md / Copilot, each pointing at
 * the anchor's root AGENTS.md. No AGENTS.md hub link (the root AGENTS.md IS the
 * canonical).
 */
function anchorSpokes(
  states: Partial<Record<string, InstructionSymlinkState>> = {},
): InstructionSymlinkFact[] {
  const specs: { name: string; expectedTarget: string }[] = [
    { name: "CLAUDE.md", expectedTarget: "AGENTS.md" },
    { name: ".github/copilot-instructions.md", expectedTarget: "../AGENTS.md" },
  ];
  return specs.map((s) => ({
    name: s.name,
    expectedTarget: s.expectedTarget,
    state: states[s.name] ?? "correct",
  }));
}

function repo(over: Partial<RepoSymlinkFacts> & Pick<RepoSymlinkFacts, "path">): RepoSymlinkFacts {
  return {
    isAnchor: false,
    reachable: true,
    canonicalPresent: true,
    files: wiredFiles(),
    ...over,
  };
}

describe("summarizeSymlinkPlan", () => {
  it("reports ok when every declared repo is already correctly wired", () => {
    const s = summarizeSymlinkPlan([repo({ path: "../basou" }), repo({ path: "../basou-site" })]);
    expect(s.ok).toBe(true);
    expect(s.plans).toEqual([]);
    expect(s.conflicts).toEqual([]);
  });

  it("leaves an un-seeded anchor (no root AGENTS.md) alone — no plan, reported in no bucket", () => {
    const s = summarizeSymlinkPlan([
      repo({ path: ".", isAnchor: true, canonicalPresent: false, files: [] }),
      repo({ path: "../basou" }),
    ]);
    expect(s.ok).toBe(true);
    expect(s.plans).toEqual([]);
    // An un-seeded anchor is NOT reported as missing (distinct from a hub repo's
    // absent canonical or a self repo's absent AGENTS.md).
    expect(s.missingCanonical).toEqual([]);
    expect(s.selfAgentsMissing).toEqual([]);
    expect(s.unreachable).toEqual([]);
  });

  it("wires the anchor's own CLAUDE.md / Copilot spokes once its root AGENTS.md exists", () => {
    const s = summarizeSymlinkPlan([
      repo({
        path: ".",
        isAnchor: true,
        canonicalPresent: true,
        canonicalName: "anchor",
        files: anchorSpokes({
          "CLAUDE.md": "missing",
          ".github/copilot-instructions.md": "missing",
        }),
      }),
      repo({ path: "../basou" }),
    ]);
    expect(s.plans).toEqual([
      {
        path: ".",
        toCreate: [
          { name: "CLAUDE.md", target: "AGENTS.md" },
          { name: ".github/copilot-instructions.md", target: "../AGENTS.md" },
        ],
      },
    ]);
    // Only the two spokes — never an AGENTS.md hub link (the root AGENTS.md IS the canonical).
    expect(s.plans[0]?.toCreate.some((c) => c.name === "AGENTS.md")).toBe(false);
    expect(s.ok).toBe(false);
  });

  it("reports ok for a seeded anchor whose spokes are already correct (idempotent)", () => {
    const s = summarizeSymlinkPlan([
      repo({
        path: ".",
        isAnchor: true,
        canonicalPresent: true,
        canonicalName: "anchor",
        files: anchorSpokes(),
      }),
      repo({ path: "../basou" }),
    ]);
    expect(s.ok).toBe(true);
    expect(s.plans).toEqual([]);
  });

  it("ok is true for an un-seeded anchor-only roster (a solo project has nothing to wire yet)", () => {
    const s = summarizeSymlinkPlan([
      repo({ path: ".", isAnchor: true, canonicalPresent: false, files: [] }),
    ]);
    expect(s.ok).toBe(true);
    expect(s.plans).toEqual([]);
  });

  it("plans only the missing links, leaving the correct ones alone", () => {
    const s = summarizeSymlinkPlan([
      repo({
        path: "../basou",
        files: wiredFiles({
          "CLAUDE.md": "missing",
          ".github/copilot-instructions.md": "missing",
        }),
      }),
    ]);
    expect(s.ok).toBe(false);
    expect(s.plans).toEqual([
      {
        path: "../basou",
        toCreate: [
          { name: "CLAUDE.md", target: "AGENTS.md" },
          { name: ".github/copilot-instructions.md", target: "../AGENTS.md" },
        ],
      },
    ]);
    expect(s.conflicts).toEqual([]);
  });

  it("plans all three links when none exist yet", () => {
    const s = summarizeSymlinkPlan([
      repo({
        path: "../basou",
        files: wiredFiles({
          "AGENTS.md": "missing",
          "CLAUDE.md": "missing",
          ".github/copilot-instructions.md": "missing",
        }),
      }),
    ]);
    expect(s.plans[0]?.toCreate).toEqual([
      { name: "AGENTS.md", target: "../anchor/agents/basou/AGENTS.md" },
      { name: "CLAUDE.md", target: "AGENTS.md" },
      { name: ".github/copilot-instructions.md", target: "../AGENTS.md" },
    ]);
  });

  it("reports a symlink pointing elsewhere as a mismatch conflict (never overwritten)", () => {
    const s = summarizeSymlinkPlan([
      repo({
        path: "../basou",
        files: wiredFiles({ "AGENTS.md": "mismatch" }, { "AGENTS.md": "../somewhere/else.md" }),
      }),
    ]);
    expect(s.ok).toBe(false);
    expect(s.plans).toEqual([]);
    expect(s.conflicts).toEqual([
      {
        repo: "../basou",
        file: "AGENTS.md",
        reason: "mismatch",
        actualTarget: "../somewhere/else.md",
      },
    ]);
  });

  it("reports a real file occupying the path as an occupied conflict (never overwritten)", () => {
    const s = summarizeSymlinkPlan([
      repo({ path: "../basou", files: wiredFiles({ "AGENTS.md": "occupied" }) }),
    ]);
    expect(s.ok).toBe(false);
    expect(s.conflicts).toEqual([{ repo: "../basou", file: "AGENTS.md", reason: "occupied" }]);
    // No actualTarget is carried for an occupied (non-symlink) path.
    expect(s.conflicts[0]).not.toHaveProperty("actualTarget");
  });

  it("still plans creatable links while reporting conflicts on the same repo", () => {
    const s = summarizeSymlinkPlan([
      repo({
        path: "../basou",
        files: wiredFiles({ "AGENTS.md": "occupied", "CLAUDE.md": "missing" }),
      }),
    ]);
    expect(s.plans).toEqual([
      { path: "../basou", toCreate: [{ name: "CLAUDE.md", target: "AGENTS.md" }] },
    ]);
    expect(s.conflicts).toEqual([{ repo: "../basou", file: "AGENTS.md", reason: "occupied" }]);
    expect(s.ok).toBe(false);
  });

  it("reports a repo whose anchor canonical is absent (cannot wire the hub) and plans nothing for it", () => {
    const s = summarizeSymlinkPlan([
      repo({
        path: "../newrepo",
        canonicalPresent: false,
        // Even if some files look missing, no links are planned without a canonical.
        files: wiredFiles({ "AGENTS.md": "missing" }),
      }),
    ]);
    expect(s.ok).toBe(false);
    expect(s.plans).toEqual([]);
    expect(s.missingCanonical).toEqual(["../newrepo"]);
  });

  it("degrades an unresolvable repo to unreachable without blanking the rest", () => {
    const s = summarizeSymlinkPlan([
      repo({ path: "../gone", reachable: false, files: [] }),
      repo({ path: "../basou" }),
    ]);
    expect(s.ok).toBe(false);
    expect(s.unreachable).toEqual(["../gone"]);
    // The reachable, correctly-wired repo contributes no plans/conflicts.
    expect(s.plans).toEqual([]);
    expect(s.conflicts).toEqual([]);
  });

  it("ok is false when only a missing canonical blocks an otherwise clean roster (no false-clear)", () => {
    const s = summarizeSymlinkPlan([
      repo({ path: "../basou" }),
      repo({ path: "../newrepo", canonicalPresent: false, files: [] }),
    ]);
    expect(s.plans).toEqual([]);
    expect(s.conflicts).toEqual([]);
    expect(s.ok).toBe(false);
  });

  it("reports a blocked file (uninspectable path) as a conflict, never as a create", () => {
    const s = summarizeSymlinkPlan([
      repo({ path: "../basou", files: wiredFiles({ "AGENTS.md": "blocked" }) }),
    ]);
    expect(s.plans).toEqual([]);
    expect(s.conflicts).toEqual([{ repo: "../basou", file: "AGENTS.md", reason: "blocked" }]);
    expect(s.ok).toBe(false);
  });

  it("dedupes a repo declared twice (one plan, no duplicate buckets)", () => {
    const s = summarizeSymlinkPlan([
      repo({ path: "../pub", files: wiredFiles({ "CLAUDE.md": "missing" }) }),
      repo({ path: "../pub", files: wiredFiles({ "CLAUDE.md": "missing" }) }),
    ]);
    expect(s.plans).toEqual([
      { path: "../pub", toCreate: [{ name: "CLAUDE.md", target: "AGENTS.md" }] },
    ]);
  });

  it("dedupes duplicate paths in the unreachable bucket too", () => {
    const s = summarizeSymlinkPlan([
      repo({ path: "../gone", reachable: false, files: [] }),
      repo({ path: "../gone", reachable: false, files: [] }),
    ]);
    expect(s.unreachable).toEqual(["../gone"]);
  });

  it("surfaces two distinct repos sharing a canonical name as a collision and wires neither", () => {
    const s = summarizeSymlinkPlan([
      repo({
        path: "../x/pub",
        canonicalName: "pub",
        files: wiredFiles({ "AGENTS.md": "missing" }),
      }),
      repo({
        path: "../y/pub",
        canonicalName: "pub",
        files: wiredFiles({ "AGENTS.md": "missing" }),
      }),
    ]);
    expect(s.collisions).toEqual([{ canonicalName: "pub", repos: ["../x/pub", "../y/pub"] }]);
    expect(s.plans).toEqual([]);
    expect(s.ok).toBe(false);
  });

  it("does not flag a collision for distinct canonical names", () => {
    const s = summarizeSymlinkPlan([
      repo({ path: "../basou", canonicalName: "basou" }),
      repo({ path: "../basou-site", canonicalName: "basou-site" }),
    ]);
    expect(s.collisions).toEqual([]);
    expect(s.ok).toBe(true);
  });
});

describe("summarizeSymlinkPlan — instructions: self", () => {
  /** The two spoke files (no AGENTS.md hub) a `self` repo carries, pointing at its own AGENTS.md. */
  function selfSpokes(
    states: Partial<Record<string, InstructionSymlinkState>> = {},
  ): InstructionSymlinkFact[] {
    const specs: { name: string; expectedTarget: string }[] = [
      { name: "CLAUDE.md", expectedTarget: "AGENTS.md" },
      { name: ".github/copilot-instructions.md", expectedTarget: "../AGENTS.md" },
    ];
    return specs.map((s) => ({
      name: s.name,
      expectedTarget: s.expectedTarget,
      state: states[s.name] ?? "correct",
    }));
  }

  it("plans only the two spokes for a self repo (never the AGENTS.md hub link)", () => {
    const s = summarizeSymlinkPlan([
      repo({
        path: "../blog",
        self: true,
        canonicalName: "blog",
        files: selfSpokes({ "CLAUDE.md": "missing", ".github/copilot-instructions.md": "missing" }),
      }),
    ]);
    expect(s.plans).toEqual([
      {
        path: "../blog",
        toCreate: [
          { name: "CLAUDE.md", target: "AGENTS.md" },
          { name: ".github/copilot-instructions.md", target: "../AGENTS.md" },
        ],
      },
    ]);
    expect(s.selfAgentsMissing).toEqual([]);
  });

  it("is ok when a self repo's spokes are already wired", () => {
    const s = summarizeSymlinkPlan([repo({ path: "../blog", self: true, files: selfSpokes() })]);
    expect(s.ok).toBe(true);
    expect(s.plans).toEqual([]);
  });

  it("routes an absent own-AGENTS.md to selfAgentsMissing, not missingCanonical", () => {
    const s = summarizeSymlinkPlan([
      repo({ path: "../blog", self: true, canonicalPresent: false, files: [] }),
    ]);
    expect(s.selfAgentsMissing).toEqual(["../blog"]);
    expect(s.missingCanonical).toEqual([]);
    expect(s.plans).toEqual([]);
    expect(s.ok).toBe(false);
  });

  it("excludes self repos from canonical-name collision detection", () => {
    // Two self repos sharing a basename do NOT collide (each owns its own AGENTS.md).
    const s = summarizeSymlinkPlan([
      repo({ path: "../x/blog", self: true, canonicalName: "blog", files: selfSpokes() }),
      repo({ path: "../y/blog", self: true, canonicalName: "blog", files: selfSpokes() }),
    ]);
    expect(s.collisions).toEqual([]);
    expect(s.ok).toBe(true);
  });

  it("a hub and a self repo coexist: the hub gets its links, the self gets only spokes", () => {
    const s = summarizeSymlinkPlan([
      repo({
        path: "../basou",
        canonicalName: "basou",
        files: wiredFiles({ "AGENTS.md": "missing" }),
      }),
      repo({
        path: "../blog",
        self: true,
        canonicalName: "blog",
        files: selfSpokes({ "CLAUDE.md": "missing" }),
      }),
    ]);
    expect(s.plans).toEqual([
      {
        path: "../basou",
        toCreate: [{ name: "AGENTS.md", target: "../anchor/agents/basou/AGENTS.md" }],
      },
      { path: "../blog", toCreate: [{ name: "CLAUDE.md", target: "AGENTS.md" }] },
    ]);
  });
});
