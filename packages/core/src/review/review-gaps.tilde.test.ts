import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `~/...` is a documented spelling for a record's `repos`, and it is the one the
 * help text and the README example use. Covering it needs `homedir()` to point
 * somewhere a fixture may create a repository, so it lives in its own file: the
 * mock is module-wide, and the rest of the suite must keep the real home.
 *
 * Without this, removing tilde expansion would reject a supported input while
 * every other test stayed green.
 */
let home: string | undefined;
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => process.env.BASOU_TEST_HOME ?? actual.homedir() };
});

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(os.tmpdir(), "basou-rg-home-")));
  process.env.BASOU_TEST_HOME = home;
});
afterEach(async () => {
  process.env.BASOU_TEST_HOME = undefined;
  if (home !== undefined) {
    await rm(home, { recursive: true, force: true });
    home = undefined;
  }
});

describe("tilde-spelled repository paths", () => {
  it("the writer accepts `~/repo` and the reader keys it the same way", async () => {
    const { findUnbindableRepos, normalizeRepoPath, resolveRepoRoot } = await import(
      "./review-gaps.js"
    );
    const repo = join(home as string, "projects", "app");
    await mkdir(join(repo, ".git"), { recursive: true });

    // Everything the writer accepts, the reader must resolve to the same key.
    expect(findUnbindableRepos(["~/projects/app"])).toEqual([]);
    expect(resolveRepoRoot("~/projects/app")).toBe(repo);
    expect(normalizeRepoPath("~/projects/app")).toBe(repo);
    // ...and it agrees with the absolute spelling of the same directory.
    expect(resolveRepoRoot(repo)).toBe(resolveRepoRoot("~/projects/app"));
  });

  it("`~/` naming something that is not a repository root is still refused", async () => {
    const { findUnbindableRepos } = await import("./review-gaps.js");
    await mkdir(join(home as string, "notes"), { recursive: true });
    expect(findUnbindableRepos(["~/notes"])).toEqual([
      { repo: "~/notes", index: 0, problem: "not_a_repo_root" },
    ]);
  });
});
