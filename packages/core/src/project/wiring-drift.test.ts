import { describe, expect, it } from "vitest";

import type { RepoSymlinkFacts } from "./symlinks.js";
import { summarizeWiringDrift, type ViewWiringFacts } from "./wiring-drift.js";

/** A fully-wired hub repo: canonical present, every spoke `correct`. */
function wiredHub(path: string, canonicalName = path.replace(/.*\//, "")): RepoSymlinkFacts {
  return {
    path,
    isAnchor: false,
    reachable: true,
    canonicalPresent: true,
    canonicalName,
    files: [
      { name: "AGENTS.md", expectedTarget: `../../${canonicalName}/agents`, state: "correct" },
      { name: "CLAUDE.md", expectedTarget: "AGENTS.md", state: "correct" },
      { name: ".github/copilot-instructions.md", expectedTarget: "../AGENTS.md", state: "correct" },
    ],
  };
}

const NO_VIEW: ViewWiringFacts = { kind: "no-view" };

describe("summarizeWiringDrift", () => {
  it("reports no drift when every repo is wired and there is no view", () => {
    const summary = summarizeWiringDrift({
      repos: [wiredHub("../app"), wiredHub("../site")],
      view: NO_VIEW,
    });
    expect(summary.ok).toBe(true);
    expect(summary.missingCanonicals).toEqual([]);
    expect(summary.incompleteWiring).toEqual([]);
    expect(summary.conflicts).toEqual([]);
    expect(summary.collisions).toEqual([]);
    expect(summary.unreachable).toEqual([]);
  });

  it("surfaces a hub repo's absent anchor canonical as a repo-hub missing canonical", () => {
    const summary = summarizeWiringDrift({
      repos: [
        { path: "../app", isAnchor: false, reachable: true, canonicalPresent: false, files: [] },
      ],
      view: NO_VIEW,
    });
    expect(summary.ok).toBe(false);
    expect(summary.missingCanonicals).toEqual([{ target: "repo-hub", name: "../app" }]);
  });

  it("surfaces a self repo's absent own AGENTS.md as a repo-self missing canonical", () => {
    const summary = summarizeWiringDrift({
      repos: [
        {
          path: "../app",
          isAnchor: false,
          self: true,
          reachable: true,
          canonicalPresent: false,
          files: [],
        },
      ],
      view: NO_VIEW,
    });
    expect(summary.ok).toBe(false);
    expect(summary.missingCanonicals).toEqual([{ target: "repo-self", name: "../app" }]);
  });

  it("surfaces the view's absent canonical as a view missing canonical (the my-favorites case)", () => {
    const summary = summarizeWiringDrift({
      repos: [wiredHub("../app")],
      view: { kind: "missing-canonical", viewName: "my-favorites" },
    });
    expect(summary.ok).toBe(false);
    expect(summary.missingCanonicals).toEqual([{ target: "view", name: "my-favorites" }]);
  });

  it("reports a view↔repo canonical-name collision with view: true", () => {
    const summary = summarizeWiringDrift({
      repos: [wiredHub("../app")],
      view: { kind: "collision", viewName: "app", repoPath: "../app" },
    });
    expect(summary.ok).toBe(false);
    expect(summary.collisions).toEqual([{ canonicalName: "app", repos: ["../app"], view: true }]);
  });

  it("reports a repo's missing spokes as incomplete wiring (canonical present)", () => {
    const summary = summarizeWiringDrift({
      repos: [
        {
          path: "../app",
          isAnchor: false,
          reachable: true,
          canonicalPresent: true,
          canonicalName: "app",
          files: [
            { name: "AGENTS.md", expectedTarget: "../../app/agents", state: "correct" },
            { name: "CLAUDE.md", expectedTarget: "AGENTS.md", state: "missing" },
            {
              name: ".github/copilot-instructions.md",
              expectedTarget: "../AGENTS.md",
              state: "missing",
            },
          ],
        },
      ],
      view: NO_VIEW,
    });
    expect(summary.ok).toBe(false);
    expect(summary.incompleteWiring).toEqual([
      { target: "repo", path: "../app", files: ["CLAUDE.md", ".github/copilot-instructions.md"] },
    ]);
    expect(summary.missingCanonicals).toEqual([]);
  });

  it("reports a repo link pointing elsewhere as a mismatch conflict, carrying actualTarget", () => {
    const summary = summarizeWiringDrift({
      repos: [
        {
          path: "../app",
          isAnchor: false,
          reachable: true,
          canonicalPresent: true,
          canonicalName: "app",
          files: [
            {
              name: "AGENTS.md",
              expectedTarget: "../../app/agents",
              state: "mismatch",
              actualTarget: "somewhere/else",
            },
          ],
        },
      ],
      view: NO_VIEW,
    });
    expect(summary.ok).toBe(false);
    expect(summary.conflicts).toEqual([
      {
        target: "repo",
        path: "../app",
        file: "AGENTS.md",
        reason: "mismatch",
        actualTarget: "somewhere/else",
      },
    ]);
  });

  it("folds view spoke drift in: missing spokes as incomplete wiring, occupied as a conflict", () => {
    const summary = summarizeWiringDrift({
      repos: [wiredHub("../app")],
      view: {
        kind: "gathered",
        viewName: "workspace",
        files: [
          { name: "AGENTS.md", expectedTarget: "agents/workspace/AGENTS.md", state: "correct" },
          { name: "CLAUDE.md", expectedTarget: "AGENTS.md", state: "missing" },
          {
            name: ".github/copilot-instructions.md",
            expectedTarget: "../AGENTS.md",
            state: "occupied",
          },
        ],
      },
    });
    expect(summary.ok).toBe(false);
    expect(summary.incompleteWiring).toEqual([
      { target: "view", path: "workspace", files: ["CLAUDE.md"] },
    ]);
    expect(summary.conflicts).toEqual([
      {
        target: "view",
        path: "workspace",
        file: ".github/copilot-instructions.md",
        reason: "occupied",
      },
    ]);
  });

  it("treats an unreachable repo as advisory: reported, but ok stays true (partial checkout)", () => {
    const summary = summarizeWiringDrift({
      repos: [
        wiredHub("../app"),
        { path: "../gone", isAnchor: false, reachable: false, canonicalPresent: false, files: [] },
      ],
      view: NO_VIEW,
    });
    // A declared repo not cloned on this machine must not fail the check.
    expect(summary.unreachable).toEqual(["../gone"]);
    expect(summary.ok).toBe(true);
  });

  it("still denies ok when actionable drift accompanies an unreachable repo", () => {
    const summary = summarizeWiringDrift({
      repos: [
        { path: "../app", isAnchor: false, reachable: true, canonicalPresent: false, files: [] },
        { path: "../gone", isAnchor: false, reachable: false, canonicalPresent: false, files: [] },
      ],
      view: NO_VIEW,
    });
    expect(summary.unreachable).toEqual(["../gone"]);
    expect(summary.missingCanonicals).toEqual([{ target: "repo-hub", name: "../app" }]);
    // The missing canonical is actionable → ok is false regardless of the advisory unreachable.
    expect(summary.ok).toBe(false);
  });

  it("covers the anchor: an un-seeded anchor is left alone, a broken anchor spoke is a conflict", () => {
    // Un-seeded anchor (own AGENTS.md absent) → summarizeSymlinkPlan skips it, so no drift.
    const clean = summarizeWiringDrift({
      repos: [
        { path: ".", isAnchor: true, reachable: true, canonicalPresent: false, files: [] },
        wiredHub("../app"),
      ],
      view: NO_VIEW,
    });
    expect(clean.ok).toBe(true);
    expect(clean.missingCanonicals).toEqual([]);

    // Seeded anchor whose spoke points elsewhere → a mismatch conflict is surfaced.
    const drift = summarizeWiringDrift({
      repos: [
        {
          path: ".",
          isAnchor: true,
          reachable: true,
          canonicalPresent: true,
          files: [
            {
              name: "CLAUDE.md",
              expectedTarget: "AGENTS.md",
              state: "mismatch",
              actualTarget: "elsewhere",
            },
          ],
        },
      ],
      view: NO_VIEW,
    });
    expect(drift.ok).toBe(false);
    expect(drift.conflicts).toEqual([
      {
        target: "repo",
        path: ".",
        file: "CLAUDE.md",
        reason: "mismatch",
        actualTarget: "elsewhere",
      },
    ]);
  });

  it("stays clean when the view is gathered and every spoke is correct", () => {
    const summary = summarizeWiringDrift({
      repos: [wiredHub("../app")],
      view: {
        kind: "gathered",
        viewName: "workspace",
        files: [
          { name: "AGENTS.md", expectedTarget: "agents/workspace/AGENTS.md", state: "correct" },
          { name: "CLAUDE.md", expectedTarget: "AGENTS.md", state: "correct" },
          {
            name: ".github/copilot-instructions.md",
            expectedTarget: "../AGENTS.md",
            state: "correct",
          },
        ],
      },
    });
    expect(summary.ok).toBe(true);
  });
});
