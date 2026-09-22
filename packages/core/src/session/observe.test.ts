import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SimpleGit, simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Manifest } from "../schemas/manifest.schema.js";
import { readSessionObservation, writeSessionObservation } from "./observation.js";
import { observedRepoRoots, observeSessionChanges, recordSessionBaseline } from "./observe.js";

const ENV_GLOBAL = process.platform === "win32" ? "\\\\.\\nul" : "/dev/null";
const ENV: NodeJS.ProcessEnv = {
  ...(process.env.PATH !== undefined ? { PATH: process.env.PATH } : {}),
  ...(process.env.HOME !== undefined ? { HOME: process.env.HOME } : {}),
  ...(process.env.USERPROFILE !== undefined ? { USERPROFILE: process.env.USERPROFILE } : {}),
  GIT_CONFIG_GLOBAL: ENV_GLOBAL,
  GIT_CONFIG_SYSTEM: ENV_GLOBAL,
};

function fixtureSimpleGit(baseDir: string): SimpleGit {
  return simpleGit({
    baseDir,
    config: ["init.defaultBranch=main"],
    unsafe: { allowUnsafeConfigPaths: true },
  }).env(ENV);
}

let dir: string;
let repo: string;
let observationsDir: string;
let git: SimpleGit;

const EXTERNAL_ID = "session-under-test";
const T0 = "2026-09-22T10:00:00.000Z";
const T1 = "2026-09-22T10:30:00.000Z";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "basou-observe-test-"));
  repo = join(dir, "repo");
  observationsDir = join(dir, "observations");
  git = await initRepo(repo);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A repository with one commit, isolated from the machine's git config. */
async function initRepo(path: string): Promise<SimpleGit> {
  await mkdir(path, { recursive: true });
  const repoGit = fixtureSimpleGit(path);
  await repoGit.init();
  await repoGit.addConfig("user.email", "test@example.com");
  await repoGit.addConfig("user.name", "test");
  await writeFile(join(path, "README.md"), "# init\n");
  await repoGit.add("README.md");
  await repoGit.commit("initial");
  return repoGit;
}

async function baseline(): Promise<void> {
  await recordSessionBaseline({
    observationsDir,
    repoRoots: [repo],
    externalId: EXTERNAL_ID,
    nowIso: T0,
  });
}

async function observe(): Promise<string[]> {
  const result = await observeSessionChanges({
    observationsDir,
    externalId: EXTERNAL_ID,
    nowIso: T1,
  });
  return (result?.repos[0]?.files ?? []).map((f) => f.path);
}

describe("observedRepoRoots", () => {
  const manifest = (repos?: { path: string }[]): Manifest =>
    ({ ...(repos !== undefined ? { repos } : {}) }) as unknown as Manifest;

  it("resolves the declared roster against the store root", () => {
    expect(observedRepoRoots("/ws", manifest([{ path: "." }, { path: "../other" }]))).toEqual([
      "/ws",
      "/other",
    ]);
  });

  it("falls back to the store's own repository when no roster is declared", () => {
    expect(observedRepoRoots("/ws", manifest())).toEqual(["/ws"]);
  });

  it("collapses duplicate spellings of the same root", () => {
    expect(observedRepoRoots("/ws", manifest([{ path: "." }, { path: "./" }]))).toEqual(["/ws"]);
  });
});

describe("recordSessionBaseline", () => {
  it("records HEAD for each repository it can read", async () => {
    await baseline();
    const stored = await readSessionObservation(observationsDir, EXTERNAL_ID);
    expect(stored?.repos).toHaveLength(1);
    expect(stored?.repos[0]?.base_head).toBe((await git.revparse(["HEAD"])).trimEnd());
  });

  it("records what was ALREADY dirty, so the session is not charged for it", async () => {
    await writeFile(join(repo, "README.md"), "# edited before the session\n");
    await baseline();
    const stored = await readSessionObservation(observationsDir, EXTERNAL_ID);
    expect(stored?.repos[0]?.base_dirty).toEqual([join(repo, "README.md")]);
  });

  it("does NOT re-baseline an id it has already seen (a resume must not reset the base)", async () => {
    await baseline();
    const first = await readSessionObservation(observationsDir, EXTERNAL_ID);
    await writeFile(join(repo, "later.ts"), "export const a = 1;\n");
    await git.add("later.ts");
    await git.commit("work done inside the session");

    await recordSessionBaseline({
      observationsDir,
      repoRoots: [repo],
      externalId: EXTERNAL_ID,
      nowIso: T1,
    });

    expect(await readSessionObservation(observationsDir, EXTERNAL_ID)).toEqual(first);
  });

  it("skips a path that is not a repository, and writes nothing when none is", async () => {
    const result = await recordSessionBaseline({
      observationsDir,
      repoRoots: [join(dir, "not-a-repo")],
      externalId: EXTERNAL_ID,
      nowIso: T0,
    });
    expect(result).toBeNull();
    expect(await readSessionObservation(observationsDir, EXTERNAL_ID)).toBeNull();
  });

  it("records a repository with no commits yet, with a null base", async () => {
    const fresh = join(dir, "fresh");
    await mkdir(fresh, { recursive: true });
    await fixtureSimpleGit(fresh).init();
    await recordSessionBaseline({
      observationsDir,
      repoRoots: [fresh],
      externalId: EXTERNAL_ID,
      nowIso: T0,
    });
    const stored = await readSessionObservation(observationsDir, EXTERNAL_ID);
    expect(stored?.repos[0]?.base_head).toBeNull();
  });
});

describe("observeSessionChanges", () => {
  it("sees a file written by a shell command and never named in any tool call", async () => {
    await baseline();
    await writeFile(join(repo, "written-by-heredoc.ts"), "export const a = 1;\n");
    expect(await observe()).toEqual([join(repo, "written-by-heredoc.ts")]);
  });

  it("still sees the work after it is committed", async () => {
    await baseline();
    await writeFile(join(repo, "shipped.ts"), "export const a = 1;\n");
    await git.add("shipped.ts");
    await git.commit("ship it");
    expect(await observe()).toEqual([join(repo, "shipped.ts")]);
  });

  it("sees a deletion", async () => {
    await baseline();
    await unlink(join(repo, "README.md"));
    expect(await observe()).toEqual([join(repo, "README.md")]);
  });

  it("subtracts what was already dirty when the session started", async () => {
    await writeFile(join(repo, "README.md"), "# dirty before\n");
    await baseline();
    await writeFile(join(repo, "mine.ts"), "export const a = 1;\n");
    expect(await observe()).toEqual([join(repo, "mine.ts")]);
  });

  it("forgets a change that was reverted, because it recomputes rather than accumulates", async () => {
    await baseline();
    await writeFile(join(repo, "temp.ts"), "export const a = 1;\n");
    expect(await observe()).toEqual([join(repo, "temp.ts")]);
    await unlink(join(repo, "temp.ts"));
    expect(await observe()).toEqual([]);
  });

  it("keeps the previous file list when the base no longer resolves", async () => {
    await baseline();
    await writeFile(join(repo, "work.ts"), "export const a = 1;\n");
    const observed = await observe();
    expect(observed).toEqual([join(repo, "work.ts")]);

    const stored = await readSessionObservation(observationsDir, EXTERNAL_ID);
    if (stored === null) throw new Error("expected an observation");
    const first = stored.repos[0];
    if (first === undefined) throw new Error("expected a repository entry");
    await writeSessionObservation(observationsDir, {
      ...stored,
      repos: [{ ...first, base_head: "0".repeat(40) }],
    });

    expect(await observe()).toEqual([join(repo, "work.ts")]);
  });

  it("returns null when the session has no baseline, rather than measuring from now", async () => {
    await writeFile(join(repo, "someone-elses-work.ts"), "export const a = 1;\n");
    expect(
      await observeSessionChanges({ observationsDir, externalId: "never-started", nowIso: T1 }),
    ).toBeNull();
  });

  it("stamps the observation with the time it was taken", async () => {
    await baseline();
    await observe();
    const stored = await readSessionObservation(observationsDir, EXTERNAL_ID);
    expect(stored?.started_at).toBe(T0);
    expect(stored?.updated_at).toBe(T1);
  });
});

describe("observeSessionChanges and basou's own store", () => {
  it("never reports a file inside .basou, not even the observation it just wrote", async () => {
    await baseline();
    await mkdir(join(repo, ".basou", "sessions"), { recursive: true });
    await writeFile(join(repo, ".basou", "status.json"), "{}\n");
    await writeFile(join(repo, "real-work.ts"), "export const a = 1;\n");
    expect(await observe()).toEqual([join(repo, "real-work.ts")]);
  });
});
