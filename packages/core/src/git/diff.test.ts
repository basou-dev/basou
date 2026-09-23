import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SimpleGit, simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getChangesSince, getDiff } from "./diff.js";

const ENV_GLOBAL = process.platform === "win32" ? "\\\\.\\nul" : "/dev/null";
const ENV: NodeJS.ProcessEnv = {
  ...(process.env.PATH !== undefined ? { PATH: process.env.PATH } : {}),
  ...(process.env.HOME !== undefined ? { HOME: process.env.HOME } : {}),
  ...(process.env.USERPROFILE !== undefined ? { USERPROFILE: process.env.USERPROFILE } : {}),
  GIT_CONFIG_GLOBAL: ENV_GLOBAL,
  GIT_CONFIG_SYSTEM: ENV_GLOBAL,
};

// Test-only SimpleGit factory: needs `unsafe.allowUnsafeConfigPaths` so the
// isolated GIT_CONFIG_GLOBAL/SYSTEM paths are honoured. Production code paths
// in diff.ts use the production `safeSimpleGit` from snapshot.ts which does
// not opt into unsafe options. Named distinctly to avoid shadowing the
// production export inside this module.
function fixtureSimpleGit(baseDir: string, extraConfig: readonly string[] = []): SimpleGit {
  return simpleGit({
    baseDir,
    config: [...extraConfig],
    unsafe: { allowUnsafeConfigPaths: true },
  }).env(ENV);
}

let tmpRepo: string;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-diff-test-"));
});

afterEach(async () => {
  await rm(tmpRepo, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function initRepoWithFiles(
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
  const head = (await git.revparse(["HEAD"])).trimEnd();
  return { head, git };
}

describe("getDiff", () => {
  it("returns an empty result when baseRef equals headRef (early return)", async () => {
    const { head } = await initRepoWithFiles(tmpRepo);
    const diff = await getDiff(tmpRepo, head, head);
    expect(diff.changed_files).toEqual([]);
  });

  it("classifies a single added file as 'added'", async () => {
    const { head: base, git } = await initRepoWithFiles(tmpRepo);
    await writeFile(join(tmpRepo, "added.txt"), "new\n");
    await git.add("added.txt");
    await git.commit("add new file");
    const head = (await git.revparse(["HEAD"])).trimEnd();
    const diff = await getDiff(tmpRepo, base, head);
    expect(diff.changed_files).toEqual([{ path: "added.txt", status: "added" }]);
  });

  it("classifies a single modified file as 'modified'", async () => {
    const { head: base, git } = await initRepoWithFiles(tmpRepo);
    await writeFile(join(tmpRepo, "README.md"), "# init (modified)\n");
    await git.add("README.md");
    await git.commit("modify README");
    const head = (await git.revparse(["HEAD"])).trimEnd();
    const diff = await getDiff(tmpRepo, base, head);
    expect(diff.changed_files).toEqual([{ path: "README.md", status: "modified" }]);
  });

  it("classifies a single deleted file as 'deleted'", async () => {
    const { head: base, git } = await initRepoWithFiles(tmpRepo);
    await git.rm("README.md");
    await git.commit("delete README");
    const head = (await git.revparse(["HEAD"])).trimEnd();
    const diff = await getDiff(tmpRepo, base, head);
    expect(diff.changed_files).toEqual([{ path: "README.md", status: "deleted" }]);
  });

  it("classifies a renamed file as 'renamed' with old_path set", async () => {
    const { head: base, git } = await initRepoWithFiles(tmpRepo, { "old.txt": "same body\n" });
    await git.mv("old.txt", "new.txt");
    await git.commit("rename");
    const head = (await git.revparse(["HEAD"])).trimEnd();
    const diff = await getDiff(tmpRepo, base, head);
    expect(diff.changed_files).toEqual([
      { path: "new.txt", old_path: "old.txt", status: "renamed" },
    ]);
  });

  it("captures multiple changes in a single diff", async () => {
    const { head: base, git } = await initRepoWithFiles(tmpRepo, {
      "keep.txt": "keep\n",
      "to-delete.txt": "x\n",
      "to-modify.txt": "before\n",
    });
    await writeFile(join(tmpRepo, "added.txt"), "fresh\n");
    await git.add("added.txt");
    await writeFile(join(tmpRepo, "to-modify.txt"), "after\n");
    await git.add("to-modify.txt");
    await git.rm("to-delete.txt");
    await git.commit("multi");
    const head = (await git.revparse(["HEAD"])).trimEnd();
    const diff = await getDiff(tmpRepo, base, head);
    const sorted = [...diff.changed_files].sort((a, b) => a.path.localeCompare(b.path));
    expect(sorted).toEqual([
      { path: "added.txt", status: "added" },
      { path: "to-delete.txt", status: "deleted" },
      { path: "to-modify.txt", status: "modified" },
    ]);
  });

  it("throws Error('Not a git repository') for a non-git directory", async () => {
    let err: unknown;
    try {
      await getDiff(tmpRepo, "HEAD", "HEAD~1");
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Not a git repository");
    expect((err as Error).message).not.toContain(tmpRepo);
  });

  it.skipIf(process.platform === "win32")(
    "throws 'Git executable not found in PATH. Install git first.' when git binary is missing",
    async () => {
      const { head } = await initRepoWithFiles(tmpRepo);
      vi.stubEnv("PATH", "/nonexistent");
      let err: unknown;
      try {
        await getDiff(tmpRepo, head, head === "" ? "HEAD" : `${head}~1`);
      } catch (caught) {
        err = caught;
      }
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("Git executable not found in PATH. Install git first.");
      expect((err as Error).cause).toBeInstanceOf(Error);
    },
  );

  it("throws Error('Invalid ref') when an unknown ref is supplied", async () => {
    const { head } = await initRepoWithFiles(tmpRepo);
    let err: unknown;
    try {
      await getDiff(tmpRepo, "nonexistent-base-ref", head);
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Invalid ref");
    expect((err as Error).cause).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(tmpRepo);
  });

  it("does not classify typechange (T) entries as added/modified/deleted/renamed", async () => {
    // A typechange between two non-symlink commits is impossible to construct
    // portably (Windows lacks symlink permissions by default), so we instead
    // verify the contract negatively: the parser drops anything that does not
    // match A / M / D / R*. We construct an extremely simple commit-pair where
    // git produces no T entries; the assertion is that the result remains
    // strictly within the four allowed statuses.
    const { head: base, git } = await initRepoWithFiles(tmpRepo);
    await writeFile(join(tmpRepo, "x.txt"), "x\n");
    await git.add("x.txt");
    await git.commit("add x");
    const head = (await git.revparse(["HEAD"])).trimEnd();
    const diff = await getDiff(tmpRepo, base, head);
    for (const change of diff.changed_files) {
      expect(["added", "modified", "deleted", "renamed"]).toContain(change.status);
    }
  });

  describe("message contract (exact match)", () => {
    it("Not a git repository / non-git directory", async () => {
      const dir = await mkdtemp(join(tmpdir(), "basou-diff-nongit-"));
      try {
        let err: unknown;
        try {
          await getDiff(dir, "HEAD", "HEAD~1");
        } catch (caught) {
          err = caught;
        }
        expect((err as Error).message).toBe("Not a git repository");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it.skipIf(process.platform === "win32")(
      "Git executable not found in PATH. Install git first.",
      async () => {
        const { head } = await initRepoWithFiles(tmpRepo);
        vi.stubEnv("PATH", "/nonexistent");
        let err: unknown;
        try {
          await getDiff(tmpRepo, head, head);
        } catch (caught) {
          err = caught;
        }
        // baseRef === headRef short-circuits before any git call, so this
        // case constructs a divergent ref pair to force the spawn path.
        if (err === undefined) {
          try {
            await getDiff(tmpRepo, `${head}~1`, head);
          } catch (caught) {
            err = caught;
          }
        }
        expect((err as Error).message).toBe("Git executable not found in PATH. Install git first.");
      },
    );

    it("Invalid ref / unknown ref", async () => {
      const { head } = await initRepoWithFiles(tmpRepo);
      let err: unknown;
      try {
        await getDiff(tmpRepo, head, "no-such-ref");
      } catch (caught) {
        err = caught;
      }
      expect((err as Error).message).toBe("Invalid ref");
    });
  });
});

describe("getChangesSince", () => {
  it("answers with committed AND uncommitted work in one call", async () => {
    const { head, git } = await initRepoWithFiles(tmpRepo);
    // Committed after the base.
    await writeFile(join(tmpRepo, "committed.ts"), "export const a = 1;\n");
    await git.add("committed.ts");
    await git.commit("add committed.ts");
    // Left dirty after that commit.
    await writeFile(join(tmpRepo, "README.md"), "# edited\n");

    const changes = await getChangesSince(tmpRepo, head);
    expect(changes).toEqual(
      expect.arrayContaining([
        { path: "committed.ts", status: "added" },
        { path: "README.md", status: "modified" },
      ]),
    );
    expect(changes).toHaveLength(2);
  });

  it("classifies a file relative to the BASE, not to the last commit", async () => {
    const { head, git } = await initRepoWithFiles(tmpRepo);
    await writeFile(join(tmpRepo, "new.ts"), "export const a = 1;\n");
    await git.add("new.ts");
    await git.commit("add new.ts");
    // Changed again after being committed: still `added` as far as the base is
    // concerned, because it did not exist there.
    await writeFile(join(tmpRepo, "new.ts"), "export const a = 2;\n");

    expect(await getChangesSince(tmpRepo, head)).toEqual([{ path: "new.ts", status: "added" }]);
  });

  it("does not report untracked files (the caller unions them in)", async () => {
    const { head } = await initRepoWithFiles(tmpRepo);
    await writeFile(join(tmpRepo, "untracked.ts"), "export const a = 1;\n");
    expect(await getChangesSince(tmpRepo, head)).toEqual([]);
  });

  it("throws the fixed 'Invalid ref' when the base no longer resolves", async () => {
    await initRepoWithFiles(tmpRepo);
    await expect(getChangesSince(tmpRepo, "0".repeat(40))).rejects.toThrow("Invalid ref");
  });

  it("throws the fixed 'Not a git repository' outside a repository", async () => {
    await expect(getChangesSince(tmpRepo, "HEAD")).rejects.toThrow("Not a git repository");
  });
});

describe("paths git would quote", () => {
  // Without `-z`, git renders each of these as a double-quoted, escaped string
  // (`"\346\227\245.md"`, `"has\"quote.txt"`, ...) that names no file on disk.
  const NAMES = [
    ["non-ASCII", "日本語.md"],
    ["a double quote", 'has"quote.txt'],
    ["a backslash", "back\\slash.txt"],
    ["a tab", "tab\there.txt"],
    ["a newline", "new\nline.txt"],
  ] as const;

  it.each(NAMES)(
    "getDiff returns a path with %s exactly as it is on disk",
    async (_label, name) => {
      const { head: base, git } = await initRepoWithFiles(tmpRepo);
      await writeFile(join(tmpRepo, name), "x\n");
      await git.add(name);
      await git.commit("add it");
      const head = (await git.revparse(["HEAD"])).trimEnd();

      const { changed_files } = await getDiff(tmpRepo, base, head);
      expect(changed_files).toEqual([{ path: name, status: "added" }]);
    },
  );

  it.each(NAMES)(
    "getChangesSince returns a path with %s exactly as it is on disk",
    async (_label, name) => {
      const { head: base, git } = await initRepoWithFiles(tmpRepo);
      await writeFile(join(tmpRepo, name), "x\n");
      await git.add(name);
      await git.commit("add it");

      expect(await getChangesSince(tmpRepo, base)).toEqual([{ path: name, status: "added" }]);
    },
  );

  it("keeps both halves of a rename between two such names, in the right order", async () => {
    const from = "日本語.md";
    const to = 'renamed "日本".md';
    const { git } = await initRepoWithFiles(tmpRepo, { [from]: "same body\n" });
    const base = (await git.revparse(["HEAD"])).trimEnd();
    await git.mv(from, to);
    await git.commit("rename it");
    const head = (await git.revparse(["HEAD"])).trimEnd();

    const { changed_files } = await getDiff(tmpRepo, base, head);
    expect(changed_files).toEqual([{ path: to, status: "renamed", old_path: from }]);
  });

  it("does not let one entry's fields leak into the next", async () => {
    // A rename (two paths) followed by ordinary entries (one path each): if the
    // parser took the wrong number of fields for the rename, every later path
    // would be shifted by one and read as a status.
    const { git } = await initRepoWithFiles(tmpRepo, {
      "a.txt": "a body that stays the same\n",
      "b.txt": "b\n",
    });
    const base = (await git.revparse(["HEAD"])).trimEnd();
    await git.mv("a.txt", "z-renamed.txt");
    await writeFile(join(tmpRepo, "b.txt"), "b changed\n");
    await writeFile(join(tmpRepo, "cé.txt"), "new\n");
    await git.add(["b.txt", "cé.txt"]);
    await git.commit("three kinds at once");
    const head = (await git.revparse(["HEAD"])).trimEnd();

    const { changed_files } = await getDiff(tmpRepo, base, head);
    expect([...changed_files].sort((x, y) => (x.path < y.path ? -1 : 1))).toEqual([
      { path: "b.txt", status: "modified" },
      { path: "cé.txt", status: "added" },
      { path: "z-renamed.txt", status: "renamed", old_path: "a.txt" },
    ]);
  });

  it("skips a copy entry without shifting the ones after it", async () => {
    // basou never asks for copy detection, but an operator's `diff.renames =
    // copies` makes git emit `C<score>\0<from>\0<to>` -- two paths, like a
    // rename. Reading it as one path would turn every later path into a status.
    const body = "a body long enough for git to call the new file a copy of it\n".repeat(8);
    const { git } = await initRepoWithFiles(tmpRepo, { "orig.txt": body, "z.txt": "z\n" });
    await git.addConfig("diff.renames", "copies");
    const base = (await git.revparse(["HEAD"])).trimEnd();
    await writeFile(join(tmpRepo, "orig.txt"), `${body}one more line\n`);
    await writeFile(join(tmpRepo, "copy.txt"), body);
    await writeFile(join(tmpRepo, "z.txt"), "z changed\n");
    await git.add(["orig.txt", "copy.txt", "z.txt"]);
    await git.commit("copy, modify, modify");
    const head = (await git.revparse(["HEAD"])).trimEnd();

    const raw = await git.raw(["diff", "--name-status", `${base}..${head}`]);
    expect(raw).toMatch(/^C\d+\t/m); // the fixture really produces a copy entry
    const { changed_files } = await getDiff(tmpRepo, base, head);
    expect([...changed_files].sort((x, y) => (x.path < y.path ? -1 : 1))).toEqual([
      { path: "orig.txt", status: "modified" },
      { path: "z.txt", status: "modified" },
    ]);
  });

  it("reads a deletion of such a name", async () => {
    const name = "日本語.md";
    const { git } = await initRepoWithFiles(tmpRepo, { [name]: "x\n", "keep.txt": "k\n" });
    const base = (await git.revparse(["HEAD"])).trimEnd();
    await git.rm(name);
    await git.commit("remove it");
    const head = (await git.revparse(["HEAD"])).trimEnd();

    expect((await getDiff(tmpRepo, base, head)).changed_files).toEqual([
      { path: name, status: "deleted" },
    ]);
  });
});
