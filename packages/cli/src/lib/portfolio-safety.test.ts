import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

/**
 * Create a workspace `.basou/` whose manifest declares the given source roots
 * (and, optionally, a `workspace.view` relative path).
 */
async function initWorkspace(
  repoRoot: string,
  sourceRoots: string[],
  view?: string,
): Promise<void> {
  const paths = await ensureBasouDirectory(repoRoot);
  const manifest = createManifest({ workspaceName: "ws", sourceRoots });
  if (view !== undefined) manifest.workspace.view = view;
  await writeManifest(paths, manifest);
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

  it("flags a master's workspace view registered alongside it (redundant)", async () => {
    const master = join(getParent(), "proj-planning");
    const view = join(getParent(), "proj-workspace");
    await mkdir(view, { recursive: true }); // the throwaway view dir (no .basou of its own)
    await initWorkspace(master, ["."], "../proj-workspace");

    const result = await checkPortfolioSafety([
      wsEntry(master, "proj"),
      wsEntry(view, "proj-view"),
    ]);
    const redundant = result.findings.filter((f) => f.kind === "redundant");
    expect(redundant).toHaveLength(1);
    expect(redundant[0]?.monitoredRepo).toBe(view); // the entry to remove is the view, not the master
    expect(redundant[0]?.detail).toContain('"proj"'); // points at the master entry
  });

  it("flags a member / source-root repo registered alongside its master (redundant)", async () => {
    const master = join(getParent(), "master");
    const member = join(getParent(), "member");
    await mkdir(member, { recursive: true }); // a monitored member repo (no .basou)
    await initWorkspace(master, [".", "../member"]);

    const result = await checkPortfolioSafety([
      wsEntry(master, "master"),
      wsEntry(member, "member"),
    ]);
    const redundant = result.findings.filter((f) => f.kind === "redundant");
    expect(redundant).toHaveLength(1);
    expect(redundant[0]?.monitoredRepo).toBe(member);
  });

  it("does not flag two genuinely distinct planning masters", async () => {
    const a = join(getParent(), "a");
    const b = join(getParent(), "b");
    await initWorkspace(a, ["."]);
    await initWorkspace(b, ["."]);

    const result = await checkPortfolioSafety([wsEntry(a, "a"), wsEntry(b, "b")]);
    expect(result.findings.some((f) => f.kind === "redundant")).toBe(false);
  });

  it("does not flag a source-root member that owns its own .basou store", async () => {
    // The load-bearing false-positive guard: a member repo that is BOTH a
    // source root of the master AND a planning master in its own right (owns a
    // `.basou/`) must never be flagged redundant — `isMaster` gives it its own
    // identity regardless of who lists it. (A footprint finding on the same
    // member is a separate, expected axis and is not asserted here.)
    const master = join(getParent(), "master");
    const member = join(getParent(), "member");
    await initWorkspace(member, ["."]); // member owns its own store
    await initWorkspace(master, [".", "../member"]); // ...and is a source root of master

    const result = await checkPortfolioSafety([
      wsEntry(master, "master"),
      wsEntry(member, "member"),
    ]);
    expect(result.findings.some((f) => f.kind === "redundant")).toBe(false);
  });

  it("flags a master registered twice under different symlink spellings (redundant)", async () => {
    const real = join(getParent(), "master");
    await initWorkspace(real, ["."]);
    const link = join(getParent(), "master-link");
    await symlink(real, link); // a second registry spelling that survives lexical de-dup

    const result = await checkPortfolioSafety([wsEntry(real, "real"), wsEntry(link, "link")]);
    const redundant = result.findings.filter((f) => f.kind === "redundant");
    expect(redundant).toHaveLength(1); // both realpath-collapse to one master identity
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
    // The monitored-repo advice appears; the redundant advice does not.
    expect(lines.some((l) => l.includes("must have no basou footprint"))).toBe(true);
    expect(lines.some((l) => l.includes("A redundant entry"))).toBe(false);
  });

  it("renders a WARNING (not DANGER) block for a redundant-only result", () => {
    const lines = formatSafetyReport({
      findings: [
        {
          workspaceLabel: "proj-view",
          workspaceRoot: "/p/proj-workspace",
          monitoredRepo: "/p/proj-workspace",
          kind: "redundant",
          detail: 'resolves to the same workspace as portfolio entry "proj"',
        },
      ],
      workspacesChecked: 2,
      monitoredReposChecked: 0,
    });
    expect(lines[0]).toContain("WARNING");
    expect(lines[0]).not.toContain("DANGER");
    expect(lines.some((l) => l.includes("[redundant]") && l.includes("/p/proj-workspace"))).toBe(
      true,
    );
    // The redundant advice appears; the monitored-repo footprint advice does not.
    expect(lines.some((l) => l.includes("A redundant entry"))).toBe(true);
    expect(lines.some((l) => l.includes("must have no basou footprint"))).toBe(false);
  });

  it("keeps DANGER and renders both advice blocks when footprint and redundant coexist", () => {
    const lines = formatSafetyReport({
      findings: [
        {
          workspaceLabel: "a",
          workspaceRoot: "/p/a",
          monitoredRepo: "/p/mon",
          kind: "footprint",
          detail: "a .basou/ entry exists here",
        },
        {
          workspaceLabel: "b-view",
          workspaceRoot: "/p/b-workspace",
          monitoredRepo: "/p/b-workspace",
          kind: "redundant",
          detail: 'resolves to the same workspace as portfolio entry "b"',
        },
      ],
      workspacesChecked: 2,
      monitoredReposChecked: 1,
    });
    // A write risk anywhere keeps the whole report at DANGER.
    expect(lines[0]).toContain("DANGER");
    // Both advice blocks render, one per finding class present.
    expect(lines.some((l) => l.includes("must have no basou footprint"))).toBe(true);
    expect(lines.some((l) => l.includes("A redundant entry"))).toBe(true);
  });
});
