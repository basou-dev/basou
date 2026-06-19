import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertNotSymlink, writeFileDurable } from "./durable-write.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "basou-durable-write-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeFileDurable", () => {
  it("creates a new file with the given content", async () => {
    const p = join(dir, "new.txt");
    await writeFileDurable(p, "hello\n");
    expect(await readFile(p, "utf8")).toBe("hello\n");
  });

  it("overwrites an existing file and preserves its permission bits", async () => {
    const p = join(dir, "f.txt");
    await writeFile(p, "old\n");
    await chmod(p, 0o600);
    await writeFileDurable(p, "new\n");
    expect(await readFile(p, "utf8")).toBe("new\n");
    expect((await stat(p)).mode & 0o777).toBe(0o600);
  });

  it("leaves no stray tmp file behind", async () => {
    const p = join(dir, "f.txt");
    await writeFileDurable(p, "x\n");
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    expect(entries.filter((e) => e.includes(".tmp."))).toEqual([]);
  });
});

describe("assertNotSymlink", () => {
  it("resolves for a missing path and for a regular file", async () => {
    await expect(assertNotSymlink(join(dir, "missing"))).resolves.toBeUndefined();
    const f = join(dir, "regular");
    await writeFile(f, "x");
    await expect(assertNotSymlink(f)).resolves.toBeUndefined();
  });

  it("throws for a symlinked path", async () => {
    const real = join(dir, "real");
    await writeFile(real, "x");
    const link = join(dir, "link");
    await symlink(real, link);
    await expect(assertNotSymlink(link)).rejects.toThrow(/symlink/);
  });
});
