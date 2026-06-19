import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SimpleGit, simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type GitSnapshot,
  getSnapshot,
  resolveBasouRepositoryRoot,
  resolveRepositoryRoot,
  tryRemoteUrl,
} from "./snapshot.js";

const ENV_GLOBAL = process.platform === "win32" ? "\\\\.\\nul" : "/dev/null";
// Minimal env for fixtures: only PATH / HOME / USERPROFILE are needed for
// git itself to run; GIT_CONFIG_GLOBAL / SYSTEM neutralize the developer's
// global git config. We deliberately do NOT spread `process.env` because
// simple-git v3.31+ refuses inherited unsafe env vars (GIT_EDITOR, GIT_SSH,
// ...) without explicit `unsafe` opt-in.
const ENV: NodeJS.ProcessEnv = {
  ...(process.env.PATH !== undefined ? { PATH: process.env.PATH } : {}),
  ...(process.env.HOME !== undefined ? { HOME: process.env.HOME } : {}),
  ...(process.env.USERPROFILE !== undefined ? { USERPROFILE: process.env.USERPROFILE } : {}),
  GIT_CONFIG_GLOBAL: ENV_GLOBAL,
  GIT_CONFIG_SYSTEM: ENV_GLOBAL,
};

/**
 * Build a SimpleGit instance for fixtures with simple-git's safety guards
 * relaxed enough to accept GIT_CONFIG_GLOBAL/SYSTEM in the test env. The
 * production capability (snapshot.ts) deliberately does NOT use this opt —
 * only fixture setup does, where we need git init / commit / push to
 * honour our isolated config paths.
 */
function safeSimpleGit(baseDir: string, extraConfig: readonly string[] = []): SimpleGit {
  return simpleGit({
    baseDir,
    config: [...extraConfig],
    unsafe: { allowUnsafeConfigPaths: true },
  }).env(ENV);
}

let tmpRepo: string;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-git-test-"));
});

afterEach(async () => {
  await rm(tmpRepo, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function initRepoWithCommit(dir: string): Promise<string> {
  const git = safeSimpleGit(dir, ["init.defaultBranch=main"]);
  await git.init();
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "test");
  await writeFile(join(dir, "README.md"), "# test\n");
  await git.add("README.md");
  await git.commit("initial");
  return (await git.revparse(["HEAD"])).trimEnd();
}

async function initEmptyRepo(dir: string): Promise<void> {
  const git = safeSimpleGit(dir, ["init.defaultBranch=main"]);
  await git.init();
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "test");
}

describe("resolveRepositoryRoot", () => {
  it("returns the repository root when cwd is the root itself", async () => {
    await initRepoWithCommit(tmpRepo);
    const root = await resolveRepositoryRoot(tmpRepo);
    expect(root.length).toBeGreaterThan(0);
    // The returned path resolves to the same directory as tmpRepo (macOS may
    // canonicalize symlinks like /var -> /private/var, so we compare via fs).
    const { realpath } = await import("node:fs/promises");
    expect(await realpath(root)).toBe(await realpath(tmpRepo));
  });

  it("resolves the repository root from a subdirectory", async () => {
    await initRepoWithCommit(tmpRepo);
    const subdir = join(tmpRepo, "subdir");
    await mkdir(subdir);
    const root = await resolveRepositoryRoot(subdir);
    const { realpath } = await import("node:fs/promises");
    expect(await realpath(root)).toBe(await realpath(tmpRepo));
  });

  it("throws Error('Not a git repository') for a non-git directory (contract: exact message + cause preserved)", async () => {
    let err: unknown;
    try {
      await resolveRepositoryRoot(tmpRepo);
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Not a git repository");
    expect((err as Error).cause).toBeInstanceOf(Error);
    // Pathless contract: the wrapped message must not embed tmpRepo.
    expect((err as Error).message).not.toContain(tmpRepo);
  });

  it("throws 'Git command failed' (NOT 'Not a git repository') when git fails for a non-'no repo' reason", async () => {
    // A `.git` FILE with garbage makes git fail with "invalid gitfile format":
    // a real fault, not "there is no repo here". It must NOT be laundered into
    // the "Not a git repository" sentinel that drives the workspace-view
    // fallback, or a corrupt repo would silently redirect / suggest `git init`.
    await writeFile(join(tmpRepo, ".git"), "this is not a valid gitfile\n");
    let err: unknown;
    try {
      await resolveRepositoryRoot(tmpRepo);
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Git command failed");
    expect((err as Error).cause).toBeInstanceOf(Error);
    // Pathless contract holds on the new branch too.
    expect((err as Error).message).not.toContain(tmpRepo);
  });
});

describe("resolveBasouRepositoryRoot (workspace-view fallback)", () => {
  /** A git repo with a `.basou/` store (the shape a planning repo has). */
  async function initBasouRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "basou-ws-"));
    await initRepoWithCommit(dir);
    await mkdir(join(dir, ".basou"));
    return dir;
  }

  it("returns the git toplevel when cwd is a git repo (no fallback)", async () => {
    await initRepoWithCommit(tmpRepo);
    expect(await realpath(await resolveBasouRepositoryRoot(tmpRepo))).toBe(await realpath(tmpRepo));
  });

  it("redirects a non-git view to its single linked repo that has a .basou store", async () => {
    const planning = await initBasouRepo();
    const impl = await mkdtemp(join(tmpdir(), "basou-impl-")); // linked but NO .basou
    await initRepoWithCommit(impl);
    const view = await mkdtemp(join(tmpdir(), "basou-view-")); // git-untracked view dir
    try {
      await symlink(planning, join(view, "foo-planning"));
      await symlink(impl, join(view, "foo"));
      const redirects: { via: string; root: string }[] = [];
      const root = await resolveBasouRepositoryRoot(view, {
        onRedirect: (info) => redirects.push(info),
      });
      expect(await realpath(root)).toBe(await realpath(planning));
      expect(redirects).toHaveLength(1);
      expect(redirects[0]?.via).toBe("foo-planning");
    } finally {
      for (const d of [planning, impl, view]) await rm(d, { recursive: true, force: true });
    }
  });

  it("throws an ambiguity error when several linked repos have a .basou store", async () => {
    const a = await initBasouRepo();
    const b = await initBasouRepo();
    const view = await mkdtemp(join(tmpdir(), "basou-view-"));
    try {
      await symlink(a, join(view, "a-planning"));
      await symlink(b, join(view, "b-planning"));
      await expect(resolveBasouRepositoryRoot(view)).rejects.toThrow(/Ambiguous workspace view/);
    } finally {
      for (const d of [a, b, view]) await rm(d, { recursive: true, force: true });
    }
  });

  it("re-throws 'Not a git repository' for a non-git dir with no linked .basou repos", async () => {
    await expect(resolveBasouRepositoryRoot(tmpRepo)).rejects.toThrow("Not a git repository");
  });

  it("does NOT fall back to a linked repo when the view's own git is broken (corrupt, not 'no repo')", async () => {
    const planning = await initBasouRepo();
    const view = await mkdtemp(join(tmpdir(), "basou-view-"));
    try {
      await symlink(planning, join(view, "foo-planning"));
      // A corrupt `.git` is a real git fault, not "no repo here": the fallback
      // must surface the error, not silently redirect to the linked repo.
      await writeFile(join(view, ".git"), "garbage\n");
      await expect(resolveBasouRepositoryRoot(view)).rejects.toThrow("Git command failed");
    } finally {
      for (const d of [planning, view]) await rm(d, { recursive: true, force: true });
    }
  });
});

describe("tryRemoteUrl", () => {
  it("returns the configured remote.origin.url", async () => {
    await initRepoWithCommit(tmpRepo);
    const git = safeSimpleGit(tmpRepo);
    await git.addRemote("origin", "https://example.com/foo.git");
    const url = await tryRemoteUrl(tmpRepo);
    expect(url).toBe("https://example.com/foo.git");
  });

  it("returns undefined when remote.origin.url is unset", async () => {
    await initRepoWithCommit(tmpRepo);
    const url = await tryRemoteUrl(tmpRepo);
    expect(url).toBeUndefined();
  });

  it("returns undefined for a non-git directory (best-effort)", async () => {
    const url = await tryRemoteUrl(tmpRepo);
    expect(url).toBeUndefined();
  });
});

describe("getSnapshot — basic", () => {
  it("returns a clean snapshot for a 1-commit repo with no changes", async () => {
    const head = await initRepoWithCommit(tmpRepo);
    const snap = await getSnapshot(tmpRepo);
    expect(snap.head).toBe(head);
    expect(snap.branch).toBe("main");
    expect(snap.dirty).toBe(false);
    expect(snap.staged).toEqual([]);
    expect(snap.unstaged).toEqual([]);
    expect(snap.untracked).toEqual([]);
    // No remote → ahead/behind omitted.
    expect("ahead" in snap).toBe(false);
    expect("behind" in snap).toBe(false);
  });

  it("reports dirty=true with the modified file in unstaged", async () => {
    await initRepoWithCommit(tmpRepo);
    await writeFile(join(tmpRepo, "README.md"), "# test (modified)\n");
    const snap = await getSnapshot(tmpRepo);
    expect(snap.dirty).toBe(true);
    expect(snap.unstaged).toEqual(["README.md"]);
    expect(snap.staged).toEqual([]);
    expect(snap.untracked).toEqual([]);
  });

  it("reports dirty=true with the staged file in staged", async () => {
    await initRepoWithCommit(tmpRepo);
    await writeFile(join(tmpRepo, "new.txt"), "fresh\n");
    const git = safeSimpleGit(tmpRepo);
    await git.add("new.txt");
    const snap = await getSnapshot(tmpRepo);
    expect(snap.dirty).toBe(true);
    expect(snap.staged).toEqual(["new.txt"]);
    expect(snap.unstaged).toEqual([]);
    expect(snap.untracked).toEqual([]);
  });

  it("reports dirty=true with the untracked file in untracked", async () => {
    await initRepoWithCommit(tmpRepo);
    await writeFile(join(tmpRepo, "untracked.txt"), "u\n");
    const snap = await getSnapshot(tmpRepo);
    expect(snap.dirty).toBe(true);
    expect(snap.untracked).toEqual(["untracked.txt"]);
    expect(snap.staged).toEqual([]);
    expect(snap.unstaged).toEqual([]);
  });

  it("reports dirty=true with a working-tree deleted file in unstaged (post-1)", async () => {
    await initRepoWithCommit(tmpRepo);
    await rm(join(tmpRepo, "README.md"));
    const snap = await getSnapshot(tmpRepo);
    expect(snap.dirty).toBe(true);
    expect(snap.unstaged).toEqual(["README.md"]);
    expect(snap.staged).toEqual([]);
    expect(snap.untracked).toEqual([]);
  });

  it("reports dirty=true with a staged rename in staged (post-1)", async () => {
    await initRepoWithCommit(tmpRepo);
    const git = safeSimpleGit(tmpRepo);
    await git.mv("README.md", "README2.md");
    const snap = await getSnapshot(tmpRepo);
    expect(snap.dirty).toBe(true);
    // simple-git reports renames either as a single R entry or as
    // delete+add depending on similarity heuristics; in either case
    // README2.md must appear in `staged`.
    expect(snap.staged).toContain("README2.md");
  });

  it("reports dirty=true with a merge conflict in unstaged (post-1)", async () => {
    await initRepoWithCommit(tmpRepo);
    const git = safeSimpleGit(tmpRepo);
    // Create a divergent branch then merge it back to provoke a conflict
    // on README.md.
    await git.checkoutBranch("feature", "main");
    await writeFile(join(tmpRepo, "README.md"), "# feature side\n");
    await git.add("README.md");
    await git.commit("feature change");
    await git.checkout("main");
    await writeFile(join(tmpRepo, "README.md"), "# main side\n");
    await git.add("README.md");
    await git.commit("main change");
    let mergeFailed = false;
    try {
      await git.merge(["feature"]);
    } catch {
      mergeFailed = true;
    }
    expect(mergeFailed).toBe(true);
    const snap = await getSnapshot(tmpRepo);
    expect(snap.dirty).toBe(true);
    // Conflicted entries surface with `index === "U"` and/or
    // `working_dir === "U"`, so they appear in either staged or unstaged.
    const allChanged = [...snap.staged, ...snap.unstaged];
    expect(allChanged).toContain("README.md");
  });
});

describe("getSnapshot — edge cases", () => {
  it("throws Error('No commits in repository') for an empty repo (contract: exact message + cause preserved)", async () => {
    await initEmptyRepo(tmpRepo);
    let err: unknown;
    try {
      await getSnapshot(tmpRepo);
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("No commits in repository");
    expect((err as Error).cause).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(tmpRepo);
  });

  it("returns branch='HEAD' on detached HEAD with the commit hash", async () => {
    const head = await initRepoWithCommit(tmpRepo);
    // Detach by checking out the commit hash directly.
    const git = safeSimpleGit(tmpRepo);
    await git.raw(["checkout", head]);
    const snap = await getSnapshot(tmpRepo);
    expect(snap.branch).toBe("HEAD");
    expect(snap.head).toBe(head);
    expect("ahead" in snap).toBe(false);
    expect("behind" in snap).toBe(false);
  });

  it("omits ahead/behind when there is no remote", async () => {
    await initRepoWithCommit(tmpRepo);
    const snap = await getSnapshot(tmpRepo);
    expect("ahead" in snap).toBe(false);
    expect("behind" in snap).toBe(false);
  });

  it("omits ahead/behind when the branch has no upstream tracking", async () => {
    await initRepoWithCommit(tmpRepo);
    // Add a remote but do not set upstream tracking for `main`.
    const git = safeSimpleGit(tmpRepo);
    const bare = await mkdtemp(join(tmpdir(), "basou-git-test-bare-"));
    try {
      await safeSimpleGit(bare).init(true);
      await git.addRemote("origin", bare);
      const snap = await getSnapshot(tmpRepo);
      expect("ahead" in snap).toBe(false);
      expect("behind" in snap).toBe(false);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("reports ahead=1, behind=0 when local is one commit ahead of upstream", async () => {
    await initRepoWithCommit(tmpRepo);
    const bare = await mkdtemp(join(tmpdir(), "basou-git-test-bare-"));
    try {
      await safeSimpleGit(bare).init(true);
      const git = safeSimpleGit(tmpRepo);
      await git.addRemote("origin", bare);
      await git.push(["-u", "origin", "main"]);
      // Make a second commit so we are ahead by 1.
      await writeFile(join(tmpRepo, "second.txt"), "two\n");
      await git.add("second.txt");
      await git.commit("second");
      const snap = await getSnapshot(tmpRepo);
      expect(snap.ahead).toBe(1);
      expect(snap.behind).toBe(0);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe("getSnapshot — errors", () => {
  it("throws Error('Not a git repository') for a non-git directory (contract: exact message + cause preserved)", async () => {
    let err: unknown;
    try {
      await getSnapshot(tmpRepo);
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Not a git repository");
    // checkIsRepo() returning false hits the explicit throw, so no cause is attached.
    expect((err as Error).message).not.toContain(tmpRepo);
  });

  it.skipIf(process.platform === "win32")(
    "throws 'Git executable not found in PATH...' when git binary is missing (PATH stubbed)",
    async () => {
      await initRepoWithCommit(tmpRepo);
      vi.stubEnv("PATH", "/nonexistent");
      let err: unknown;
      try {
        await resolveRepositoryRoot(tmpRepo);
      } catch (caught) {
        err = caught;
      }
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("Git executable not found in PATH. Install git first.");
      expect((err as Error).cause).toBeInstanceOf(Error);
    },
  );
});

describe("GitSnapshot type integrity", () => {
  it("matches the event payload shape (omitting envelope fields)", () => {
    // Compile-time check: this object literal must satisfy GitSnapshot.
    const sample: GitSnapshot = {
      head: "abc",
      branch: "main",
      dirty: false,
      staged: [],
      unstaged: [],
      untracked: [],
    };
    expect(sample.head).toBe("abc");
  });
});
