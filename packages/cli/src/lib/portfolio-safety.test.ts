import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { basouPaths, createManifest, ensureBasouDirectory, writeManifest } from "@basou/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPortfolioSafety, formatSafetyReport } from "./portfolio-safety.js";
import type { WorkspaceEntry } from "./view-server.js";

const execFileAsync = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };

let parent: string | undefined;

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), "basou-safety-"));
});

afterEach(async () => {
  if (parent !== undefined) await rm(parent, { recursive: true, force: true });
  parent = undefined;
});

function getParent(): string {
  if (parent === undefined) throw new Error("parent not initialized");
  return parent;
}

function wsEntry(repoRoot: string, label = "ws"): WorkspaceEntry {
  return {
    key: `k-${label}`,
    label,
    paths: basouPaths(repoRoot),
    repoRoot,
    importCtx: { cwd: repoRoot },
    initialized: true,
  };
}

/** Create a workspace `.basou/` whose manifest declares the given source roots. */
async function initWorkspace(repoRoot: string, sourceRoots: string[]): Promise<void> {
  const paths = await ensureBasouDirectory(repoRoot);
  await writeManifest(paths, createManifest({ workspaceName: "ws", sourceRoots }));
}

describe("checkPortfolioSafety", () => {
  it("passes when the monitored repo is clean (no .basou)", async () => {
    const ws = join(getParent(), "ws");
    await mkdir(join(getParent(), "mon"), { recursive: true });
    await initWorkspace(ws, [".", "../mon"]);

    const result = await checkPortfolioSafety([wsEntry(ws)]);
    expect(result.findings).toEqual([]);
    expect(result.monitoredReposChecked).toBe(1); // "." (self) is exempt; only ../mon counts
  });

  it("flags a monitored repo that already has a .basou footprint", async () => {
    const ws = join(getParent(), "ws");
    const mon = join(getParent(), "mon");
    await mkdir(join(mon, ".basou"), { recursive: true });
    await initWorkspace(ws, ["../mon"]);

    const result = await checkPortfolioSafety([wsEntry(ws)]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("footprint");
    expect(result.findings[0]?.monitoredRepo).toBe(mon);
  });

  it("flags a workspace nested inside a monitored repo (overlap)", async () => {
    const outer = join(getParent(), "outer");
    const inner = join(outer, "inner");
    await initWorkspace(inner, [".."]); // source root resolves to `outer`, which contains the workspace

    const result = await checkPortfolioSafety([wsEntry(inner)]);
    expect(result.findings.some((f) => f.kind === "overlap" && f.monitoredRepo === outer)).toBe(
      true,
    );
  });

  it("treats an uninitialized workspace as having no monitored repos", async () => {
    const ws = join(getParent(), "bare"); // no .basou
    const result = await checkPortfolioSafety([wsEntry(ws)]);
    expect(result.findings).toEqual([]);
    expect(result.monitoredReposChecked).toBe(0);
  });

  it("detects a tracked .basou nested in a subdirectory of the monitored repo", async () => {
    const ws = join(getParent(), "ws");
    const mon = join(getParent(), "mon");
    // mon is a git repo whose ONLY footprint is committed at sub/.basou/ (no top-level .basou).
    await mkdir(join(mon, "sub", ".basou"), { recursive: true });
    await writeFile(join(mon, "sub", ".basou", "manifest.yaml"), "schema_version: 0.1.0\n");
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], {
      cwd: mon,
      env: GIT_ENV,
    });
    await execFileAsync("git", ["config", "user.email", "t@e.com"], { cwd: mon, env: GIT_ENV });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: mon, env: GIT_ENV });
    await execFileAsync("git", ["add", "-A"], { cwd: mon, env: GIT_ENV });
    await execFileAsync("git", ["commit", "-m", "x"], { cwd: mon, env: GIT_ENV });
    await initWorkspace(ws, ["../mon"]);

    const result = await checkPortfolioSafety([wsEntry(ws)]);
    expect(result.findings.some((f) => f.kind === "footprint" && f.monitoredRepo === mon)).toBe(
      true,
    );
  });

  it("fails closed (unverifiable) when a workspace manifest is present but unreadable", async () => {
    const ws = join(getParent(), "ws");
    const paths = await ensureBasouDirectory(ws);
    await writeFile(paths.files.manifest, "::: not yaml :::\n");

    const result = await checkPortfolioSafety([wsEntry(ws)]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("unverifiable");
  });
});

describe("formatSafetyReport", () => {
  it("renders an OK line when there are no findings", () => {
    const lines = formatSafetyReport({
      findings: [],
      workspacesChecked: 2,
      monitoredReposChecked: 3,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Portfolio safety: OK");
  });

  it("renders a DANGER block listing each finding", () => {
    const lines = formatSafetyReport({
      findings: [
        {
          workspaceLabel: "alpha",
          workspaceRoot: "/p/alpha",
          monitoredRepo: "/p/mon",
          kind: "footprint",
          detail: "a .basou/ directory exists here",
        },
      ],
      workspacesChecked: 1,
      monitoredReposChecked: 1,
    });
    expect(lines[0]).toContain("DANGER");
    expect(lines.some((l) => l.includes("[footprint]") && l.includes("/p/mon"))).toBe(true);
  });
});
