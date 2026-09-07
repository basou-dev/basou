import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { basouPaths, createManifest, ensureBasouDirectory, writeManifest } from "@basou/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeProjectDir } from "../commands/import.js";
import {
  type CoverageResult,
  checkPortfolioCoverage,
  formatCoverageReport,
  uncapturedTotal,
} from "./portfolio-coverage.js";
import type { WorkspaceEntry } from "./view-server.js";

const execFileAsync = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };

let parent: string | undefined;

beforeEach(async () => {
  // realpath, because coverage derives a workspace's roots from `git
  // rev-parse --show-toplevel` exactly as `basou import` does, and on macOS the
  // tmpdir spelling is a symlink to /private/var. A fixture using the symlinked
  // spelling would be a fixture where import genuinely does not attribute.
  parent = await realpath(await mkdtemp(join(tmpdir(), "basou-coverage-")));
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
 * A workspace `basou import` can actually run in: a git repo with a readable
 * `.basou/` declaring `sourceRoots`. Coverage derives declared roots exactly as
 * import does — git toplevel plus an initialized store — so a fixture that
 * skips either would not be attributed.
 */
async function initWorkspace(repoRoot: string, sourceRoots: string[]): Promise<void> {
  await mkdir(repoRoot, { recursive: true });
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], {
    cwd: repoRoot,
    env: GIT_ENV,
  });
  const paths = await ensureBasouDirectory(repoRoot);
  await writeManifest(paths, createManifest({ workspaceName: "ws", sourceRoots }));
}

/**
 * Write a Claude transcript recording `cwd`, in the per-project directory the
 * real Claude Code would use for `dirFor` (default: the recorded cwd). Passing
 * a different `dirFor` builds the case where the cwd is declared but the file
 * sits in a directory the importer never lists.
 */
async function claudeTranscript(
  projectsRoot: string,
  id: string,
  cwd: string | undefined,
  dirFor?: string,
): Promise<void> {
  const dir = join(projectsRoot, encodeProjectDir(dirFor ?? cwd ?? "unknown"));
  await mkdir(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "summary", summary: "no cwd on this record" }),
    ...(cwd !== undefined ? [JSON.stringify({ type: "user", cwd, message: {} })] : []),
  ];
  await writeFile(join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`, "utf8");
}

/** Write a Codex rollout whose first record is a usable `session_meta`. */
async function codexRollout(
  sessionsRoot: string,
  id: string,
  cwd: string | undefined,
): Promise<void> {
  const dir = join(sessionsRoot, "2026", "09", "07");
  await mkdir(dir, { recursive: true });
  const meta = { type: "session_meta", payload: { id, ...(cwd !== undefined ? { cwd } : {}) } };
  await writeFile(join(dir, `rollout-${id}.jsonl`), `${JSON.stringify(meta)}\n`, "utf8");
}

/** Write a rollout whose records the Codex import guard rejects. */
async function codexRolloutRaw(sessionsRoot: string, id: string, lines: string[]): Promise<void> {
  const dir = join(sessionsRoot, "2026", "09", "07");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `rollout-${id}.jsonl`), `${lines.join("\n")}\n`, "utf8");
}

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
    await claudeTranscript(claude, "t1", repo);
    await codexRollout(codex, "r1", ws);

    const result = await run([wsEntry(ws)], claude, codex);

    expect(result.logsScanned).toBe(2);
    expect(result.attributed).toBe(2);
    expect(result.groups).toEqual([]);
    expect(uncapturedTotal(result)).toBe(0);
    expect(formatCoverageReport(result)[0]).toContain("Capture coverage: OK");
  });

  it("groups logs under no declared root by cwd, counting both adapters", async () => {
    const root = getParent();
    const ws = join(root, "ws");
    await initWorkspace(ws, ["."]);
    const stray = join(root, "stray");
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    await claudeTranscript(claude, "t1", stray);
    await codexRollout(codex, "r1", stray);
    await codexRollout(codex, "r2", stray);

    const result = await run([wsEntry(ws)], claude, codex);

    expect(result.attributed).toBe(0);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      cwd: stray,
      logs: 3,
      sources: ["claude-code", "codex"],
      kind: "no_declared_root",
    });
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
    await codexRollout(codex, "r1", nested);

    const result = await run([wsEntry(ws)], claude, codex);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      cwd: nested,
      kind: "below_declared_root",
      declaredRoot: repo,
    });
    const report = formatCoverageReport(result).join("\n");
    // F7: declaring the subdirectory itself DOES capture it, so the advice must
    // not tell the owner the case is unfixable.
    expect(report).toContain("Declaring that subdirectory itself");
    expect(report).not.toContain("report it rather than working around it");
  });

  it("does not treat a sibling path that merely shares a prefix as being inside a root", async () => {
    const root = getParent();
    const ws = join(root, "ws");
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    await initWorkspace(ws, [".", "../repo"]);
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    await codexRollout(codex, "r1", `${repo}-site`);

    const result = await run([wsEntry(ws)], claude, codex);

    expect(result.groups[0]).toMatchObject({ kind: "no_declared_root" });
  });

  it("does not attribute a transcript whose cwd is declared but whose directory import never lists", async () => {
    const root = getParent();
    const ws = join(root, "ws");
    await initWorkspace(ws, ["."]);
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    // cwd IS the declared root, but the file sits in another project's dir.
    await claudeTranscript(claude, "t1", ws, join(root, "unrelated"));

    const result = await run([wsEntry(ws)], claude, codex);

    expect(result.attributed).toBe(0);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ cwd: ws, kind: "dir_not_listed" });
    expect(formatCoverageReport(result).join("\n")).toContain("is never listed by the importer");
  });

  it("orders the declared-root kinds first, then by log count", async () => {
    const root = getParent();
    const ws = join(root, "ws");
    const repo = join(root, "repo");
    await mkdir(join(repo, "sub"), { recursive: true });
    await initWorkspace(ws, [".", "../repo"]);
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    await claudeTranscript(claude, "t1", ws, join(root, "unrelated"));
    await codexRollout(codex, "n1", join(repo, "sub"));
    for (const id of ["a1", "a2", "a3"]) {
      await codexRollout(codex, id, join(root, "elsewhere"));
    }

    const result = await run([wsEntry(ws)], claude, codex);

    expect(result.groups.map((g) => g.kind)).toEqual([
      "dir_not_listed",
      "below_declared_root",
      "no_declared_root",
    ]);
    expect(result.groups.map((g) => g.logs)).toEqual([1, 1, 3]);
  });

  it("applies the Codex import guard: a cwd outside a usable first-line session_meta is not attributed", async () => {
    const root = getParent();
    const ws = join(root, "ws");
    await initWorkspace(ws, ["."]);
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    // Each of these carries the declared root as a cwd somewhere, yet the Codex
    // importer treats none of them as a candidate.
    await codexRolloutRaw(codex, "notmeta", [
      JSON.stringify({ type: "turn_context", payload: { cwd: ws } }),
    ]);
    await codexRolloutRaw(codex, "badfirst", [
      "{ not json",
      JSON.stringify({ type: "session_meta", payload: { id: "badfirst", cwd: ws } }),
    ]);
    await codexRolloutRaw(codex, "noid", [
      JSON.stringify({ type: "session_meta", payload: { cwd: ws } }),
    ]);

    const result = await run([wsEntry(ws)], claude, codex);

    expect(result.logsScanned).toBe(3);
    expect(result.attributed).toBe(0);
    expect(result.groups).toEqual([]);
    expect(result.unplaceable).toBe(3);
    expect(uncapturedTotal(result)).toBe(3);
  });

  it("counts a log with no usable cwd as uncaptured, never as OK", async () => {
    const root = getParent();
    const ws = join(root, "ws");
    await initWorkspace(ws, ["."]);
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    await claudeTranscript(claude, "t1", undefined, ws);
    await codexRollout(codex, "r1", undefined);

    const result = await run([wsEntry(ws)], claude, codex);

    expect(result.unplaceable).toBe(2);
    expect(result.attributed).toBe(0);
    expect(uncapturedTotal(result)).toBe(2);
    const report = formatCoverageReport(result).join("\n");
    // F6: both importers DROP a log with no usable cwd, so calling this "OK,
    // all imported" reported uncaptured logs as captured.
    expect(report).not.toContain("Capture coverage: OK");
    expect(report).toContain("2 of 2 source log(s) (100%)");
    expect(report).toContain("no directory to name");
  });

  it("scans a symlinked per-project directory, which the importer reads through", async () => {
    const root = getParent();
    const ws = join(root, "ws");
    await initWorkspace(ws, ["."]);
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    await mkdir(claude, { recursive: true });
    await mkdir(codex, { recursive: true });
    const real = join(root, "elsewhere");
    await mkdir(real, { recursive: true });
    await writeFile(join(real, "t1.jsonl"), `${JSON.stringify({ cwd: ws })}\n`, "utf8");
    await symlink(real, join(claude, encodeProjectDir(ws)));

    const result = await run([wsEntry(ws)], claude, codex);

    // F8: judging the entry by isDirectory() alone dropped it from the scan
    // entirely — it landed in no counter and the denominator was wrong.
    expect(result.logsScanned).toBe(1);
    expect(result.attributed).toBe(1);
  });

  it("attributes across every registered workspace, not just the first", async () => {
    const root = getParent();
    const a = join(root, "a");
    const b = join(root, "b");
    await initWorkspace(a, ["."]);
    await initWorkspace(b, ["."]);
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    await codexRollout(codex, "r1", b);

    expect((await run([wsEntry(a, "a")], claude, codex)).groups).toHaveLength(1);
    expect((await run([wsEntry(a, "a"), wsEntry(b, "b")], claude, codex)).attributed).toBe(1);
  });

  it("declares nothing for a registered entry import cannot run in", async () => {
    const root = getParent();
    const bare = join(root, "bare"); // registered, but no git repo and no .basou
    await mkdir(bare, { recursive: true });
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    await codexRollout(codex, "r1", bare);

    const result = await run([wsEntry(bare, "bare")], claude, codex);

    // F2: counting the entry's own root as declared let registering a path move
    // the number while capturing nothing (`basou import` asserts a git repo and
    // an initialized store before reading a log).
    expect(result.attributed).toBe(0);
    expect(result.groups).toHaveLength(1);
    expect(result.inertWorkspaces).toEqual([{ path: bare, reason: "not_a_git_repo" }]);
    expect(formatCoverageReport(result).join("\n")).toContain("not a git repository");
  });

  it("reports a git repo with no .basou store as inert, not as a declared root", async () => {
    const root = getParent();
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], {
      cwd: repo,
      env: GIT_ENV,
    });
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    await codexRollout(codex, "r1", repo);

    const result = await run([wsEntry(repo, "repo")], claude, codex);

    expect(result.attributed).toBe(0);
    expect(result.inertWorkspaces).toEqual([{ path: repo, reason: "no_store" }]);
  });

  it("says registering in portfolio.yaml alone imports nothing", async () => {
    const root = getParent();
    const ws = join(root, "ws");
    await initWorkspace(ws, ["."]);
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    await codexRollout(codex, "r1", join(root, "stray"));

    const report = formatCoverageReport(await run([wsEntry(ws)], claude, codex)).join("\n");

    // F2/F3: the old remedy named portfolio.yaml as a way to start capturing.
    expect(report).toContain("import.source_roots to start capturing it");
    expect(report).toContain("portfolio.yaml alone imports nothing");
  });

  it("reports an absent adapter tree instead of failing", async () => {
    const root = getParent();
    const ws = join(root, "ws");
    await initWorkspace(ws, ["."]);
    const codex = join(root, "codex");
    await codexRollout(codex, "r1", ws);

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

  it("keeps logsScanned equal to its parts", async () => {
    const root = getParent();
    const ws = join(root, "ws");
    await initWorkspace(ws, ["."]);
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    await claudeTranscript(claude, "t1", ws);
    await claudeTranscript(claude, "t2", undefined, ws);
    await codexRollout(codex, "r1", join(root, "stray"));

    const r = await run([wsEntry(ws)], claude, codex);
    const grouped = r.groups.reduce((sum, g) => sum + g.logs, 0);

    expect(r.logsScanned).toBe(r.attributed + grouped + r.unplaceable + r.unreadable);
    expect(r.logsScanned).toBe(3);
  });
});

describe("formatCoverageReport", () => {
  function resultWith(groups: CoverageResult["groups"], over: Partial<CoverageResult> = {}) {
    return {
      logsScanned: 200,
      attributed: 0,
      groups,
      unplaceable: 0,
      unreadable: 0,
      absentTrees: [],
      inertWorkspaces: [],
      ...over,
    } satisfies CoverageResult;
  }

  it("caps the listed cwds and totals the remainder", () => {
    const groups = Array.from({ length: 13 }, (_, i) => ({
      cwd: `/p/${String(i).padStart(2, "0")}`,
      logs: 20 - i,
      sources: ["codex" as const],
      kind: "no_declared_root" as const,
    }));

    const report = formatCoverageReport(resultWith(groups));
    const listed = report.filter((l) => l.includes(" /p/"));

    expect(listed).toHaveLength(10);
    // 13 groups of 20,19,...,8 logs; the 3 beyond the cap hold 10+9+8 = 27.
    expect(report.join("\n")).toContain("+3 more working directories (27 log(s))");
  });

  it("prints no remainder line at exactly the cap", () => {
    const groups = Array.from({ length: 10 }, (_, i) => ({
      cwd: `/p/${i}`,
      logs: 1,
      sources: ["codex" as const],
      kind: "no_declared_root" as const,
    }));

    expect(formatCoverageReport(resultWith(groups)).join("\n")).not.toContain("more working");
  });

  it("does not add a kind's note when no group is of that kind", () => {
    const report = formatCoverageReport(
      resultWith([{ cwd: "/tmp", logs: 1, sources: ["codex"], kind: "no_declared_root" }]),
    ).join("\n");

    expect(report).not.toContain("Declaring that subdirectory itself");
    expect(report).not.toContain("is never listed by the importer");
  });

  it("withholds OK while a log was unreadable, since its verdict is unknown", () => {
    const report = formatCoverageReport(
      resultWith([], { logsScanned: 3, attributed: 2, unreadable: 1 }),
    ).join("\n");

    expect(report).not.toContain("Capture coverage: OK");
    expect(report).toContain("unreadable, verdict unknown");
  });

  it("reports inert registry entries even when coverage is otherwise OK", () => {
    const report = formatCoverageReport(
      resultWith([], {
        logsScanned: 2,
        attributed: 2,
        inertWorkspaces: [{ path: "/x/ghost", reason: "no_store" }],
      }),
    ).join("\n");

    expect(report).toContain("Capture coverage: OK");
    expect(report).toContain("1 registered entry import cannot run in");
    expect(report).toContain("/x/ghost — no .basou store (never initialized)");
  });
});
