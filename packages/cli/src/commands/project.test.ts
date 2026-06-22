import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  basouPaths,
  createManifest,
  ensureBasouDirectory,
  GENERATED_END,
  GENERATED_START,
  ManifestSchema,
  type RepoEntry,
  type RosterDriftSummary,
  readManifest,
  renderPresetBlock,
  writeManifest,
} from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  doRunProjectAdopt,
  doRunProjectArchive,
  doRunProjectCheck,
  doRunProjectGitignore,
  doRunProjectPreset,
  doRunProjectRename,
  doRunProjectSymlinks,
  doRunProjectSync,
  doRunProjectWiring,
  doRunProjectWorkspace,
  gatherExistingViewLinks,
  type ProjectAdoptResult,
  type ProjectArchiveResult,
  type ProjectGitignoreResult,
  type ProjectPresetResult,
  type ProjectRenameResult,
  type ProjectSymlinksResult,
  type ProjectSyncResult,
  type ProjectWiringResult,
  type ProjectWorkspaceResult,
  pruneViewLinks,
  renderProjectAdopt,
  renderProjectArchive,
  renderProjectCheck,
  renderProjectGitignore,
  renderProjectPreset,
  renderProjectRename,
  renderProjectSymlinks,
  renderProjectSync,
  renderProjectWiring,
  renderProjectWorkspace,
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

describe("basou project workspace", () => {
  let parent: string | undefined;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "basou-ws-"));
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
  function p(name: string): string {
    return join(parent as string, name);
  }
  async function makeRepo(name: string): Promise<void> {
    const dir = p(name);
    await mkdir(dir, { recursive: true });
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: dir, env: ENV });
  }
  async function setup(opts: { repos: RepoEntry[]; view?: string }): Promise<void> {
    const paths = await ensureBasouDirectory(host());
    const base = createManifest({ workspaceName: "ws", now: NOW, workspaceId: WS });
    await writeManifest(paths, {
      ...base,
      repos: opts.repos,
      ...(opts.view !== undefined ? { workspace: { ...base.workspace, view: opts.view } } : {}),
    });
  }
  function mute(): void {
    vi.spyOn(console, "log").mockImplementation(() => {});
  }

  it("plans a link per roster repo, anchor included (dry-run creates nothing)", async () => {
    await makeRepo("r1");
    await setup({ repos: [{ path: "." }, { path: "../r1" }], view: "../wsview" });
    mute();
    const r = await doRunProjectWorkspace({}, { cwd: host() });
    expect(r.hasView).toBe(true);
    expect(r.applied).toBe(false);
    expect(r.toCreate).toEqual([
      { name: "host", target: "../host" }, // the anchor is aggregated too
      { name: "r1", target: "../r1" },
    ]);
    await expect(readlink(join(p("wsview"), "r1"))).rejects.toThrow();
  });

  it("--apply creates the view directory and the symlinks with correct targets", async () => {
    await makeRepo("r1");
    await setup({ repos: [{ path: "." }, { path: "../r1" }], view: "../wsview" });
    mute();
    const r = await doRunProjectWorkspace({ apply: true }, { cwd: host() });
    expect(r.applied).toBe(true);
    expect(await readlink(join(p("wsview"), "host"))).toBe("../host");
    expect(await readlink(join(p("wsview"), "r1"))).toBe("../r1");
    expect(r.failures).toEqual([]);
  });

  it("is idempotent: a fully aggregated view reports ok and --apply changes nothing", async () => {
    await makeRepo("r1");
    await setup({ repos: [{ path: "." }, { path: "../r1" }], view: "../wsview" });
    mute();
    await doRunProjectWorkspace({ apply: true }, { cwd: host() });
    const r = await doRunProjectWorkspace({ apply: true }, { cwd: host() });
    expect(r.ok).toBe(true);
    expect(r.toCreate).toEqual([]);
    expect(r.applied).toBe(false);
    expect(r.correctCount).toBe(2);
  });

  it("reports a view entry pointing elsewhere as a mismatch and never repoints it", async () => {
    await makeRepo("r1");
    await mkdir(p("wsview"), { recursive: true });
    await symlink("../elsewhere", join(p("wsview"), "r1"));
    await setup({ repos: [{ path: "../r1" }], view: "../wsview" });
    mute();
    const r = await doRunProjectWorkspace({ apply: true }, { cwd: host() });
    expect(r.conflicts).toEqual([{ name: "r1", reason: "mismatch", actualTarget: "../elsewhere" }]);
    expect(await readlink(join(p("wsview"), "r1"))).toBe("../elsewhere");
  });

  it("degrades an unresolvable repo to unreachable", async () => {
    await makeRepo("r1");
    await setup({ repos: [{ path: "../r1" }, { path: "../gone" }], view: "../wsview" });
    mute();
    const r = await doRunProjectWorkspace({}, { cwd: host() });
    expect(r.unreachable).toEqual(["../gone"]);
    expect(r.ok).toBe(false);
  });

  it("surfaces two repos sharing a basename as a collision and wires neither", async () => {
    await makeRepo("x/pub");
    await makeRepo("y/pub");
    await setup({ repos: [{ path: "../x/pub" }, { path: "../y/pub" }], view: "../wsview" });
    mute();
    const r = await doRunProjectWorkspace({}, { cwd: host() });
    expect(r.collisions).toEqual([{ linkName: "pub", repos: ["../x/pub", "../y/pub"] }]);
    expect(r.toCreate).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it("reports hasView false when no view is declared", async () => {
    await makeRepo("r1");
    await setup({ repos: [{ path: "../r1" }] });
    mute();
    const r = await doRunProjectWorkspace({}, { cwd: host() });
    expect(r.hasView).toBe(false);
    expect(r.toCreate).toEqual([]);
  });

  it("--json prints the machine-readable result", async () => {
    await makeRepo("r1");
    await setup({ repos: [{ path: "../r1" }], view: "../wsview" });
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      out.push(String(m));
    });
    await doRunProjectWorkspace({ json: true }, { cwd: host() });
    const parsed = JSON.parse(out.join("\n")) as ProjectWorkspaceResult;
    expect(parsed.hasView).toBe(true);
    expect(parsed.toCreate[0]?.name).toBe("r1");
  });

  it("treats a repo that resolves to the view itself as unreachable (no empty-target self-link)", async () => {
    await mkdir(p("wsview"), { recursive: true });
    await makeRepo("r1");
    await setup({ repos: [{ path: "../r1" }, { path: "../wsview" }], view: "../wsview" });
    mute();
    const r = await doRunProjectWorkspace({ apply: true }, { cwd: host() });
    expect(r.unreachable).toContain("../wsview");
    expect(r.ok).toBe(false);
    // No broken empty-target self-link was created for the view itself.
    await expect(readlink(join(p("wsview"), "wsview"))).rejects.toThrow();
    // The real repo was still aggregated.
    expect(await readlink(join(p("wsview"), "r1"))).toBe("../r1");
  });

  it("aggregates exactly the declared roster (the anchor is not injected when its '.' entry is absent)", async () => {
    await makeRepo("r1");
    await setup({ repos: [{ path: "../r1" }], view: "../wsview" }); // no "." entry
    mute();
    const r = await doRunProjectWorkspace({}, { cwd: host() });
    expect(r.toCreate).toEqual([{ name: "r1", target: "../r1" }]);
    expect(r.toCreate.map((c) => c.name)).not.toContain("host");
  });

  it("reports a stray repo link (a de-rostered repo's view symlink) but prunes nothing in dry-run", async () => {
    await makeRepo("r1");
    await makeRepo("old"); // an on-disk git repo no longer in the roster
    await mkdir(p("wsview"), { recursive: true });
    await symlink("../old", join(p("wsview"), "old")); // a stray basou-shaped repo link
    await setup({ repos: [{ path: "../r1" }], view: "../wsview" });
    mute();
    const r = await doRunProjectWorkspace({}, { cwd: host() });
    expect(r.toPrune).toEqual([{ name: "old", target: "../old" }]);
    expect(r.pruned).toBe(false);
    expect(r.ok).toBe(false); // a view carrying a stray is not "in sync"
    await expect(readlink(join(p("wsview"), "old"))).resolves.toBe("../old"); // untouched
  });

  it("--prune removes the stray repo link but never the linked repo", async () => {
    await makeRepo("r1");
    await makeRepo("old");
    await mkdir(p("wsview"), { recursive: true });
    await symlink("../old", join(p("wsview"), "old"));
    await setup({ repos: [{ path: "../r1" }], view: "../wsview" });
    mute();
    const r = await doRunProjectWorkspace({ prune: true }, { cwd: host() });
    expect(r.pruned).toBe(true);
    expect(r.pruneFailures).toEqual([]);
    await expect(readlink(join(p("wsview"), "old"))).rejects.toThrow(); // link gone
    expect(existsSync(p("old"))).toBe(true); // the repo it pointed at is intact
  });

  it("--prune leaves a current roster repo's link and the view's own instruction file untouched", async () => {
    await makeRepo("r1");
    await makeRepo("old");
    await mkdir(p("wsview"), { recursive: true });
    await symlink("../r1", join(p("wsview"), "r1")); // a CURRENT roster link
    await symlink("../old", join(p("wsview"), "old")); // a stray
    await writeFile(p("planning-AGENTS.md"), "# canonical\n");
    await symlink("../planning-AGENTS.md", join(p("wsview"), "AGENTS.md")); // the view's own instruction file
    await setup({ repos: [{ path: "../r1" }], view: "../wsview" });
    mute();
    const r = await doRunProjectWorkspace({ prune: true }, { cwd: host() });
    expect(r.toPrune).toEqual([{ name: "old", target: "../old" }]);
    expect(r.strayUnknown).toEqual([]); // AGENTS.md is filtered out, never reported
    await expect(readlink(join(p("wsview"), "r1"))).resolves.toBe("../r1"); // roster link kept
    await expect(readlink(join(p("wsview"), "AGENTS.md"))).resolves.toBe("../planning-AGENTS.md");
    await expect(readlink(join(p("wsview"), "old"))).rejects.toThrow(); // only the stray went
  });

  it("reports a broken stray symlink as unknown and never prunes it", async () => {
    await makeRepo("r1");
    await mkdir(p("wsview"), { recursive: true });
    await symlink("../vanished", join(p("wsview"), "vanished")); // target does not exist
    await setup({ repos: [{ path: "../r1" }], view: "../wsview" });
    mute();
    const r = await doRunProjectWorkspace({ prune: true }, { cwd: host() });
    expect(r.toPrune).toEqual([]);
    expect(r.strayUnknown).toEqual([{ name: "vanished", target: "../vanished", reason: "broken" }]);
    await expect(readlink(join(p("wsview"), "vanished"))).resolves.toBe("../vanished"); // untouched
  });

  it("reports a symlink to a non-repo directory as unknown and never prunes it", async () => {
    await makeRepo("r1");
    await mkdir(p("plain"), { recursive: true }); // a directory without .git
    await mkdir(p("wsview"), { recursive: true });
    await symlink("../plain", join(p("wsview"), "plain"));
    await setup({ repos: [{ path: "../r1" }], view: "../wsview" });
    mute();
    const r = await doRunProjectWorkspace({ prune: true }, { cwd: host() });
    expect(r.toPrune).toEqual([]);
    expect(r.strayUnknown).toEqual([{ name: "plain", target: "../plain", reason: "non-repo" }]);
    await expect(readlink(join(p("wsview"), "plain"))).resolves.toBe("../plain");
  });

  it("never treats a real (non-symlink) view entry as a stray", async () => {
    await makeRepo("r1");
    await mkdir(p("wsview"), { recursive: true });
    await writeFile(join(p("wsview"), "README.md"), "local notes\n");
    await setup({ repos: [{ path: "../r1" }], view: "../wsview" });
    mute();
    const r = await doRunProjectWorkspace({ prune: true }, { cwd: host() });
    expect(r.toPrune).toEqual([]);
    expect(r.strayUnknown).toEqual([]);
    expect(existsSync(join(p("wsview"), "README.md"))).toBe(true);
  });

  it("--apply and --prune together: creates the missing link and removes the stray in one run", async () => {
    await makeRepo("r1");
    await makeRepo("old");
    await mkdir(p("wsview"), { recursive: true });
    await symlink("../old", join(p("wsview"), "old")); // stray
    await setup({ repos: [{ path: "../r1" }], view: "../wsview" }); // r1 link is missing
    mute();
    const r = await doRunProjectWorkspace({ apply: true, prune: true }, { cwd: host() });
    expect(r.applied).toBe(true);
    expect(r.pruned).toBe(true);
    expect(await readlink(join(p("wsview"), "r1"))).toBe("../r1"); // created
    await expect(readlink(join(p("wsview"), "old"))).rejects.toThrow(); // pruned
    const after = await doRunProjectWorkspace({}, { cwd: host() });
    expect(after.ok).toBe(true); // fully reconciled
  });

  it("reports ok=true on the prune run itself once the only stray is removed (no false 'attention')", async () => {
    await makeRepo("r1");
    await makeRepo("old");
    await mkdir(p("wsview"), { recursive: true });
    await symlink("../r1", join(p("wsview"), "r1")); // current roster link, already correct
    await symlink("../old", join(p("wsview"), "old")); // the only stray
    await setup({ repos: [{ path: "../r1" }], view: "../wsview" });
    mute();
    const r = await doRunProjectWorkspace({ prune: true }, { cwd: host() });
    expect(r.pruned).toBe(true);
    expect(r.ok).toBe(true); // residual is recomputed post-prune — not the stale pre-prune false
  });

  it("--prune on an already-clean view is a no-op (pruned:false, ok:true)", async () => {
    await makeRepo("r1");
    await mkdir(p("wsview"), { recursive: true });
    await symlink("../r1", join(p("wsview"), "r1"));
    await setup({ repos: [{ path: "../r1" }], view: "../wsview" });
    mute();
    const r = await doRunProjectWorkspace({ prune: true }, { cwd: host() });
    expect(r.toPrune).toEqual([]);
    expect(r.pruned).toBe(false);
    expect(r.pruneFailures).toEqual([]);
    expect(r.ok).toBe(true);
    await expect(readlink(join(p("wsview"), "r1"))).resolves.toBe("../r1");
  });

  it("withholds pruning entirely while a declared repo is unreachable (no false-delete of an indistinguishable link)", async () => {
    await makeRepo("r1");
    await makeRepo("old");
    await mkdir(p("wsview"), { recursive: true });
    await symlink("../old", join(p("wsview"), "old")); // a genuine de-rostered stray
    await setup({ repos: [{ path: "../r1" }, { path: "../gone" }], view: "../wsview" }); // ../gone does not resolve
    mute();
    const r = await doRunProjectWorkspace({ prune: true }, { cwd: host() });
    expect(r.unreachable).toEqual(["../gone"]);
    expect(r.toPrune).toEqual([{ name: "old", target: "../old" }]);
    expect(r.pruneWithheld).toBe(true);
    expect(r.pruned).toBe(false);
    await expect(readlink(join(p("wsview"), "old"))).resolves.toBe("../old"); // not pruned
  });

  it("never prunes a link that resolves to a CURRENT roster repo under a different name (alias / case)", async () => {
    await makeRepo("r1");
    await mkdir(p("wsview"), { recursive: true });
    await symlink("../r1", join(p("wsview"), "r1")); // canonical link
    await symlink("../r1", join(p("wsview"), "alias")); // a SECOND link to the same in-roster repo
    await setup({ repos: [{ path: "../r1" }], view: "../wsview" });
    mute();
    const r = await doRunProjectWorkspace({ prune: true }, { cwd: host() });
    expect(r.toPrune).toEqual([]); // alias resolves to a rostered repo → owned, never a stray
    expect(r.strayUnknown).toEqual([]);
    await expect(readlink(join(p("wsview"), "alias"))).resolves.toBe("../r1"); // untouched
  });

  it("prunes a stray whose target is a worktree/submodule (a `.git` FILE, not a directory)", async () => {
    await makeRepo("r1");
    await mkdir(p("wt"), { recursive: true });
    await writeFile(join(p("wt"), ".git"), "gitdir: /somewhere/.git/worktrees/wt\n"); // worktree gitdir-pointer FILE
    await mkdir(p("wsview"), { recursive: true });
    await symlink("../wt", join(p("wsview"), "wt")); // a de-rostered stray pointing at a worktree
    await setup({ repos: [{ path: "../r1" }], view: "../wsview" });
    mute();
    const r = await doRunProjectWorkspace({ prune: true }, { cwd: host() });
    expect(r.toPrune).toEqual([{ name: "wt", target: "../wt" }]); // classified repo via existsSync(.git)
    expect(r.pruned).toBe(true);
    await expect(readlink(join(p("wsview"), "wt"))).rejects.toThrow();
    expect(existsSync(p("wt"))).toBe(true); // the worktree dir itself is untouched
  });

  it("classifies an absolute-target stray as unknown (never pruned) via the live scanner", async () => {
    await makeRepo("r1");
    await makeRepo("absrepo");
    await mkdir(p("wsview"), { recursive: true });
    await symlink(p("absrepo"), join(p("wsview"), "absrepo")); // ABSOLUTE target to a real git repo
    await setup({ repos: [{ path: "../r1" }], view: "../wsview" });
    mute();
    const r = await doRunProjectWorkspace({ prune: true }, { cwd: host() });
    expect(r.toPrune).toEqual([]);
    expect(r.strayUnknown).toEqual([{ name: "absrepo", target: p("absrepo"), reason: "absolute" }]);
    await expect(readlink(join(p("wsview"), "absrepo"))).resolves.toBe(p("absrepo"));
  });

  it("classifies a symlink to a loose FILE as a non-repo unknown stray (never pruned)", async () => {
    await makeRepo("r1");
    await writeFile(p("loose.txt"), "x\n");
    await mkdir(p("wsview"), { recursive: true });
    await symlink("../loose.txt", join(p("wsview"), "loose"));
    await setup({ repos: [{ path: "../r1" }], view: "../wsview" });
    mute();
    const r = await doRunProjectWorkspace({ prune: true }, { cwd: host() });
    expect(r.toPrune).toEqual([]);
    expect(r.strayUnknown).toEqual([{ name: "loose", target: "../loose.txt", reason: "non-repo" }]);
  });

  it("surfaces an error (does not report a clean view) when the view path is a file, not a directory", async () => {
    await makeRepo("r1");
    await writeFile(p("wsview"), "not a directory\n"); // workspace.view points at a regular file
    await setup({ repos: [{ path: "../r1" }], view: "../wsview" });
    mute();
    await expect(doRunProjectWorkspace({ prune: true }, { cwd: host() })).rejects.toThrow(
      /走査できません/,
    );
  });

  it("filters the view's own instruction file case-insensitively (no noise on agents.md)", async () => {
    await makeRepo("r1");
    await mkdir(p("wsview"), { recursive: true });
    await symlink("../r1", join(p("wsview"), "r1"));
    await writeFile(p("canonical.md"), "# canonical\n");
    await symlink("../canonical.md", join(p("wsview"), "agents.md")); // lowercase variant
    await setup({ repos: [{ path: "../r1" }], view: "../wsview" });
    mute();
    const r = await doRunProjectWorkspace({ prune: true }, { cwd: host() });
    expect(r.toPrune).toEqual([]);
    expect(r.strayUnknown).toEqual([]); // agents.md filtered, not reported as an unknown stray
    expect(r.ok).toBe(true);
  });
});

describe("gatherExistingViewLinks", () => {
  let parent: string | undefined;
  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "basou-gevl-"));
  });
  afterEach(async () => {
    if (parent !== undefined) await rm(parent, { recursive: true, force: true });
    parent = undefined;
  });
  function p(name: string): string {
    return join(parent as string, name);
  }

  it("returns [] for an absent view directory (ENOENT — not yet generated)", () => {
    expect(gatherExistingViewLinks(p("missing"), new Set())).toEqual([]);
  });

  it("throws (no silent clean) when the view path is a regular file (ENOTDIR)", async () => {
    await writeFile(p("view"), "x\n");
    expect(() => gatherExistingViewLinks(p("view"), new Set())).toThrow(/走査できません/);
  });
});

describe("pruneViewLinks (pre-unlink re-verification)", () => {
  let parent: string | undefined;
  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "basou-pvl-"));
    await mkdir(join(parent, "view"), { recursive: true });
  });
  afterEach(async () => {
    if (parent !== undefined) await rm(parent, { recursive: true, force: true });
    parent = undefined;
  });
  function view(): string {
    return join(parent as string, "view");
  }
  function p(name: string): string {
    return join(parent as string, name);
  }

  it("skips (collects a failure for) a planned name that is no longer a symlink", async () => {
    await writeFile(join(view(), "old"), "became a real file\n"); // not a symlink anymore
    const r = pruneViewLinks(view(), [{ name: "old", target: "../old" }], new Set());
    expect(r.pruned).toEqual([]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]?.name).toBe("old");
    expect(existsSync(join(view(), "old"))).toBe(true); // the real file is left intact
  });

  it("skips a planned name that now resolves to a current roster repo (re-verified ownership)", async () => {
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], {
      cwd: p("."),
      env: ENV,
    }).catch(() => {});
    await mkdir(p("repo"), { recursive: true });
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], {
      cwd: p("repo"),
      env: ENV,
    });
    await symlink("../repo", join(view(), "repo"));
    const realRepo = await import("node:fs").then((m) => m.realpathSync(p("repo")));
    // The plan said prune "repo", but a re-check sees its target is now a rostered repo.
    const r = pruneViewLinks(view(), [{ name: "repo", target: "../repo" }], new Set([realRepo]));
    expect(r.pruned).toEqual([]);
    expect(r.failed).toHaveLength(1);
    await expect(readlink(join(view(), "repo"))).resolves.toBe("../repo"); // not unlinked
  });
});

describe("renderProjectWorkspace", () => {
  const base: ProjectWorkspaceResult = {
    toCreate: [],
    conflicts: [],
    collisions: [],
    unreachable: [],
    toPrune: [],
    strayUnknown: [],
    correctCount: 0,
    ok: true,
    hasView: true,
    applied: false,
    pruned: false,
    pruneWithheld: false,
    failures: [],
    pruneFailures: [],
  };

  it("guides to declare a view when none is set", () => {
    const out = renderProjectWorkspace({ ...base, hasView: false });
    expect(out).toContain("workspace.view");
  });

  it("shows a clean verdict when the view aggregates the whole roster", () => {
    const out = renderProjectWorkspace({ ...base, correctCount: 3 });
    expect(out).toContain("集約しています");
    expect(out).toContain("3 links");
  });

  it("lists planned links with dry-run framing", () => {
    const out = renderProjectWorkspace({
      ...base,
      ok: false,
      toCreate: [{ name: "basou", target: "../basou" }],
    });
    expect(out).toContain("--apply");
    expect(out).toContain("basou -> ../basou");
  });

  it("renders a collision and a blocked conflict accurately", () => {
    const out = renderProjectWorkspace({
      ...base,
      ok: false,
      conflicts: [{ name: "x", reason: "blocked" }],
      collisions: [{ linkName: "pub", repos: ["../a/pub", "../b/pub"] }],
    });
    expect(out).toContain("検査できないパス");
    expect(out).toContain("basename 衝突");
    expect(out).toContain("pub ← ../a/pub, ../b/pub");
  });

  it("on partial --apply failure, lists only created links and shows the failure", () => {
    const out = renderProjectWorkspace({
      ...base,
      ok: false,
      applied: true,
      toCreate: [
        { name: "basou", target: "../basou" },
        { name: "site", target: "../site" },
      ],
      failures: [{ name: "site", message: "EACCES" }],
    });
    expect(out).toContain("一部失敗");
    expect(out).toContain("basou -> ../basou");
    expect(out).not.toContain("site -> ../site");
    expect(out).toContain("site: EACCES");
  });

  it("notes the --prune semantics in the trailing guidance", () => {
    const out = renderProjectWorkspace(base);
    expect(out).toContain("--prune");
    expect(out).toContain("参照先 repo は削除しません");
  });

  it("lists prunable strays with dry-run framing", () => {
    const out = renderProjectWorkspace({
      ...base,
      ok: false,
      toPrune: [{ name: "old", target: "../old" }],
    });
    expect(out).toContain("--prune");
    expect(out).toContain("撤去予定");
    expect(out).toContain("old -> ../old");
  });

  it("on partial --prune failure, lists only removed strays and shows the failure", () => {
    const out = renderProjectWorkspace({
      ...base,
      ok: false,
      pruned: true,
      toPrune: [
        { name: "a", target: "../a" },
        { name: "b", target: "../b" },
      ],
      pruneFailures: [{ name: "b", message: "EACCES" }],
    });
    expect(out).toContain("一部失敗");
    expect(out).toContain("a -> ../a");
    expect(out).not.toContain("b -> ../b");
    expect(out).toContain("b: EACCES");
  });

  it("frames withheld pruning (unreachable repos present) as withheld, not as a dry-run", () => {
    const out = renderProjectWorkspace({
      ...base,
      ok: false,
      unreachable: ["../gone"],
      toPrune: [{ name: "old", target: "../old" }],
      pruneWithheld: true,
    });
    expect(out).toContain("撤去を保留");
    expect(out).toContain("old -> ../old");
    expect(out).not.toContain("撤去するには --prune"); // not the dry-run framing
  });

  it("reports unrecognized strays (broken / non-repo / absolute) as left untouched", () => {
    const out = renderProjectWorkspace({
      ...base,
      ok: false,
      strayUnknown: [
        { name: "dead", target: "../dead", reason: "broken" },
        { name: "notrepo", target: "../notrepo", reason: "non-repo" },
        { name: "abs", target: "/somewhere", reason: "absolute" },
      ],
    });
    expect(out).toContain("未撤去の stray");
    expect(out).toContain("リンク切れ");
    expect(out).toContain("git repo でない");
    expect(out).toContain("絶対パス");
  });
});

describe("basou project preset", () => {
  let parent: string | undefined;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "basou-preset-"));
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
  /** Path of the anchor's canonical for a repo: host/agents/<name>/AGENTS.md. */
  function canonicalPath(name: string): string {
    return join(host(), "agents", name, "AGENTS.md");
  }
  /** Write an existing canonical with the given body (e.g. with or without markers). */
  async function writeCanonical(name: string, body: string): Promise<void> {
    await mkdir(join(host(), "agents", name), { recursive: true });
    await writeFile(canonicalPath(name), body);
  }
  async function setupHostManifest(repos: RepoEntry[]): Promise<void> {
    const paths = await ensureBasouDirectory(host());
    const base = createManifest({ workspaceName: "ws", now: NOW, workspaceId: WS });
    await writeManifest(paths, { ...base, repos });
  }
  function mute(): void {
    vi.spyOn(console, "log").mockImplementation(() => {});
  }

  it("informs when no roster is declared", () => {
    const out = renderProjectPreset({
      plans: [],
      inSync: [],
      undeclared: [],
      markerConflicts: [],
      unreadable: [],
      collisions: [],
      anchors: [],
      unreachable: [],
      ok: true,
      hasRoster: false,
      applied: false,
      failures: [],
    } satisfies ProjectPresetResult);
    expect(out).toContain("ロースターが未宣言");
  });

  it("plans a create for a renderable repo with no canonical (dry-run writes nothing)", async () => {
    await makeRepo("pub");
    await setupHostManifest([{ path: "../pub", visibility: "public", language: "en" }]);
    mute();
    const r = await doRunProjectPreset({}, { cwd: host() });
    expect(r.applied).toBe(false);
    expect(r.plans).toHaveLength(1);
    expect(r.plans[0]?.action).toBe("create");
    expect(r.plans[0]?.path).toBe("../pub");
    expect(existsSync(canonicalPath("pub"))).toBe(false);
  });

  it("--apply creates an absent canonical seeded with the marker-delimited block", async () => {
    await makeRepo("pub");
    await setupHostManifest([
      {
        path: "../pub",
        visibility: "private",
        language: "en",
        publishes: [{ kind: "web", visibility: "public", language: "en+ja" }],
      },
    ]);
    mute();
    const r = await doRunProjectPreset({ apply: true }, { cwd: host() });
    expect(r.applied).toBe(true);
    const body = await readFile(canonicalPath("pub"), "utf8");
    expect(body).toContain(GENERATED_START);
    expect(body).toContain(GENERATED_END);
    expect(body).toContain("ソース可視性: private");
    expect(body).toContain("web(デプロイ) — 公開 / en+ja");
  });

  it("--apply updates only the marker region, preserving hand-authored content", async () => {
    await makeRepo("pub");
    const handBefore = "# pub\n\nhand-written intro\n\n";
    const handAfter = "\n## 技術選定\n\nhand-written policy\n";
    await writeCanonical(
      "pub",
      `${handBefore}${GENERATED_START}\nstale\n${GENERATED_END}${handAfter}`,
    );
    await setupHostManifest([{ path: "../pub", visibility: "public", language: "ja" }]);
    mute();
    const r = await doRunProjectPreset({ apply: true }, { cwd: host() });
    expect(r.plans[0]?.action).toBe("update");
    const body = await readFile(canonicalPath("pub"), "utf8");
    expect(body).toContain("hand-written intro");
    expect(body).toContain("hand-written policy");
    expect(body).toContain("ソース可視性: public");
    expect(body).not.toContain("stale");
  });

  it("is idempotent: a synced canonical reports inSync and --apply changes nothing", async () => {
    await makeRepo("pub");
    await setupHostManifest([{ path: "../pub", visibility: "public", language: "ja" }]);
    mute();
    await doRunProjectPreset({ apply: true }, { cwd: host() });
    const before = await readFile(canonicalPath("pub"), "utf8");
    const r = await doRunProjectPreset({ apply: true }, { cwd: host() });
    expect(r.ok).toBe(true);
    expect(r.inSync).toEqual(["../pub"]);
    expect(r.plans).toEqual([]);
    expect(r.applied).toBe(false);
    expect(await readFile(canonicalPath("pub"), "utf8")).toBe(before);
  });

  it("never overwrites a canonical with no markers (surfaces a conflict with a remedy)", async () => {
    await makeRepo("pub");
    await writeCanonical("pub", "# pub\n\nhand-written, no markers\n");
    await setupHostManifest([{ path: "../pub", visibility: "public" }]);
    mute();
    const r = await doRunProjectPreset({ apply: true }, { cwd: host() });
    expect(r.plans).toEqual([]);
    expect(r.markerConflicts).toEqual([{ repo: "../pub", reason: "no_markers" }]);
    expect(await readFile(canonicalPath("pub"), "utf8")).toBe(
      "# pub\n\nhand-written, no markers\n",
    );
  });

  it("skips the anchor entry and reports undeclared repos", async () => {
    await makeRepo("pub");
    await setupHostManifest([
      { path: ".", visibility: "private" }, // anchor
      { path: "../pub" }, // nothing declared
    ]);
    mute();
    const r = await doRunProjectPreset({}, { cwd: host() });
    expect(r.anchors).toEqual(["."]);
    expect(r.undeclared).toEqual(["../pub"]);
    expect(r.plans).toEqual([]);
  });

  it("reports an unreachable repo (path does not resolve / not a git repo)", async () => {
    await setupHostManifest([{ path: "../gone", visibility: "public" }]);
    mute();
    const r = await doRunProjectPreset({}, { cwd: host() });
    expect(r.unreachable).toEqual(["../gone"]);
    expect(r.plans).toEqual([]);
  });

  it("renders the generated block in the dry-run preview", () => {
    const expected = renderPresetBlock({ visibility: "public", language: "en" });
    const out = renderProjectPreset({
      plans: [{ path: "../pub", canonicalName: "pub", action: "create", desiredBlock: expected }],
      inSync: [],
      undeclared: [],
      markerConflicts: [],
      unreadable: [],
      collisions: [],
      anchors: [],
      unreachable: [],
      ok: false,
      hasRoster: true,
      applied: false,
      failures: [],
    } satisfies ProjectPresetResult);
    expect(out).toContain("生成予定");
    expect(out).toContain("ソース可視性: public");
    expect(out).toContain("agents/pub/AGENTS.md");
  });

  it("surfaces two distinct repos sharing a canonical name as a collision (generates neither)", async () => {
    for (const p of ["a", "b"]) {
      const dir = join(parent as string, p, "pub");
      await mkdir(dir, { recursive: true });
      await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: dir, env: ENV });
    }
    await setupHostManifest([
      { path: "../a/pub", visibility: "public" },
      { path: "../b/pub", visibility: "public" },
    ]);
    mute();
    const r = await doRunProjectPreset({ apply: true }, { cwd: host() });
    expect(r.collisions).toEqual([{ canonicalName: "pub", repos: ["../a/pub", "../b/pub"] }]);
    expect(r.plans).toEqual([]);
    expect(r.applied).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("degrades an unreadable canonical (a directory at the path) without crashing other repos", async () => {
    await makeRepo("pub");
    await makeRepo("ok");
    // A directory where the canonical file should be -> readMarkdownFile throws (EISDIR).
    await mkdir(canonicalPath("pub"), { recursive: true });
    await setupHostManifest([
      { path: "../pub", visibility: "public" },
      { path: "../ok", visibility: "public" },
    ]);
    mute();
    const r = await doRunProjectPreset({}, { cwd: host() });
    expect(r.unreadable).toEqual(["../pub"]);
    // The other repo is still planned — one bad canonical does not blank the report.
    expect(r.plans.map((p) => p.path)).toEqual(["../ok"]);
    expect(r.ok).toBe(false);
  });

  it("surfaces a malformed marker region (missing END) as a conflict and never writes", async () => {
    await makeRepo("pub");
    await writeCanonical("pub", `# pub\n\n${GENERATED_START}\norphan start, no end\n`);
    await setupHostManifest([{ path: "../pub", visibility: "public" }]);
    mute();
    const r = await doRunProjectPreset({ apply: true }, { cwd: host() });
    expect(r.markerConflicts).toEqual([{ repo: "../pub", reason: "missing_end" }]);
    expect(r.plans).toEqual([]);
    expect(r.applied).toBe(false);
    expect(await readFile(canonicalPath("pub"), "utf8")).toBe(
      `# pub\n\n${GENERATED_START}\norphan start, no end\n`,
    );
  });

  it("refuses to replace a symlinked canonical (collects a failure, leaves the link intact)", async () => {
    await makeRepo("pub");
    // A real target with valid markers, and the canonical as a symlink to it.
    await mkdir(join(host(), "agents", "pub"), { recursive: true });
    const target = join(host(), "agents", "pub", "_target.md");
    await writeFile(target, `${GENERATED_START}\nstale\n${GENERATED_END}\n`);
    await symlink("_target.md", canonicalPath("pub"));
    await setupHostManifest([{ path: "../pub", visibility: "public", language: "ja" }]);
    mute();
    const r = await doRunProjectPreset({ apply: true }, { cwd: host() });
    expect(r.applied).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]?.repo).toBe("../pub");
    expect(r.failures[0]?.message).toContain("symlink");
    // The link and its target content are untouched.
    expect(await readlink(canonicalPath("pub"))).toBe("_target.md");
    expect(await readFile(target, "utf8")).toBe(`${GENERATED_START}\nstale\n${GENERATED_END}\n`);
    const out = renderProjectPreset(r);
    expect(out).toContain("書き込みに失敗");
  });

  it("--json emits a parseable result with the full plan shape", async () => {
    await makeRepo("pub");
    await setupHostManifest([{ path: "../pub", visibility: "public", language: "en" }]);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    await doRunProjectPreset({ json: true }, { cwd: host() });
    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0] as string) as ProjectPresetResult;
    expect(parsed.hasRoster).toBe(true);
    expect(parsed.plans[0]?.path).toBe("../pub");
    expect(parsed.plans[0]?.action).toBe("create");
    expect(Array.isArray(parsed.inSync)).toBe(true);
    expect(Array.isArray(parsed.failures)).toBe(true);
    expect(parsed.ok).toBe(false);
  });
});

describe("basou project archive", () => {
  let parent: string | undefined;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "basou-archive-"));
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
  async function setup(opts: {
    repos: RepoEntry[];
    sourceRoots?: string[];
    view?: string;
  }): Promise<void> {
    const paths = await ensureBasouDirectory(host());
    const base = createManifest({ workspaceName: "ws", now: NOW, workspaceId: WS });
    await writeManifest(paths, {
      ...base,
      repos: opts.repos,
      ...(opts.sourceRoots !== undefined ? { import: { source_roots: opts.sourceRoots } } : {}),
      ...(opts.view !== undefined ? { workspace: { ...base.workspace, view: opts.view } } : {}),
    });
  }
  async function manifestOf(): Promise<Awaited<ReturnType<typeof readManifest>>> {
    return readManifest(basouPaths(host()));
  }
  function mute(): void {
    vi.spyOn(console, "log").mockImplementation(() => {});
  }

  it("dry-run reports the plan and writes nothing", async () => {
    await makeRepo("pub");
    await setup({
      repos: [{ path: "." }, { path: "../pub", visibility: "public" }],
      sourceRoots: [".", "../pub"],
    });
    mute();
    const r = await doRunProjectArchive("../pub", {}, { cwd: host() });
    expect(r.found).toBe(true);
    expect(r.applied).toBe(false);
    expect(r.nextRepos.map((e) => e.path)).toEqual(["."]);
    expect(r.sourceRootRemoval).toBe("../pub");
    // Manifest unchanged on dry-run.
    expect((await manifestOf()).repos?.map((e) => e.path)).toEqual([".", "../pub"]);
  });

  it("--apply removes the target from repos and prunes its source_roots entry", async () => {
    await makeRepo("pub");
    await makeRepo("site");
    await setup({
      repos: [{ path: "." }, { path: "../pub", visibility: "public" }, { path: "../site" }],
      sourceRoots: [".", "../pub", "../site", "../view"],
    });
    mute();
    const r = await doRunProjectArchive("../pub", { apply: true }, { cwd: host() });
    expect(r.applied).toBe(true);
    const m = await manifestOf();
    // The written manifest is schema-valid (no repos:[] / empty source_roots corruption).
    expect(() => ManifestSchema.parse(m)).not.toThrow();
    expect(m.repos?.map((e) => e.path)).toEqual([".", "../site"]);
    // The view source-root and the host `.` are preserved — only the target is pruned.
    expect(m.import?.source_roots).toEqual([".", "../site", "../view"]);
  });

  it("refuses to archive the anchor (.) and writes nothing", async () => {
    await makeRepo("pub");
    await setup({ repos: [{ path: "." }, { path: "../pub" }], sourceRoots: [".", "../pub"] });
    mute();
    const r = await doRunProjectArchive(".", { apply: true }, { cwd: host() });
    expect(r.isAnchor).toBe(true);
    expect(r.applied).toBe(false);
    const m = await manifestOf();
    expect(m.repos?.map((e) => e.path)).toEqual([".", "../pub"]);
    expect(m.import?.source_roots).toEqual([".", "../pub"]);
  });

  it("refuses a non-'.' roster path that resolves to the anchor (realpath detection)", async () => {
    // `../host` resolves back to the host (anchor) — the realpath compare must catch it.
    await setup({ repos: [{ path: "." }, { path: "../host", visibility: "private" }] });
    mute();
    const r = await doRunProjectArchive("../host", { apply: true }, { cwd: host() });
    expect(r.isAnchor).toBe(true);
    expect(r.applied).toBe(false);
    expect((await manifestOf()).repos?.map((e) => e.path)).toEqual([".", "../host"]);
  });

  it("reports found:false for a target not in the roster (manifest unchanged)", async () => {
    await setup({ repos: [{ path: "." }], sourceRoots: ["."] });
    mute();
    const r = await doRunProjectArchive("../ghost", { apply: true }, { cwd: host() });
    expect(r.found).toBe(false);
    expect(r.applied).toBe(false);
    expect((await manifestOf()).repos?.map((e) => e.path)).toEqual(["."]);
    const out = renderProjectArchive(r);
    expect(out).toContain("roster に宣言されていません");
  });

  it("reports the repo-side teardown checklist and never touches it on --apply", async () => {
    await makeRepo("pub");
    // Repo-side wiring: instruction file, gitignore pattern, canonical, view symlink.
    await writeFile(join(sibling("pub"), "AGENTS.md"), "x\n");
    await writeFile(join(sibling("pub"), ".gitignore"), "AGENTS.md\n");
    await mkdir(join(host(), "agents", "pub"), { recursive: true });
    await writeFile(join(host(), "agents", "pub", "AGENTS.md"), "canonical\n");
    await mkdir(sibling("view"), { recursive: true });
    await symlink("../pub", join(sibling("view"), "pub"));
    await setup({
      repos: [{ path: "." }, { path: "../pub", visibility: "public" }],
      sourceRoots: [".", "../pub"],
      view: "../view",
    });
    mute();
    const r = await doRunProjectArchive("../pub", { apply: true }, { cwd: host() });
    expect(r.teardown.inspected).toBe(true);
    expect(r.teardown.viewLink).toBe(true);
    expect(r.teardown.instructionFiles).toContain("AGENTS.md");
    expect(r.teardown.gitignorePatterns).toContain("AGENTS.md");
    expect(r.teardown.canonical).toBe(true);
    // Manifest pruned, but every repo-side artifact is left untouched.
    expect((await manifestOf()).repos?.map((e) => e.path)).toEqual(["."]);
    expect(existsSync(join(sibling("pub"), "AGENTS.md"))).toBe(true);
    expect(existsSync(join(host(), "agents", "pub", "AGENTS.md"))).toBe(true);
    expect(await readlink(join(sibling("view"), "pub"))).toBe("../pub");
  });

  it("archives a repo already deleted from disk (teardown not inspected)", async () => {
    await setup({
      repos: [{ path: "." }, { path: "../gone", visibility: "public" }],
      sourceRoots: [".", "../gone"],
    });
    mute();
    const r = await doRunProjectArchive("../gone", { apply: true }, { cwd: host() });
    expect(r.found).toBe(true);
    expect(r.applied).toBe(true);
    expect(r.teardown.inspected).toBe(false);
    expect((await manifestOf()).repos?.map((e) => e.path)).toEqual(["."]);
  });

  it("drops the repos (and emptied import) keys when the last member is archived", async () => {
    await makeRepo("solo");
    await setup({ repos: [{ path: "../solo", visibility: "public" }], sourceRoots: ["../solo"] });
    mute();
    const r = await doRunProjectArchive("../solo", { apply: true }, { cwd: host() });
    expect(r.reposEmptied).toBe(true);
    const m = await manifestOf();
    expect(() => ManifestSchema.parse(m)).not.toThrow();
    expect(m.repos).toBeUndefined();
    expect(m.import).toBeUndefined();
  });

  it("leaves an absent import block absent (never writes an empty import)", async () => {
    await makeRepo("x");
    // No source_roots declared => no import block.
    await setup({ repos: [{ path: "." }, { path: "../x", visibility: "public" }] });
    mute();
    const r = await doRunProjectArchive("../x", { apply: true }, { cwd: host() });
    expect(r.applied).toBe(true);
    expect(r.sourceRootRemoval).toBeUndefined();
    const m = await manifestOf();
    expect(m.repos?.map((e) => e.path)).toEqual(["."]);
    expect(m.import).toBeUndefined();
  });

  it("--json emits a parseable result with the plan and teardown", async () => {
    await makeRepo("pub");
    await setup({
      repos: [{ path: "." }, { path: "../pub", visibility: "public" }],
      sourceRoots: [".", "../pub"],
    });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    await doRunProjectArchive("../pub", { json: true }, { cwd: host() });
    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0] as string) as ProjectArchiveResult;
    expect(parsed.found).toBe(true);
    expect(parsed.target).toBe("../pub");
    expect(parsed.nextRepos.map((e) => e.path)).toEqual(["."]);
    expect(parsed.teardown.inspected).toBe(true);
  });
});

describe("basou project rename", () => {
  let parent: string | undefined;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "basou-rename-"));
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
  async function setup(opts: {
    repos: RepoEntry[];
    sourceRoots?: string[];
    view?: string;
  }): Promise<void> {
    const paths = await ensureBasouDirectory(host());
    const base = createManifest({ workspaceName: "ws", now: NOW, workspaceId: WS });
    await writeManifest(paths, {
      ...base,
      repos: opts.repos,
      ...(opts.sourceRoots !== undefined ? { import: { source_roots: opts.sourceRoots } } : {}),
      ...(opts.view !== undefined ? { workspace: { ...base.workspace, view: opts.view } } : {}),
    });
  }
  async function manifestOf(): Promise<Awaited<ReturnType<typeof readManifest>>> {
    return readManifest(basouPaths(host()));
  }
  function mute(): void {
    vi.spyOn(console, "log").mockImplementation(() => {});
  }

  it("dry-run reports the plan and writes nothing", async () => {
    await setup({
      repos: [{ path: "." }, { path: "../takuhon", visibility: "public", language: "en" }],
      sourceRoots: [".", "../takuhon"],
    });
    mute();
    const r = await doRunProjectRename("../takuhon", "../takuhon-cli", {}, { cwd: host() });
    expect(r.found).toBe(true);
    expect(r.applied).toBe(false);
    expect(r.nextRepos.map((e) => e.path)).toEqual([".", "../takuhon-cli"]);
    expect((await manifestOf()).repos?.map((e) => e.path)).toEqual([".", "../takuhon"]);
  });

  it("--apply re-paths the roster entry and source_roots, preserving other fields", async () => {
    await setup({
      repos: [{ path: "." }, { path: "../takuhon", visibility: "public", language: "en" }],
      sourceRoots: [".", "../takuhon", "../view"],
    });
    mute();
    const r = await doRunProjectRename(
      "../takuhon",
      "../takuhon-cli",
      { apply: true },
      { cwd: host() },
    );
    expect(r.applied).toBe(true);
    const m = await manifestOf();
    expect(() => ManifestSchema.parse(m)).not.toThrow();
    expect(m.repos).toEqual([
      { path: "." },
      { path: "../takuhon-cli", visibility: "public", language: "en" },
    ]);
    // The view source-root and host `.` keep their position; only the target is re-pathed.
    expect(m.import?.source_roots).toEqual([".", "../takuhon-cli", "../view"]);
  });

  it("refuses to rename onto an existing entry (collision)", async () => {
    await setup({
      repos: [{ path: "." }, { path: "../a" }, { path: "../b" }],
    });
    mute();
    const r = await doRunProjectRename("../a", "../b", { apply: true }, { cwd: host() });
    expect(r.collision).toBe(true);
    expect(r.applied).toBe(false);
    expect((await manifestOf()).repos?.map((e) => e.path)).toEqual([".", "../a", "../b"]);
  });

  it("refuses to rename the anchor (.)", async () => {
    await setup({ repos: [{ path: "." }, { path: "../x" }] });
    mute();
    const r = await doRunProjectRename(".", "../root", { apply: true }, { cwd: host() });
    expect(r.isAnchor).toBe(true);
    expect(r.applied).toBe(false);
    expect((await manifestOf()).repos?.map((e) => e.path)).toEqual([".", "../x"]);
  });

  it("is a no-op when old and new normalize to the same path", async () => {
    await setup({ repos: [{ path: "." }, { path: "../x" }] });
    mute();
    const r = await doRunProjectRename("../x", "../x/", { apply: true }, { cwd: host() });
    expect(r.noop).toBe(true);
    expect(r.applied).toBe(false);
    const out = renderProjectRename(r);
    expect(out).toContain("同一です");
  });

  it("reports found:false for a source not in the roster (manifest unchanged)", async () => {
    await setup({ repos: [{ path: "." }] });
    mute();
    const r = await doRunProjectRename("../ghost", "../x", { apply: true }, { cwd: host() });
    expect(r.found).toBe(false);
    expect(r.applied).toBe(false);
    expect((await manifestOf()).repos?.map((e) => e.path)).toEqual(["."]);
  });

  it("reports the anchor-side rename checklist when the basename changes", async () => {
    // canonical dir + view link at the OLD basename.
    await mkdir(join(host(), "agents", "takuhon"), { recursive: true });
    await writeFile(join(host(), "agents", "takuhon", "AGENTS.md"), "canonical\n");
    await mkdir(join(parent as string, "view"), { recursive: true });
    await symlink("../takuhon", join(parent as string, "view", "takuhon"));
    await setup({
      repos: [{ path: "." }, { path: "../takuhon", visibility: "public" }],
      sourceRoots: [".", "../takuhon"],
      view: "../view",
    });
    mute();
    const r = await doRunProjectRename(
      "../takuhon",
      "../takuhon-cli",
      { apply: true },
      { cwd: host() },
    );
    expect(r.basenameChanged).toBe(true);
    expect(r.wiring.canonicalDirOld).toBe(true);
    expect(r.wiring.viewLinkOld).toBe(true);
    // Manifest re-pathed, but the old-named on-disk artifacts are left untouched.
    expect((await manifestOf()).repos?.map((e) => e.path)).toEqual([".", "../takuhon-cli"]);
    expect(existsSync(join(host(), "agents", "takuhon", "AGENTS.md"))).toBe(true);
    expect(await readlink(join(parent as string, "view", "takuhon"))).toBe("../takuhon");
    const out = renderProjectRename(r);
    expect(out).toContain("agents/takuhon/ → agents/takuhon-cli/");
  });

  it("--json emits a parseable result", async () => {
    await setup({
      repos: [{ path: "." }, { path: "../takuhon", visibility: "public" }],
      sourceRoots: [".", "../takuhon"],
    });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    await doRunProjectRename("../takuhon", "../takuhon-cli", { json: true }, { cwd: host() });
    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0] as string) as ProjectRenameResult;
    expect(parsed.found).toBe(true);
    expect(parsed.oldTarget).toBe("../takuhon");
    expect(parsed.newTarget).toBe("../takuhon-cli");
    expect(parsed.nextRepos.map((e) => e.path)).toEqual([".", "../takuhon-cli"]);
  });
});
