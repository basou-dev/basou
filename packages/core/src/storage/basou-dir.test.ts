import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { basouPaths, ensureBasouDirectory } from "./basou-dir.js";

let repoRoot: string | undefined;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "basou-test-"));
});

afterEach(async () => {
  if (repoRoot !== undefined) {
    await rm(repoRoot, { recursive: true, force: true });
    repoRoot = undefined;
  }
});

// Detects absolute-style paths: a leading slash followed by two or more
// path components (e.g. "/var/folders/abc"). Relative labels emitted by
// the implementation (e.g. ".basou/sessions") deliberately do not match —
// they are not absolute paths and remain safe to surface in error
// messages. The contract enforced is "no absolute path leakage", not
// "no slash anywhere".
const PATH_LIKE_PATTERN = /\/[\w-]+\/[\w-]+\//;

async function expectPathlessMessage(message: string): Promise<void> {
  if (repoRoot === undefined) throw new Error("repoRoot not initialized");
  expect(message).not.toContain(repoRoot);
  expect(message).not.toContain(await realpath(repoRoot));
  expect(message).not.toMatch(PATH_LIKE_PATTERN);
}

function getRepoRoot(): string {
  if (repoRoot === undefined) throw new Error("repoRoot not initialized");
  return repoRoot;
}

describe("basouPaths", () => {
  it("returns a layout rooted at <repo>/.basou", () => {
    const root = getRepoRoot();
    const paths = basouPaths(root);
    expect(paths.root).toBe(join(root, ".basou"));
    expect(paths.sessions.startsWith(`${paths.root}${sep}`)).toBe(true);
    expect(paths.tasks.startsWith(`${paths.root}${sep}`)).toBe(true);
    expect(paths.approvals.pending.startsWith(`${paths.root}${sep}`)).toBe(true);
    expect(paths.approvals.resolved.startsWith(`${paths.root}${sep}`)).toBe(true);
    expect(paths.locks.startsWith(`${paths.root}${sep}`)).toBe(true);
    expect(paths.logs.startsWith(`${paths.root}${sep}`)).toBe(true);
    expect(paths.raw.startsWith(`${paths.root}${sep}`)).toBe(true);
    expect(paths.tmp.startsWith(`${paths.root}${sep}`)).toBe(true);
  });

  it("includes manifest/status/handoff/decisions file paths under .basou root", () => {
    const root = getRepoRoot();
    const paths = basouPaths(root);
    expect(paths.files.manifest).toBe(join(root, ".basou", "manifest.yaml"));
    expect(paths.files.status).toBe(join(root, ".basou", "status.json"));
    expect(paths.files.handoff).toBe(join(root, ".basou", "handoff.md"));
    expect(paths.files.decisions).toBe(join(root, ".basou", "decisions.md"));
  });

  it("is pure — calling it does not create any files", async () => {
    const root = getRepoRoot();
    basouPaths(root);
    const entries = await readdir(root);
    expect(entries).toEqual([]);
  });
});

describe("ensureBasouDirectory", () => {
  it("creates all required subdirectories", async () => {
    const paths = await ensureBasouDirectory(getRepoRoot());
    for (const target of [
      paths.sessions,
      paths.tasks,
      paths.approvals.pending,
      paths.approvals.resolved,
      paths.locks,
      paths.logs,
      paths.raw,
      paths.tmp,
    ]) {
      const info = await stat(target);
      expect(info.isDirectory()).toBe(true);
    }
  });

  it("returns paths matching basouPaths(repositoryRoot)", async () => {
    const root = getRepoRoot();
    const created = await ensureBasouDirectory(root);
    expect(created).toEqual(basouPaths(root));
  });

  it("is idempotent on an empty target", async () => {
    const root = getRepoRoot();
    await ensureBasouDirectory(root);
    const second = await ensureBasouDirectory(root);
    expect(second).toEqual(basouPaths(root));
    const info = await stat(second.sessions);
    expect(info.isDirectory()).toBe(true);
  });

  it("is idempotent when some subdirectories pre-exist", async () => {
    const root = getRepoRoot();
    const paths = basouPaths(root);
    await mkdir(paths.sessions, { recursive: true });
    await ensureBasouDirectory(root);
    for (const target of [
      paths.tasks,
      paths.approvals.pending,
      paths.approvals.resolved,
      paths.locks,
      paths.logs,
      paths.raw,
      paths.tmp,
    ]) {
      const info = await stat(target);
      expect(info.isDirectory()).toBe(true);
    }
  });

  it("throws when .basou exists as a file", async () => {
    const root = getRepoRoot();
    await writeFile(join(root, ".basou"), "");
    await expect(ensureBasouDirectory(root)).rejects.toThrow(/exists but is not a directory/);
  });

  it("throws when .basou/approvals exists as a file", async () => {
    const root = getRepoRoot();
    await mkdir(join(root, ".basou"));
    await writeFile(join(root, ".basou", "approvals"), "");
    await expect(ensureBasouDirectory(root)).rejects.toThrow(/exists but is not a directory/);
  });

  it("rejects when .basou is a symlink (regardless of target)", async () => {
    const root = getRepoRoot();
    const linkTarget = await mkdtemp(join(tmpdir(), "basou-symlink-target-"));
    try {
      await symlink(linkTarget, join(root, ".basou"));
      await expect(ensureBasouDirectory(root)).rejects.toThrow(/exists but is not a directory/);
    } finally {
      await rm(linkTarget, { recursive: true, force: true });
    }
  });

  it("emits a pathless error message when .basou is a file (root-as-file case)", async () => {
    const root = getRepoRoot();
    await writeFile(join(root, ".basou"), "");
    let captured: unknown;
    try {
      await ensureBasouDirectory(root);
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    await expectPathlessMessage((captured as Error).message);
  });

  it("emits a pathless error message when a subdirectory is a file (subdirectory-as-file case)", async () => {
    const root = getRepoRoot();
    await mkdir(join(root, ".basou"));
    await writeFile(join(root, ".basou", "approvals"), "");
    let captured: unknown;
    try {
      await ensureBasouDirectory(root);
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    await expectPathlessMessage((captured as Error).message);
  });

  it("works when repositoryRoot is itself created via mkdtemp (sanity)", async () => {
    const paths = await ensureBasouDirectory(getRepoRoot());
    const info = await stat(paths.root);
    expect(info.isDirectory()).toBe(true);
  });
});
