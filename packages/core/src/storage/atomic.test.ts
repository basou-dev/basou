import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicCreate, atomicReplace } from "./atomic.js";

let workDir: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "basou-atomic-test-"));
});

afterEach(async () => {
  if (workDir !== undefined) {
    await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function getWorkDir(): string {
  if (workDir === undefined) throw new Error("workDir not initialized");
  return workDir;
}

describe("atomicCreate", () => {
  it("creates the target file with the given string content", async () => {
    const filePath = join(getWorkDir(), "created.txt");
    await atomicCreate(filePath, "hello\nworld\n");
    expect(await readFile(filePath, "utf8")).toBe("hello\nworld\n");
  });

  it("supports Buffer content", async () => {
    const filePath = join(getWorkDir(), "buffer.txt");
    await atomicCreate(filePath, Buffer.from("buf-body"));
    expect(await readFile(filePath, "utf8")).toBe("buf-body");
  });

  it("leaves no tmp file behind on success", async () => {
    const root = getWorkDir();
    const filePath = join(root, "created.txt");
    await atomicCreate(filePath, "x");
    const entries = await readdir(root);
    expect(entries).toContain("created.txt");
    expect(entries.some((name) => name.startsWith("created.txt.tmp."))).toBe(false);
  });

  it("re-throws the native EEXIST error when the target already exists", async () => {
    const filePath = join(getWorkDir(), "existing.txt");
    await writeFile(filePath, "first", "utf8");
    let captured: unknown;
    try {
      await atomicCreate(filePath, "second");
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    // The helper re-throws the native fs Error verbatim (not wrapped), so
    // `code` lives directly on the captured error.
    expect((captured as { code?: unknown }).code).toBe("EEXIST");
    // Original target content untouched.
    expect(await readFile(filePath, "utf8")).toBe("first");
  });

  it("cleans up the tmp file when link fails", async () => {
    const root = getWorkDir();
    const filePath = join(root, "existing.txt");
    await writeFile(filePath, "first", "utf8");
    let threw = false;
    try {
      await atomicCreate(filePath, "second");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    const entries = await readdir(root);
    expect(entries.some((name) => name.startsWith("existing.txt.tmp."))).toBe(false);
  });

  it("cleans up the tmp file when the tmp write itself fails (missing dir)", async () => {
    const root = getWorkDir();
    const filePath = join(root, "no-such-dir", "x.txt");
    let captured: unknown;
    try {
      await atomicCreate(filePath, "x");
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as { code?: unknown }).code).toBe("ENOENT");
    // No tmp pollution in the parent directory.
    const entries = await readdir(root);
    expect(entries.length).toBe(0);
  });
});

describe("atomicReplace", () => {
  it("creates the target file when absent", async () => {
    const filePath = join(getWorkDir(), "new.txt");
    await atomicReplace(filePath, "hello");
    expect(await readFile(filePath, "utf8")).toBe("hello");
  });

  it("overwrites an existing target", async () => {
    const filePath = join(getWorkDir(), "replace.txt");
    await writeFile(filePath, "v1", "utf8");
    await atomicReplace(filePath, "v2");
    expect(await readFile(filePath, "utf8")).toBe("v2");
  });

  it("supports Buffer content", async () => {
    const filePath = join(getWorkDir(), "buffer.txt");
    await atomicReplace(filePath, Buffer.from("buf-body"));
    expect(await readFile(filePath, "utf8")).toBe("buf-body");
  });

  it("leaves no tmp file behind on success", async () => {
    const root = getWorkDir();
    const filePath = join(root, "ok.txt");
    await atomicReplace(filePath, "x");
    const entries = await readdir(root);
    expect(entries).toContain("ok.txt");
    expect(entries.some((name) => name.startsWith("ok.txt.tmp."))).toBe(false);
  });

  it("cleans up the tmp file when the tmp write fails (missing dir)", async () => {
    const root = getWorkDir();
    const filePath = join(root, "no-such-dir", "x.txt");
    let captured: unknown;
    try {
      await atomicReplace(filePath, "x");
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as { code?: unknown }).code).toBe("ENOENT");
    const entries = await readdir(root);
    expect(entries.length).toBe(0);
  });

  it("cleans up the tmp file when rename fails (target is a non-empty directory)", async () => {
    // Pre-create the target as a non-empty directory so `rename(tmp, target)`
    // fails after the tmp write has already succeeded. This exercises the
    // post-write / rename-failure cleanup path explicitly, complementing the
    // missing-dir case above (which fails inside the tmp write itself).
    const root = getWorkDir();
    const filePath = join(root, "target");
    await mkdir(filePath);
    await writeFile(join(filePath, "child"), "x", "utf8");
    let captured: unknown;
    try {
      await atomicReplace(filePath, "content");
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    // Native rename error: code is platform-dependent (EISDIR / ENOTDIR /
    // EEXIST) so we only assert that *some* errno code surfaced.
    expect((captured as { code?: unknown }).code).toBeDefined();
    // Target untouched — still the original directory.
    const stat = await lstat(filePath);
    expect(stat.isDirectory()).toBe(true);
    // No tmp pollution alongside the target.
    const entries = await readdir(root);
    expect(entries.some((name) => name.startsWith("target.tmp."))).toBe(false);
  });
});
