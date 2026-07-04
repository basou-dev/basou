import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  doRunProjectDerive,
  doRunProjectGitignore,
  doRunProjectNew,
  doRunProjectPreset,
  doRunProjectRename,
  doRunProjectRetrofit,
  doRunProjectSymlinks,
  doRunProjectSync,
  doRunProjectTeardown,
  doRunProjectWiring,
  doRunProjectWorkspace,
  gatherExistingViewLinks,
  type ProjectAdoptResult,
  type ProjectArchiveResult,
  type ProjectGitignoreResult,
  type ProjectNewResult,
  type ProjectPresetResult,
  type ProjectRenameResult,
  type ProjectRetrofitRepoResult,
  type ProjectRetrofitResult,
  type ProjectSymlinksResult,
  type ProjectSyncResult,
  type ProjectWiringResult,
  type ProjectWorkspaceResult,
  pruneViewLinks,
  renderProjectAdopt,
  renderProjectArchive,
  renderProjectCheck,
  renderProjectGitignore,
  renderProjectNew,
  renderProjectPreset,
  renderProjectRename,
  renderProjectRetrofit,
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

/** Narrow a retrofit result to the repo-argument form (fails the test otherwise). */
function expectRepoRun(r: ProjectRetrofitResult): ProjectRetrofitRepoResult {
  expect(r.kind).toBe("repo");
  if (r.kind !== "repo") throw new Error("expected a repo-argument retrofit result");
  return r;
}

async function setupManifest(opts: {
  repos?: RepoEntry[];
  sourceRoots?: string[];
  extra?: Record<string, unknown>;
}): Promise<void> {
  const paths = await ensureBasouDirectory(repo());
  const base = createManifest({ workspaceName: "ws", now: NOW, workspaceId: WS });
  await writeManifest(paths, {
    ...base,
    ...(opts.repos !== undefined ? { repos: opts.repos } : {}),
    ...(opts.sourceRoots !== undefined ? { import: { source_roots: opts.sourceRoots } } : {}),
    ...(opts.extra ?? {}),
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

  it("--apply preserves an unknown top-level manifest field and surfaces it (no silent drop)", async () => {
    await setupManifest({
      repos: [{ path: "." }, { path: "../takuhon" }, { path: "../bio" }],
      sourceRoots: [".", "../takuhon"], // bio is the gap to sync
      extra: { signing: { key_id: "abc" } }, // a field this basou does not recognize
    });
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      out.push(String(m));
    });
    const r = await doRunProjectSync({ apply: true }, { cwd: repo(), now: () => SYNC_NOW });
    expect(r.applied).toBe(true);
    expect(r.preservedUnknownFields).toEqual(["signing"]);
    expect(out.join("\n")).toContain("signing"); // the advisory names it
    // the unknown field SURVIVED the read-modify-write that previously stripped it
    const after = await readManifest(basouPaths(repo()));
    expect((after as Record<string, unknown>).signing).toEqual({ key_id: "abc" });
    expect(after.import?.source_roots).toEqual([".", "../takuhon", "../bio"]); // and the sync still happened
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
    preservedUnknownFields: [],
  };

  it("explains the no-roster case", () => {
    const out = renderProjectSync({ ...base, hasRoster: false });
    expect(out).toContain("No repo roster declared");
  });

  it("surfaces the preserved-unknown advisory even in an early-return (no-roster) branch", () => {
    const out = renderProjectSync({
      ...base,
      hasRoster: false,
      preservedUnknownFields: ["signing", "zeta"],
    });
    expect(out).toContain("No repo roster declared"); // still the no-roster verdict
    expect(out).toContain("signing, zeta"); // advisory appears before the early return
    expect(out).toContain("Preserving");
  });

  it("reports already-in-sync with a check mark", () => {
    const out = renderProjectSync({ ...base, unchanged: true });
    expect(out).toContain("✅");
    expect(out).toContain("nothing to sync");
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
    expect(out).toContain("nothing is removed");
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
    expect(out).toContain("Added");
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
    expect(out).toContain("3 declared repos");
  });

  it("explains the undeclared-roster case", () => {
    const out = renderProjectCheck({ ...base, capturedCount: 1, extra: ["../x"] });
    expect(out).toContain("No repo roster declared");
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
    extra?: Record<string, unknown>;
  }): Promise<void> {
    const paths = await ensureBasouDirectory(host());
    const base = createManifest({ workspaceName: "ws", now: NOW, workspaceId: WS });
    await writeManifest(paths, {
      ...base,
      ...(opts.repos !== undefined ? { repos: opts.repos } : {}),
      ...(opts.sourceRoots !== undefined ? { import: { source_roots: opts.sourceRoots } } : {}),
      ...(opts.extra ?? {}),
    });
  }

  it("--apply preserves an unknown manifest field and surfaces it (sorted), while bootstrapping the roster", async () => {
    await setupHostManifest({
      sourceRoots: [".", "../sibling"],
      extra: { zeta: 1, signing: { key_id: "abc" } },
    });
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      out.push(String(m));
    });
    const r = await doRunProjectAdopt({ apply: true }, { cwd: host() });
    expect(r.applied).toBe(true);
    expect(r.preservedUnknownFields).toEqual(["signing", "zeta"]); // sorted
    expect(out.join("\n")).toContain("signing");
    const after = await readManifest(basouPaths(host()));
    expect((after as Record<string, unknown>).signing).toEqual({ key_id: "abc" });
    expect((after as Record<string, unknown>).zeta).toBe(1);
    expect(after.repos?.map((x) => x.path)).toEqual([".", "../sibling"]); // roster bootstrapped
  });

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
    preservedUnknownFields: [],
  };

  it("explains the already-declared case (points to check/sync)", () => {
    const out = renderProjectAdopt({ ...base, alreadyDeclared: true });
    expect(out).toContain("already declared");
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
    expect(out).toContain("unresolvable");
  });

  it("applied confirms the write with a check mark", () => {
    const out = renderProjectAdopt({ ...base, repos: [{ path: "." }], applied: true });
    expect(out).toContain("✅");
    expect(out).toContain("Wrote");
  });

  it("reports when nothing was found", () => {
    const out = renderProjectAdopt({ ...base, excluded: [{ path: "../view", kind: "non-repo" }] });
    expect(out).toContain("nothing to bootstrap");
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

  it("instructions: self — a public repo tracking all instruction files is reported as self, not a risk", async () => {
    await makeRepo("blog", [
      { name: "AGENTS.md", tracked: true },
      { name: "CLAUDE.md", tracked: true },
      { name: ".github/copilot-instructions.md", tracked: true },
    ]);
    await setupHostManifest([{ path: "../blog", visibility: "public", instructions: "self" }]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectWiring({}, { cwd: host() });
    expect(r.risks).toEqual([]);
    expect(r.self).toEqual(["../blog"]);
    expect(r.unknown).toEqual([]);
    expect(r.incomplete).toHaveLength(0);
    expect(r.ok).toBe(true);
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
    // The instructions-source axis adds an always-present (additive) `self` bucket.
    expect(parsed.self).toEqual([]);
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
    self: [],
    incomplete: [],
    unreachable: [],
    ok: true,
    hasRoster: true,
  };

  it("explains the no-roster case (points to adopt)", () => {
    const out = renderProjectWiring({ ...base, hasRoster: false });
    expect(out).toContain("No repo roster declared");
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
    expect(out).not.toContain("no privacy risk");
    expect(out).toContain("No confirmed privacy risk");
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

  it("lists a self section explaining committed instruction files are intentional", () => {
    const out = renderProjectWiring({ ...base, self: ["../blog"] });
    expect(out).toContain("instructions: self");
    expect(out).toContain("../blog");
    expect(out).toContain("no leak risk");
  });

  it("lists unknown-visibility, incomplete and unreachable sections", () => {
    const out = renderProjectWiring({
      ...base,
      unknown: ["../x"],
      incomplete: [{ repo: "../y", missing: ["CLAUDE.md"] }],
      unreachable: ["../z"],
      ok: false,
    });
    expect(out).toContain("Visibility unset");
    expect(out).toContain("../x");
    expect(out).toContain("Missing instruction files");
    expect(out).toContain("../y");
    expect(out).toContain("Unreachable");
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

  it("instructions: self — never gitignores a self repo's committed instruction files (even when public)", async () => {
    await makeRepo("blog", "node_modules\n");
    await setupHostManifest([{ path: "../blog", visibility: "public", instructions: "self" }]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectGitignore({ apply: true }, { cwd: host() });
    expect(r.plans).toHaveLength(0);
    expect(r.self).toEqual(["../blog"]);
    expect(r.unknown).toEqual([]);
    expect(r.applied).toBe(false);
    expect(r.ok).toBe(true);
    expect(await gitignoreOf("blog")).toBe("node_modules\n"); // untouched
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
    // The instructions-source axis adds an always-present (additive) `self` bucket.
    expect(parsed.self).toEqual([]);
  });
});

describe("renderProjectGitignore", () => {
  const base: ProjectGitignoreResult = {
    plans: [],
    unknown: [],
    self: [],
    unreachable: [],
    ok: true,
    hasRoster: true,
    applied: false,
  };

  it("explains the no-roster case (points to adopt)", () => {
    const out = renderProjectGitignore({ ...base, hasRoster: false });
    expect(out).toContain("No repo roster declared");
    expect(out).toContain("project adopt");
  });

  it("reports a clean state with a check mark", () => {
    const out = renderProjectGitignore(base);
    expect(out).toContain("✅");
    expect(out).toContain("nothing to add");
  });

  it("does NOT lead with a clean verdict when there are skipped/unreachable repos and nothing to add", () => {
    const out = renderProjectGitignore({ ...base, unknown: ["../x"], ok: false });
    expect(out).not.toContain("nothing to add");
    expect(out).toContain("unjudgeable / unreachable");
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
    expect(out).toContain("nothing is removed");
  });

  it("lists a self section explaining shared committed files are skipped by design", () => {
    const out = renderProjectGitignore({ ...base, self: ["../blog"] });
    expect(out).toContain("instructions: self");
    expect(out).toContain("../blog");
    expect(out).toContain("never gitignored");
  });

  it("applied lists what was added with a check mark", () => {
    const out = renderProjectGitignore({
      ...base,
      plans: [{ path: "../pub", toAdd: ["CLAUDE.md"] }],
      ok: false,
      applied: true,
    });
    expect(out).toContain("✅");
    expect(out).toContain("Added to");
  });

  it("always caveats that .gitignore does not untrack already-tracked files (points to wiring)", () => {
    const out = renderProjectGitignore(base);
    expect(out).toContain("does not untrack");
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
    // The instructions-source axis adds an always-present (additive) bucket.
    expect(parsed.selfAgentsMissing).toEqual([]);
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

  it("instructions: self — wires only the spokes, never an AGENTS.md hub link, and never touches the committed AGENTS.md", async () => {
    await makeRepo("blog");
    // The self repo owns its AGENTS.md as a regular committed file (no anchor canonical).
    await writeFile(join(sibling("blog"), "AGENTS.md"), "hand-authored\n");
    await setupHostManifest([{ path: "../blog", visibility: "public", instructions: "self" }]);
    mute();
    const r = await doRunProjectSymlinks({ apply: true }, { cwd: host() });
    expect(r.plans).toEqual([
      {
        path: "../blog",
        toCreate: [
          { name: "CLAUDE.md", target: "AGENTS.md" },
          { name: ".github/copilot-instructions.md", target: "../AGENTS.md" },
        ],
      },
    ]);
    // The spokes point at the repo's own AGENTS.md...
    expect(await readlink(join(sibling("blog"), "CLAUDE.md"))).toBe("AGENTS.md");
    expect(await readlink(join(sibling("blog"), ".github/copilot-instructions.md"))).toBe(
      "../AGENTS.md",
    );
    // ...and the committed AGENTS.md is left a regular file, untouched.
    await expect(readlink(join(sibling("blog"), "AGENTS.md"))).rejects.toThrow();
    expect(await readFile(join(sibling("blog"), "AGENTS.md"), "utf8")).toBe("hand-authored\n");
  });

  it("instructions: self — reports selfAgentsMissing when the repo has no committed AGENTS.md yet", async () => {
    await makeRepo("blog");
    await setupHostManifest([{ path: "../blog", instructions: "self" }]);
    mute();
    const r = await doRunProjectSymlinks({ apply: true }, { cwd: host() });
    expect(r.selfAgentsMissing).toEqual(["../blog"]);
    expect(r.missingCanonical).toEqual([]);
    expect(r.plans).toEqual([]);
    expect(r.ok).toBe(false);
    // No dangling spokes were created.
    await expect(readlink(join(sibling("blog"), "CLAUDE.md"))).rejects.toThrow();
  });
});

describe("renderProjectSymlinks", () => {
  const base: ProjectSymlinksResult = {
    plans: [],
    conflicts: [],
    missingCanonical: [],
    selfAgentsMissing: [],
    unreachable: [],
    collisions: [],
    ok: true,
    hasRoster: true,
    applied: false,
    failures: [],
    view: { kind: "no-view" },
    viewCreated: [],
    viewFailures: [],
  };

  it("guides to adopt when no roster is declared", () => {
    const out = renderProjectSymlinks({ ...base, hasRoster: false, ok: false });
    expect(out).toContain("project adopt");
  });

  it("shows a clean verdict when everything is wired", () => {
    const out = renderProjectSymlinks(base);
    expect(out).toContain("correctly wired");
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
    expect(out).not.toContain("correctly wired");
    expect(out).toContain("Conflicts");
    expect(out).toContain("Canonical missing");
  });

  it("lists a selfAgentsMissing section pointing the operator to author AGENTS.md", () => {
    const out = renderProjectSymlinks({ ...base, ok: false, selfAgentsMissing: ["../blog"] });
    expect(out).not.toContain("correctly wired");
    expect(out).toContain("AGENTS.md missing");
    expect(out).toContain("instructions: self");
    expect(out).toContain("../blog");
  });

  it("applied shows a check mark and created wording", () => {
    const out = renderProjectSymlinks({
      ...base,
      ok: false,
      applied: true,
      plans: [{ path: "../pub", toCreate: [{ name: "CLAUDE.md", target: "AGENTS.md" }] }],
    });
    expect(out).toContain("✅");
    expect(out).toContain("Created instruction-file symlinks");
  });

  it("renders a canonical collision", () => {
    const out = renderProjectSymlinks({
      ...base,
      ok: false,
      collisions: [{ canonicalName: "pub", repos: ["../x/pub", "../y/pub"] }],
    });
    expect(out).toContain("Canonical collisions");
    expect(out).toContain("agents/pub/AGENTS.md");
    expect(out).toContain("../x/pub");
  });

  it("renders a blocked conflict with an accurate (not 'real file') description", () => {
    const out = renderProjectSymlinks({
      ...base,
      ok: false,
      conflicts: [{ repo: "../pub", file: ".github/copilot-instructions.md", reason: "blocked" }],
    });
    expect(out).toContain("uninspectable path");
    expect(out).not.toContain("a real file/directory, not a symlink");
  });

  it("renders --apply failures", () => {
    const out = renderProjectSymlinks({
      ...base,
      ok: false,
      failures: [{ repo: "../pub", file: "AGENTS.md", message: "EACCES" }],
    });
    expect(out).toContain("Creation failed");
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
    expect(out).toContain("some failed");
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
    expect(out).toContain("Could not create");
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

  it("treats an ABSOLUTE-target link resolving to a current roster repo as owned (not a stray)", async () => {
    await makeRepo("r1");
    await mkdir(p("wsview"), { recursive: true });
    await symlink("../r1", join(p("wsview"), "r1")); // canonical relative link
    await symlink(p("r1"), join(p("wsview"), "abs")); // ABSOLUTE link to the SAME rostered repo
    await setup({ repos: [{ path: "../r1" }], view: "../wsview" });
    mute();
    const r = await doRunProjectWorkspace({ prune: true }, { cwd: host() });
    expect(r.toPrune).toEqual([]);
    expect(r.strayUnknown).toEqual([]); // owned by realpath before the absolute branch — no false-dirty
    expect(r.ok).toBe(true);
    await expect(readlink(join(p("wsview"), "abs"))).resolves.toBe(p("r1")); // untouched
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
      /Cannot scan the workspace view/,
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
    expect(() => gatherExistingViewLinks(p("view"), new Set())).toThrow(
      /Cannot scan the workspace view/,
    );
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
    expect(out).toContain("aggregates the entire declared roster");
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
    expect(out).toContain("uninspectable path");
    expect(out).toContain("Basename collisions");
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
    expect(out).toContain("some failed");
    expect(out).toContain("basou -> ../basou");
    expect(out).not.toContain("site -> ../site");
    expect(out).toContain("site: EACCES");
  });

  it("notes the --prune semantics in the trailing guidance", () => {
    const out = renderProjectWorkspace(base);
    expect(out).toContain("--prune");
    expect(out).toContain("never the referenced repo");
  });

  it("lists prunable strays with dry-run framing", () => {
    const out = renderProjectWorkspace({
      ...base,
      ok: false,
      toPrune: [{ name: "old", target: "../old" }],
    });
    expect(out).toContain("--prune");
    expect(out).toContain("to prune");
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
    expect(out).toContain("some failed");
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
    expect(out).toContain("pruning was withheld");
    expect(out).toContain("old -> ../old");
    expect(out).not.toContain("pass --prune to remove"); // not the dry-run framing
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
    expect(out).toContain("Strays left in place");
    expect(out).toContain("broken link");
    expect(out).toContain("non-git-repo target");
    expect(out).toContain("absolute-path target");
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
      self: [],
      unreachable: [],
      ok: true,
      hasRoster: false,
      applied: false,
      failures: [],
      view: { kind: "no-view" },
      viewApplied: false,
    } satisfies ProjectPresetResult);
    expect(out).toContain("No repo roster declared");
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

  it("instructions: self — never writes a preset block into the repo's hand-authored AGENTS.md", async () => {
    await makeRepo("blog");
    // The self repo has a hand-authored AGENTS.md with markers; preset must still leave it alone.
    await writeFile(
      join(sibling("blog"), "AGENTS.md"),
      `# blog\n\n${GENERATED_START}\nstale\n${GENERATED_END}\n`,
    );
    await setupHostManifest([
      { path: "../blog", visibility: "public", language: "ja", instructions: "self" },
    ]);
    mute();
    const r = await doRunProjectPreset({ apply: true }, { cwd: host() });
    expect(r.self).toEqual(["../blog"]);
    expect(r.plans).toEqual([]);
    expect(r.applied).toBe(false);
    expect(r.ok).toBe(true);
    // No anchor canonical was created, and the repo's AGENTS.md is byte-for-byte unchanged.
    expect(existsSync(canonicalPath("blog"))).toBe(false);
    expect(await readFile(join(sibling("blog"), "AGENTS.md"), "utf8")).toBe(
      `# blog\n\n${GENERATED_START}\nstale\n${GENERATED_END}\n`,
    );
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
      self: [],
      unreachable: [],
      ok: false,
      hasRoster: true,
      applied: false,
      failures: [],
      view: { kind: "no-view" },
      viewApplied: false,
    } satisfies ProjectPresetResult);
    expect(out).toContain("Preset blocks to generate");
    expect(out).toContain("ソース可視性: public");
    expect(out).toContain("agents/pub/AGENTS.md");
  });

  it("renders a self section explaining the hand-authored AGENTS.md is never written", () => {
    const out = renderProjectPreset({
      plans: [],
      inSync: [],
      undeclared: [],
      markerConflicts: [],
      unreadable: [],
      collisions: [],
      anchors: [],
      self: ["../blog"],
      unreachable: [],
      ok: true,
      hasRoster: true,
      applied: false,
      failures: [],
      view: { kind: "no-view" },
      viewApplied: false,
    } satisfies ProjectPresetResult);
    expect(out).toContain("instructions: self");
    expect(out).toContain("../blog");
    expect(out).toContain("hands-off");
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
    expect(out).toContain("Write failed");
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
    // The instructions-source axis adds an always-present (additive) `self` bucket.
    expect(parsed.self).toEqual([]);
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
    extra?: Record<string, unknown>;
  }): Promise<void> {
    const paths = await ensureBasouDirectory(host());
    const base = createManifest({ workspaceName: "ws", now: NOW, workspaceId: WS });
    await writeManifest(paths, {
      ...base,
      repos: opts.repos,
      ...(opts.sourceRoots !== undefined ? { import: { source_roots: opts.sourceRoots } } : {}),
      ...(opts.view !== undefined ? { workspace: { ...base.workspace, view: opts.view } } : {}),
      ...(opts.extra ?? {}),
    });
  }
  async function manifestOf(): Promise<Awaited<ReturnType<typeof readManifest>>> {
    return readManifest(basouPaths(host()));
  }
  function mute(): void {
    vi.spyOn(console, "log").mockImplementation(() => {});
  }

  it("--apply preserves an unknown manifest field and surfaces it while pruning the target", async () => {
    await makeRepo("pub");
    await setup({
      repos: [{ path: "." }, { path: "../pub" }],
      sourceRoots: [".", "../pub"],
      extra: { signing: { key_id: "abc" } },
    });
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      out.push(String(m));
    });
    const r = await doRunProjectArchive("../pub", { apply: true }, { cwd: host() });
    expect(r.applied).toBe(true);
    expect(r.preservedUnknownFields).toEqual(["signing"]);
    expect(out.join("\n")).toContain("signing");
    const after = await manifestOf();
    expect((after as Record<string, unknown>).signing).toEqual({ key_id: "abc" });
    expect(after.repos?.map((e) => e.path)).toEqual(["."]); // ../pub pruned
  });

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
    expect(out).toContain("not declared in the roster");
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
    extra?: Record<string, unknown>;
  }): Promise<void> {
    const paths = await ensureBasouDirectory(host());
    const base = createManifest({ workspaceName: "ws", now: NOW, workspaceId: WS });
    await writeManifest(paths, {
      ...base,
      repos: opts.repos,
      ...(opts.sourceRoots !== undefined ? { import: { source_roots: opts.sourceRoots } } : {}),
      ...(opts.view !== undefined ? { workspace: { ...base.workspace, view: opts.view } } : {}),
      ...(opts.extra ?? {}),
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

  it("--apply preserves an unknown manifest field and surfaces it while re-pathing", async () => {
    await setup({
      repos: [{ path: "." }, { path: "../takuhon" }],
      sourceRoots: [".", "../takuhon"],
      extra: { signing: { key_id: "abc" } },
    });
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      out.push(String(m));
    });
    const r = await doRunProjectRename(
      "../takuhon",
      "../takuhon-cli",
      { apply: true },
      { cwd: host() },
    );
    expect(r.applied).toBe(true);
    expect(r.preservedUnknownFields).toEqual(["signing"]);
    expect(out.join("\n")).toContain("signing");
    const after = await manifestOf();
    expect((after as Record<string, unknown>).signing).toEqual({ key_id: "abc" });
    expect(after.repos?.map((e) => e.path)).toEqual([".", "../takuhon-cli"]); // re-pathed
  });

  it("surfaces the preserved-unknown advisory even on a dry-run (preservation is not gated by --apply)", async () => {
    await setup({
      repos: [{ path: "." }, { path: "../takuhon" }],
      sourceRoots: [".", "../takuhon"],
      extra: { signing: { key_id: "abc" } },
    });
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      out.push(String(m));
    });
    const r = await doRunProjectRename("../takuhon", "../takuhon-cli", {}, { cwd: host() }); // no --apply
    expect(r.applied).toBe(false);
    expect(r.preservedUnknownFields).toEqual(["signing"]);
    expect(out.join("\n")).toContain("signing"); // advisory shows in dry-run too
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
    expect(out).toContain("are identical");
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

describe("basou project teardown", () => {
  let parent: string | undefined;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "basou-teardown-"));
    await mkdir(join(parent, "host"), { recursive: true });
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], {
      cwd: join(parent, "host"),
      env: ENV,
    });
  });
  afterEach(async () => {
    if (parent !== undefined) await rm(parent, { recursive: true, force: true });
    parent = undefined;
    process.exitCode = 0;
    vi.restoreAllMocks();
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
  function mute(): void {
    vi.spyOn(console, "log").mockImplementation(() => {});
  }
  /** Wire a public repo end-to-end via the real generators: canonical preset,
   * instruction symlinks, .gitignore patterns, and the workspace view symlink. */
  async function wirePub(): Promise<void> {
    const paths = await ensureBasouDirectory(host());
    const base = createManifest({ workspaceName: "ws", now: NOW, workspaceId: WS });
    await writeManifest(paths, {
      ...base,
      workspace: { ...base.workspace, view: "../view" },
      repos: [{ path: "." }, { path: "../pub", visibility: "public", language: "en" }],
    });
    mute();
    await doRunProjectPreset({ apply: true }, { cwd: host() });
    await doRunProjectSymlinks({ apply: true }, { cwd: host() });
    await doRunProjectGitignore({ apply: true }, { cwd: host() });
    await doRunProjectWorkspace({ apply: true }, { cwd: host() });
  }

  it("dry-run classifies every generated artifact as removable and removes nothing", async () => {
    await makeRepo("pub");
    await wirePub();
    const r = await doRunProjectTeardown("../pub", {}, { cwd: host() });

    expect(r.isAnchor).toBe(false);
    expect(r.applied).toBe(false);
    // Provably-owned artifacts: 3 instruction symlinks + view link + canonical block.
    const kinds = r.items
      .filter((i) => i.state === "removable")
      .map((i) => i.kind)
      .sort();
    expect(kinds).toEqual(
      [
        "canonical-block",
        "instruction-symlink",
        "instruction-symlink",
        "instruction-symlink",
        "view-symlink",
      ].sort(),
    );
    expect(r.removableCount).toBe(5);
    // .gitignore lines are unprovable (no marker) → reported as manual, never auto-removed.
    const gi = r.items.filter((i) => i.kind === "gitignore");
    expect(gi.length).toBe(3);
    expect(gi.every((i) => i.state === "manual")).toBe(true);
    // dry-run touches nothing
    expect(await readlink(join(sibling("pub"), "AGENTS.md"))).toBe("../host/agents/pub/AGENTS.md");
    expect(existsSync(join(parent as string, "view", "pub"))).toBe(true);
  });

  it("--apply removes the verified artifacts, strips the canonical block, leaves .gitignore", async () => {
    await makeRepo("pub");
    await wirePub();
    const r = await doRunProjectTeardown("../pub", { apply: true }, { cwd: host() });

    expect(r.applied).toBe(true);
    expect(r.failed).toEqual([]);
    expect(r.removed.length).toBe(5);
    // instruction symlinks gone
    await expect(readlink(join(sibling("pub"), "AGENTS.md"))).rejects.toThrow();
    await expect(readlink(join(sibling("pub"), "CLAUDE.md"))).rejects.toThrow();
    // view symlink gone
    expect(existsSync(join(parent as string, "view", "pub"))).toBe(false);
    // canonical generated block stripped (markers gone)
    const canon = await readFile(join(host(), "agents", "pub", "AGENTS.md"), "utf8");
    expect(canon).not.toContain("BASOU:GENERATED");
    // .gitignore is NOT auto-removed (unprovable ownership) — the line stays.
    const gi = await readFile(join(sibling("pub"), ".gitignore"), "utf8");
    expect(gi).toContain("AGENTS.md");
  });

  it("never removes a foreign (real-file) instruction file", async () => {
    await makeRepo("pub");
    await wirePub();
    // Replace the AGENTS.md symlink with a real file — now foreign.
    await rm(join(sibling("pub"), "AGENTS.md"));
    await writeFile(join(sibling("pub"), "AGENTS.md"), "hand-written\n");

    const r = await doRunProjectTeardown("../pub", { apply: true }, { cwd: host() });
    const agents = r.items.find((i) => i.kind === "instruction-symlink" && i.label === "AGENTS.md");
    expect(agents?.state).toBe("foreign");
    // the real file survived --apply
    expect(await readFile(join(sibling("pub"), "AGENTS.md"), "utf8")).toBe("hand-written\n");
    expect(r.removed).not.toContain("AGENTS.md");
  });

  it("instructions: self — never removes the repo's committed AGENTS.md or its committed spokes", async () => {
    await makeRepo("blog");
    // A self repo owns its AGENTS.md as a regular committed file.
    await writeFile(join(sibling("blog"), "AGENTS.md"), "hand-authored\n");
    const paths = await ensureBasouDirectory(host());
    const base = createManifest({ workspaceName: "ws", now: NOW, workspaceId: WS });
    await writeManifest(paths, {
      ...base,
      workspace: { ...base.workspace, view: "../view" },
      repos: [{ path: "." }, { path: "../blog", visibility: "public", instructions: "self" }],
    });
    mute();
    // Wire the committed spokes (CLAUDE.md / copilot → AGENTS.md) and the view link.
    await doRunProjectSymlinks({ apply: true }, { cwd: host() });
    await doRunProjectWorkspace({ apply: true }, { cwd: host() });

    const r = await doRunProjectTeardown("../blog", { apply: true }, { cwd: host() });
    // Every instruction file is reported foreign (committed, left untouched), none removable.
    const instr = r.items.filter((i) => i.kind === "instruction-symlink");
    expect(instr.length).toBeGreaterThan(0);
    expect(instr.every((i) => i.state === "foreign")).toBe(true);
    // The committed files all survive --apply.
    expect(await readFile(join(sibling("blog"), "AGENTS.md"), "utf8")).toBe("hand-authored\n");
    expect(await readlink(join(sibling("blog"), "CLAUDE.md"))).toBe("AGENTS.md");
    expect(await readlink(join(sibling("blog"), ".github/copilot-instructions.md"))).toBe(
      "../AGENTS.md",
    );
    expect(r.removed).not.toContain("AGENTS.md");
    expect(r.removed).not.toContain("CLAUDE.md");
    // The basou-generated view link is still basou's, so it IS torn down.
    expect(existsSync(join(parent as string, "view", "blog"))).toBe(false);
  });

  it("refuses to tear down the anchor (`.`)", async () => {
    await makeRepo("pub");
    await wirePub();
    const r = await doRunProjectTeardown(".", { apply: true }, { cwd: host() });
    expect(r.isAnchor).toBe(true);
    expect(r.removableCount).toBe(0);
    expect(r.applied).toBe(false);
    expect(r.removed).toEqual([]);
  });

  it("blocks the shared canonical when another repo has the same basename", async () => {
    // Two repos named `pub` under different parents share `agents/pub/AGENTS.md`.
    for (const p of ["a/pub", "b/pub"]) {
      await mkdir(sibling(p), { recursive: true });
      await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], {
        cwd: sibling(p),
        env: ENV,
      });
    }
    const paths = await ensureBasouDirectory(host());
    const base = createManifest({ workspaceName: "ws", now: NOW, workspaceId: WS });
    await writeManifest(paths, {
      ...base,
      repos: [
        { path: "." },
        { path: "../a/pub", visibility: "public" },
        { path: "../b/pub", visibility: "public" },
      ],
    });
    const canonDir = join(host(), "agents", "pub");
    await mkdir(canonDir, { recursive: true });
    await writeFile(
      join(canonDir, "AGENTS.md"),
      "intro\n<!-- BASOU:GENERATED:START -->\ngen\n<!-- BASOU:GENERATED:END -->\n",
    );
    mute();
    const r = await doRunProjectTeardown("../a/pub", { apply: true }, { cwd: host() });
    const canon = r.items.find((i) => i.kind === "canonical-block");
    expect(canon?.state).toBe("blocked");
    expect(r.removableCount).toBe(0);
    // the shared block survived
    expect(await readFile(join(canonDir, "AGENTS.md"), "utf8")).toContain("BASOU:GENERATED");
  });

  it("treats a symlinked canonical as foreign and never rewrites it", async () => {
    await makeRepo("pub");
    await wirePub();
    // Swap the canonical for a symlink — must be classified foreign, never followed.
    const canonFile = join(host(), "agents", "pub", "AGENTS.md");
    const decoy = join(host(), "agents", "pub", "real.md");
    await writeFile(
      decoy,
      "intro\n<!-- BASOU:GENERATED:START -->\ngen\n<!-- BASOU:GENERATED:END -->\n",
    );
    await rm(canonFile);
    await symlink("real.md", canonFile);

    const r = await doRunProjectTeardown("../pub", { apply: true }, { cwd: host() });
    const canon = r.items.find((i) => i.kind === "canonical-block");
    expect(canon?.state).toBe("foreign");
    // the symlink target's block is untouched
    expect(await readFile(decoy, "utf8")).toContain("BASOU:GENERATED");
    expect(r.removed.some((x) => x.includes("agents"))).toBe(false);
  });

  it("does not auto-remove the canonical when the repo path is unresolvable", async () => {
    await makeRepo("pub");
    await wirePub();
    // A canonical for `ghost` exists but `../ghost` does not resolve and is NOT in
    // the roster (no basename collision). Ownership of the basename-keyed canonical
    // cannot be proven without the repo, so it is `manual`, never auto-removed.
    const ghostDir = join(host(), "agents", "ghost");
    await mkdir(ghostDir, { recursive: true });
    await writeFile(
      join(ghostDir, "AGENTS.md"),
      "intro\n<!-- BASOU:GENERATED:START -->\ngen\n<!-- BASOU:GENERATED:END -->\n",
    );
    const r = await doRunProjectTeardown("../ghost", { apply: true }, { cwd: host() });
    expect(r.resolved).toBe(false);
    const canon = r.items.find((i) => i.kind === "canonical-block");
    expect(canon?.state).toBe("manual");
    expect(r.removableCount).toBe(0);
    expect(await readFile(join(ghostDir, "AGENTS.md"), "utf8")).toContain("BASOU:GENERATED");
  });
});

describe("basou project new", () => {
  let parent: string | undefined;

  beforeEach(async () => {
    // A workspace parent holding the anchor (the current git repo), a git sibling
    // (a valid roster member), and a non-git sibling (an invalid one).
    parent = await mkdtemp(join(tmpdir(), "basou-new-"));
    const anchor = join(parent, "anchor");
    const sibling = join(parent, "sibling");
    const notrepo = join(parent, "notrepo");
    await mkdir(anchor, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await mkdir(notrepo, { recursive: true });
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], {
      cwd: anchor,
      env: ENV,
    });
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], {
      cwd: sibling,
      env: ENV,
    });
  });
  afterEach(async () => {
    if (parent !== undefined) await rm(parent, { recursive: true, force: true });
    parent = undefined;
  });
  function anchor(): string {
    if (parent === undefined) throw new Error("parent not initialized");
    return join(parent, "anchor");
  }

  it("dry-run writes nothing and plans the anchor-only roster with a default view", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectNew([], {}, { cwd: anchor() });
    expect(r.applied).toBe(false);
    expect(r.repos).toEqual([{ path: "." }]);
    expect(r.view).toBe("../anchor-workspace");
    expect(r.sourceRoots).toEqual([".", "../anchor-workspace"]);
    // Nothing on disk.
    expect(existsSync(basouPaths(anchor()).files.manifest)).toBe(false);
  });

  it("--apply creates .basou + manifest (anchor + given repos, view in source_roots)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectNew(["../sibling"], { apply: true }, { cwd: anchor() });
    expect(r.applied).toBe(true);
    const after = await readManifest(basouPaths(anchor()));
    expect(after.repos).toEqual([{ path: "." }, { path: "../sibling" }]);
    expect(after.workspace.view).toBe("../anchor-workspace");
    expect(after.import?.source_roots).toEqual([".", "../sibling", "../anchor-workspace"]);
    // The .gitignore block was appended (best-effort step ran).
    expect(await readFile(join(anchor(), ".gitignore"), "utf8")).toContain(".basou");
  });

  it("throws (pathless) when a declared repo is not a git repository", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(
      doRunProjectNew(["../notrepo"], { apply: true }, { cwd: anchor() }),
    ).rejects.toThrow(/not git repositories/);
    // The error message names the path relatively, never absolutely.
    await expect(
      doRunProjectNew(["../notrepo"], { apply: true }, { cwd: anchor() }),
    ).rejects.toThrow(/\.\.\/notrepo/);
    expect(existsSync(basouPaths(anchor()).files.manifest)).toBe(false);
  });

  it("--no-view (commander view:false) seeds no workspace.view and keeps it out of source_roots", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectNew([], { apply: true, view: false }, { cwd: anchor() });
    expect(r.view).toBeNull();
    expect(r.sourceRoots).toEqual(["."]);
    const after = await readManifest(basouPaths(anchor()));
    expect(after.workspace.view).toBeUndefined();
    expect(after.import?.source_roots).toEqual(["."]);
  });

  it("--view overrides the default view path", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectNew([], { apply: true, view: "../custom-view" }, { cwd: anchor() });
    expect(r.view).toBe("../custom-view");
    const after = await readManifest(basouPaths(anchor()));
    expect(after.workspace.view).toBe("../custom-view");
    expect(after.import?.source_roots).toEqual([".", "../custom-view"]);
  });

  it("dedupes a given repo that resolves to the anchor itself", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await doRunProjectNew(["."], { apply: true }, { cwd: anchor() });
    expect(r.repos).toEqual([{ path: "." }]); // not [".", "."]
  });

  it("--apply refuses (throws) when a manifest already exists without --force", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await doRunProjectNew([], { apply: true }, { cwd: anchor() });
    await expect(doRunProjectNew([], { apply: true }, { cwd: anchor() })).rejects.toThrow(
      /Already initialized/,
    );
  });

  it("dry-run flags an existing manifest as needing --force", async () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      out.push(String(m));
    });
    await doRunProjectNew([], { apply: true }, { cwd: anchor() });
    const r = await doRunProjectNew([], {}, { cwd: anchor() });
    expect(r.existed).toBe(true);
    expect(r.applied).toBe(false);
    expect(out.join("\n")).toContain("--force");
  });

  it("--force overwrites an existing manifest", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await doRunProjectNew([], { apply: true }, { cwd: anchor() });
    const r = await doRunProjectNew(
      ["../sibling"],
      { apply: true, force: true },
      { cwd: anchor() },
    );
    expect(r.applied).toBe(true);
    const after = await readManifest(basouPaths(anchor()));
    expect(after.repos).toEqual([{ path: "." }, { path: "../sibling" }]);
  });

  it("throws a 'git init' hint when the cwd is not a git repository", async () => {
    if (parent === undefined) throw new Error("parent not initialized");
    const bare = join(parent, "notrepo");
    await expect(doRunProjectNew([], {}, { cwd: bare })).rejects.toThrow(/Run 'git init' first/);
  });

  it("--json prints the machine-readable result", async () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      out.push(String(m));
    });
    await doRunProjectNew(["../sibling"], { json: true }, { cwd: anchor() });
    const parsed = JSON.parse(out.join("\n")) as ProjectNewResult;
    expect(parsed.repos).toEqual([{ path: "." }, { path: "../sibling" }]);
    expect(parsed.view).toBe("../anchor-workspace");
  });

  it("renderProjectNew shows the roster, view, and next-step guidance", () => {
    const text = renderProjectNew({
      workspaceName: "anchor",
      repos: [{ path: "." }, { path: "../sibling" }],
      view: "../anchor-workspace",
      sourceRoots: [".", "../sibling", "../anchor-workspace"],
      invalidRepos: [],
      existed: false,
      applied: true,
    });
    expect(text).toContain("../sibling");
    expect(text).toContain("../anchor-workspace");
    expect(text).toContain("basou project derive");
  });

  it("--apply --verbose .gitignore failure does not leak absolute paths", async () => {
    // A `.gitignore` directory makes appendBasouGitignore fail (EISDIR). The
    // best-effort try/catch must keep --apply succeeding, and the verbose
    // warning must surface only the pathless cause label — never the absolute
    // repo path that the native fs error embeds.
    await mkdir(join(anchor(), ".gitignore"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const r = await doRunProjectNew([], { apply: true, verbose: true }, { cwd: anchor() });
    expect(r.applied).toBe(true);
    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("Warning: Could not update .gitignore");
    expect(stderr).toContain("Caused by:");
    expect(stderr).not.toContain(anchor());
  });
});

describe("basou project derive", () => {
  const DERIVE_NOW = new Date("2026-06-26T12:00:00.000Z");
  let parent: string | undefined;

  beforeEach(async () => {
    // Anchor (manifest host) + one public git sibling. The view is a sibling dir.
    parent = await mkdtemp(join(tmpdir(), "basou-derive-"));
    const anchor = join(parent, "anchor");
    const sibling = join(parent, "sibling");
    await mkdir(anchor, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await mkdir(join(parent, "anchor-workspace"), { recursive: true });
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], {
      cwd: anchor,
      env: ENV,
    });
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], {
      cwd: sibling,
      env: ENV,
    });
  });
  afterEach(async () => {
    if (parent !== undefined) await rm(parent, { recursive: true, force: true });
    parent = undefined;
  });
  function anchor(): string {
    if (parent === undefined) throw new Error("parent not initialized");
    return join(parent, "anchor");
  }
  async function setupAnchorManifest(opts: {
    repos?: RepoEntry[];
    sourceRoots?: string[];
    view?: string;
  }): Promise<void> {
    const paths = await ensureBasouDirectory(anchor());
    const base = createManifest({
      workspaceName: "anchor",
      now: NOW,
      workspaceId: WS,
      ...(opts.sourceRoots !== undefined ? { sourceRoots: opts.sourceRoots } : {}),
    });
    await writeManifest(paths, {
      ...base,
      ...(opts.repos !== undefined ? { repos: opts.repos } : {}),
      ...(opts.view !== undefined ? { workspace: { ...base.workspace, view: opts.view } } : {}),
    });
  }

  it("no-op (not an error) when no roster is declared", async () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      out.push(String(m));
    });
    await setupAnchorManifest({}); // no repos
    await doRunProjectDerive({}, { cwd: anchor() });
    expect(out.join("\n")).toContain("No repo roster declared");
    expect(process.exitCode === 1).toBe(false);
  });

  it("dry-run runs all five sections and writes nothing", async () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      out.push(String(m));
    });
    await setupAnchorManifest({
      repos: [
        { path: ".", visibility: "private" },
        { path: "../sibling", visibility: "public", language: "en" },
      ],
      sourceRoots: ["."],
      view: "../anchor-workspace",
    });
    await doRunProjectDerive({}, { cwd: anchor() });
    const text = out.join("\n");
    expect(text).toContain("1/5");
    expect(text).toContain("2/5");
    expect(text).toContain("3/5");
    expect(text).toContain("4/5");
    expect(text).toContain("5/5");
    // source_roots NOT written (dry-run): still just ["."].
    const after = await readManifest(basouPaths(anchor()));
    expect(after.import?.source_roots).toEqual(["."]);
    // No canonical, no view symlink generated.
    expect(existsSync(join(anchor(), "agents", "sibling", "AGENTS.md"))).toBe(false);
  });

  it("--apply runs sync -> preset -> symlinks -> workspace -> gitignore in order", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await setupAnchorManifest({
      repos: [
        { path: ".", visibility: "private" },
        { path: "../sibling", visibility: "public", language: "en" },
      ],
      sourceRoots: ["."],
      view: "../anchor-workspace",
    });
    await doRunProjectDerive({ apply: true }, { cwd: anchor(), now: () => DERIVE_NOW });

    const after = await readManifest(basouPaths(anchor()));
    // sync: source_roots now cover the declared sibling (additive over ".").
    expect(after.import?.source_roots).toContain("../sibling");

    // preset: the sibling's canonical was created at the anchor.
    expect(existsSync(join(anchor(), "agents", "sibling", "AGENTS.md"))).toBe(true);

    // symlinks: the sibling's AGENTS.md is a symlink at the canonical.
    const link = await readlink(join(parent ?? "", "sibling", "AGENTS.md"));
    expect(link).toContain("agents/sibling/AGENTS.md");

    // workspace: the view aggregates the sibling via a basename symlink.
    expect(existsSync(join(parent ?? "", "anchor-workspace", "sibling"))).toBe(true);

    // gitignore: the public sibling now ignores the instruction files.
    const gi = await readFile(join(parent ?? "", "sibling", ".gitignore"), "utf8");
    expect(gi).toContain("AGENTS.md");
  });
});

describe("basou project retrofit", () => {
  let parent: string | undefined;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "basou-retrofit-"));
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
  async function makeRepo(name: string): Promise<string> {
    const dir = sibling(name);
    await mkdir(dir, { recursive: true });
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: dir, env: ENV });
    return dir;
  }
  async function setupHostManifest(repos: RepoEntry[]): Promise<void> {
    const paths = await ensureBasouDirectory(host());
    const base = createManifest({ workspaceName: "ws", now: NOW, workspaceId: WS });
    await writeManifest(paths, { ...base, repos });
  }
  function mute(): void {
    vi.spyOn(console, "log").mockImplementation(() => {});
  }

  it("dry-run plans a relocate for a regular-file AGENTS.md and writes nothing", async () => {
    const dir = await makeRepo("foo");
    await writeFile(join(dir, "AGENTS.md"), "hand-authored\n");
    await setupHostManifest([{ path: "../foo", visibility: "private" }]);
    mute();
    const r = expectRepoRun(await doRunProjectRetrofit("../foo", {}, { cwd: host() }));
    expect(r.action).toBe("relocate");
    expect(r.applied).toBe(false);
    expect(r.canonicalPath).toBe("agents/foo/AGENTS.md");
    // nothing moved: the regular file is intact and no canonical exists yet.
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("hand-authored\n");
    expect(existsSync(join(host(), "agents", "foo", "AGENTS.md"))).toBe(false);
  });

  it("--apply moves the file to the canonical and leaves a symlink in its place", async () => {
    const dir = await makeRepo("foo");
    await writeFile(join(dir, "AGENTS.md"), "hand-authored\n");
    await setupHostManifest([{ path: "../foo", visibility: "private" }]);
    mute();
    const r = expectRepoRun(await doRunProjectRetrofit("../foo", { apply: true }, { cwd: host() }));
    expect(r.applied).toBe(true);
    // the canonical now holds the original content.
    expect(await readFile(join(host(), "agents", "foo", "AGENTS.md"), "utf8")).toBe(
      "hand-authored\n",
    );
    // the repo's AGENTS.md is now a symlink that resolves back to that content.
    expect(await readlink(join(dir, "AGENTS.md"))).toContain("agents/foo/AGENTS.md");
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("hand-authored\n");
  });

  it("is idempotent: a second --apply skips (already a symlink)", async () => {
    const dir = await makeRepo("foo");
    await writeFile(join(dir, "AGENTS.md"), "hand-authored\n");
    await setupHostManifest([{ path: "../foo", visibility: "private" }]);
    mute();
    await doRunProjectRetrofit("../foo", { apply: true }, { cwd: host() });
    const r = expectRepoRun(await doRunProjectRetrofit("../foo", { apply: true }, { cwd: host() }));
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("already-symlink");
    expect(r.applied).toBe(false);
  });

  it("refuses when the destination canonical already exists (never clobbers either side)", async () => {
    const dir = await makeRepo("foo");
    await writeFile(join(dir, "AGENTS.md"), "repo-side\n");
    await mkdir(join(host(), "agents", "foo"), { recursive: true });
    await writeFile(join(host(), "agents", "foo", "AGENTS.md"), "canonical-side\n");
    await setupHostManifest([{ path: "../foo", visibility: "private" }]);
    mute();
    const r = expectRepoRun(await doRunProjectRetrofit("../foo", { apply: true }, { cwd: host() }));
    expect(r.action).toBe("refuse");
    expect(r.reason).toBe("canonical-exists");
    expect(r.applied).toBe(false);
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("repo-side\n");
    expect(await readFile(join(host(), "agents", "foo", "AGENTS.md"), "utf8")).toBe(
      "canonical-side\n",
    );
  });

  it("refuses when the destination canonical is a dangling symlink (lstat-detected, never clobbered)", async () => {
    const dir = await makeRepo("foo");
    await writeFile(join(dir, "AGENTS.md"), "repo-side\n");
    await mkdir(join(host(), "agents", "foo"), { recursive: true });
    // A dangling symlink occupies the canonical path; existsSync would call it
    // absent, but lstat-based detection must treat it as present and refuse.
    await symlink("nowhere-target", join(host(), "agents", "foo", "AGENTS.md"));
    await setupHostManifest([{ path: "../foo", visibility: "private" }]);
    mute();
    const r = expectRepoRun(await doRunProjectRetrofit("../foo", { apply: true }, { cwd: host() }));
    expect(r.action).toBe("refuse");
    expect(r.reason).toBe("canonical-exists");
    expect(r.applied).toBe(false);
    expect(await readlink(join(host(), "agents", "foo", "AGENTS.md"))).toBe("nowhere-target");
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("repo-side\n");
  });

  it("skips when the repo has no AGENTS.md to relocate", async () => {
    await makeRepo("foo");
    await setupHostManifest([{ path: "../foo", visibility: "private" }]);
    mute();
    const r = expectRepoRun(await doRunProjectRetrofit("../foo", { apply: true }, { cwd: host() }));
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("absent");
    expect(r.applied).toBe(false);
  });

  it("refuses an undeclared repo and leaves its AGENTS.md untouched", async () => {
    const dir = await makeRepo("foo");
    await writeFile(join(dir, "AGENTS.md"), "x\n");
    await setupHostManifest([{ path: ".", visibility: "private" }]);
    mute();
    const r = expectRepoRun(await doRunProjectRetrofit("../foo", { apply: true }, { cwd: host() }));
    expect(r.action).toBe("refuse");
    expect(r.reason).toBe("not-declared");
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("x\n");
  });

  it("refuses the anchor (it owns the canonical directly)", async () => {
    await writeFile(join(host(), "AGENTS.md"), "anchor own\n");
    await setupHostManifest([{ path: ".", visibility: "private" }]);
    mute();
    const r = expectRepoRun(await doRunProjectRetrofit(".", { apply: true }, { cwd: host() }));
    expect(r.action).toBe("refuse");
    expect(r.reason).toBe("anchor");
    expect(await readFile(join(host(), "AGENTS.md"), "utf8")).toBe("anchor own\n");
  });

  it("instructions: self — refuses (the AGENTS.md stays in the repo) and never relocates it", async () => {
    const dir = await makeRepo("blog");
    await writeFile(join(dir, "AGENTS.md"), "hand-authored\n");
    await setupHostManifest([{ path: "../blog", visibility: "public", instructions: "self" }]);
    mute();
    const r = expectRepoRun(
      await doRunProjectRetrofit("../blog", { apply: true }, { cwd: host() }),
    );
    expect(r.action).toBe("refuse");
    expect(r.reason).toBe("self");
    expect(r.applied).toBe(false);
    // The committed AGENTS.md is left in place; no anchor canonical is created.
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("hand-authored\n");
    expect(existsSync(join(host(), "agents", "blog", "AGENTS.md"))).toBe(false);
  });

  it("surfaces a regular-file spoke (CLAUDE.md) as a manual checklist", async () => {
    const dir = await makeRepo("foo");
    await writeFile(join(dir, "AGENTS.md"), "a\n");
    await writeFile(join(dir, "CLAUDE.md"), "dup\n");
    await setupHostManifest([{ path: "../foo", visibility: "private" }]);
    mute();
    const r = expectRepoRun(await doRunProjectRetrofit("../foo", {}, { cwd: host() }));
    expect(r.action).toBe("relocate");
    expect(r.regularSpokes).toContain("CLAUDE.md");
  });
});

describe("renderProjectRetrofit", () => {
  function base(over: Partial<ProjectRetrofitRepoResult> = {}): ProjectRetrofitRepoResult {
    return {
      kind: "repo",
      path: "../foo",
      action: "relocate",
      reason: "ok",
      canonicalName: "foo",
      canonicalPath: "agents/foo/AGENTS.md",
      regularSpokes: [],
      hasRoster: true,
      applied: false,
      view: { kind: "no-view" },
      viewApplied: false,
      ...over,
    };
  }
  it("dry-run relocate shows the move/symlink plan and the derive next-step", () => {
    const out = renderProjectRetrofit(base());
    expect(out).toContain("dry-run");
    expect(out).toContain("agents/foo/AGENTS.md");
    expect(out).toContain("basou project derive");
  });
  it("applied relocate confirms and lists the spoke checklist", () => {
    const out = renderProjectRetrofit(base({ applied: true, regularSpokes: ["CLAUDE.md"] }));
    expect(out).toContain("Relocated");
    expect(out).toContain("Spoke files to reconcile");
    expect(out).toContain("CLAUDE.md");
  });
  it("canonical-exists refusal warns about clobbering", () => {
    // The canonical-exists branch derives the path from canonicalName, so the
    // default canonicalPath is harmless here (and omitting the override keeps it
    // valid under exactOptionalPropertyTypes — an explicit `undefined` is not).
    const out = renderProjectRetrofit(base({ action: "refuse", reason: "canonical-exists" }));
    expect(out).toContain("already exists");
  });
  it("self refusal explains the AGENTS.md stays in the repo (retrofit does not apply)", () => {
    const out = renderProjectRetrofit(base({ action: "refuse", reason: "self" }));
    expect(out).toContain("instructions: self");
    expect(out).toContain("stays in the repo");
    expect(out).toContain("basou project symlinks");
  });
  it("view-collision refusal names both owners and the remedy (rename one side)", () => {
    const out = renderProjectRetrofit(base({ action: "refuse", reason: "view-collision" }));
    expect(out).toContain("shares its canonical name with the workspace view");
    expect(out).toContain("agents/foo/AGENTS.md");
    expect(out).toContain("Rename the view directory or the repo");
  });
  it("no roster points at new/adopt", () => {
    const out = renderProjectRetrofit(base({ hasRoster: false }));
    expect(out).toContain("No repo roster");
  });
  it("a repo-argument run reports a pending view seed as bare-form guidance, never as applied", () => {
    const out = renderProjectRetrofit(base({ view: { kind: "seed", viewName: "ws", block: "x" } }));
    expect(out).toContain("Run `basou project retrofit` (no repo argument)");
    // The marker pair is portable by hand; preset only rewrites the region.
    expect(out).toContain("moved anywhere in the file by hand");
    expect(out).not.toContain("Prepended the generated block");
  });
  it("a bare-form seed report carries the marker-portability note (dry-run and applied)", () => {
    const viewOnly = (viewApplied: boolean): ProjectRetrofitResult => ({
      kind: "view-only",
      hasRoster: true,
      view: { kind: "seed", viewName: "ws", block: "x" },
      viewApplied,
    });
    const dry = renderProjectRetrofit(viewOnly(false));
    expect(dry).toContain("dry-run; pass --apply");
    expect(dry).toContain("moved anywhere in the file by hand");
    const applied = renderProjectRetrofit(viewOnly(true));
    expect(applied).toContain("Prepended the generated block");
    expect(applied).toContain("moved anywhere in the file by hand");
  });
});

// The workspace view is a second instruction target: its own AGENTS.md canonical
// (BASOU:GENERATED) plus the AGENTS.md/CLAUDE.md/Copilot spokes generated INTO the
// view directory. These exercise the greenfield create path, the never-clobber
// path, the retrofit seed path, and the stray-prune protection regression.
describe("workspace view instruction files", () => {
  const DERIVE_NOW = new Date("2026-06-26T12:00:00.000Z");
  let parent: string | undefined;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "basou-viewagents-"));
  });
  afterEach(async () => {
    if (parent !== undefined) await rm(parent, { recursive: true, force: true });
    parent = undefined;
  });
  function p(name: string): string {
    return join(parent as string, name);
  }
  async function makeGitRepo(name: string): Promise<string> {
    const dir = p(name);
    await mkdir(dir, { recursive: true });
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: dir, env: ENV });
    return dir;
  }
  function mute(): void {
    vi.spyOn(console, "log").mockImplementation(() => {});
  }
  /** Write a manifest at `anchor` with the given (optional) roster and view. */
  async function setupManifestAt(
    anchorDir: string,
    opts: { repos?: RepoEntry[]; view?: string; sourceRoots?: string[] },
  ): Promise<void> {
    const paths = await ensureBasouDirectory(anchorDir);
    const base = createManifest({
      workspaceName: "anchor",
      now: NOW,
      workspaceId: WS,
      ...(opts.sourceRoots !== undefined ? { sourceRoots: opts.sourceRoots } : {}),
    });
    await writeManifest(
      paths,
      {
        ...base,
        ...(opts.repos !== undefined ? { repos: opts.repos } : {}),
        workspace: {
          ...base.workspace,
          ...(opts.view !== undefined ? { view: opts.view } : {}),
        },
      },
      { force: true },
    );
  }

  // (a) greenfield: new -> derive --apply generates the view canonical AND the
  //     view's own instruction-file spokes.
  it("(a) greenfield new -> derive --apply generates the view canonical + spokes", async () => {
    await makeGitRepo("anchor");
    await makeGitRepo("sibling");
    mute();

    // Scaffold the manifest with a view path (project new writes the declaration).
    const newResult = await doRunProjectNew(
      ["../sibling"],
      { apply: true, view: "../anchor-workspace" },
      { cwd: p("anchor") },
    );
    // project new seeds the view path into the manifest (E: derive creates the canonical).
    expect(newResult.view).toBe("../anchor-workspace");
    // Fill in visibility / language so the preset block is renderable, keeping the
    // seeded roster + view.
    await setupManifestAt(p("anchor"), {
      repos: [
        { path: ".", visibility: "private", language: "ja" },
        { path: "../sibling", visibility: "public", language: "en" },
      ],
      view: "../anchor-workspace",
      sourceRoots: ["."],
    });

    await doRunProjectDerive({ apply: true }, { cwd: p("anchor"), now: () => DERIVE_NOW });

    // The view's own canonical exists at the anchor with a BASOU:GENERATED region.
    const viewCanonical = join(p("anchor"), "agents", "anchor-workspace", "AGENTS.md");
    expect(existsSync(viewCanonical)).toBe(true);
    const canonicalBody = await readFile(viewCanonical, "utf8");
    expect(canonicalBody).toContain(GENERATED_START);
    expect(canonicalBody).toContain("workspace view 構成");
    // The aggregation table lists the roster (anchor + sibling) by basename.
    expect(canonicalBody).toContain("| anchor |");
    expect(canonicalBody).toContain("| sibling |");

    // The view directory carries its own instruction-file symlinks.
    const view = p("anchor-workspace");
    expect(await readlink(join(view, "AGENTS.md"))).toContain("agents/anchor-workspace/AGENTS.md");
    expect(await readlink(join(view, "CLAUDE.md"))).toBe("AGENTS.md");
    expect(await readlink(join(view, ".github", "copilot-instructions.md"))).toBe("../AGENTS.md");
  });

  // (b) a markerless (hand-authored) view canonical is a marker conflict for the
  //     normal preset — never clobbered.
  it("(b) preset surfaces a markerless view canonical as a conflict and never clobbers the prose", async () => {
    await makeGitRepo("anchor");
    await mkdir(p("anchor-workspace"), { recursive: true });
    // A hand-authored view canonical with NO markers.
    const viewCanonical = join(p("anchor"), "agents", "anchor-workspace", "AGENTS.md");
    await mkdir(dirname(viewCanonical), { recursive: true });
    const prose = "# workspace\n\nhand-written notes\n";
    await writeFile(viewCanonical, prose);
    await setupManifestAt(p("anchor"), {
      repos: [{ path: ".", visibility: "private" }],
      view: "../anchor-workspace",
    });
    mute();

    const r = await doRunProjectPreset({ apply: true }, { cwd: p("anchor") });
    expect(r.view?.kind).toBe("conflict");
    if (r.view?.kind === "conflict") expect(r.view.reason).toBe("no_markers");
    expect(r.viewApplied).toBe(false);
    // A pending view conflict denies the clean verdict (no false-clear).
    expect(r.ok).toBe(false);
    // The hand-authored prose is byte-for-byte unchanged (never clobbered).
    expect(await readFile(viewCanonical, "utf8")).toBe(prose);
  });

  // (c) a repo-argument retrofit only REPORTS the markerless view canonical
  //     (even with --apply); the bare form performs the seed.
  it("(c) repo-arg retrofit --apply reports the view seed without writing; the bare form migrates it", async () => {
    await makeGitRepo("anchor");
    await mkdir(p("anchor-workspace"), { recursive: true });
    const viewCanonical = join(p("anchor"), "agents", "anchor-workspace", "AGENTS.md");
    await mkdir(dirname(viewCanonical), { recursive: true });
    const prose = "# workspace\n\nhand-written notes\n";
    await writeFile(viewCanonical, prose);
    await setupManifestAt(p("anchor"), {
      repos: [{ path: ".", visibility: "private", language: "ja" }],
      view: "../anchor-workspace",
    });
    mute();

    // The repo-arg run surfaces the pending seed but never writes the view —
    // one invocation writes at most one target.
    const r = expectRepoRun(await doRunProjectRetrofit(".", { apply: true }, { cwd: p("anchor") }));
    expect(r.view?.kind).toBe("seed");
    expect(r.viewApplied).toBe(false);
    expect(await readFile(viewCanonical, "utf8")).toBe(prose);

    // The bare form performs the migration: block prepended, prose preserved.
    const bare = await doRunProjectRetrofit(undefined, { apply: true }, { cwd: p("anchor") });
    expect(bare.kind).toBe("view-only");
    expect(bare.view?.kind).toBe("seed");
    expect(bare.viewApplied).toBe(true);
    const migrated = await readFile(viewCanonical, "utf8");
    expect(migrated.startsWith(GENERATED_START)).toBe(true);
    expect(migrated).toContain("workspace view 構成");
    expect(migrated.endsWith(prose)).toBe(true);
  });

  // (c') the repo argument is optional: a bare `retrofit` runs only the view
  //      canonical's migration (the invocation preset's guidance points at).
  it("(c') retrofit without a repo argument runs the view-only migration", async () => {
    await makeGitRepo("anchor");
    await mkdir(p("anchor-workspace"), { recursive: true });
    const viewCanonical = join(p("anchor"), "agents", "anchor-workspace", "AGENTS.md");
    await mkdir(dirname(viewCanonical), { recursive: true });
    const prose = "# workspace\n\nhand-written notes\n";
    await writeFile(viewCanonical, prose);
    await setupManifestAt(p("anchor"), {
      repos: [{ path: ".", visibility: "private", language: "ja" }],
      view: "../anchor-workspace",
    });
    mute();

    // Dry-run: the seed is planned, nothing is written, and the result carries
    // no repo-arg plan (the view-only form).
    const dry = await doRunProjectRetrofit(undefined, {}, { cwd: p("anchor") });
    expect(dry.kind).toBe("view-only");
    expect(dry.view?.kind).toBe("seed");
    expect(dry.viewApplied).toBe(false);
    expect(await readFile(viewCanonical, "utf8")).toBe(prose);

    // Apply: the block is prepended, the prose preserved.
    const r = await doRunProjectRetrofit(undefined, { apply: true }, { cwd: p("anchor") });
    expect(r.view?.kind).toBe("seed");
    expect(r.viewApplied).toBe(true);
    const migrated = await readFile(viewCanonical, "utf8");
    expect(migrated.startsWith(GENERATED_START)).toBe(true);
    expect(migrated.endsWith(prose)).toBe(true);
  });

  // (d) regression: the stray-prune (workspace) never removes the view's own
  //     AGENTS.md / CLAUDE.md instruction symlinks.
  it("(d) workspace --prune never removes the view's own AGENTS.md / CLAUDE.md symlinks", async () => {
    const anchorDir = await makeGitRepo("anchor");
    await makeGitRepo("sibling");
    const view = p("anchor-workspace");
    await mkdir(view, { recursive: true });
    // The view's own instruction-file symlinks (as derive would generate them).
    await mkdir(join(anchorDir, "agents", "anchor-workspace"), { recursive: true });
    await writeFile(
      join(anchorDir, "agents", "anchor-workspace", "AGENTS.md"),
      `${GENERATED_START}\nx\n${GENERATED_END}\n`,
    );
    await symlink("../anchor/agents/anchor-workspace/AGENTS.md", join(view, "AGENTS.md"));
    await symlink("AGENTS.md", join(view, "CLAUDE.md"));
    // A genuine repo-aggregation link (sibling), plus the anchor's own.
    await symlink("../sibling", join(view, "sibling"));
    await symlink("../anchor", join(view, "anchor"));
    await setupManifestAt(p("anchor"), {
      repos: [{ path: "." }, { path: "../sibling" }],
      view: "../anchor-workspace",
    });
    mute();

    const r = await doRunProjectWorkspace({ prune: true }, { cwd: p("anchor") });
    // No stray was detected for the instruction-file symlinks (they are excluded).
    expect(r.toPrune.map((x) => x.name)).not.toContain("AGENTS.md");
    expect(r.toPrune.map((x) => x.name)).not.toContain("CLAUDE.md");
    // Both instruction-file symlinks survive.
    expect(await readlink(join(view, "AGENTS.md"))).toBe(
      "../anchor/agents/anchor-workspace/AGENTS.md",
    );
    expect(await readlink(join(view, "CLAUDE.md"))).toBe("AGENTS.md");
  });

  // (e) an empty roster (`repos` undeclared — the schema forbids an empty array)
  //     is a whole no-op: the view is neither inspected nor written by preset /
  //     symlinks / retrofit (no unreported writes, no empty-roster block).
  it("(e) empty roster + declared view: preset/symlinks/retrofit --apply write nothing", async () => {
    await makeGitRepo("anchor");
    await setupManifestAt(p("anchor"), { view: "../anchor-workspace" });
    mute();

    const preset = await doRunProjectPreset({ apply: true }, { cwd: p("anchor") });
    expect(preset.hasRoster).toBe(false);
    expect(preset.view).toBeUndefined();
    expect(preset.viewApplied).toBe(false);

    const links = await doRunProjectSymlinks({ apply: true }, { cwd: p("anchor") });
    expect(links.hasRoster).toBe(false);
    expect(links.view).toBeUndefined();
    expect(links.viewCreated).toEqual([]);

    const bare = await doRunProjectRetrofit(undefined, { apply: true }, { cwd: p("anchor") });
    expect(bare.kind).toBe("view-only");
    expect(bare.hasRoster).toBe(false);
    expect(bare.view).toBeUndefined();
    expect(bare.viewApplied).toBe(false);

    // Nothing landed on disk: no view canonical dir at the anchor, no view dir.
    expect(existsSync(join(p("anchor"), "agents"))).toBe(false);
    expect(existsSync(p("anchor-workspace"))).toBe(false);
  });

  // (f) view basename == a roster repo's canonical name: BOTH sides are
  //     suppressed everywhere (preset both-side, symlinks view skip, retrofit
  //     repo refuse + bare collision report) — nothing is ever written into the
  //     shared agents/<name>/AGENTS.md.
  it("(f) a view↔repo canonical-name collision suppresses both sides across preset/symlinks/retrofit", async () => {
    await makeGitRepo("anchor");
    const pubDir = await makeGitRepo("pub");
    await writeFile(join(pubDir, "AGENTS.md"), "repo prose\n");
    // The view lives elsewhere but shares the basename `pub`.
    await setupManifestAt(p("anchor"), {
      repos: [
        { path: ".", visibility: "private" },
        { path: "../pub", visibility: "public", language: "en" },
      ],
      view: "../nested/pub",
    });
    mute();

    // preset: the repo side is suppressed as a view-flagged collision AND the
    // view side reports the collision — neither writes the shared canonical.
    const preset = await doRunProjectPreset({ apply: true }, { cwd: p("anchor") });
    expect(preset.collisions).toEqual([{ canonicalName: "pub", repos: ["../pub"], view: true }]);
    expect(preset.plans).toEqual([]);
    expect(preset.view?.kind).toBe("collision");
    if (preset.view?.kind === "collision") expect(preset.view.repoPath).toBe("../pub");
    expect(preset.viewApplied).toBe(false);
    expect(preset.ok).toBe(false);
    expect(existsSync(join(p("anchor"), "agents", "pub", "AGENTS.md"))).toBe(false);
    const presetOut = renderProjectPreset(preset);
    expect(presetOut).toContain("the workspace view");

    // symlinks: the view spokes are not wired (collision reported).
    const links = await doRunProjectSymlinks({ apply: true }, { cwd: p("anchor") });
    expect(links.view?.kind).toBe("collision");
    expect(links.viewCreated).toEqual([]);
    expect(links.ok).toBe(false);
    expect(existsSync(join(p("nested"), "pub", "AGENTS.md"))).toBe(false);

    // repo-arg retrofit: refuses the relocate (the canonical is the view's too).
    const retro = expectRepoRun(
      await doRunProjectRetrofit("../pub", { apply: true }, { cwd: p("anchor") }),
    );
    expect(retro.action).toBe("refuse");
    expect(retro.reason).toBe("view-collision");
    expect(retro.applied).toBe(false);
    expect(await readFile(join(pubDir, "AGENTS.md"), "utf8")).toBe("repo prose\n");
    expect(existsSync(join(p("anchor"), "agents", "pub", "AGENTS.md"))).toBe(false);

    // bare retrofit: reports the collision, migrates nothing.
    const bare = await doRunProjectRetrofit(undefined, { apply: true }, { cwd: p("anchor") });
    expect(bare.view?.kind).toBe("collision");
    expect(bare.viewApplied).toBe(false);
    expect(renderProjectRetrofit(bare)).toContain("shares its canonical name");
  });

  // (g) ok never false-clears while the view is pending: repos all in sync +
  //     a view plan => ok=false; after the view is generated too => ok=true.
  it("(g) preset ok includes the view target (pending view plan denies the clean verdict)", async () => {
    await makeGitRepo("anchor");
    await makeGitRepo("pub");
    // First: no view declared — sync the repo canonical.
    await setupManifestAt(p("anchor"), {
      repos: [{ path: "../pub", visibility: "public", language: "en" }],
    });
    mute();
    await doRunProjectPreset({ apply: true }, { cwd: p("anchor") });

    // Now declare the view: the repo is in sync but the view canonical is a
    // pending create, so the clean verdict must be denied.
    await setupManifestAt(p("anchor"), {
      repos: [{ path: "../pub", visibility: "public", language: "en" }],
      view: "../anchor-workspace",
    });
    const pending = await doRunProjectPreset({}, { cwd: p("anchor") });
    expect(pending.inSync).toEqual(["../pub"]);
    expect(pending.plans).toEqual([]);
    expect(pending.view?.kind).toBe("plan");
    expect(pending.ok).toBe(false);
    expect(renderProjectPreset(pending)).not.toContain("nothing to generate).");

    // After the view is generated too, the verdict is clean.
    await doRunProjectPreset({ apply: true }, { cwd: p("anchor") });
    const clean = await doRunProjectPreset({}, { cwd: p("anchor") });
    expect(clean.view?.kind).toBe("in-sync");
    expect(clean.ok).toBe(true);
  });

  it("(g') symlinks ok includes the view spokes (missing spokes deny the clean verdict)", async () => {
    await makeGitRepo("anchor");
    await setupManifestAt(p("anchor"), {
      repos: [{ path: ".", visibility: "private" }],
      view: "../anchor-workspace",
    });
    mute();
    // Create the view canonical (the roster is just the anchor, which symlinks skips).
    await doRunProjectPreset({ apply: true }, { cwd: p("anchor") });

    // Repo side has nothing to do, but the view spokes are missing => ok=false.
    const pending = await doRunProjectSymlinks({}, { cwd: p("anchor") });
    expect(pending.plans).toEqual([]);
    expect(pending.view?.kind).toBe("gathered");
    expect(pending.ok).toBe(false);

    // Wire the spokes; the verdict turns clean.
    await doRunProjectSymlinks({ apply: true }, { cwd: p("anchor") });
    const clean = await doRunProjectSymlinks({}, { cwd: p("anchor") });
    expect(clean.view?.kind).toBe("gathered");
    if (clean.view?.kind === "gathered") {
      expect(clean.view.files.every((f) => f.state === "correct")).toBe(true);
    }
    expect(clean.ok).toBe(true);
  });
});
