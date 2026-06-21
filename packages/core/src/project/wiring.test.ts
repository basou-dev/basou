import { describe, expect, it } from "vitest";
import { type RepoWiringFacts, summarizeWiring } from "./wiring.js";

/** Build the three instruction-file facts from a terse spec; default present, untracked. */
function files(
  spec?: Partial<
    Record<
      "AGENTS.md" | "CLAUDE.md" | ".github/copilot-instructions.md",
      { present?: boolean; tracked?: boolean }
    >
  >,
): RepoWiringFacts["instructionFiles"] {
  const names = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"] as const;
  return names.map((name) => ({
    name,
    present: spec?.[name]?.present ?? true,
    tracked: spec?.[name]?.tracked ?? false,
  }));
}

describe("summarizeWiring", () => {
  it("flags a tracked instruction file in a public repo as a privacy risk", () => {
    const s = summarizeWiring([
      {
        path: "../takuhon",
        visibility: "public",
        reachable: true,
        instructionFiles: files({ "AGENTS.md": { tracked: true } }),
      },
    ]);
    expect(s.ok).toBe(false);
    expect(s.risks).toEqual([{ repo: "../takuhon", visibility: "public", file: "AGENTS.md" }]);
  });

  it("treats future-public like public", () => {
    const s = summarizeWiring([
      {
        path: "../site",
        visibility: "future-public",
        reachable: true,
        instructionFiles: files({ "CLAUDE.md": { tracked: true } }),
      },
    ]);
    expect(s.risks).toEqual([{ repo: "../site", visibility: "future-public", file: "CLAUDE.md" }]);
  });

  it("does NOT flag a tracked instruction file in a private repo (the anchor's canonical)", () => {
    const s = summarizeWiring([
      {
        path: ".",
        visibility: "private",
        reachable: true,
        instructionFiles: files({ "AGENTS.md": { tracked: true } }),
      },
    ]);
    expect(s.ok).toBe(true);
    expect(s.risks).toHaveLength(0);
  });

  it("is ok when a public repo's instruction files are all present and untracked (gitignored symlinks)", () => {
    const s = summarizeWiring([
      { path: "../takuhon", visibility: "public", reachable: true, instructionFiles: files() },
    ]);
    expect(s.ok).toBe(true);
    expect(s.risks).toHaveLength(0);
    expect(s.incomplete).toHaveLength(0);
  });

  it("reports a repo with unset visibility as unknown (privacy cannot be judged)", () => {
    const s = summarizeWiring([
      {
        path: "../x",
        reachable: true,
        instructionFiles: files({ "AGENTS.md": { tracked: true } }),
      },
    ]);
    expect(s.ok).toBe(false);
    expect(s.unknown).toEqual(["../x"]);
    // a tracked file under unknown visibility is NOT counted as a risk (can't judge)
    expect(s.risks).toHaveLength(0);
  });

  it("reports missing instruction files as incomplete (a wiring gap, not a privacy risk)", () => {
    const s = summarizeWiring([
      {
        path: "../takuhon",
        visibility: "public",
        reachable: true,
        instructionFiles: files({
          "CLAUDE.md": { present: false },
          ".github/copilot-instructions.md": { present: false },
        }),
      },
    ]);
    expect(s.risks).toHaveLength(0);
    expect(s.incomplete).toEqual([
      { repo: "../takuhon", missing: ["CLAUDE.md", ".github/copilot-instructions.md"] },
    ]);
    // incomplete alone (no risk/unknown/unreachable) keeps ok true
    expect(s.ok).toBe(true);
  });

  it("reports an unreachable repo and is not ok", () => {
    const s = summarizeWiring([
      { path: "../gone", visibility: "public", reachable: false, instructionFiles: [] },
    ]);
    expect(s.ok).toBe(false);
    expect(s.unreachable).toEqual(["../gone"]);
  });

  it("collects multiple risks across repos and files", () => {
    const s = summarizeWiring([
      {
        path: "../a",
        visibility: "public",
        reachable: true,
        instructionFiles: files({ "AGENTS.md": { tracked: true }, "CLAUDE.md": { tracked: true } }),
      },
      {
        path: "../b",
        visibility: "private",
        reachable: true,
        instructionFiles: files({ "AGENTS.md": { tracked: true } }),
      },
    ]);
    expect(s.risks).toEqual([
      { repo: "../a", visibility: "public", file: "AGENTS.md" },
      { repo: "../a", visibility: "public", file: "CLAUDE.md" },
    ]);
  });

  it("is ok for an empty roster", () => {
    const s = summarizeWiring([]);
    expect(s.ok).toBe(true);
    expect(s.repos).toEqual([]);
  });
});
