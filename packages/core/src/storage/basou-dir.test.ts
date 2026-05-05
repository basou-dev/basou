import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { basouPaths, ensureBasouDirectory } from "./basou-dir.js";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "basou-test-"));
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

const PATH_LIKE_PATTERN = /\/[\w-]+\/[\w-]+\//;

async function expectPathlessMessage(message: string): Promise<void> {
  expect(message).not.toContain(repoRoot);
  expect(message).not.toContain(await realpath(repoRoot));
  expect(message).not.toMatch(PATH_LIKE_PATTERN);
}

describe("basouPaths", () => {
  it("returns a layout rooted at <repo>/.basou", () => {
    const paths = basouPaths(repoRoot);
    expect(paths.root).toBe(join(repoRoot, ".basou"));
    expect(paths.sessions.startsWith(`${paths.root}${sep}`)).toBe(true);
    expect(paths.tasks.startsWith(`${paths.root}${sep}`)).toBe(true);
    expect(paths.approvals.pending.startsWith(`${paths.root}${sep}`)).toBe(true);
    expect(paths.approvals.resolved.startsWith(`${paths.root}${sep}`)).toBe(true);
    expect(paths.logs.startsWith(`${paths.root}${sep}`)).toBe(true);
    expect(paths.raw.startsWith(`${paths.root}${sep}`)).toBe(true);
    expect(paths.tmp.startsWith(`${paths.root}${sep}`)).toBe(true);
  });

  it("is pure — calling it does not create any files", async () => {
    basouPaths(repoRoot);
    const entries = await readdir(repoRoot);
    expect(entries).toEqual([]);
  });
});

describe("ensureBasouDirectory", () => {
  it("creates all six required subdirectories", async () => {
    const paths = await ensureBasouDirectory(repoRoot);
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

  it("returns paths matching basouPaths(repositoryRoot)", async () => {
    const created = await ensureBasouDirectory(repoRoot);
    expect(created).toEqual(basouPaths(repoRoot));
  });

  it("is idempotent on an empty target", async () => {
    await ensureBasouDirectory(repoRoot);
    const second = await ensureBasouDirectory(repoRoot);
    expect(second).toEqual(basouPaths(repoRoot));
    const info = await stat(second.sessions);
    expect(info.isDirectory()).toBe(true);
  });

  it("is idempotent when some subdirectories pre-exist", async () => {
    const paths = basouPaths(repoRoot);
    await mkdir(paths.sessions, { recursive: true });
    await ensureBasouDirectory(repoRoot);
    for (const target of [
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

  it("throws when .basou exists as a file", async () => {
    await writeFile(join(repoRoot, ".basou"), "");
    await expect(ensureBasouDirectory(repoRoot)).rejects.toThrow(/exists but is not a directory/);
  });

  it("throws when .basou/approvals exists as a file", async () => {
    await mkdir(join(repoRoot, ".basou"));
    await writeFile(join(repoRoot, ".basou", "approvals"), "");
    await expect(ensureBasouDirectory(repoRoot)).rejects.toThrow(/exists but is not a directory/);
  });

  it("emits a pathless error message when .basou is a file (root-as-file case)", async () => {
    await writeFile(join(repoRoot, ".basou"), "");
    let captured: unknown;
    try {
      await ensureBasouDirectory(repoRoot);
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    await expectPathlessMessage((captured as Error).message);
  });

  it("emits a pathless error message when a subdirectory is a file (subdirectory-as-file case)", async () => {
    await mkdir(join(repoRoot, ".basou"));
    await writeFile(join(repoRoot, ".basou", "approvals"), "");
    let captured: unknown;
    try {
      await ensureBasouDirectory(repoRoot);
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    await expectPathlessMessage((captured as Error).message);
  });

  it("works when repositoryRoot is itself created via mkdtemp (sanity)", async () => {
    const paths = await ensureBasouDirectory(repoRoot);
    const info = await stat(paths.root);
    expect(info.isDirectory()).toBe(true);
  });
});
