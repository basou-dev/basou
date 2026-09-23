import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SimpleGit, simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getUntrackedFiles,
  getWorkingTreeChanges,
  readEmptyTreeSha,
  readHeadSha,
} from "./working-tree.js";

const ENV_GLOBAL = process.platform === "win32" ? "\\\\.\\nul" : "/dev/null";
const ENV: NodeJS.ProcessEnv = {
  ...(process.env.PATH !== undefined ? { PATH: process.env.PATH } : {}),
  ...(process.env.HOME !== undefined ? { HOME: process.env.HOME } : {}),
  ...(process.env.USERPROFILE !== undefined ? { USERPROFILE: process.env.USERPROFILE } : {}),
  GIT_CONFIG_GLOBAL: ENV_GLOBAL,
  GIT_CONFIG_SYSTEM: ENV_GLOBAL,
};

function fixtureSimpleGit(baseDir: string, extraConfig: readonly string[] = []): SimpleGit {
  return simpleGit({
    baseDir,
    config: [...extraConfig],
    unsafe: { allowUnsafeConfigPaths: true },
  }).env(ENV);
}

let tmpRepo: string;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-worktree-test-"));
});

afterEach(async () => {
  await rm(tmpRepo, { recursive: true, force: true });
});

async function initRepo(
  dir: string,
  files: Record<string, string> = { "README.md": "# init\n" },
): Promise<{ head: string; git: SimpleGit }> {
  const git = fixtureSimpleGit(dir, ["init.defaultBranch=main"]);
  await git.init();
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "test");
  for (const [path, body] of Object.entries(files)) {
    await writeFile(join(dir, path), body);
    await git.add(path);
  }
  await git.commit("initial");
  return { head: (await git.revparse(["HEAD"])).trimEnd(), git };
}

describe("getWorkingTreeChanges", () => {
  it("returns nothing for a clean tree", async () => {
    await initRepo(tmpRepo);
    expect(await getWorkingTreeChanges(tmpRepo)).toEqual([]);
  });

  it("reports an untracked file as added", async () => {
    await initRepo(tmpRepo);
    await writeFile(join(tmpRepo, "new.ts"), "export const a = 1;\n");
    expect(await getWorkingTreeChanges(tmpRepo)).toEqual([{ path: "new.ts", status: "added" }]);
  });

  it("reports an uncommitted edit as modified", async () => {
    await initRepo(tmpRepo);
    await writeFile(join(tmpRepo, "README.md"), "# changed\n");
    expect(await getWorkingTreeChanges(tmpRepo)).toEqual([
      { path: "README.md", status: "modified" },
    ]);
  });

  it("reports a removed file as deleted", async () => {
    await initRepo(tmpRepo);
    await unlink(join(tmpRepo, "README.md"));
    expect(await getWorkingTreeChanges(tmpRepo)).toEqual([
      { path: "README.md", status: "deleted" },
    ]);
  });

  it("reports a staged rename once, with its previous path", async () => {
    const { git } = await initRepo(tmpRepo);
    await git.mv("README.md", "DOCS.md");
    expect(await getWorkingTreeChanges(tmpRepo)).toEqual([
      { path: "DOCS.md", status: "renamed", old_path: "README.md" },
    ]);
  });

  it("omits ignored files, so a build tree never enters a session's file list", async () => {
    await initRepo(tmpRepo, { ".gitignore": "dist/\n" });
    await mkdir(join(tmpRepo, "dist"));
    await writeFile(join(tmpRepo, "dist", "index.js"), "// built\n");
    await writeFile(join(tmpRepo, "kept.ts"), "export const a = 1;\n");
    expect(await getWorkingTreeChanges(tmpRepo)).toEqual([{ path: "kept.ts", status: "added" }]);
  });

  it("throws the fixed 'Not a git repository' outside a repository", async () => {
    await expect(getWorkingTreeChanges(tmpRepo)).rejects.toThrow("Not a git repository");
  });
});

describe("readHeadSha", () => {
  it("returns HEAD's sha", async () => {
    const { head } = await initRepo(tmpRepo);
    expect(await readHeadSha(tmpRepo)).toBe(head);
  });

  it("returns null on an unborn branch rather than treating it as a failure", async () => {
    const git = fixtureSimpleGit(tmpRepo, ["init.defaultBranch=main"]);
    await git.init();
    expect(await readHeadSha(tmpRepo)).toBeNull();
  });

  it("throws the fixed 'Not a git repository' outside a repository", async () => {
    await expect(readHeadSha(tmpRepo)).rejects.toThrow("Not a git repository");
  });
});

describe("getUntrackedFiles", () => {
  it("names each file inside an untracked directory, not the directory", async () => {
    await initRepo(tmpRepo);
    await mkdir(join(tmpRepo, "newdir"));
    await writeFile(join(tmpRepo, "newdir", "x.ts"), "export const x = 1;\n");
    expect(await getUntrackedFiles(tmpRepo)).toEqual([{ path: "newdir/x.ts", status: "added" }]);
  });

  it("drops an untracked nested repository, which git can only name as a directory", async () => {
    await initRepo(tmpRepo);
    const nested = join(tmpRepo, "nested");
    await mkdir(nested);
    await initRepo(nested);
    await writeFile(join(tmpRepo, "mine.ts"), "export const a = 1;\n");
    expect(await getUntrackedFiles(tmpRepo)).toEqual([{ path: "mine.ts", status: "added" }]);
  });

  it("returns a non-ASCII path unquoted, as `git status` reports it", async () => {
    await initRepo(tmpRepo);
    const name = "\u65e5\u672c\u8a9e.md";
    await writeFile(join(tmpRepo, name), "x\n");
    expect(await getUntrackedFiles(tmpRepo)).toEqual([{ path: name, status: "added" }]);
  });

  it("omits tracked and ignored files", async () => {
    await initRepo(tmpRepo, { ".gitignore": "ignored.ts\n", "README.md": "# init\n" });
    await writeFile(join(tmpRepo, "ignored.ts"), "export const a = 1;\n");
    // A tracked file, edited: it belongs to the diff pass, not to this one.
    await writeFile(join(tmpRepo, "README.md"), "# edited\n");
    expect(await getUntrackedFiles(tmpRepo)).toEqual([]);
  });

  it("throws the fixed 'Not a git repository' outside a repository", async () => {
    await expect(getUntrackedFiles(tmpRepo)).rejects.toThrow("Not a git repository");
  });
});

describe("readEmptyTreeSha", () => {
  it("returns a base that diffs a repository's entire content as new", async () => {
    const { git } = await initRepo(tmpRepo);
    const empty = await readEmptyTreeSha(tmpRepo);
    // Computed, not hard-coded: a sha-256 repository has a different value.
    expect(empty).toMatch(/^[0-9a-f]{40,64}$/);
    const listed = await git.raw(["diff", "--name-only", empty]);
    expect(listed.trim()).toBe("README.md");
  });
});
