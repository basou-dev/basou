import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

describe("doRunInit + .gitignore integration", () => {
  it("creates .gitignore with Basou block during init in fresh repo", async () => {
    const repo = getTmpRepo();
    await doRunInit({}, { cwd: repo });
    const body = await readFile(join(repo, ".gitignore"), "utf8");
    expect(body).toContain("# Basou - default ignore");
    expect(body).toContain(".basou/logs/");
  });

  it("appends to existing .gitignore preserving prior rules", async () => {
    const repo = getTmpRepo();
    await writeFile(join(repo, ".gitignore"), "node_modules/\n", "utf8");
    await doRunInit({}, { cwd: repo });
    const body = await readFile(join(repo, ".gitignore"), "utf8");
    expect(body).toContain("node_modules/");
    expect(body).toContain("# Basou - default ignore");
  });

  it("second init with --force does not duplicate Basou block", async () => {
    const repo = getTmpRepo();
    await doRunInit({}, { cwd: repo });
    await doRunInit({ force: true }, { cwd: repo });
    const body = await readFile(join(repo, ".gitignore"), "utf8");
    const matches = body.match(/^# Basou - default ignore/gm);
    expect(matches?.length ?? 0).toBe(1);
  });

  it("warns and continues with exitCode 0 when .gitignore is unwritable", async () => {
    const repo = getTmpRepo();
    // .gitignore as a directory makes both readFile and writeFile fail
    // (EISDIR). doRunInit's try/catch around appendBasouGitignore must
    // swallow the error and return success.
    await mkdir(join(repo, ".gitignore"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runInit({}, { cwd: repo });
    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("Warning: Could not update .gitignore");
    expect(process.exitCode).toBe(0);
    // manifest must still be written
    const manifest = await readManifest(basouPaths(repo));
    expect(manifest.workspace.id.startsWith("ws_")).toBe(true);
  });

  it("warning message is pathless by default", async () => {
    const repo = getTmpRepo();
    await mkdir(join(repo, ".gitignore"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runInit({}, { cwd: repo });
    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("Warning: Could not update .gitignore");
    expect(stderr).not.toContain(repo);
    expect(stderr).not.toContain("Caused by:");
    expect(process.exitCode).toBe(0);
  });

  it("verbose warning does not leak absolute paths through cause", async () => {
    const repo = getTmpRepo();
    await mkdir(join(repo, ".gitignore"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runInit({ verbose: true }, { cwd: repo });
    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("Warning: Could not update .gitignore");
    expect(stderr).toContain("Caused by:");
    expect(stderr).not.toContain(repo);
    expect(process.exitCode).toBe(0);
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

  it("verbose mode does not leak absolute paths through cause.message", async () => {
    // Force a native fs error whose `message` embeds an absolute path:
    // creating `.basou/sessions` as a regular file makes mkdirLabeled fail
    // with EEXIST, which gets wrapped by ensureBasouDirectory carrying the
    // native error as `cause`. Verbose rendering must surface only the
    // cause's code / constructor name, never its message (which would
    // include the absolute path).
    const repo = getTmpRepo();
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(repo, ".basou"), { recursive: true });
    await writeFile(join(repo, ".basou", "sessions"), "");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runInit({ verbose: true }, { cwd: repo });
    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain(".basou/sessions exists but is not a directory");
    expect(stderr).toContain("Caused by:");
    expect(stderr).not.toContain(repo);
    expect(process.exitCode).toBe(1);
  });
});
