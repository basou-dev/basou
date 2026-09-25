import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
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

/** Whether commits can be signed here (with an SSH key, which needs no agent). */
const HAS_SSH_KEYGEN = spawnSync("ssh-keygen", ["-?"]).error === undefined;

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

/** The fixture repository's git, with every date it writes set to `iso`. */
function datedAt(iso: string): SimpleGit {
  return fixtureSimpleGit(repo).env({ ...ENV, GIT_COMMITTER_DATE: iso, GIT_AUTHOR_DATE: iso });
}

/** The fixture repository's git, dated an hour before the session's start (T0). */
function beforeStart(): SimpleGit {
  return datedAt("2026-09-22T09:00:00Z");
}

/**
 * The fixture repository's git, with an editor that accepts the message as it
 * is, plus any other variables (a sequence editor for `rebase -i`).
 */
function withEditor(env: NodeJS.ProcessEnv = {}): SimpleGit {
  return simpleGit({
    baseDir: repo,
    unsafe: { allowUnsafeConfigPaths: true, allowUnsafeEditor: true },
  }).env({ ...ENV, GIT_EDITOR: "true", ...env });
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

  it("sees work in a repository that still has no commit when it is observed", async () => {
    const fresh = join(dir, "unborn");
    await mkdir(fresh, { recursive: true });
    const freshGit = fixtureSimpleGit(fresh);
    await freshGit.init();
    await recordSessionBaseline({
      observationsDir,
      repoRoots: [fresh],
      externalId: "unborn-session",
      nowIso: T0,
    });
    await writeFile(join(fresh, "staged.ts"), "export const a = 1;\n");
    await freshGit.add("staged.ts");
    await writeFile(join(fresh, "untracked.ts"), "export const b = 1;\n");
    const result = await observeSessionChanges({
      observationsDir,
      externalId: "unborn-session",
      nowIso: T1,
    });
    expect((result?.repos[0]?.files ?? []).map((f) => f.path)).toEqual([
      join(fresh, "staged.ts"),
      join(fresh, "untracked.ts"),
    ]);
  });

  it("names both sides of a rename the session has not committed yet", async () => {
    const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    // Dated before the start, so neither name is among the session's commits
    // and only the uncommitted rename can put them there.
    const early = beforeStart();
    await writeFile(join(repo, "guide.md"), `${body}\n`);
    await early.add("guide.md");
    await early.commit("add the guide");
    await baseline();
    await git.mv("guide.md", "handbook.md");
    expect(await observe()).toEqual([join(repo, "guide.md"), join(repo, "handbook.md")]);
  });

  it.each([
    [
      "a file with a conflict",
      async () => {
        await writeFile(join(repo, "shared.txt"), "base\n");
        await git.add("shared.txt");
        await git.commit("shared");
        await git.checkoutLocalBranch("other");
        await writeFile(join(repo, "shared.txt"), "other\n");
        await git.add("shared.txt");
        await git.commit("other side");
        await git.checkout("main");
        await writeFile(join(repo, "shared.txt"), "main\n");
        await git.add("shared.txt");
        await git.commit("main side");
        await git.raw(["merge", "other"]).catch(() => undefined); // conflicts
      },
    ],
    [
      "an untracked file",
      async () => {
        await writeFile(join(repo, "scratch.txt"), "notes\n");
      },
    ],
    [
      "a name with a leading space",
      async () => {
        await writeFile(join(repo, " lead.txt"), "one\n");
        await git.add(" lead.txt");
        await git.commit("lead");
        await writeFile(join(repo, " lead.txt"), "two\n");
      },
    ],
    [
      "a rename staged and then deleted",
      async () => {
        await mkdir(join(repo, "docs"));
        await writeFile(join(repo, "docs", "guide.md"), "guide\n");
        await git.add("docs/guide.md");
        await git.commit("guide");
        await git.mv("docs/guide.md", "handbook.md");
        await unlink(join(repo, "handbook.md"));
      },
    ],
    [
      "a copy git status reports as a copy",
      async () => {
        // README.md is "# init\n": changing it and adding its old content under
        // a new name is what git status reports as `C README.md -> COPY.md`.
        await git.addConfig("status.renames", "copies");
        await git.addConfig("diff.renames", "copies");
        await writeFile(join(repo, "README.md"), "# init\nand more\n");
        await writeFile(join(repo, "COPY.md"), "# init\n");
        await git.add(["README.md", "COPY.md"]);
      },
    ],
  ])(
    "observes nothing straight after the baseline when it started with %s",
    async (_what, dirty) => {
      await dirty();
      await baseline();
      expect(await observe()).toEqual([]);
    },
  );

  it.each([
    [
      "a change staged while its working copy was put back",
      async () => {
        await writeFile(join(repo, "y.txt"), "one\n");
        await git.add("y.txt");
        await git.commit("y");
        await writeFile(join(repo, "y.txt"), "two\n");
        await git.add("y.txt");
        await writeFile(join(repo, "y.txt"), "one\n");
      },
      async () => {
        await git.commit("commit what was staged");
        await git.raw(["checkout", "--", "y.txt"]);
      },
    ],
    [
      "a conflict whose working copy matches HEAD",
      async () => {
        await writeFile(join(repo, "dm.txt"), "base\n");
        await git.add("dm.txt");
        await git.commit("dm");
        await git.checkoutLocalBranch("delete-it");
        await git.rm("dm.txt");
        await git.commit("delete");
        await git.checkout("main");
        await writeFile(join(repo, "dm.txt"), "modified\n");
        await git.add("dm.txt");
        await git.commit("modify");
        await git.raw(["merge", "delete-it"]).catch(() => undefined); // modify/delete
      },
      async () => {
        await writeFile(join(repo, "dm.txt"), "resolved\n");
        await git.add("dm.txt");
        await git.raw(["commit", "--no-edit"]);
      },
    ],
    [
      "a conflict on a name with a leading space whose working copy matches HEAD",
      async () => {
        await writeFile(join(repo, " dm.txt"), "base\n");
        await git.add(" dm.txt");
        await git.commit("dm");
        await git.checkoutLocalBranch("delete-it");
        await git.rm(" dm.txt");
        await git.commit("delete");
        await git.checkout("main");
        await writeFile(join(repo, " dm.txt"), "modified\n");
        await git.add(" dm.txt");
        await git.commit("modify");
        await git.raw(["merge", "delete-it"]).catch(() => undefined); // modify/delete
      },
      async () => {
        await writeFile(join(repo, " dm.txt"), "resolved\n");
        await git.add(" dm.txt");
        await git.raw(["commit", "--no-edit"]);
      },
    ],
    [
      "an untracked nested repository",
      async () => {
        await initRepo(join(repo, "nested"));
      },
      async () => {
        await git.raw(["add", "nested"]);
        await git.commit("take the nested repository in");
      },
    ],
    [
      "a file turned into a symbolic link",
      async () => {
        await writeFile(join(repo, "link"), "a file\n");
        await git.add("link");
        await git.commit("link");
        await unlink(join(repo, "link"));
        await symlink("README.md", join(repo, "link"));
      },
      async () => {
        await unlink(join(repo, "link"));
        await writeFile(join(repo, "link"), "a file again\n");
      },
    ],
  ])(
    "leaves out %s at the start, even after the session finishes it",
    async (_what, dirty, finish) => {
      await dirty();
      await baseline();
      await finish();
      expect(await observe()).toEqual([]);
    },
  );

  it("still records what the other readings find when git status fails at the start", async () => {
    // An invalid status setting fails `git status` but not `git diff` or
    // `git ls-files`, which the later pass uses.
    await writeFile(join(repo, "README.md"), "# edited before the session\n");
    await writeFile(join(repo, "scratch.txt"), "notes\n");
    await git.addConfig("status.renames", "bogus");
    await baseline();
    expect(await observe()).toEqual([]);
  });

  it("does not charge the session with the old name of a rename staged before it started", async () => {
    const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const early = beforeStart();
    await writeFile(join(repo, "guide.md"), `${body}\n`);
    await early.add("guide.md");
    await early.commit("add the guide");
    await git.mv("guide.md", "handbook.md"); // staged, not committed, BEFORE the session
    await baseline();
    await writeFile(join(repo, "unrelated.txt"), "u\n");
    expect(await observe()).toEqual([join(repo, "unrelated.txt")]);
  });

  it("keeps observing when a branch ref it has nothing to do with is broken", async () => {
    await baseline();
    await writeFile(join(repo, ".git", "refs", "heads", "old-experiment"), "");
    await writeFile(join(repo, "own.ts"), "export const a = 1;\n");
    await git.add("own.ts");
    await git.commit("own commit");
    await writeFile(join(repo, "wip.txt"), "w\n");
    expect(await observe()).toEqual([join(repo, "own.ts"), join(repo, "wip.txt")]);
  });

  it("keeps observing a repository with a file named HEAD at its top", async () => {
    const early = beforeStart();
    await writeFile(join(repo, "HEAD"), "not a ref\n");
    await early.add("HEAD");
    await early.commit("a file named HEAD");
    await baseline();
    await writeFile(join(repo, "own.ts"), "export const a = 1;\n");
    await git.add("own.ts");
    await git.commit("own commit");
    await writeFile(join(repo, "wip.txt"), "w\n");
    expect(await observe()).toEqual([join(repo, "own.ts"), join(repo, "wip.txt")]);
  });

  it("keeps a commit stamped earlier in the second the session started in", async () => {
    // Reflog times are whole seconds; the start is not.
    await recordSessionBaseline({
      observationsDir,
      repoRoots: [repo],
      externalId: EXTERNAL_ID,
      nowIso: "2026-09-22T10:00:00.500Z",
    });
    const dated = datedAt("2026-09-22T10:00:00Z");
    await writeFile(join(repo, "same-second.ts"), "export const a = 1;\n");
    await dated.add("same-second.ts");
    await dated.commit("same second");
    expect(await observe()).toEqual([join(repo, "same-second.ts")]);
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

  /**
   * A file both sides changed in different places, so git joins the two without
   * a conflict: a local commit made before the session changed its first line,
   * and the upstream changed its last line and added a bot's file.
   */
  async function divergedOnSharedFile(): Promise<void> {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    await upstreamCommits("shared.txt", `${body.join("\n")}\n`);
    await git.pull("origin", "main", { "--ff-only": null });
    await upstreamCommits("shared.txt", `${[...body.slice(0, 9), "upstream end"].join("\n")}\n`);
    await upstreamCommits("bot.md", "# regenerated by a bot\n");
    await writeFile(join(repo, "shared.txt"), `${["local start", ...body.slice(1)].join("\n")}\n`);
    const early = beforeStart();
    await early.add("shared.txt");
    await early.commit("local: first line");
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
    const before = beforeStart();
    await before.checkoutLocalBranch("earlier");
    await writeFile(join(repo, "earlier.ts"), "export const e = 1;\n");
    await before.add("earlier.ts");
    await before.commit("made before the session");
    await before.checkout("main");
    await baseline(); // T0 is 2026-09-22T10:00:00Z
    await git.merge(["--ff-only", "earlier"]);
    expect(await observe()).toEqual([]);
  });

  it("names the file the session edited, not the name an upstream commit later gave it", async () => {
    // Renames are not paired: the session's edit went to guide.md, and the
    // upstream's handbook.md is a file the session never touched.
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
    expect(await observe()).toEqual([join(repo, "guide.md")]);
  });

  it("does not let a pulled file in by pairing it with one the session deleted", async () => {
    const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    await upstreamCommits("guide.md", `${body}\n`);
    await git.pull("origin", "main", { "--ff-only": null });
    await git.addConfig("diff.renames", "true");
    await baseline();
    await git.rm("guide.md");
    await git.commit("own: drop the guide");
    await upstreamGit.fetch(repo, "main");
    await upstreamGit.merge(["--ff-only", "FETCH_HEAD"]);
    await upstreamCommits("handbook.md", `${body}\n`);
    await git.pull("origin", "main", { "--ff-only": null });
    expect(await observe()).toEqual([join(repo, "guide.md")]);
  });

  it("keeps a commit made in another worktree of the repository", async () => {
    await baseline();
    const other = join(dir, "other-worktree");
    await git.raw(["worktree", "add", "-b", "agent", other]);
    const otherGit = fixtureSimpleGit(other);
    await writeFile(join(other, "feature.ts"), "export const a = 1;\n");
    await otherGit.add("feature.ts");
    await otherGit.commit("feature");
    await git.merge(["--ff-only", "agent"]);
    expect(await observe()).toEqual([join(repo, "feature.ts")]);
  });

  it("keeps a commit made in another worktree after it comes back as a squash merge", async () => {
    await baseline();
    const other = join(dir, "other-worktree");
    await git.raw(["worktree", "add", "-b", "agent", other]);
    const otherGit = fixtureSimpleGit(other);
    await writeFile(join(other, "feature.ts"), "export const a = 1;\n");
    await otherGit.add("feature.ts");
    await otherGit.commit("feature");
    await upstreamCommits("docs.md", "# regenerated by a bot\n");
    await upstreamGit.fetch(repo, "agent");
    await upstreamGit.raw(["merge", "--squash", "FETCH_HEAD"]);
    await upstreamGit.commit("feature (#1)");
    await git.pull("origin", "main", { "--ff-only": null });
    expect(await observe()).toEqual([join(repo, "feature.ts")]);
  });

  it("does not charge a branch created at a commit that arrived from elsewhere", async () => {
    await baseline();
    await upstreamCommits("docs.md", "# regenerated by a bot\n");
    await git.fetch("origin", "main");
    await git.raw(["branch", "bot-docs", "origin/main"]);
    await git.merge(["--ff-only", "bot-docs"]);
    expect(await observe()).toEqual([]);
  });

  it("charges a commit the session cherry-picked, since the pick is created here", async () => {
    await baseline();
    await upstreamCommits("picked.ts", "export const p = 1;\n");
    await upstreamCommits("docs.md", "# regenerated by a bot\n");
    await git.fetch("origin", "main");
    await git.raw(["cherry-pick", "origin/main~1"]);
    expect(await observe()).toEqual([join(repo, "picked.ts")]);
  });

  it.each([
    ["cherry-pick --continue", ["cherry-pick", "--continue"]],
    ["a plain commit", ["commit", "--no-edit"]],
  ])(
    "charges a cherry-pick that stopped on a conflict and was finished by %s",
    async (_how, finish) => {
      await upstreamCommits("shared.txt", "base\n");
      await git.pull("origin", "main", { "--ff-only": null });
      await writeFile(join(repo, "shared.txt"), "local\n");
      const early = beforeStart();
      await early.add("shared.txt");
      await early.commit("local: shared");
      await baseline();
      await writeFile(join(upstream, "shared.txt"), "upstream\n");
      await writeFile(join(upstream, "picked.ts"), "export const p = 1;\n");
      await upstreamGit.add(["shared.txt", "picked.ts"]);
      await upstreamGit.commit("upstream: shared and picked");
      await git.fetch("origin", "main");
      await git.raw(["cherry-pick", "origin/main"]).catch(() => undefined); // conflicts on shared.txt
      await writeFile(join(repo, "shared.txt"), "resolved\n");
      await git.add("shared.txt");
      await withEditor().raw(finish);
      expect(await observe()).toEqual([join(repo, "picked.ts"), join(repo, "shared.txt")]);
    },
  );

  it("does not charge a cherry-pick that only fast-forwarded to the picked commit", async () => {
    await baseline();
    await upstreamCommits("docs.md", "# regenerated by a bot\n");
    await git.fetch("origin", "main");
    await git.raw(["cherry-pick", "--ff", "origin/main"]);
    expect(await observe()).toEqual([]);
  });

  it("charges a revert the session made of an earlier commit", async () => {
    await writeFile(join(repo, "reverted.ts"), "export const r = 1;\n");
    const early = beforeStart();
    await early.add("reverted.ts");
    await early.commit("made before the session");
    await baseline();
    await git.raw(["revert", "--no-edit", "HEAD"]);
    expect(await observe()).toEqual([join(repo, "reverted.ts")]);
  });

  it("charges what the session added by amending an earlier commit", async () => {
    await writeFile(join(repo, "earlier.ts"), "export const e = 1;\n");
    const early = beforeStart();
    await early.add("earlier.ts");
    await early.commit("made before the session");
    await baseline();
    await writeFile(join(repo, "amended.ts"), "export const a = 1;\n");
    await git.add("amended.ts");
    await git.raw(["commit", "--amend", "--no-edit"]);
    expect(await observe()).toEqual([join(repo, "amended.ts")]);
  });

  it("charges a patch the session applied with git am", async () => {
    await baseline();
    await upstreamCommits("patched.ts", "export const p = 1;\n");
    const patch = join(dir, "patched.patch");
    await writeFile(patch, await upstreamGit.raw(["format-patch", "-1", "--stdout"]));
    await git.raw(["am", patch]);
    expect(await observe()).toEqual([join(repo, "patched.ts")]);
  });

  it.each([
    ["git rebase", ["rebase", "origin/main"]],
    ["git pull --rebase", ["pull", "--rebase"]],
    ["git pull -r", ["pull", "-r"]],
    ["git pull --rebase origin main", ["pull", "--rebase", "origin", "main"]],
    ["git pull -q -r", ["pull", "-q", "-r"]],
  ])("charges the picks %s replays, however it is spelled", async (_how, command) => {
    await divergedOnSharedFile();
    await baseline();
    await git.fetch("origin", "main");
    await git.raw(command);
    // The replayed commit is created here; the upstream's bot.md is not.
    expect(await observe()).toEqual([join(repo, "shared.txt")]);
  });

  it("charges the picks of a pull from a URL", async () => {
    await divergedOnSharedFile();
    await baseline();
    await git.raw(["pull", "--rebase", `file://${upstream}`, "main"]);
    expect(await observe()).toEqual([join(repo, "shared.txt")]);
  });

  it("charges a merge a pull from a URL made", async () => {
    await divergedOnSharedFile();
    await baseline();
    await git.raw(["pull", "--no-rebase", "--no-edit", `file://${upstream}`, "main"]);
    expect(await observe()).toEqual([join(repo, "shared.txt")]);
  });

  it("does not read a rebase's start entry as a pick, however its upstream is spelled", async () => {
    // The start entry repeats the upstream as typed: here a search whose text
    // looks like a step and a colon.
    await writeFile(join(repo, "own.ts"), "export const a = 1;\n");
    const early = beforeStart();
    await early.add("own.ts");
    await early.commit("made before the session");
    await baseline();
    await writeFile(join(upstream, "bot.md"), "# regenerated by a bot\n");
    await upstreamGit.add("bot.md");
    await upstreamGit.commit("docs pick: regenerate");
    await git.fetch("origin", "main");
    await git.raw(["rebase", "origin/main^{/docs (pick): regenerate}"]);
    expect(await observe()).toEqual([]);
  });

  it("charges a merge commit git merge made itself", async () => {
    await divergedOnSharedFile();
    await baseline();
    await git.fetch("origin", "main");
    await git.raw(["merge", "--no-edit", "origin/main"]);
    expect(await observe()).toEqual([join(repo, "shared.txt")]);
  });

  it("charges a merge git made itself of a revision named with a colon", async () => {
    await divergedOnSharedFile();
    await baseline();
    await git.fetch("origin", "main");
    // `:/<text>` names the newest commit whose message matches: the bot's.
    await git.raw(["merge", "--no-edit", ":/upstream: bot.md"]);
    expect(await observe()).toEqual([join(repo, "shared.txt")]);
  });

  it("charges a rebased commit whose conflict the session resolved and continued", async () => {
    await upstreamCommits("shared.txt", "base\n");
    await git.pull("origin", "main", { "--ff-only": null });
    await writeFile(join(repo, "shared.txt"), "local\n");
    const early = beforeStart();
    await early.add("shared.txt");
    await early.commit("local: shared");
    await upstreamCommits("shared.txt", "upstream\n");
    await upstreamCommits("bot.md", "# regenerated by a bot\n");
    await baseline();
    await git.fetch("origin", "main");
    await git.raw(["rebase", "origin/main"]).catch(() => undefined); // conflicts on shared.txt
    await writeFile(join(repo, "shared.txt"), "resolved\n");
    await git.add("shared.txt");
    await withEditor().raw(["rebase", "--continue"]);
    expect(await observe()).toEqual([join(repo, "shared.txt")]);
  });

  it.each([["reword"], ["edit"]])(
    "charges a pick the session marked %s while rebasing",
    async (step) => {
      await divergedOnSharedFile();
      await baseline();
      await git.fetch("origin", "main");
      const rebasing = withEditor({ GIT_SEQUENCE_EDITOR: `perl -pi -e 's/^pick/${step}/'` });
      await rebasing.raw(["rebase", "-i", "origin/main"]);
      if (step === "edit") await rebasing.raw(["rebase", "--continue"]); // it stopped there
      expect(await observe()).toEqual([join(repo, "shared.txt")]);
    },
  );

  it.each([["fixup!"], ["squash!"]])(
    "charges what a %s commit the session folded in while rebasing added",
    async (prefix) => {
      // Two files both sides change in different places: the upstream at their
      // ends; before the session, a commit at the start of shared.txt and a
      // fixup of it at the start of other.txt.
      const body = Array.from({ length: 10 }, (_, i) => `line ${i}`);
      const text = (lines: string[]): string => `${lines.join("\n")}\n`;
      await upstreamCommits("shared.txt", text(body));
      await upstreamCommits("other.txt", text(body));
      await git.pull("origin", "main", { "--ff-only": null });
      await upstreamCommits("shared.txt", text([...body.slice(0, 9), "upstream end"]));
      await upstreamCommits("other.txt", text([...body.slice(0, 9), "upstream end"]));
      const early = beforeStart();
      await writeFile(join(repo, "shared.txt"), text(["local start", ...body.slice(1)]));
      await early.add("shared.txt");
      await early.commit("local: first line");
      await writeFile(join(repo, "other.txt"), text(["local start", ...body.slice(1)]));
      await early.add("other.txt");
      await early.commit(`${prefix} local: first line`);
      await baseline();
      await git.fetch("origin", "main");
      await withEditor({ GIT_SEQUENCE_EDITOR: "true" }).raw([
        "rebase",
        "-i",
        "--autosquash",
        "origin/main",
      ]);
      // other.txt is in the session's net change only through the folded commit.
      expect(await observe()).toEqual([join(repo, "other.txt"), join(repo, "shared.txt")]);
    },
  );

  /**
   * Two commits on a topic branch made before the session, and the upstream's
   * bot commit pulled into main during it. `git replay` is experimental; a git
   * that has none, or that only prints the ref updates, skips the test.
   */
  async function topicToReplay(): Promise<void> {
    await git.checkoutLocalBranch("topic");
    const early = beforeStart();
    for (const file of ["t1.txt", "t2.txt"]) {
      await writeFile(join(repo, file), `${file}\n`);
      await early.add(file);
      await early.commit(file);
    }
    await git.checkout("main");
    await baseline();
    await upstreamCommits("docs.md", "# regenerated by a bot\n");
    await git.pull("origin", "main", { "--ff-only": null });
  }

  async function replayed(ref: string, args: string[], by: SimpleGit = git): Promise<boolean> {
    const before = (await git.revparse([ref])).trimEnd();
    const ran = await by.raw(["replay", ...args]).then(
      () => true,
      () => false,
    );
    return ran && (await git.revparse([ref])).trimEnd() !== before;
  }

  it("charges every commit git replay --onto replayed, not only the one the branch ends at", async (ctx) => {
    await topicToReplay();
    if (!(await replayed("topic", ["--onto", "main", "main..topic"]))) ctx.skip();
    await git.merge(["--ff-only", "topic"]);
    expect(await observe()).toEqual([join(repo, "t1.txt"), join(repo, "t2.txt")]);
  });

  it("charges every commit git replay --advance replayed", async (ctx) => {
    await topicToReplay();
    await git.raw(["branch", "target"]);
    if (!(await replayed("target", ["--advance", "target", "main..topic"]))) ctx.skip();
    await git.merge(["--ff-only", "target"]);
    expect(await observe()).toEqual([join(repo, "t1.txt"), join(repo, "t2.txt")]);
  });

  it("takes a replayed branch's previous value from that branch, not from the next line", async (ctx) => {
    // Git lists the branches' entries interleaved by date, so the dates are
    // set to make the line after the replay entry topic's, not target's own:
    // target's commit at 08:00, the topic at 09:00, the replay at 11:00 (the
    // session started at 10:00).
    const eight = datedAt("2026-09-22T08:00:00Z");
    await eight.checkoutLocalBranch("target");
    await writeFile(join(repo, "old.txt"), "old\n");
    await eight.add("old.txt");
    await eight.commit("old");
    await eight.checkout("main");
    const nine = beforeStart();
    await nine.checkoutLocalBranch("topic");
    for (const file of ["t1.txt", "t2.txt"]) {
      await writeFile(join(repo, file), `${file}\n`);
      await nine.add(file);
      await nine.commit(file);
    }
    await nine.checkout("main");
    await baseline();
    const eleven = datedAt("2026-09-22T11:00:00Z");
    if (!(await replayed("target", ["--advance", "target", "main..topic"], eleven))) ctx.skip();
    await git.merge(["--ff-only", "target"]);
    expect(await observe()).toEqual([join(repo, "t1.txt"), join(repo, "t2.txt")]);
  });

  it("counts only the commit a replayed branch ends at when that branch had no reflog", async (ctx) => {
    // A documented limit: with no earlier entry, where the replay started is
    // unknown.
    await topicToReplay();
    await git.raw(["branch", "target"]);
    await rm(join(repo, ".git", "logs", "refs", "heads", "target"));
    if (!(await replayed("target", ["--advance", "target", "main..topic"]))) ctx.skip();
    await git.merge(["--ff-only", "target"]);
    expect(await observe()).toEqual([join(repo, "t2.txt")]);
  });

  it("charges a merge git committed itself with a file it joined from both sides", async () => {
    // A merge counts every path where it differs from all of its parents, and a
    // file git merged cleanly from two changes is one of them.
    await divergedOnSharedFile();
    await baseline();
    await git.raw(["pull", "--no-rebase", "--no-edit"]);
    expect(await observe()).toEqual([join(repo, "shared.txt")]);
  });

  it("draws the window at the start's second, by the date the reflog entry carries", async () => {
    await baseline(); // T0 is 2026-09-22T10:00:00.000Z
    await upstreamCommits("docs.md", "# regenerated by a bot\n");
    await git.pull("origin", "main", { "--ff-only": null });
    for (const [file, iso] of [
      ["same-second.ts", "2026-09-22T10:00:00Z"],
      ["second-earlier.ts", "2026-09-22T09:59:59Z"],
    ] as const) {
      const dated = datedAt(iso);
      await writeFile(join(repo, file), "export const a = 1;\n");
      await dated.add(file);
      await dated.commit(file);
    }
    expect(await observe()).toEqual([join(repo, "same-second.ts")]);
  });

  it("keeps the list it observed last when reading its own commits fails", async () => {
    await baseline();
    await upstreamCommits("docs.md", "# regenerated by a bot\n");
    await git.pull("origin", "main", { "--ff-only": null });
    const pulled = (await git.revparse(["HEAD"])).trimEnd();
    await writeFile(join(repo, "own.ts"), "export const a = 1;\n");
    await git.add("own.ts");
    await git.commit("own commit");
    expect(await observe()).toEqual([join(repo, "own.ts")]);
    // Without the pulled commit's object, HEAD, the working tree and the diff
    // against the base still read, but the diff of the session's own commit
    // against its parent does not. Dropping the limit for this pass would
    // charge the session with docs.md.
    await rm(join(repo, ".git", "objects", pulled.slice(0, 2), pulled.slice(2)));
    expect(await observe()).toEqual([join(repo, "own.ts")]);
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

describe("observeSessionChanges whatever the repository's git config says", () => {
  it("keeps a root commit's files when log.showRoot is off", async () => {
    const fresh = join(dir, "unborn");
    await mkdir(fresh, { recursive: true });
    const freshGit = fixtureSimpleGit(fresh);
    await freshGit.init();
    await freshGit.addConfig("user.email", "test@example.com");
    await freshGit.addConfig("user.name", "test");
    await freshGit.addConfig("log.showRoot", "false");
    await recordSessionBaseline({
      observationsDir,
      repoRoots: [fresh],
      externalId: "unborn-session",
      nowIso: T0,
    });
    for (const file of ["w.ts", "x.ts"]) {
      await writeFile(join(fresh, file), "export const a = 1;\n");
      await freshGit.add(file);
      await freshGit.commit(file);
    }
    const result = await observeSessionChanges({
      observationsDir,
      externalId: "unborn-session",
      nowIso: T1,
    });
    expect((result?.repos[0]?.files ?? []).map((f) => f.path)).toEqual([
      join(fresh, "w.ts"),
      join(fresh, "x.ts"),
    ]);
  });

  it.skipIf(!HAS_SSH_KEYGEN)(
    "reads its own signed commits when log.showSignature is on",
    async () => {
      const key = join(dir, "signing-key");
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
      const allowed = join(dir, "allowed-signers");
      await writeFile(allowed, `test@example.com ${await readFile(`${key}.pub`, "utf8")}`);
      await git.addConfig("gpg.format", "ssh");
      await git.addConfig("user.signingkey", key);
      await git.addConfig("gpg.ssh.allowedSignersFile", allowed);
      await git.addConfig("commit.gpgsign", "true");
      await git.addConfig("log.showSignature", "true");
      await baseline();
      for (const file of ["w.ts", "x.ts"]) {
        await writeFile(join(repo, file), "export const a = 1;\n");
        await git.add(file);
        await git.commit(file);
      }
      expect(await observe()).toEqual([join(repo, "w.ts"), join(repo, "x.ts")]);
    },
  );
});
