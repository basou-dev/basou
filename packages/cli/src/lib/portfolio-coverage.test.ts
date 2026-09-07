import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { basouPaths, createManifest, ensureBasouDirectory, writeManifest } from "@basou/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CoverageResult,
  checkPortfolioCoverage,
  formatCoverageReport,
  unattributedTotal,
} from "./portfolio-coverage.js";
import type { WorkspaceEntry } from "./view-server.js";

let parent: string | undefined;

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), "basou-coverage-"));
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

/** A workspace whose manifest declares `sourceRoots` (relative to its root). */
async function initWorkspace(repoRoot: string, sourceRoots: string[]): Promise<void> {
  const paths = await ensureBasouDirectory(repoRoot);
  await writeManifest(paths, createManifest({ workspaceName: "ws", sourceRoots }));
}

/**
 * Write a Claude transcript that records `cwd`. Claude's per-project directory
 * name is derived from the project path (every non-alphanumeric char -> "-"),
 * but coverage attributes by the recorded cwd, so the directory name only has
 * to be distinct.
 */
async function claudeTranscript(
  projectsRoot: string,
  dirName: string,
  id: string,
  cwd: string | undefined,
): Promise<void> {
  const dir = join(projectsRoot, dirName);
  await mkdir(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "summary", summary: "no cwd on this record" }),
    ...(cwd !== undefined ? [JSON.stringify({ type: "user", cwd, message: {} })] : []),
  ];
  await writeFile(join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`, "utf8");
}

/** Write a Codex rollout whose `session_meta` payload records `cwd`. */
async function codexRollout(
  sessionsRoot: string,
  datePath: string,
  id: string,
  cwd: string | undefined,
): Promise<void> {
  const dir = join(sessionsRoot, datePath);
  await mkdir(dir, { recursive: true });
  const meta = { type: "session_meta", payload: { id, ...(cwd !== undefined ? { cwd } : {}) } };
  await writeFile(join(dir, `rollout-${id}.jsonl`), `${JSON.stringify(meta)}\n`, "utf8");
}

/** Run the check against empty adapter roots unless the test created them. */
async function run(
  workspaces: WorkspaceEntry[],
  claudeProjectsDir: string,
  codexSessionsDir: string,
): Promise<CoverageResult> {
  return checkPortfolioCoverage(workspaces, { claudeProjectsDir, codexSessionsDir });
}

describe("checkPortfolioCoverage", () => {
  it("attributes a log whose cwd equals a declared source root", async () => {
    const root = getParent();
    const ws = join(root, "ws");
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    await initWorkspace(ws, [".", "../repo"]);
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    await claudeTranscript(claude, "-repo", "t1", repo);
    await codexRollout(codex, "2026/09/07", "r1", ws);

    const result = await run([wsEntry(ws)], claude, codex);

    expect(result.logsScanned).toBe(2);
    expect(result.attributed).toBe(2);
    expect(result.groups).toEqual([]);
    expect(unattributedTotal(result)).toBe(0);
    expect(formatCoverageReport(result)[0]).toContain("Capture coverage: OK");
  });

  it("groups logs under no declared root by cwd, counting both adapters", async () => {
    const root = getParent();
    const ws = join(root, "ws");
    await initWorkspace(ws, ["."]);
    const stray = join(root, "stray");
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    await claudeTranscript(claude, "-stray", "t1", stray);
    await codexRollout(codex, "2026/09/07", "r1", stray);
    await codexRollout(codex, "2026/09/07", "r2", stray);

    const result = await run([wsEntry(ws)], claude, codex);

    expect(result.attributed).toBe(0);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      cwd: stray,
      logs: 3,
      sources: ["claude-code", "codex"],
      kind: "no_declared_root",
    });
    expect(result.groups[0]?.declaredRoot).toBeUndefined();
  });

  it("reports a cwd INSIDE a declared root separately (the exact-match guard drops it)", async () => {
    const root = getParent();
    const ws = join(root, "ws");
    const repo = join(root, "repo");
    const nested = join(repo, "packages", "core");
    await mkdir(nested, { recursive: true });
    await initWorkspace(ws, [".", "../repo"]);
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    await codexRollout(codex, "2026/09/07", "r1", nested);

    const result = await run([wsEntry(ws)], claude, codex);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      cwd: nested,
      kind: "below_declared_root",
      declaredRoot: repo,
    });
    const report = formatCoverageReport(result);
    expect(report.join("\n")).toContain("must EQUAL a source root");
  });

  it("does not treat a sibling path that merely shares a prefix as being inside a root", async () => {
    const root = getParent();
    const ws = join(root, "ws");
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    await initWorkspace(ws, [".", "../repo"]);
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    // `<root>/repo-site` starts with the string `<root>/repo` but is a sibling.
    await codexRollout(codex, "2026/09/07", "r1", `${repo}-site`);

    const result = await run([wsEntry(ws)], claude, codex);

    expect(result.groups[0]).toMatchObject({ kind: "no_declared_root" });
  });

  it("orders below_declared_root first, then by log count", async () => {
    const root = getParent();
    const ws = join(root, "ws");
    const repo = join(root, "repo");
    await mkdir(join(repo, "sub"), { recursive: true });
    await initWorkspace(ws, [".", "../repo"]);
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    await codexRollout(codex, "2026/09/07", "n1", join(repo, "sub"));
    for (const id of ["a1", "a2", "a3"]) {
      await codexRollout(codex, "2026/09/07", id, join(root, "elsewhere"));
    }

    const result = await run([wsEntry(ws)], claude, codex);

    expect(result.groups.map((g) => g.kind)).toEqual(["below_declared_root", "no_declared_root"]);
    expect(result.groups.map((g) => g.logs)).toEqual([1, 3]);
  });

  it("counts a log that records no cwd separately from an unattributed one", async () => {
    const root = getParent();
    const ws = join(root, "ws");
    await initWorkspace(ws, ["."]);
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    await claudeTranscript(claude, "-nocwd", "t1", undefined);
    await codexRollout(codex, "2026/09/07", "r1", undefined);

    const result = await run([wsEntry(ws)], claude, codex);

    expect(result.cwdMissing).toBe(2);
    expect(result.attributed).toBe(0);
    expect(result.groups).toEqual([]);
    const first = formatCoverageReport(result)[0];
    expect(first).toContain("Capture coverage: OK");
    expect(first).toContain("2 recorded no cwd");
  });

  it("ignores nested subagent transcripts, which the importer never reads", async () => {
    const root = getParent();
    const ws = join(root, "ws");
    await initWorkspace(ws, ["."]);
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    const nested = join(claude, "-ws", "session-1", "subagents");
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(nested, "agent-1.jsonl"),
      `${JSON.stringify({ cwd: join(root, "stray") })}\n`,
      "utf8",
    );
    await mkdir(codex, { recursive: true });

    const result = await run([wsEntry(ws)], claude, codex);

    expect(result.logsScanned).toBe(0);
    expect(result.groups).toEqual([]);
  });

  it("attributes across every registered workspace, not just the first", async () => {
    const root = getParent();
    const a = join(root, "a");
    const b = join(root, "b");
    await initWorkspace(a, ["."]);
    await initWorkspace(b, ["."]);
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    await codexRollout(codex, "2026/09/07", "r1", b);

    expect((await run([wsEntry(a, "a")], claude, codex)).groups).toHaveLength(1);
    expect((await run([wsEntry(a, "a"), wsEntry(b, "b")], claude, codex)).attributed).toBe(1);
  });

  it("falls back to the entry's own root when its manifest is missing", async () => {
    const root = getParent();
    const bare = join(root, "bare");
    await mkdir(bare, { recursive: true });
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    await codexRollout(codex, "2026/09/07", "r1", bare);

    const result = await run([wsEntry(bare, "bare")], claude, codex);

    expect(result.attributed).toBe(1);
    expect(result.groups).toEqual([]);
  });

  it("reports an absent adapter tree instead of failing", async () => {
    const root = getParent();
    const ws = join(root, "ws");
    await initWorkspace(ws, ["."]);
    const codex = join(root, "codex");
    await codexRollout(codex, "2026/09/07", "r1", ws);

    const result = await run([wsEntry(ws)], join(root, "no-such-claude"), codex);

    expect(result.absentTrees).toEqual([join(root, "no-such-claude")]);
    expect(result.logsScanned).toBe(1);
    expect(formatCoverageReport(result)[0]).toContain("not scanned:");
  });

  it("says there is nothing to check when both trees are absent", async () => {
    const root = getParent();
    const ws = join(root, "ws");
    await initWorkspace(ws, ["."]);

    const result = await run([wsEntry(ws)], join(root, "nc"), join(root, "nx"));

    expect(result.logsScanned).toBe(0);
    expect(formatCoverageReport(result)[0]).toContain("nothing to check");
  });
});

describe("formatCoverageReport", () => {
  it("caps the listed cwds and totals the remainder", () => {
    const groups = Array.from({ length: 13 }, (_, i) => ({
      cwd: `/p/${String(i).padStart(2, "0")}`,
      logs: 20 - i,
      sources: ["codex" as const],
      kind: "no_declared_root" as const,
    }));
    const result: CoverageResult = {
      logsScanned: 200,
      attributed: 0,
      groups,
      cwdMissing: 0,
      unreadable: 0,
      absentTrees: [],
    };

    const report = formatCoverageReport(result);
    const listed = report.filter((l) => l.includes(" /p/"));

    expect(listed).toHaveLength(10);
    // 13 groups of 20,19,...,8 logs; the 3 beyond the cap hold 10+9+8 = 27.
    expect(report.join("\n")).toContain("+3 more working directories (27 log(s))");
  });

  it("does not add the declared-root note when no group is below one", () => {
    const result: CoverageResult = {
      logsScanned: 10,
      attributed: 9,
      groups: [{ cwd: "/tmp", logs: 1, sources: ["codex"], kind: "no_declared_root" }],
      cwdMissing: 0,
      unreadable: 0,
      absentTrees: [],
    };

    expect(formatCoverageReport(result).join("\n")).not.toContain("must EQUAL a source root");
  });
});
