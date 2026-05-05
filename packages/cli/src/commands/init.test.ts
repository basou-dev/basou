import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { basouPaths, readManifest } from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doRunInit, runInit } from "./init.js";

const execFileAsync = promisify(execFile);

let tmpRepo: string | undefined;

// Force git invocations to ignore the developer's global/system config so
// `git config --local --get remote.origin.url` reflects only what the test
// sets up.
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-init-test-"));
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: tmpRepo, env: ENV });
  // Required for `git commit`-y operations later; harmless here.
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: tmpRepo,
    env: ENV,
  });
  await execFileAsync("git", ["config", "user.name", "test"], {
    cwd: tmpRepo,
    env: ENV,
  });
});

afterEach(async () => {
  if (tmpRepo !== undefined) {
    await rm(tmpRepo, { recursive: true, force: true });
    tmpRepo = undefined;
  }
  process.exitCode = 0;
  vi.restoreAllMocks();
});

function getTmpRepo(): string {
  if (tmpRepo === undefined) throw new Error("tmpRepo not initialized");
  return tmpRepo;
}

describe("doRunInit (pure runner)", () => {
  it("creates .basou/ directory layout in a fresh git repo", async () => {
    const repo = getTmpRepo();
    await doRunInit({}, { cwd: repo });
    const paths = basouPaths(repo);
    for (const target of [
      paths.sessions,
      paths.tasks,
      paths.approvals.pending,
      paths.approvals.resolved,
      paths.logs,
      paths.raw,
      paths.tmp,
    ]) {
      const info = await stat(target);
      expect(info.isDirectory()).toBe(true);
    }
  });

  it("writes manifest.yaml with workspace.name = repo basename by default", async () => {
    const repo = getTmpRepo();
    await doRunInit({}, { cwd: repo });
    const manifest = await readManifest(basouPaths(repo));
    expect(manifest.workspace.name.length).toBeGreaterThan(0);
    expect(repo.endsWith(manifest.workspace.name)).toBe(true);
  });

  it("uses --name to override workspace.name", async () => {
    const repo = getTmpRepo();
    await doRunInit({ name: "custom-name" }, { cwd: repo });
    const manifest = await readManifest(basouPaths(repo));
    expect(manifest.workspace.name).toBe("custom-name");
  });

  it("populates project.name and project.description from CLI options", async () => {
    const repo = getTmpRepo();
    await doRunInit(
      { projectName: "Project X", projectDescription: "A test project" },
      { cwd: repo },
    );
    const manifest = await readManifest(basouPaths(repo));
    expect(manifest.project.name).toBe("Project X");
    expect(manifest.project.description).toBe("A test project");
  });

  it("auto-fills project.repository_url from git remote.origin.url", async () => {
    const repo = getTmpRepo();
    await execFileAsync("git", ["remote", "add", "origin", "https://example.com/foo.git"], {
      cwd: repo,
      env: ENV,
    });
    await doRunInit({}, { cwd: repo });
    const manifest = await readManifest(basouPaths(repo));
    expect(manifest.project.repository_url).toBe("https://example.com/foo.git");
  });

  it("omits project.repository_url when no remote and no --repo-url", async () => {
    const repo = getTmpRepo();
    await doRunInit({}, { cwd: repo });
    const manifest = await readManifest(basouPaths(repo));
    expect("repository_url" in manifest.project).toBe(false);
  });

  it("--repo-url overrides git remote", async () => {
    const repo = getTmpRepo();
    await execFileAsync("git", ["remote", "add", "origin", "https://example.com/from-git.git"], {
      cwd: repo,
      env: ENV,
    });
    await doRunInit({ repoUrl: "https://override.example.com/foo.git" }, { cwd: repo });
    const manifest = await readManifest(basouPaths(repo));
    expect(manifest.project.repository_url).toBe("https://override.example.com/foo.git");
  });

  it("--repo-url '' sets repository_url to null", async () => {
    const repo = getTmpRepo();
    await doRunInit({ repoUrl: "" }, { cwd: repo });
    const manifest = await readManifest(basouPaths(repo));
    expect(manifest.project.repository_url).toBeNull();
  });

  it("refuses to re-initialize without --force", async () => {
    const repo = getTmpRepo();
    await doRunInit({}, { cwd: repo });
    await expect(doRunInit({}, { cwd: repo })).rejects.toThrow(/Already initialized/);
  });

  it("--force overwrites manifest with a new workspace_id", async () => {
    const repo = getTmpRepo();
    await doRunInit({}, { cwd: repo });
    const first = await readManifest(basouPaths(repo));
    await doRunInit({ force: true }, { cwd: repo });
    const second = await readManifest(basouPaths(repo));
    expect(second.workspace.id).not.toBe(first.workspace.id);
  });

  it("throws when not in a git repository", async () => {
    const nonGitDir = await mkdtemp(join(tmpdir(), "basou-not-git-"));
    try {
      await expect(doRunInit({}, { cwd: nonGitDir })).rejects.toThrow(/Not a git repository/);
    } finally {
      await rm(nonGitDir, { recursive: true, force: true });
    }
  });

  it("creates .basou/ at repo root when run from a subdirectory", async () => {
    const repo = getTmpRepo();
    const sub = join(repo, "src", "deep");
    await mkdir(sub, { recursive: true });
    await doRunInit({}, { cwd: sub });
    const paths = basouPaths(repo);
    const info = await stat(paths.root);
    expect(info.isDirectory()).toBe(true);
  });
});

describe("runInit (process-state wrapper)", () => {
  it("error messages are pathless by default", async () => {
    const repo = getTmpRepo();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runInit({}, { cwd: repo });
    await runInit({}, { cwd: repo }); // second call -> Already initialized
    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("Already initialized");
    expect(stderr).not.toContain(repo);
    expect(process.exitCode).toBe(1);
  });
});
