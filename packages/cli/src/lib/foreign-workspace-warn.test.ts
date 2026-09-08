import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describeForeignWorkspaceLines,
  findForeignWorkspaceNames,
  positionForeignWorkspaceWarning,
  protocolForeignWorkspaceWarning,
} from "./foreign-workspace-warn.js";

let dir: string;
let configPath: string;
let selfPath: string;
let otherPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "basou-foreign-warn-test-"));
  selfPath = join(dir, "alpha-planning");
  otherPath = join(dir, "beta-planning");
  configPath = join(dir, "portfolio.yaml");
  await writeFile(
    configPath,
    `workspaces:\n  - path: ${selfPath}\n    label: alpha\n  - path: ${otherPath}\n    label: beta\n`,
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("findForeignWorkspaceNames", () => {
  it("returns null when the registry does not exist", async () => {
    const report = await findForeignWorkspaceNames({
      text: "beta-planning is mentioned here",
      selfPath,
      configPath: join(dir, "absent.yaml"),
    });
    expect(report).toBeNull();
  });

  it("returns null when the registry is malformed", async () => {
    const broken = join(dir, "broken.yaml");
    await writeFile(broken, "workspaces: not-a-list\n");
    const report = await findForeignWorkspaceNames({
      text: "beta-planning is mentioned here",
      selfPath,
      configPath: broken,
    });
    expect(report).toBeNull();
  });

  it("returns null when only the scanning workspace is named", async () => {
    const report = await findForeignWorkspaceNames({
      text: `position of ${selfPath}\nalpha-workspace is its view`,
      selfPath,
      configPath,
    });
    expect(report).toBeNull();
  });

  it("reports the count and the lines when another workspace is named", async () => {
    const report = await findForeignWorkspaceNames({
      text: ["# Position", "nothing here", "- open track: beta-planning has no store"].join("\n"),
      selfPath,
      configPath,
    });
    expect(report).toEqual({ workspaceCount: 1, lines: [3] });
  });

  it("counts the scanning workspace too when no self is given", async () => {
    const report = await findForeignWorkspaceNames({
      text: "alpha-planning and beta-planning",
      configPath,
    });
    expect(report).toEqual({ workspaceCount: 2, lines: [1] });
  });
});

describe("describeForeignWorkspaceLines", () => {
  it("lists the lines it has, with the noun agreeing", () => {
    expect(describeForeignWorkspaceLines([3])).toBe("line 3");
    expect(describeForeignWorkspaceLines([3, 7])).toBe("lines 3, 7");
  });

  it("summarizes the tail past the listing cap", () => {
    expect(describeForeignWorkspaceLines([1, 2, 3, 4, 5, 6, 7])).toBe(
      "lines 1, 2, 3, 4, 5 and 2 more",
    );
  });
});

describe("the warning text", () => {
  // The point of reporting line numbers rather than matches: the warning is
  // printed by a command whose whole subject is a name that should not travel,
  // so the warning must not carry that name itself.
  const report = { workspaceCount: 1, lines: [14] };

  it("names no workspace and quotes no match", () => {
    const position = positionForeignWorkspaceWarning(report, ".basou/orientation.md");
    const protocol = protocolForeignWorkspaceWarning(report);
    for (const line of [position, protocol]) {
      expect(line).not.toContain("alpha");
      expect(line).not.toContain("beta");
      expect(line).toContain("14");
    }
  });

  it("says it withheld nothing", () => {
    expect(positionForeignWorkspaceWarning(report, ".basou/orientation.md")).toContain(
      "nothing was withheld",
    );
    expect(protocolForeignWorkspaceWarning(report)).toContain("nothing was withheld");
  });

  it("pluralizes on the workspace count", () => {
    expect(positionForeignWorkspaceWarning({ workspaceCount: 2, lines: [1] }, "f.md")).toContain(
      "2 other registered workspaces",
    );
  });
});
