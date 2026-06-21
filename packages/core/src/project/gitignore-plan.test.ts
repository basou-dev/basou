import { describe, expect, it } from "vitest";
import { planGitignore, type RepoGitignoreFacts } from "./gitignore-plan.js";

const REQUIRED = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"];

function repo(
  over: Partial<RepoGitignoreFacts> & Pick<RepoGitignoreFacts, "path">,
): RepoGitignoreFacts {
  return { reachable: true, currentLines: [], ...over };
}

describe("planGitignore", () => {
  it("plans the missing patterns for a public repo whose .gitignore lacks them", () => {
    const s = planGitignore({
      repos: [
        repo({
          path: "../takuhon",
          visibility: "public",
          currentLines: ["node_modules", "AGENTS.md"],
        }),
      ],
      required: REQUIRED,
    });
    expect(s.ok).toBe(false);
    expect(s.plans).toEqual([
      { path: "../takuhon", toAdd: ["CLAUDE.md", ".github/copilot-instructions.md"] },
    ]);
  });

  it("plans all patterns when a public repo has no .gitignore", () => {
    const s = planGitignore({
      repos: [repo({ path: "../x", visibility: "future-public", currentLines: [] })],
      required: REQUIRED,
    });
    expect(s.plans).toEqual([{ path: "../x", toAdd: REQUIRED }]);
  });

  it("is ok when a public repo already excludes every pattern (ignoring surrounding whitespace)", () => {
    const s = planGitignore({
      repos: [
        repo({
          path: "../x",
          visibility: "public",
          currentLines: ["  AGENTS.md  ", "CLAUDE.md", ".github/copilot-instructions.md", ""],
        }),
      ],
      required: REQUIRED,
    });
    expect(s.ok).toBe(true);
    expect(s.plans).toHaveLength(0);
  });

  it("treats an anchored-root form (/AGENTS.md) as already covering AGENTS.md", () => {
    const s = planGitignore({
      repos: [
        repo({
          path: "../x",
          visibility: "public",
          currentLines: ["/AGENTS.md", "CLAUDE.md", "/.github/copilot-instructions.md"],
        }),
      ],
      required: REQUIRED,
    });
    expect(s.ok).toBe(true);
    expect(s.plans).toHaveLength(0);
  });

  it("does NOT treat a comment or a directory-only form as covering the pattern", () => {
    const s = planGitignore({
      repos: [
        repo({
          path: "../x",
          visibility: "public",
          currentLines: ["# AGENTS.md", "CLAUDE.md/", ".github/copilot-instructions.md"],
        }),
      ],
      required: REQUIRED,
    });
    expect(s.plans).toEqual([{ path: "../x", toAdd: ["AGENTS.md", "CLAUDE.md"] }]);
  });

  it("leaves a private repo untouched (the anchor may track its canonical)", () => {
    const s = planGitignore({
      repos: [repo({ path: ".", visibility: "private", currentLines: [] })],
      required: REQUIRED,
    });
    expect(s.ok).toBe(true);
    expect(s.plans).toHaveLength(0);
  });

  it("reports unset visibility as unknown (never guesses) and is not ok", () => {
    const s = planGitignore({
      repos: [repo({ path: "../x", currentLines: [] })],
      required: REQUIRED,
    });
    expect(s.unknown).toEqual(["../x"]);
    expect(s.plans).toHaveLength(0);
    expect(s.ok).toBe(false);
  });

  it("reports an unreachable repo and is not ok", () => {
    const s = planGitignore({
      repos: [{ path: "../gone", visibility: "public", reachable: false, currentLines: [] }],
      required: REQUIRED,
    });
    expect(s.unreachable).toEqual(["../gone"]);
    expect(s.ok).toBe(false);
  });

  it("ok is false when nothing is planned but some repos were skipped (no false-clear)", () => {
    const s = planGitignore({
      repos: [
        repo({ path: "../ok", visibility: "public", currentLines: REQUIRED }),
        repo({ path: "../x", currentLines: [] }), // unset visibility
      ],
      required: REQUIRED,
    });
    expect(s.plans).toHaveLength(0);
    expect(s.unknown).toEqual(["../x"]);
    expect(s.ok).toBe(false);
  });

  it("is ok for an empty roster", () => {
    const s = planGitignore({ repos: [], required: REQUIRED });
    expect(s.ok).toBe(true);
  });
});
