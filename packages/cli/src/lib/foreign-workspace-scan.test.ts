import { describe, expect, it } from "vitest";
import { scanForeignWorkspaceNames } from "./foreign-workspace-scan.js";

// A synthetic registry standing in for ~/.basou/portfolio.yaml. `alpha` is the
// workspace doing the scanning; `beta` and `gamma` are the foreign ones.
const HOME = "/home/tester";
const ALPHA = `${HOME}/projects/alpha-planning`;
const BETA = `${HOME}/projects/beta-planning`;
const GAMMA = `${HOME}/work/gamma-planning`;
const REGISTRY = [ALPHA, BETA, GAMMA];

function scan(text: string, selfPath: string | undefined = ALPHA) {
  return scanForeignWorkspaceNames({
    text,
    workspacePaths: REGISTRY,
    selfPath,
    homedir: HOME,
  });
}

describe("scanForeignWorkspaceNames", () => {
  it("reports nothing for a text that only names the scanning workspace", () => {
    const text = [
      "# Orientation",
      `- last session: ${ALPHA}/docs/plan.md`,
      "- alpha-planning is the master; alpha-workspace is its view",
      "- ~/projects/alpha-planning/AGENTS.md",
    ].join("\n");
    expect(scan(text)).toEqual([]);
  });

  it("reports a foreign workspace named by its directory name, with line numbers", () => {
    const text = ["# Orientation", "line two", "- open track: beta-planning has no .basou"].join(
      "\n",
    );
    const hits = scan(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.workspacePath).toBe(BETA);
    expect(hits[0]?.lines).toEqual([3]);
    expect(hits[0]?.tokens).toContain("beta-planning");
  });

  // The leak observed in practice: a recorded scratchpad path whose directory
  // name ENCODES a session's cwd, carrying the VIEW spelling of a workspace the
  // registry knows only by its MASTER spelling.
  it("finds a workspace name encoded inside a scratchpad path", () => {
    const text = `- /private/tmp/claude-501/-home-tester-projects-beta-workspace/scratchpad/notes.md`;
    const hits = scan(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.workspacePath).toBe(BETA);
    expect(hits[0]?.tokens).toContain("beta-workspace");
  });

  it("finds a foreign workspace by absolute and tilde path alike", () => {
    const hits = scan([`- ${GAMMA}/notes.md`, "- ~/work/gamma-planning/other.md"].join("\n"));
    expect(hits).toHaveLength(1);
    expect(hits[0]?.workspacePath).toBe(GAMMA);
    expect(hits[0]?.lines).toEqual([1, 2]);
  });

  // The false-positive guard this whole design turns on: a product name (what
  // the portfolio shows as a label) appears throughout its own documents, and
  // matching on it would warn on every run until the warning is ignored.
  it("does not match on a product name alone", () => {
    const text = [
      "beta is the product this milestone ships",
      "gamma remains unscheduled",
      "the alpha CLI reads beta's output",
    ].join("\n");
    expect(scan(text)).toEqual([]);
  });

  // The self's view spelling must be excluded even when a registry entry is
  // written that way: without the paired spelling the view name would not be
  // recognized as the self's and every line naming it would report.
  it("excludes every spelling of the scanning workspace, including its view", () => {
    const text = [
      `- ${ALPHA}/x.md`,
      "- ~/projects/alpha-planning/y.md",
      "- /private/tmp/claude-501/-home-tester-projects-alpha-workspace/scratchpad/z.md",
    ].join("\n");
    const hits = scanForeignWorkspaceNames({
      text,
      workspacePaths: [`${HOME}/projects/alpha-workspace`],
      selfPath: ALPHA,
      homedir: HOME,
    });
    expect(hits).toEqual([]);
  });

  it("reports several foreign workspaces in registry order", () => {
    const text = ["- gamma-planning", "- beta-workspace"].join("\n");
    const hits = scan(text);
    expect(hits.map((h) => h.workspacePath)).toEqual([BETA, GAMMA]);
  });

  it("counts every registered workspace as foreign when no self is given", () => {
    const text = "- alpha-planning and beta-planning both appear here";
    const hits = scanForeignWorkspaceNames({
      text,
      workspacePaths: REGISTRY,
      homedir: HOME,
    });
    expect(hits.map((h) => h.workspacePath)).toEqual([ALPHA, BETA]);
  });

  it("ignores a directory name too short to attribute", () => {
    const hits = scanForeignWorkspaceNames({
      text: "the ai directory holds the prompts",
      workspacePaths: [`${HOME}/ai`],
      selfPath: ALPHA,
      homedir: HOME,
    });
    expect(hits).toEqual([]);
  });

  it("still matches a short-named workspace by its full path", () => {
    const hits = scanForeignWorkspaceNames({
      text: `see ${HOME}/ai/prompt.md and ~/ai/other.md`,
      workspacePaths: [`${HOME}/ai`],
      selfPath: ALPHA,
      homedir: HOME,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.tokens).toEqual([`${HOME}/ai`, "~/ai"]);
  });

  // The encoding an agent tool uses for a per-project directory replaces EVERY
  // non-alphanumeric character, so a workspace name carrying `_` or `.` reaches
  // a recorded path under a spelling its own name does not contain.
  it("finds a workspace whose name reaches a path in its encoded spelling", () => {
    const hits = scanForeignWorkspaceNames({
      text: "- /private/tmp/claude-501/-home-tester-projects-delta-two-workspace/s/n.md",
      workspacePaths: [`${HOME}/projects/delta_two-planning`],
      selfPath: ALPHA,
      homedir: HOME,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.tokens).toContain("delta-two-workspace");
  });

  it("gives a solo repo the view spelling the convention would create", () => {
    const hits = scanForeignWorkspaceNames({
      text: "- /private/tmp/claude-501/-home-tester-projects-omicron-workspace/s/n.md",
      workspacePaths: [`${HOME}/projects/omicron`],
      selfPath: ALPHA,
      homedir: HOME,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.tokens).toContain("omicron-workspace");
  });

  // A registered name nested inside the self's own cannot be told apart from
  // the self on a line that names the self, and warning on every such line is
  // the failure this whole design is built to avoid.
  it("does not report a registered name nested inside the scanning workspace's own", () => {
    const self = `${HOME}/projects/atlas-planning`;
    const hits = scanForeignWorkspaceNames({
      text: [`- ${self}/x.md`, "- atlas-planning is this workspace"].join("\n"),
      workspacePaths: [`${HOME}/projects/atlas`],
      selfPath: self,
      homedir: HOME,
    });
    expect(hits).toEqual([]);
  });

  it("does not report a registered directory name that is a substring of the self's", () => {
    const self = `${HOME}/projects/nimart-planning`;
    const hits = scanForeignWorkspaceNames({
      text: [`- ${self}/x.md`, "- nimart-planning again"].join("\n"),
      workspacePaths: [`${HOME}/work/art-planning`],
      selfPath: self,
      homedir: HOME,
    });
    expect(hits).toEqual([]);
  });

  it("ignores a trailing separator on the scanning workspace's path", () => {
    const hits = scanForeignWorkspaceNames({
      text: `- ${ALPHA}/x.md`,
      workspacePaths: [ALPHA],
      selfPath: `${ALPHA}/`,
      homedir: HOME,
    });
    expect(hits).toEqual([]);
  });

  it("returns nothing for empty input", () => {
    expect(scan("")).toEqual([]);
    expect(scanForeignWorkspaceNames({ text: "beta-planning", workspacePaths: [] })).toEqual([]);
  });
});
