import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SimpleGit, simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getOwnCommitPaths } from "./own-commits.js";

const ENV_GLOBAL = process.platform === "win32" ? "\\\\.\\nul" : "/dev/null";
const ENV: NodeJS.ProcessEnv = {
  ...(process.env.PATH !== undefined ? { PATH: process.env.PATH } : {}),
  ...(process.env.HOME !== undefined ? { HOME: process.env.HOME } : {}),
  ...(process.env.USERPROFILE !== undefined ? { USERPROFILE: process.env.USERPROFILE } : {}),
  GIT_CONFIG_GLOBAL: ENV_GLOBAL,
  GIT_CONFIG_SYSTEM: ENV_GLOBAL,
};

/** Long before any commit a test makes, so every reflog entry is in the window. */
const SINCE_MS = Date.parse("2026-01-01T00:00:00.000Z");

let dir: string;
let repo: string;
let git: SimpleGit;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "basou-own-commits-test-"));
  repo = join(dir, "repo");
  await mkdir(repo, { recursive: true });
  git = simpleGit({
    baseDir: repo,
    config: ["init.defaultBranch=main"],
    unsafe: { allowUnsafeConfigPaths: true },
  }).env(ENV);
  await git.init();
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "test");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function commitFile(file: string): Promise<void> {
  await writeFile(join(repo, file), `${file}\n`);
  await git.add(file);
  await git.commit(file);
}

describe("getOwnCommitPaths", () => {
  it("reads every commit when they take more than one call", async () => {
    for (const file of ["a.ts", "b.ts", "c.ts"]) await commitFile(file);
    const result = await getOwnCommitPaths(repo, SINCE_MS, 2);
    expect([...result.paths].sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(result.entriesSince).toBe(6); // HEAD's reflog and main's, three each
  });

  it("throws rather than answer when HEAD has no commit to read a reflog from", async () => {
    await expect(getOwnCommitPaths(repo, SINCE_MS)).rejects.toThrow("Failed to read the reflog");
  });
});
