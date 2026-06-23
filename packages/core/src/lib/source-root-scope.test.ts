import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyFilesBySourceRoot } from "./source-root-scope.js";

// A temp layout standing in for a planning-master + sibling repos:
//   <tmp>/master    ← the planning master (.basou lives here; masterRoot)
//   <tmp>/sibling   ← a declared source root (../sibling)
//   <tmp>/outside   ← an UNRELATED repo (not in source_roots) = the leak
let tmp: string | undefined;
let masterRoot: string;
let homedir: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "basou-scope-test-"));
  homedir = tmp;
  masterRoot = join(tmp, "master");
  await mkdir(masterRoot, { recursive: true });
  await mkdir(join(tmp, "sibling"), { recursive: true });
  await mkdir(join(tmp, "outside"), { recursive: true });
  await writeFile(join(masterRoot, "in-master.md"), "x");
  await writeFile(join(tmp, "sibling", "in-sibling.ts"), "x");
  await writeFile(join(tmp, "outside", "blog.md"), "x");
});

afterEach(async () => {
  if (tmp !== undefined) {
    await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

describe("classifyFilesBySourceRoot", () => {
  it("returns everything in-root for an absent source_roots list (solo project)", async () => {
    const result = await classifyFilesBySourceRoot({
      files: ["~/outside/blog.md", "in-master.md"],
      workingDirectory: masterRoot,
      sourceRoots: null,
      masterRoot,
      homedir,
    });
    // Absent roots ⇒ effective root is the repo root; only files under it are
    // in-root, but the bias keeps the unresolved-vs-root call conservative.
    expect(result.outOfRoot).toEqual(["~/outside/blog.md"]);
    expect(result.inRoot).toContain("in-master.md");
  });

  it("classifies a file under a declared sibling source root as in-root", async () => {
    const result = await classifyFilesBySourceRoot({
      files: ["~/sibling/in-sibling.ts"],
      workingDirectory: masterRoot,
      sourceRoots: [".", "../sibling"],
      masterRoot,
      homedir,
    });
    expect(result.inRoot).toEqual(["~/sibling/in-sibling.ts"]);
    expect(result.outOfRoot).toEqual([]);
  });

  it("flags a file outside every source root as out-of-root (the cross-project leak)", async () => {
    const result = await classifyFilesBySourceRoot({
      files: ["in-master.md", "~/sibling/in-sibling.ts", "~/outside/blog.md"],
      workingDirectory: masterRoot,
      sourceRoots: [".", "../sibling"],
      masterRoot,
      homedir,
    });
    expect(result.outOfRoot).toEqual(["~/outside/blog.md"]);
    expect(result.inRoot.sort()).toEqual(["in-master.md", "~/sibling/in-sibling.ts"].sort());
  });

  it("does NOT mis-flag a file reached through a workspace-view symlink (realpath)", async () => {
    // A view symlink under the master points at the sibling source root; a file
    // recorded through it must resolve (via realpath) to in-root, not be cried
    // wolf on. This is the #103 realpath-first lesson applied to file scope.
    await symlink(join(tmp as string, "sibling"), join(masterRoot, "viewlink"));
    const result = await classifyFilesBySourceRoot({
      files: ["viewlink/in-sibling.ts"],
      workingDirectory: masterRoot,
      sourceRoots: [".", "../sibling"],
      masterRoot,
      homedir,
    });
    expect(result.outOfRoot).toEqual([]);
    expect(result.inRoot).toEqual(["viewlink/in-sibling.ts"]);
  });

  it("classifies a since-moved (non-existent) path by its location", async () => {
    const result = await classifyFilesBySourceRoot({
      files: ["~/outside/gone.md", "~/sibling/also-gone.ts"],
      workingDirectory: masterRoot,
      sourceRoots: [".", "../sibling"],
      masterRoot,
      homedir,
    });
    expect(result.outOfRoot).toEqual(["~/outside/gone.md"]);
    expect(result.inRoot).toEqual(["~/sibling/also-gone.ts"]);
  });

  it("returns empty partitions for empty input", async () => {
    const result = await classifyFilesBySourceRoot({
      files: [],
      workingDirectory: masterRoot,
      sourceRoots: [".", "../sibling"],
      masterRoot,
      homedir,
    });
    expect(result).toEqual({ inRoot: [], outOfRoot: [] });
  });

  it("resolves an absolute path directly", async () => {
    const result = await classifyFilesBySourceRoot({
      files: [join(tmp as string, "outside", "blog.md")],
      workingDirectory: masterRoot,
      sourceRoots: [".", "../sibling"],
      masterRoot,
      homedir,
    });
    expect(result.outOfRoot).toEqual([join(tmp as string, "outside", "blog.md")]);
  });
});
