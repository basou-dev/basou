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

  it("forgets a change that was COMMITTED and then restored to the base content", async () => {
    await baseline();
    await writeFile(join(repo, "README.md"), "# changed\n");
    await git.add("README.md");
    await git.commit("change it");
    await writeFile(join(repo, "README.md"), "# init\n");
    // The working tree still differs from HEAD, but nothing differs from the
    // base -- which is what the session is measured against.
    expect(await observe()).toEqual([]);
  });

  it("sees work committed in a repository that had NO commits when the session started", async () => {
    const fresh = join(dir, "unborn");
    await mkdir(fresh, { recursive: true });
    const freshGit = fixtureSimpleGit(fresh);
    await freshGit.init();
    await freshGit.addConfig("user.email", "test@example.com");
    await freshGit.addConfig("user.name", "test");
    await recordSessionBaseline({
      observationsDir,
      repoRoots: [fresh],
      externalId: "unborn-session",
      nowIso: T0,
    });
    await writeFile(join(fresh, "a.ts"), "export const a = 1;\n");
    await freshGit.add("a.ts");
    await freshGit.commit("first commit of the session");
    // The working tree is clean now; only a diff against the empty tree can
    // still see the work.
    const result = await observeSessionChanges({
      observationsDir,
      externalId: "unborn-session",
      nowIso: T1,
    });
    expect((result?.repos[0]?.files ?? []).map((f) => f.path)).toEqual([join(fresh, "a.ts")]);
  });

  it("spells a non-ASCII path the same way in both passes, so the subtraction holds", async () => {
    const name = "\u65e5\u672c\u8a9e.md";
    await writeFile(join(repo, name), "one\n");
    await git.add(name);
    await git.commit("add it");
    await writeFile(join(repo, name), "two\n"); // dirty BEFORE the session
    await baseline();
    // git diff quotes and octal-escapes this path by default while git status
    // reports it raw; if the two disagree, the subtraction misses and the
    // session claims a path that names no file.
    expect(await observe()).toEqual([]);
  });

  it("names the files inside an untracked directory, not the directory", async () => {
    await baseline();
    await mkdir(join(repo, "newdir"), { recursive: true });
    await writeFile(join(repo, "newdir", "x.ts"), "export const x = 1;\n");
    expect(await observe()).toEqual([join(repo, "newdir", "x.ts")]);
  });

  it("does not report an untracked nested repository as a changed file", async () => {
    await baseline();
    await initRepo(join(repo, "nested"));
    await writeFile(join(repo, "mine.ts"), "export const a = 1;\n");
    // git never looks inside another repository, so it can only offer the
    // directory -- which names no file.
    expect(await observe()).toEqual([join(repo, "mine.ts")]);
  });

  it("observes every repository in the roster, not just the first", async () => {
    const second = join(dir, "second");
    const secondGit = await initRepo(second);
    await recordSessionBaseline({
      observationsDir,
      repoRoots: [repo, second],
      externalId: "multi-repo",
      nowIso: T0,
    });
    await writeFile(join(repo, "first.ts"), "export const a = 1;\n");
    await writeFile(join(second, "second.ts"), "export const b = 2;\n");
    await secondGit.add("second.ts");
    await secondGit.commit("committed in the second repo");

    const result = await observeSessionChanges({
      observationsDir,
      externalId: "multi-repo",
      nowIso: T1,
    });
    expect((result?.repos ?? []).map((r) => r.files.map((f) => f.path))).toEqual([
      [join(repo, "first.ts")],
      [join(second, "second.ts")],
    ]);
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
  it("never reports a TRACKED .basou file, in a workspace that commits its store", async () => {
    // The guard on the diff pass is the one that matters here: a workspace that
    // keeps `.basou/` in git would otherwise have every session narrate
    // basou's own bookkeeping back to it.
    await mkdir(join(repo, ".basou"), { recursive: true });
    await writeFile(join(repo, ".basou", "handoff.md"), "# before\n");
    await git.add(".basou/handoff.md");
    await git.commit("commit the store");
    await baseline();

    await writeFile(join(repo, ".basou", "handoff.md"), "# rewritten by basou\n");
    await git.add(".basou/handoff.md");
    await git.commit("basou rewrote its own file");
    await writeFile(join(repo, "real-work.ts"), "export const a = 1;\n");

    expect(await observe()).toEqual([join(repo, "real-work.ts")]);
  });

  it("never reports an UNTRACKED .basou file, including the observation it just wrote", async () => {
    await baseline();
    await mkdir(join(repo, ".basou", "tmp", "observations"), { recursive: true });
    await writeFile(join(repo, ".basou", "tmp", "observations", "some-id.json"), "{}\n");
    await writeFile(join(repo, "real-work.ts"), "export const a = 1;\n");
    expect(await observe()).toEqual([join(repo, "real-work.ts")]);
  });
});

describe("observeSessionChanges and commits written elsewhere", () => {
  let upstream: string;
  let upstreamGit: SimpleGit;

  /**
   * Replace the fixture's standalone repository with a clone of an upstream,
   * so commits can arrive by pull the way a bot's pull request or a teammate's
   * merge does.
   */
  beforeEach(async () => {
    upstream = join(dir, "upstream");
    upstreamGit = await initRepo(upstream);
    await rm(repo, { recursive: true, force: true });
    await fixtureSimpleGit(dir).clone(upstream, repo);
    git = fixtureSimpleGit(repo);
    await git.addConfig("user.email", "test@example.com");
    await git.addConfig("user.name", "test");
  });

  /** A commit on the upstream, as a bot or another person would make it. */
  async function upstreamCommits(file: string, content: string): Promise<void> {
    await writeFile(join(upstream, file), content);
    await upstreamGit.add(file);
    await upstreamGit.commit(`upstream: ${file}`);
  }

  it("does not charge the session with a commit it only pulled", async () => {
    await baseline();
    await upstreamCommits("docs.md", "# regenerated by a bot\n");
    await git.pull("origin", "main", { "--ff-only": null });
    expect(await observe()).toEqual([]);
  });

  it("keeps the session's own work next to a commit it pulled", async () => {
    await baseline();
    await upstreamCommits("docs.md", "# regenerated by a bot\n");
    await git.pull("origin", "main", { "--ff-only": null });
    await writeFile(join(repo, "committed.ts"), "export const a = 1;\n");
    await git.add("committed.ts");
    await git.commit("own commit");
    await writeFile(join(repo, "README.md"), "# edited, not committed\n");
    expect(await observe()).toEqual([join(repo, "README.md"), join(repo, "committed.ts")]);
  });

  it("keeps the session's work after it comes back as a squash merge", async () => {
    await baseline();
    await git.checkoutLocalBranch("topic");
    await writeFile(join(repo, "feature.ts"), "export const a = 1;\n");
    await git.add("feature.ts");
    await git.commit("feature");
    // The upstream squashes the branch into its main, next to a bot's commit.
    await upstreamCommits("docs.md", "# regenerated by a bot\n");
    await upstreamGit.fetch(repo, "topic");
    await upstreamGit.raw(["merge", "--squash", "FETCH_HEAD"]);
    await upstreamGit.commit("feature (#1)");
    await git.checkout("main");
    await git.pull("origin", "main", { "--ff-only": null });
    expect(await observe()).toEqual([join(repo, "feature.ts")]);
  });

  it("charges a merge only with what it resolved", async () => {
    await writeFile(join(upstream, "shared.ts"), "export const v = 0;\n");
    await upstreamGit.add("shared.ts");
    await upstreamGit.commit("shared");
    await git.pull("origin", "main", { "--ff-only": null });
    await baseline();
    await upstreamCommits("theirs.ts", "export const t = 1;\n");
    await writeFile(join(upstream, "shared.ts"), "export const v = 1;\n");
    await upstreamGit.add("shared.ts");
    await upstreamGit.commit("upstream: shared");
    await writeFile(join(repo, "shared.ts"), "export const v = 2;\n");
    await git.add("shared.ts");
    await git.commit("local: shared");
    await git.fetch("origin", "main");
    await git.raw(["merge", "origin/main"]).catch(() => undefined); // conflicts on shared.ts
    await writeFile(join(repo, "shared.ts"), "export const v = 3;\n");
    // A change made only inside the merge commit: no parent has it, so it is
    // the merge's own work and exists nowhere else to be found.
    await writeFile(join(repo, "README.md"), "# changed while resolving\n");
    await git.add(["shared.ts", "README.md"]);
    await git.raw(["commit", "--no-edit"]);
    expect(await observe()).toEqual([join(repo, "README.md"), join(repo, "shared.ts")]);
  });

  it("does not charge the session with a commit made before it started", async () => {
    // A commit on another branch before the session, fast-forwarded into main
    // during it: the reflog records its creation BEFORE the start.
    const before = fixtureSimpleGit(repo).env({
      ...ENV,
      GIT_COMMITTER_DATE: "2026-09-22T09:00:00Z",
      GIT_AUTHOR_DATE: "2026-09-22T09:00:00Z",
    });
    await before.checkoutLocalBranch("earlier");
    await writeFile(join(repo, "earlier.ts"), "export const e = 1;\n");
    await before.add("earlier.ts");
    await before.commit("made before the session");
    await before.checkout("main");
    await baseline(); // T0 is 2026-09-22T10:00:00Z
    await git.merge(["--ff-only", "earlier"]);
    expect(await observe()).toEqual([]);
  });

  it("keeps the session's edit when an upstream commit later renamed the file", async () => {
    // Long enough for git to see the edited, renamed file as a rename.
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    await upstreamCommits("guide.md", `${lines}\n`);
    await git.pull("origin", "main", { "--ff-only": null });
    await baseline();
    await writeFile(join(repo, "guide.md"), `edited by the session\n${lines}\n`);
    await git.add("guide.md");
    await git.commit("own edit");
    await upstreamGit.fetch(repo, "main");
    await upstreamGit.merge(["--ff-only", "FETCH_HEAD"]);
    await upstreamGit.mv("guide.md", "handbook.md");
    await upstreamGit.commit("upstream: rename");
    await git.pull("origin", "main", { "--ff-only": null });
    expect(await observe()).toEqual([join(repo, "handbook.md")]);
  });

  it("keeps every net change when HEAD moved and the reflog recorded nothing", async () => {
    // With no reflog, an own commit and a pulled one cannot be told apart;
    // dropping the session's work silently is the outcome to avoid.
    await git.addConfig("core.logAllRefUpdates", "false");
    await rm(join(repo, ".git", "logs"), { recursive: true, force: true });
    await baseline();
    await writeFile(join(repo, "committed.ts"), "export const a = 1;\n");
    await git.add("committed.ts");
    await git.commit("own commit, unlogged");
    expect(await observe()).toEqual([join(repo, "committed.ts")]);
  });
});
