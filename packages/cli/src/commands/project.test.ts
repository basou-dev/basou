import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  basouPaths,
  createManifest,
  ensureBasouDirectory,
  type RepoEntry,
  type RosterDriftSummary,
  readManifest,
  writeManifest,
} from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  doRunProjectAdopt,
  doRunProjectCheck,
  doRunProjectGitignore,
  doRunProjectSymlinks,
  doRunProjectSync,
  doRunProjectWiring,
  type ProjectAdoptResult,
  type ProjectGitignoreResult,
  type ProjectSymlinksResult,
  type ProjectSyncResult,
  type ProjectWiringResult,
  renderProjectAdopt,
  renderProjectCheck,
  renderProjectGitignore,
  renderProjectSymlinks,
  renderProjectSync,
  renderProjectWiring,
} from "./project.js";

const execFileAsync = promisify(execFile);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
const WS = "ws_01HXABCDEF1234567890ABCDEF";
const NOW = new Date("2026-05-10T00:00:00.000Z");

let tmpRepo: string | undefined;
beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-proj-cli-"));
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: tmpRepo, env: ENV });
});
afterEach(async () => {
  if (tmpRepo !== undefined) await rm(tmpRepo, { recursive: true, force: true });
  tmpRepo = undefined;
  process.exitCode = 0;
  vi.restoreAllMocks();
});
function repo(): string {
  if (tmpRepo === undefined) throw new Error("tmpRepo not initialized");
  return tmpRepo;
}

async function setupManifest(opts: { repos?: RepoEntry[]; sourceRoots?: string[] }): Promise<void> {
  const paths = await ensureBasouDirectory(repo());
  const base = createManifest({ workspaceName: "ws", now: NOW, workspaceId: WS });
  await writeManifest(paths, {
    ...base,
    ...(opts.repos !== undefined ? { repos: opts.repos } : {}),
    ...(opts.sourceRoots !== undefined ? { import: { source_roots: opts.sourceRoots } } : {}),
  });
}

describe("basou project check", () => {
  it("flags a declared repo missing from source_roots as a gap", async () => {
    await setupManifest({
      repos: [
        { path: ".", visibility: "private" },
        { path: "../takuhon", visibility: "public" },
        { path: "../takashimatsuyama-bio", visibility: "public" },
      ],
      sourceRoots: [".", "../takuhon"],
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await doRunProjectCheck({}, { cwd: repo() });
    expect(s.ok).toBe(false);
    expect(s.gaps.map((g) => g.path)).toEqual(["../takashimatsuyama-bio"]);
  });

  it("is ok when every declared repo is captured (the view is extra, not a gap)", async () => {
    await setupManifest({
      repos: [
        { path: ".", visibility: "private" },
        { path: "../takuhon", visibility: "public" },
      ],
      sourceRoots: [".", "../takuhon", "../takuhon-workspace"],
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await doRunProjectCheck({}, { cwd: repo() });
    expect(s.ok).toBe(true);
    expect(s.gaps).toHaveLength(0);
    expect(s.extra).toEqual(["../takuhon-workspace"]);
  });

  it("reports declaredCount 0 when no roster is declared", async () => {
    await setupManifest({ sourceRoots: [".", "../takuhon"] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await doRunProjectCheck({}, { cwd: repo() });
    expect(s.declaredCount).toBe(0);
    expect(s.ok).toBe(true);
  });

  it("--json prints the machine-readable summary", async () => {
    await setupManifest({ repos: [{ path: "../x" }], sourceRoots: ["../x"] });
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      out.push(String(m));
    });
    await doRunProjectCheck({ json: true }, { cwd: repo() });
    const parsed = JSON.parse(out.join("\n")) as RosterDriftSummary;
    expect(parsed.ok).toBe(true);
    expect(parsed.matched).toEqual(["../x"]);
  });
});

describe("basou project sync", () => {
  const SYNC_NOW = new Date("2026-06-21T12:00:00.000Z");

  it("dry-run (default) reports the additions but writes nothing", async () => {
    await setupManifest({
      repos: [{ path: "." }, { path: "../takuhon" }, { path: "../bio" }],
      sourceRoots: [".", "../takuhon"], // bio is the gap
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectSync({}, { cwd: repo() });
    expect(r.applied).toBe(false);
    expect(r.added).toEqual(["../bio"]);
    expect(r.next).toEqual([".", "../takuhon", "../bio"]);
    // manifest is untouched
    const after = await readManifest(basouPaths(repo()));
    expect(after.import?.source_roots).toEqual([".", "../takuhon"]);
  });

  it("--apply writes the reconciled source_roots and bumps updated_at", async () => {
    await setupManifest({
      repos: [{ path: "." }, { path: "../takuhon" }, { path: "../bio" }],
      sourceRoots: [".", "../takuhon"],
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectSync({ apply: true }, { cwd: repo(), now: () => SYNC_NOW });
    expect(r.applied).toBe(true);
    const after = await readManifest(basouPaths(repo()));
    expect(after.import?.source_roots).toEqual([".", "../takuhon", "../bio"]);
    expect(after.workspace.updated_at).toBe(SYNC_NOW.toISOString());
  });

  it("--apply preserves an undeclared captured path (the workspace view)", async () => {
    await setupManifest({
      repos: [{ path: "../takuhon" }, { path: "../bio" }],
      sourceRoots: ["../takuhon", "../takuhon-workspace"], // view is not declared
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await doRunProjectSync({ apply: true }, { cwd: repo(), now: () => SYNC_NOW });
    const after = await readManifest(basouPaths(repo()));
    expect(after.import?.source_roots).toEqual(["../takuhon", "../takuhon-workspace", "../bio"]);
  });

  it("--apply is a no-op (no write) when already in sync", async () => {
    await setupManifest({
      repos: [{ path: "." }, { path: "../takuhon" }],
      sourceRoots: [".", "../takuhon"],
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectSync({ apply: true }, { cwd: repo(), now: () => SYNC_NOW });
    expect(r.applied).toBe(false);
    expect(r.unchanged).toBe(true);
    const after = await readManifest(basouPaths(repo()));
    // updated_at stays at creation time (no write happened)
    expect(after.workspace.updated_at).toBe(NOW.toISOString());
  });

  it("derives source_roots from the roster when none is configured yet", async () => {
    await setupManifest({ repos: [{ path: "." }, { path: "../takuhon" }] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectSync({ apply: true }, { cwd: repo(), now: () => SYNC_NOW });
    expect(r.applied).toBe(true);
    const after = await readManifest(basouPaths(repo()));
    expect(after.import?.source_roots).toEqual([".", "../takuhon"]);
  });

  it("does nothing when no roster is declared, even with --apply", async () => {
    await setupManifest({ sourceRoots: [".", "../takuhon"] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectSync({ apply: true }, { cwd: repo(), now: () => SYNC_NOW });
    expect(r.hasRoster).toBe(false);
    expect(r.applied).toBe(false);
    const after = await readManifest(basouPaths(repo()));
    expect(after.import?.source_roots).toEqual([".", "../takuhon"]);
  });

  it("--json prints the machine-readable result", async () => {
    await setupManifest({ repos: [{ path: "../x" }, { path: "../y" }], sourceRoots: ["../x"] });
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      out.push(String(m));
    });
    await doRunProjectSync({ json: true }, { cwd: repo() });
    const parsed = JSON.parse(out.join("\n")) as ProjectSyncResult;
    expect(parsed.added).toEqual(["../y"]);
    expect(parsed.applied).toBe(false);
    expect(parsed.hasRoster).toBe(true);
  });
});

describe("renderProjectSync", () => {
  const base: ProjectSyncResult = {
    next: [],
    added: [],
    unchanged: true,
    hasRoster: true,
    applied: false,
  };

  it("explains the no-roster case", () => {
    const out = renderProjectSync({ ...base, hasRoster: false });
    expect(out).toContain("未宣言");
  });

  it("reports already-in-sync with a check mark", () => {
    const out = renderProjectSync({ ...base, unchanged: true });
    expect(out).toContain("✅");
    expect(out).toContain("同期不要");
  });

  it("dry-run lists the additions and states nothing is written", () => {
    const out = renderProjectSync({
      ...base,
      added: ["../bio"],
      next: ["../bio"],
      unchanged: false,
    });
    expect(out).toContain("../bio");
    expect(out).toContain("--apply");
    expect(out).toContain("削除はしません");
  });

  it("applied lists what was added with a check mark", () => {
    const out = renderProjectSync({
      ...base,
      added: ["../bio"],
      next: ["../bio"],
      unchanged: false,
      applied: true,
    });
    expect(out).toContain("✅");
    expect(out).toContain("追加しました");
    expect(out).toContain("../bio");
  });
});

describe("renderProjectCheck", () => {
  const base: RosterDriftSummary = {
    declaredCount: 0,
    capturedCount: 0,
    gaps: [],
    extra: [],
    matched: [],
    ok: true,
  };

  it("surfaces each gap with its visibility and never claims 'clear'", () => {
    const out = renderProjectCheck({
      ...base,
      declaredCount: 2,
      gaps: [{ path: "../bio", visibility: "public" }],
      matched: [".."],
      ok: false,
    });
    expect(out).toContain("../bio");
    expect(out).toContain("[public]");
    expect(out).toContain("⚠️");
  });

  it("reports a clean roster with a check mark", () => {
    const out = renderProjectCheck({
      ...base,
      declaredCount: 3,
      matched: ["a", "b", "c"],
      ok: true,
    });
    expect(out).toContain("✅");
    expect(out).toContain("3 repo");
  });

  it("explains the undeclared-roster case", () => {
    const out = renderProjectCheck({ ...base, capturedCount: 1, extra: ["../x"] });
    expect(out).toContain("未宣言");
    expect(out).toContain("../x");
  });
});

describe("basou project adopt", () => {
  const ADOPT_NOW = new Date("2026-06-21T12:00:00.000Z");
  let parent: string | undefined;

  beforeEach(async () => {
    // A workspace parent holding a host repo, a sibling repo, a non-repo "view", and a
    // declared-but-absent sibling. The host carries the manifest under test.
    parent = await mkdtemp(join(tmpdir(), "basou-adopt-"));
    const host = join(parent, "host");
    const sibling = join(parent, "sibling");
    const view = join(parent, "view"); // a plain dir (no .git) standing in for the workspace view
    await mkdir(host, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await mkdir(view, { recursive: true });
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: host, env: ENV });
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], {
      cwd: sibling,
      env: ENV,
    });
  });
  afterEach(async () => {
    if (parent !== undefined) await rm(parent, { recursive: true, force: true });
    parent = undefined;
  });
  function host(): string {
    if (parent === undefined) throw new Error("parent not initialized");
    return join(parent, "host");
  }
  async function setupHostManifest(opts: {
    repos?: RepoEntry[];
    sourceRoots?: string[];
  }): Promise<void> {
    const paths = await ensureBasouDirectory(host());
    const base = createManifest({ workspaceName: "ws", now: NOW, workspaceId: WS });
    await writeManifest(paths, {
      ...base,
      ...(opts.repos !== undefined ? { repos: opts.repos } : {}),
      ...(opts.sourceRoots !== undefined ? { import: { source_roots: opts.sourceRoots } } : {}),
    });
  }

  it("classifies source_roots: keeps git repos, excludes the view and an absent path (dry-run writes nothing)", async () => {
    await setupHostManifest({ sourceRoots: [".", "../sibling", "../view", "../gone"] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectAdopt({}, { cwd: host() });
    expect(r.applied).toBe(false);
    expect(r.repos).toEqual([{ path: "." }, { path: "../sibling" }]);
    expect(r.excluded).toEqual([
      { path: "../view", kind: "non-repo" },
      { path: "../gone", kind: "unresolved" },
    ]);
    // manifest is untouched (no repos written)
    const after = await readManifest(basouPaths(host()));
    expect(after.repos).toBeUndefined();
  });

  it("--apply writes the bootstrapped roster (path only) and bumps updated_at", async () => {
    await setupHostManifest({ sourceRoots: [".", "../sibling", "../view"] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectAdopt({ apply: true }, { cwd: host(), now: () => ADOPT_NOW });
    expect(r.applied).toBe(true);
    const after = await readManifest(basouPaths(host()));
    expect(after.repos).toEqual([{ path: "." }, { path: "../sibling" }]);
    expect(after.workspace.updated_at).toBe(ADOPT_NOW.toISOString());
  });

  it("defaults to the host repo '.' when no source_roots are configured", async () => {
    await setupHostManifest({});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectAdopt({ apply: true }, { cwd: host(), now: () => ADOPT_NOW });
    expect(r.repos).toEqual([{ path: "." }]);
    const after = await readManifest(basouPaths(host()));
    expect(after.repos).toEqual([{ path: "." }]);
  });

  it("a solo adoption (no source_roots) does not then report '.' as a capture gap in check", async () => {
    // Regression: check must treat absent source_roots as ["."] (import's host-only
    // default), else a solo repo adopted as repos:["."] shows a spurious gap.
    await setupHostManifest({});
    vi.spyOn(console, "log").mockImplementation(() => {});
    await doRunProjectAdopt({ apply: true }, { cwd: host(), now: () => ADOPT_NOW });
    const s = await doRunProjectCheck({}, { cwd: host() });
    expect(s.ok).toBe(true);
    expect(s.gaps).toHaveLength(0);
  });

  it("--apply refuses (no write) when a roster already exists", async () => {
    await setupHostManifest({
      repos: [{ path: ".", visibility: "private" }],
      sourceRoots: [".", "../sibling"],
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectAdopt({ apply: true }, { cwd: host(), now: () => ADOPT_NOW });
    expect(r.alreadyDeclared).toBe(true);
    expect(r.applied).toBe(false);
    const after = await readManifest(basouPaths(host()));
    expect(after.repos).toEqual([{ path: ".", visibility: "private" }]); // untouched
    expect(after.workspace.updated_at).toBe(NOW.toISOString());
  });

  it("--json prints the machine-readable result", async () => {
    await setupHostManifest({ sourceRoots: [".", "../view"] });
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      out.push(String(m));
    });
    await doRunProjectAdopt({ json: true }, { cwd: host() });
    const parsed = JSON.parse(out.join("\n")) as ProjectAdoptResult;
    expect(parsed.repos).toEqual([{ path: "." }]);
    expect(parsed.excluded).toEqual([{ path: "../view", kind: "non-repo" }]);
    expect(parsed.applied).toBe(false);
  });
});

describe("renderProjectAdopt", () => {
  const base: ProjectAdoptResult = {
    repos: [],
    excluded: [],
    alreadyDeclared: false,
    applied: false,
  };

  it("explains the already-declared case (points to check/sync)", () => {
    const out = renderProjectAdopt({ ...base, alreadyDeclared: true });
    expect(out).toContain("既に宣言済み");
    expect(out).toContain("project check");
  });

  it("dry-run proposes the roster, flags visibility, and lists exclusions with reasons", () => {
    const out = renderProjectAdopt({
      ...base,
      repos: [{ path: "." }, { path: "../sibling" }],
      excluded: [
        { path: "../view", kind: "non-repo" },
        { path: "../gone", kind: "unresolved" },
      ],
    });
    expect(out).toContain("--apply");
    expect(out).toContain("../sibling");
    expect(out).toContain("visibility");
    expect(out).toContain("../view");
    expect(out).toContain("../gone");
    expect(out).toContain("解決不能");
  });

  it("applied confirms the write with a check mark", () => {
    const out = renderProjectAdopt({ ...base, repos: [{ path: "." }], applied: true });
    expect(out).toContain("✅");
    expect(out).toContain("書き込みました");
  });

  it("reports when nothing was found", () => {
    const out = renderProjectAdopt({ ...base, excluded: [{ path: "../view", kind: "non-repo" }] });
    expect(out).toContain("見つかりませんでした");
  });
});

describe("basou project wiring", () => {
  let parent: string | undefined;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "basou-wiring-"));
    const h = join(parent, "host");
    await mkdir(h, { recursive: true });
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: h, env: ENV });
  });
  afterEach(async () => {
    if (parent !== undefined) await rm(parent, { recursive: true, force: true });
    parent = undefined;
  });
  function host(): string {
    if (parent === undefined) throw new Error("parent not initialized");
    return join(parent, "host");
  }
  async function makeRepo(
    name: string,
    files: { name: string; tracked: boolean }[],
  ): Promise<void> {
    const dir = join(parent as string, name);
    await mkdir(dir, { recursive: true });
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: dir, env: ENV });
    for (const f of files) {
      const abs = join(dir, f.name);
      if (f.name.includes("/")) await mkdir(join(dir, f.name, ".."), { recursive: true });
      await writeFile(abs, "x\n");
      if (f.tracked) await execFileAsync("git", ["add", "--", f.name], { cwd: dir, env: ENV });
    }
  }
  async function setupHostManifest(repos: RepoEntry[]): Promise<void> {
    const paths = await ensureBasouDirectory(host());
    const base = createManifest({ workspaceName: "ws", now: NOW, workspaceId: WS });
    await writeManifest(paths, { ...base, repos });
  }

  it("surfaces a public-repo tracked instruction file as a risk; private tracked is fine; flags unknown + unreachable", async () => {
    // publeak: public, AGENTS.md tracked (others present untracked) -> risk on AGENTS.md only
    await makeRepo("publeak", [
      { name: "AGENTS.md", tracked: true },
      { name: "CLAUDE.md", tracked: false },
      { name: ".github/copilot-instructions.md", tracked: false },
    ]);
    // priv: private, AGENTS.md tracked -> NOT a risk
    await makeRepo("priv", [
      { name: "AGENTS.md", tracked: true },
      { name: "CLAUDE.md", tracked: false },
      { name: ".github/copilot-instructions.md", tracked: false },
    ]);
    // unk: no visibility, AGENTS.md tracked -> unknown (not a risk)
    await makeRepo("unk", [
      { name: "AGENTS.md", tracked: true },
      { name: "CLAUDE.md", tracked: false },
      { name: ".github/copilot-instructions.md", tracked: false },
    ]);
    await setupHostManifest([
      { path: "../publeak", visibility: "public" },
      { path: "../priv", visibility: "private" },
      { path: "../unk" }, // no visibility
      { path: "../gone" }, // not created -> unreachable
    ]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectWiring({}, { cwd: host() });
    expect(r.risks).toEqual([{ repo: "../publeak", visibility: "public", file: "AGENTS.md" }]);
    expect(r.unknown).toEqual(["../unk"]);
    expect(r.unreachable).toEqual(["../gone"]);
    expect(r.incomplete).toHaveLength(0);
    expect(r.ok).toBe(false);
  });

  it("is ok when a public repo has all instruction files present and untracked", async () => {
    await makeRepo("pub", [
      { name: "AGENTS.md", tracked: false },
      { name: "CLAUDE.md", tracked: false },
      { name: ".github/copilot-instructions.md", tracked: false },
    ]);
    await setupHostManifest([{ path: "../pub", visibility: "public" }]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectWiring({}, { cwd: host() });
    expect(r.ok).toBe(true);
    expect(r.risks).toHaveLength(0);
    expect(r.incomplete).toHaveLength(0);
  });

  it("reports missing instruction files as incomplete", async () => {
    await makeRepo("pub", [{ name: "AGENTS.md", tracked: false }]); // CLAUDE.md + copilot missing
    await setupHostManifest([{ path: "../pub", visibility: "public" }]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectWiring({}, { cwd: host() });
    expect(r.incomplete).toEqual([
      { repo: "../pub", missing: ["CLAUDE.md", ".github/copilot-instructions.md"] },
    ]);
    expect(r.risks).toHaveLength(0);
  });

  it("reports hasRoster false when no roster is declared", async () => {
    const paths = await ensureBasouDirectory(host());
    const base = createManifest({ workspaceName: "ws", now: NOW, workspaceId: WS });
    await writeManifest(paths, base);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectWiring({}, { cwd: host() });
    expect(r.hasRoster).toBe(false);
    expect(r.repos).toHaveLength(0);
  });

  it("--json prints the machine-readable result", async () => {
    await makeRepo("pub", [{ name: "AGENTS.md", tracked: true }]);
    await setupHostManifest([{ path: "../pub", visibility: "public" }]);
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      out.push(String(m));
    });
    await doRunProjectWiring({ json: true }, { cwd: host() });
    const parsed = JSON.parse(out.join("\n")) as ProjectWiringResult;
    expect(parsed.risks).toEqual([{ repo: "../pub", visibility: "public", file: "AGENTS.md" }]);
    expect(parsed.hasRoster).toBe(true);
  });

  it("counts a (broken) symlink as a present instruction file (lstat, not exists)", async () => {
    const dir = join(parent as string, "pub");
    await mkdir(dir, { recursive: true });
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: dir, env: ENV });
    // AGENTS.md is a symlink to a non-existent target — present on disk, untracked.
    await symlink("../nonexistent-canonical/AGENTS.md", join(dir, "AGENTS.md"));
    await setupHostManifest([{ path: "../pub", visibility: "public" }]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectWiring({}, { cwd: host() });
    const agents = r.repos[0]?.instructionFiles.find((f) => f.name === "AGENTS.md");
    expect(agents).toEqual({ name: "AGENTS.md", present: true, tracked: false });
    // the broken symlink is present (so not "missing"), and untracked in a public repo is fine
    expect(r.incomplete.find((i) => i.repo === "../pub")?.missing).not.toContain("AGENTS.md");
  });

  it("detects a tracked instruction file at the nested .github/copilot-instructions.md path", async () => {
    await makeRepo("pub", [{ name: ".github/copilot-instructions.md", tracked: true }]);
    await setupHostManifest([{ path: "../pub", visibility: "public" }]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectWiring({}, { cwd: host() });
    expect(r.risks).toEqual([
      { repo: "../pub", visibility: "public", file: ".github/copilot-instructions.md" },
    ]);
  });

  it("degrades a single unusable repo to unreachable without aborting the whole report", async () => {
    // 'broken' has a .git that is not a valid repo, so git ls-files fails for it only.
    const broken = join(parent as string, "broken");
    await mkdir(join(broken, ".git"), { recursive: true });
    await makeRepo("pub", [{ name: "AGENTS.md", tracked: false }]);
    await setupHostManifest([
      { path: "../broken", visibility: "public" },
      { path: "../pub", visibility: "public" },
    ]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectWiring({}, { cwd: host() });
    expect(r.unreachable).toEqual(["../broken"]);
    // the good repo is still reported (one bad repo did not blank the report)
    expect(r.repos.find((x) => x.path === "../pub")?.reachable).toBe(true);
  });
});

describe("renderProjectWiring", () => {
  const base: ProjectWiringResult = {
    repos: [],
    risks: [],
    unknown: [],
    incomplete: [],
    unreachable: [],
    ok: true,
    hasRoster: true,
  };

  it("explains the no-roster case (points to adopt)", () => {
    const out = renderProjectWiring({ ...base, hasRoster: false });
    expect(out).toContain("未宣言");
    expect(out).toContain("project adopt");
  });

  it("reports a clean wiring with a check mark", () => {
    const out = renderProjectWiring(base);
    expect(out).toContain("✅");
  });

  it("does NOT lead with a clean privacy verdict when there are no risks but unjudgeable/unreachable repos", () => {
    const out = renderProjectWiring({
      ...base,
      unknown: ["../x"],
      unreachable: ["../z"],
      ok: false,
    });
    expect(out).not.toContain("✅");
    expect(out).not.toContain("privacy リスクなし");
    expect(out).toContain("確定した privacy リスクはありません");
  });

  it("surfaces each risk with its repo, visibility and file", () => {
    const out = renderProjectWiring({
      ...base,
      risks: [{ repo: "../takuhon", visibility: "public", file: "AGENTS.md" }],
      ok: false,
    });
    expect(out).toContain("⚠️");
    expect(out).toContain("../takuhon");
    expect(out).toContain("[public]");
    expect(out).toContain("AGENTS.md");
  });

  it("lists unknown-visibility, incomplete and unreachable sections", () => {
    const out = renderProjectWiring({
      ...base,
      unknown: ["../x"],
      incomplete: [{ repo: "../y", missing: ["CLAUDE.md"] }],
      unreachable: ["../z"],
      ok: false,
    });
    expect(out).toContain("visibility 未設定");
    expect(out).toContain("../x");
    expect(out).toContain("欠落");
    expect(out).toContain("../y");
    expect(out).toContain("到達不能");
    expect(out).toContain("../z");
  });
});

describe("basou project gitignore", () => {
  let parent: string | undefined;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "basou-gi-"));
    const h = join(parent, "host");
    await mkdir(h, { recursive: true });
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: h, env: ENV });
  });
  afterEach(async () => {
    if (parent !== undefined) await rm(parent, { recursive: true, force: true });
    parent = undefined;
  });
  function host(): string {
    if (parent === undefined) throw new Error("parent not initialized");
    return join(parent, "host");
  }
  async function makeRepo(name: string, gitignore?: string): Promise<void> {
    const dir = join(parent as string, name);
    await mkdir(dir, { recursive: true });
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: dir, env: ENV });
    if (gitignore !== undefined) await writeFile(join(dir, ".gitignore"), gitignore);
  }
  async function setupHostManifest(repos: RepoEntry[]): Promise<void> {
    const paths = await ensureBasouDirectory(host());
    const base = createManifest({ workspaceName: "ws", now: NOW, workspaceId: WS });
    await writeManifest(paths, { ...base, repos });
  }
  async function gitignoreOf(name: string): Promise<string> {
    return await readFile(join(parent as string, name, ".gitignore"), "utf8");
  }

  it("dry-run plans the missing patterns for a public repo but writes nothing", async () => {
    await makeRepo("pub", "node_modules\nAGENTS.md\n");
    await setupHostManifest([{ path: "../pub", visibility: "public" }]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectGitignore({}, { cwd: host() });
    expect(r.applied).toBe(false);
    expect(r.plans).toEqual([
      { path: "../pub", toAdd: ["CLAUDE.md", ".github/copilot-instructions.md"] },
    ]);
    // .gitignore unchanged
    expect(await gitignoreOf("pub")).toBe("node_modules\nAGENTS.md\n");
  });

  it("--apply appends the missing patterns, preserving existing lines and not duplicating", async () => {
    await makeRepo("pub", "node_modules\nAGENTS.md\n");
    await setupHostManifest([{ path: "../pub", visibility: "public" }]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectGitignore({ apply: true }, { cwd: host() });
    expect(r.applied).toBe(true);
    expect(await gitignoreOf("pub")).toBe(
      "node_modules\nAGENTS.md\nCLAUDE.md\n.github/copilot-instructions.md\n",
    );
  });

  it("--apply creates a .gitignore when the public repo has none", async () => {
    await makeRepo("pub"); // no .gitignore
    await setupHostManifest([{ path: "../pub", visibility: "public" }]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await doRunProjectGitignore({ apply: true }, { cwd: host() });
    expect(await gitignoreOf("pub")).toBe(
      "AGENTS.md\nCLAUDE.md\n.github/copilot-instructions.md\n",
    );
  });

  it("--apply is idempotent (a second run adds nothing)", async () => {
    await makeRepo("pub");
    await setupHostManifest([{ path: "../pub", visibility: "public" }]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await doRunProjectGitignore({ apply: true }, { cwd: host() });
    const after1 = await gitignoreOf("pub");
    const r2 = await doRunProjectGitignore({ apply: true }, { cwd: host() });
    expect(r2.applied).toBe(false);
    expect(r2.ok).toBe(true);
    expect(await gitignoreOf("pub")).toBe(after1);
  });

  it("leaves a private repo untouched and reports unset visibility / unreachable", async () => {
    await makeRepo("priv", "node_modules\n");
    await makeRepo("unk");
    await setupHostManifest([
      { path: "../priv", visibility: "private" },
      { path: "../unk" }, // unset visibility
      { path: "../gone" }, // unreachable
    ]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectGitignore({ apply: true }, { cwd: host() });
    expect(r.plans).toHaveLength(0);
    expect(r.unknown).toEqual(["../unk"]);
    expect(r.unreachable).toEqual(["../gone"]);
    expect(r.applied).toBe(false);
    expect(await gitignoreOf("priv")).toBe("node_modules\n"); // untouched
  });

  it("reports hasRoster false when no roster is declared", async () => {
    const paths = await ensureBasouDirectory(host());
    const base = createManifest({ workspaceName: "ws", now: NOW, workspaceId: WS });
    await writeManifest(paths, base);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectGitignore({}, { cwd: host() });
    expect(r.hasRoster).toBe(false);
  });

  it("--json prints the machine-readable result", async () => {
    await makeRepo("pub");
    await setupHostManifest([{ path: "../pub", visibility: "public" }]);
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      out.push(String(m));
    });
    await doRunProjectGitignore({ json: true }, { cwd: host() });
    const parsed = JSON.parse(out.join("\n")) as ProjectGitignoreResult;
    expect(parsed.plans[0]?.path).toBe("../pub");
    expect(parsed.applied).toBe(false);
  });
});

describe("renderProjectGitignore", () => {
  const base: ProjectGitignoreResult = {
    plans: [],
    unknown: [],
    unreachable: [],
    ok: true,
    hasRoster: true,
    applied: false,
  };

  it("explains the no-roster case (points to adopt)", () => {
    const out = renderProjectGitignore({ ...base, hasRoster: false });
    expect(out).toContain("未宣言");
    expect(out).toContain("project adopt");
  });

  it("reports a clean state with a check mark", () => {
    const out = renderProjectGitignore(base);
    expect(out).toContain("✅");
    expect(out).toContain("追加不要");
  });

  it("does NOT lead with a clean verdict when there are skipped/unreachable repos and nothing to add", () => {
    const out = renderProjectGitignore({ ...base, unknown: ["../x"], ok: false });
    expect(out).not.toContain("追加不要");
    expect(out).toContain("判定できない");
  });

  it("dry-run lists the additions and says nothing is written", () => {
    const out = renderProjectGitignore({
      ...base,
      plans: [{ path: "../pub", toAdd: ["CLAUDE.md"] }],
      ok: false,
    });
    expect(out).toContain("--apply");
    expect(out).toContain("../pub");
    expect(out).toContain("CLAUDE.md");
    expect(out).toContain("削除はしません");
  });

  it("applied lists what was added with a check mark", () => {
    const out = renderProjectGitignore({
      ...base,
      plans: [{ path: "../pub", toAdd: ["CLAUDE.md"] }],
      ok: false,
      applied: true,
    });
    expect(out).toContain("✅");
    expect(out).toContain("追加しました");
  });

  it("always caveats that .gitignore does not untrack already-tracked files (points to wiring)", () => {
    const out = renderProjectGitignore(base);
    expect(out).toContain("untrack しません");
    expect(out).toContain("project wiring");
    expect(out).toContain("git rm --cached");
  });
});

describe("basou project symlinks", () => {
  let parent: string | undefined;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "basou-symlinks-"));
    const h = join(parent, "host");
    await mkdir(h, { recursive: true });
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: h, env: ENV });
  });
  afterEach(async () => {
    if (parent !== undefined) await rm(parent, { recursive: true, force: true });
    parent = undefined;
  });
  function host(): string {
    if (parent === undefined) throw new Error("parent not initialized");
    return join(parent, "host");
  }
  function sibling(name: string): string {
    return join(parent as string, name);
  }
  async function makeRepo(name: string): Promise<void> {
    const dir = sibling(name);
    await mkdir(dir, { recursive: true });
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: dir, env: ENV });
  }
  /** Write the anchor's canonical for a repo: host/agents/<name>/AGENTS.md. */
  async function makeCanonical(name: string): Promise<void> {
    const dir = join(host(), "agents", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "AGENTS.md"), "canonical\n");
  }
  async function setupHostManifest(repos: RepoEntry[]): Promise<void> {
    const paths = await ensureBasouDirectory(host());
    const base = createManifest({ workspaceName: "ws", now: NOW, workspaceId: WS });
    await writeManifest(paths, { ...base, repos });
  }
  function mute(): void {
    vi.spyOn(console, "log").mockImplementation(() => {});
  }

  it("plans all three links for an unwired repo (dry-run creates nothing)", async () => {
    await makeRepo("pub");
    await makeCanonical("pub");
    await setupHostManifest([{ path: "../pub", visibility: "public" }]);
    mute();
    const r = await doRunProjectSymlinks({}, { cwd: host() });
    expect(r.applied).toBe(false);
    expect(r.plans).toEqual([
      {
        path: "../pub",
        toCreate: [
          { name: "AGENTS.md", target: "../host/agents/pub/AGENTS.md" },
          { name: "CLAUDE.md", target: "AGENTS.md" },
          { name: ".github/copilot-instructions.md", target: "../AGENTS.md" },
        ],
      },
    ]);
    expect(r.ok).toBe(false);
    await expect(readlink(join(sibling("pub"), "AGENTS.md"))).rejects.toThrow();
  });

  it("--apply creates the symlinks with correct relative targets, making .github", async () => {
    await makeRepo("pub");
    await makeCanonical("pub");
    await setupHostManifest([{ path: "../pub", visibility: "public" }]);
    mute();
    const r = await doRunProjectSymlinks({ apply: true }, { cwd: host() });
    expect(r.applied).toBe(true);
    expect(await readlink(join(sibling("pub"), "AGENTS.md"))).toBe("../host/agents/pub/AGENTS.md");
    expect(await readlink(join(sibling("pub"), "CLAUDE.md"))).toBe("AGENTS.md");
    expect(await readlink(join(sibling("pub"), ".github/copilot-instructions.md"))).toBe(
      "../AGENTS.md",
    );
    expect(await readFile(join(sibling("pub"), "AGENTS.md"), "utf8")).toBe("canonical\n");
  });

  it("is idempotent: a fully wired repo reports ok and --apply changes nothing", async () => {
    await makeRepo("pub");
    await makeCanonical("pub");
    await setupHostManifest([{ path: "../pub", visibility: "public" }]);
    mute();
    await doRunProjectSymlinks({ apply: true }, { cwd: host() });
    const r = await doRunProjectSymlinks({ apply: true }, { cwd: host() });
    expect(r.ok).toBe(true);
    expect(r.plans).toEqual([]);
    expect(r.applied).toBe(false);
  });

  it("skips the anchor entry (resolves to the manifest root, never linked to itself)", async () => {
    await makeRepo("pub");
    await makeCanonical("pub");
    await setupHostManifest([
      { path: ".", visibility: "private" },
      { path: "../pub", visibility: "public" },
    ]);
    mute();
    const r = await doRunProjectSymlinks({}, { cwd: host() });
    expect(r.plans.map((p) => p.path)).toEqual(["../pub"]);
    expect(r.missingCanonical).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });

  it("reports a link pointing elsewhere as a mismatch conflict and never repoints it on --apply", async () => {
    await makeRepo("pub");
    await makeCanonical("pub");
    await symlink("../somewhere/else.md", join(sibling("pub"), "AGENTS.md"));
    await setupHostManifest([{ path: "../pub", visibility: "public" }]);
    mute();
    const r = await doRunProjectSymlinks({ apply: true }, { cwd: host() });
    expect(r.conflicts).toEqual([
      {
        repo: "../pub",
        file: "AGENTS.md",
        reason: "mismatch",
        actualTarget: "../somewhere/else.md",
      },
    ]);
    expect(await readlink(join(sibling("pub"), "AGENTS.md"))).toBe("../somewhere/else.md");
  });

  it("reports a real file occupying the path as an occupied conflict and never overwrites it", async () => {
    await makeRepo("pub");
    await makeCanonical("pub");
    await writeFile(join(sibling("pub"), "AGENTS.md"), "hand-written\n");
    await setupHostManifest([{ path: "../pub", visibility: "public" }]);
    mute();
    const r = await doRunProjectSymlinks({ apply: true }, { cwd: host() });
    expect(r.conflicts).toEqual([{ repo: "../pub", file: "AGENTS.md", reason: "occupied" }]);
    expect(await readFile(join(sibling("pub"), "AGENTS.md"), "utf8")).toBe("hand-written\n");
  });

  it("still creates the missing links while reporting a conflict on the same repo", async () => {
    await makeRepo("pub");
    await makeCanonical("pub");
    await writeFile(join(sibling("pub"), "AGENTS.md"), "hand-written\n");
    await setupHostManifest([{ path: "../pub", visibility: "public" }]);
    mute();
    const r = await doRunProjectSymlinks({ apply: true }, { cwd: host() });
    expect(r.conflicts).toHaveLength(1);
    expect(await readlink(join(sibling("pub"), "CLAUDE.md"))).toBe("AGENTS.md");
    expect(await readlink(join(sibling("pub"), ".github/copilot-instructions.md"))).toBe(
      "../AGENTS.md",
    );
  });

  it("reports a repo whose anchor canonical is absent as missingCanonical (plans nothing)", async () => {
    await makeRepo("pub");
    await setupHostManifest([{ path: "../pub", visibility: "public" }]);
    mute();
    const r = await doRunProjectSymlinks({}, { cwd: host() });
    expect(r.missingCanonical).toEqual(["../pub"]);
    expect(r.plans).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it("degrades an unresolvable repo to unreachable", async () => {
    await makeRepo("pub");
    await makeCanonical("pub");
    await setupHostManifest([
      { path: "../pub", visibility: "public" },
      { path: "../gone", visibility: "public" },
    ]);
    mute();
    const r = await doRunProjectSymlinks({}, { cwd: host() });
    expect(r.unreachable).toEqual(["../gone"]);
  });

  it("reports hasRoster false when no roster is declared", async () => {
    const paths = await ensureBasouDirectory(host());
    const base = createManifest({ workspaceName: "ws", now: NOW, workspaceId: WS });
    await writeManifest(paths, base);
    mute();
    const r = await doRunProjectSymlinks({}, { cwd: host() });
    expect(r.hasRoster).toBe(false);
    expect(r.plans).toEqual([]);
  });

  it("--json prints the machine-readable result", async () => {
    await makeRepo("pub");
    await makeCanonical("pub");
    await setupHostManifest([{ path: "../pub", visibility: "public" }]);
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      out.push(String(m));
    });
    await doRunProjectSymlinks({ json: true }, { cwd: host() });
    const parsed = JSON.parse(out.join("\n")) as ProjectSymlinksResult;
    expect(parsed.hasRoster).toBe(true);
    expect(parsed.plans[0]?.path).toBe("../pub");
  });

  it("classifies a path whose parent is a regular file as blocked, not missing, and does not crash --apply", async () => {
    await makeRepo("pub");
    await makeCanonical("pub");
    // .github is a regular FILE, so lstat(.github/copilot-instructions.md) throws
    // ENOTDIR — must be 'blocked' (a conflict), never 'missing' (which would crash apply).
    await writeFile(join(sibling("pub"), ".github"), "not a dir\n");
    await setupHostManifest([{ path: "../pub", visibility: "public" }]);
    mute();
    const r = await doRunProjectSymlinks({ apply: true }, { cwd: host() });
    expect(r.conflicts).toContainEqual({
      repo: "../pub",
      file: ".github/copilot-instructions.md",
      reason: "blocked",
    });
    // The two creatable links were still created; .github (the file) is untouched.
    expect(await readlink(join(sibling("pub"), "AGENTS.md"))).toBe("../host/agents/pub/AGENTS.md");
    expect(await readlink(join(sibling("pub"), "CLAUDE.md"))).toBe("AGENTS.md");
    expect(await readFile(join(sibling("pub"), ".github"), "utf8")).toBe("not a dir\n");
    expect(r.failures).toEqual([]);
    expect(r.applied).toBe(true);
  });

  it("dedupes a repo declared twice (one plan, no EEXIST on --apply)", async () => {
    await makeRepo("pub");
    await makeCanonical("pub");
    await setupHostManifest([{ path: "../pub" }, { path: "../pub" }]);
    mute();
    const r = await doRunProjectSymlinks({ apply: true }, { cwd: host() });
    expect(r.plans).toHaveLength(1);
    expect(r.failures).toEqual([]);
    expect(await readlink(join(sibling("pub"), "AGENTS.md"))).toBe("../host/agents/pub/AGENTS.md");
  });

  it("surfaces two distinct repos sharing a canonical name as a collision and wires neither", async () => {
    await makeRepo("x/pub");
    await makeRepo("y/pub");
    await makeCanonical("pub"); // both resolve to agents/pub/AGENTS.md
    await setupHostManifest([
      { path: "../x/pub", visibility: "public" },
      { path: "../y/pub", visibility: "public" },
    ]);
    mute();
    const r = await doRunProjectSymlinks({}, { cwd: host() });
    expect(r.collisions).toEqual([{ canonicalName: "pub", repos: ["../x/pub", "../y/pub"] }]);
    expect(r.plans).toEqual([]);
    expect(r.ok).toBe(false);
  });
});

describe("renderProjectSymlinks", () => {
  const base: ProjectSymlinksResult = {
    plans: [],
    conflicts: [],
    missingCanonical: [],
    unreachable: [],
    collisions: [],
    ok: true,
    hasRoster: true,
    applied: false,
    failures: [],
  };

  it("guides to adopt when no roster is declared", () => {
    const out = renderProjectSymlinks({ ...base, hasRoster: false, ok: false });
    expect(out).toContain("project adopt");
  });

  it("shows a clean verdict when everything is wired", () => {
    const out = renderProjectSymlinks(base);
    expect(out).toContain("正しく張られています");
  });

  it("lists planned links with dry-run framing", () => {
    const out = renderProjectSymlinks({
      ...base,
      ok: false,
      plans: [
        {
          path: "../pub",
          toCreate: [{ name: "AGENTS.md", target: "../host/agents/pub/AGENTS.md" }],
        },
      ],
    });
    expect(out).toContain("--apply");
    expect(out).toContain("../pub");
    expect(out).toContain("AGENTS.md -> ../host/agents/pub/AGENTS.md");
  });

  it("does not show a clean verdict when only conflicts / missing canonicals exist (no false-clear)", () => {
    const out = renderProjectSymlinks({
      ...base,
      ok: false,
      conflicts: [{ repo: "../pub", file: "AGENTS.md", reason: "occupied" }],
      missingCanonical: ["../newrepo"],
    });
    expect(out).not.toContain("正しく張られています");
    expect(out).toContain("競合");
    expect(out).toContain("canonical 不在");
  });

  it("applied shows a check mark and created wording", () => {
    const out = renderProjectSymlinks({
      ...base,
      ok: false,
      applied: true,
      plans: [{ path: "../pub", toCreate: [{ name: "CLAUDE.md", target: "AGENTS.md" }] }],
    });
    expect(out).toContain("✅");
    expect(out).toContain("作成しました");
  });

  it("renders a canonical collision", () => {
    const out = renderProjectSymlinks({
      ...base,
      ok: false,
      collisions: [{ canonicalName: "pub", repos: ["../x/pub", "../y/pub"] }],
    });
    expect(out).toContain("canonical 衝突");
    expect(out).toContain("agents/pub/AGENTS.md");
    expect(out).toContain("../x/pub");
  });

  it("renders a blocked conflict with an accurate (not 'real file') description", () => {
    const out = renderProjectSymlinks({
      ...base,
      ok: false,
      conflicts: [{ repo: "../pub", file: ".github/copilot-instructions.md", reason: "blocked" }],
    });
    expect(out).toContain("検査できないパス");
    expect(out).not.toContain("symlink でない実ファイル/ディレクトリ");
  });

  it("renders --apply failures", () => {
    const out = renderProjectSymlinks({
      ...base,
      ok: false,
      failures: [{ repo: "../pub", file: "AGENTS.md", message: "EACCES" }],
    });
    expect(out).toContain("作成に失敗");
    expect(out).toContain("EACCES");
  });

  it("on partial --apply failure, lists only created links and shows the failure separately", () => {
    const out = renderProjectSymlinks({
      ...base,
      ok: false,
      applied: true,
      plans: [
        {
          path: "../pub",
          toCreate: [
            { name: "AGENTS.md", target: "../host/agents/pub/AGENTS.md" },
            { name: "CLAUDE.md", target: "AGENTS.md" },
          ],
        },
      ],
      failures: [{ repo: "../pub", file: "CLAUDE.md", message: "EEXIST" }],
    });
    expect(out).toContain("一部失敗");
    expect(out).toContain("AGENTS.md -> ../host/agents/pub/AGENTS.md"); // created, listed
    expect(out).not.toContain("CLAUDE.md -> AGENTS.md"); // failed, NOT listed as created
    expect(out).toContain("CLAUDE.md: EEXIST"); // shown in the failures section
  });

  it("on a fully failed --apply, does not mislabel it as a dry-run", () => {
    const out = renderProjectSymlinks({
      ...base,
      ok: false,
      applied: false,
      plans: [{ path: "../pub", toCreate: [{ name: "AGENTS.md", target: "x" }] }],
      failures: [{ repo: "../pub", file: "AGENTS.md", message: "EACCES" }],
    });
    expect(out).toContain("作成できませんでした");
    expect(out).not.toContain("dry-run");
  });
});
