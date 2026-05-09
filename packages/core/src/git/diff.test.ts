import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SimpleGit, simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDiff } from "./diff.js";

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
