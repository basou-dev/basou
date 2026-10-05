import { basename, resolve } from "node:path";
import {
  blockedAmong,
  type GitResult,
  gitCanRefuseLazyFetch,
  isPartialClone,
  locateRepoRoot,
  type RepoScopeResult,
  runGit,
} from "./scope.js";

/**
 * The version of how the `repos` section measures. Raised whenever a value of
 * the section would change for the same repository, so a difference between
 * two measurements can be told apart from a change in the repository.
 */
export const BOARD_REPOS_METHOD = 1;

/**
 * One repository the manifest declares, measured where it is checked out.
 *
 * A `null` means the value could not be measured, and then `not_found` has an
 * entry at `repos[<path>].<field>`, or at `repos[<path>]` when nothing of the
 * repository could be measured. Three values are `null` with a meaning of
 * their own and no entry: `branch` when HEAD is detached; `head` and
 * `last_commit` when the repository has no commit yet (`commits` is then 0);
 * `behind_main` when there is no `refs/remotes/origin/main`.
 */
export type BoardRepo = {
  /** The path as the manifest writes it. */
  path: string;
  /** The name of the directory the repository is in, after symlinks. */
  name: string | null;
  /** The full id of HEAD's commit. */
  head: string | null;
  branch: string | null;
  /** HEAD's committer time as git recorded it: ISO 8601 with its offset. */
  last_commit: string | null;
  /** The commits reachable from HEAD, merges and all. */
  commits: number | null;
  /**
   * The files a measure counts in the working tree: tracked, and untracked
   * but not ignored, that are on disk (a measure's `file_count` of `**`).
   */
  files: number | null;
  /**
   * The paths `git status` names: each untracked file on its own (not its
   * directory), and a rename as the two paths it touches.
   */
  uncommitted: number | null;
  /** The commits on `refs/remotes/origin/main` HEAD does not have, as of the last fetch. */
  behind_main: number | null;
};

export type BoardReposResult = {
  repos: BoardRepo[];
  notFound: { at: string; reason: string }[];
};

type Head =
  | { kind: "commit"; oid: string }
  | { kind: "unborn" }
  | { kind: "error"; reason: string };

// The text of git's output without its last newline.
function line(result: GitResult): string {
  return result.stdout.toString("utf8").replace(/\n$/, "");
}

function failure(result: GitResult, reason: string): string {
  return result.spawnError ?? reason;
}

function count(result: GitResult): number | undefined {
  const text = line(result);
  return result.code === 0 && /^(0|[1-9]\d*)$/.test(text) ? Number(text) : undefined;
}

// HEAD's commit; or that there is none yet, when HEAD names a branch that
// does not exist (a new repository, or an orphan branch).
async function headOf(cwd: string, symbolic: GitResult): Promise<Head> {
  const commit = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (commit.code === 0) return { kind: "commit", oid: line(commit) };
  if (commit.spawnError !== undefined) return { kind: "error", reason: commit.spawnError };
  if (symbolic.code === 0) {
    const ref = await runGit(cwd, ["rev-parse", "--verify", "--quiet", line(symbolic)]);
    if (ref.code === 1) return { kind: "unborn" };
  }
  return { kind: "error", reason: "HEAD does not name a commit" };
}

/**
 * Measure each repository the manifest declares, in its order. `root` is the
 * absolute path the manifest's paths are relative to; `worktreeOf` opens the
 * working-tree scope of a repository by its manifest path, shared with the
 * measures. Reads, never writes, and sends nothing.
 */
export async function measureRepos(
  repoPaths: readonly string[],
  root: string,
  worktreeOf: (repo: string) => Promise<RepoScopeResult>,
): Promise<BoardReposResult> {
  const result: BoardReposResult = { repos: [], notFound: [] };
  for (const path of repoPaths) {
    const at = `repos[${path}]`;
    const repo: BoardRepo = {
      path,
      name: null,
      head: null,
      branch: null,
      last_commit: null,
      commits: null,
      files: null,
      uncommitted: null,
      behind_main: null,
    };
    result.repos.push(repo);
    const located = await locateRepoRoot(resolve(root, path));
    if (!located.ok) {
      result.notFound.push({ at, reason: `the repo '${path}' ${located.reason}` });
      continue;
    }
    const fail = (field: keyof BoardRepo, reason: string) => {
      result.notFound.push({ at: `${at}.${field}`, reason });
    };
    const cwd = located.root.toString();
    repo.name = basename(cwd);

    const symbolic = await runGit(cwd, ["symbolic-ref", "-q", "HEAD"]);
    const head = await headOf(cwd, symbolic);
    if (head.kind === "commit") repo.head = head.oid;
    else if (head.kind === "error") fail("head", head.reason);

    // 1 is a detached HEAD, which the null means.
    if (symbolic.code === 0) repo.branch = line(symbolic).replace(/^refs\/heads\//, "");
    else if (symbolic.code !== 1) fail("branch", failure(symbolic, "HEAD could not be read"));

    if (head.kind === "commit") {
      const date = await runGit(cwd, [
        "log",
        "-1",
        "--no-show-signature",
        "--format=%cI",
        head.oid,
        "--",
      ]);
      if (date.code === 0 && line(date) !== "") repo.last_commit = line(date);
      else fail("last_commit", failure(date, "the date of HEAD's commit could not be read"));
    } else if (head.kind === "error") {
      fail("last_commit", head.reason);
    }

    const shallow = await runGit(cwd, ["rev-parse", "--is-shallow-repository"]);
    const history =
      shallow.code !== 0
        ? failure(shallow, "could not tell whether the history is complete")
        : line(shallow) === "true"
          ? "the repo is a shallow clone, so its history is cut short"
          : undefined;

    if (history !== undefined) fail("commits", history);
    else if (head.kind === "unborn") repo.commits = 0;
    else if (head.kind === "error") fail("commits", head.reason);
    else {
      const commits = await runGit(cwd, ["rev-list", "--count", head.oid, "--"]);
      const n = count(commits);
      if (n === undefined) fail("commits", failure(commits, "the commits could not be counted"));
      else repo.commits = n;
    }

    const worktree = await worktreeOf(path);
    if (!worktree.ok) fail("files", `the working tree ${worktree.reason}`);
    else {
      const blocked = blockedAmong(worktree.scope, [...worktree.scope.entries.keys()]);
      if (blocked !== undefined) fail("files", blocked);
      else repo.files = worktree.scope.entries.size;
    }

    if ((await isPartialClone(cwd)) && !(await gitCanRefuseLazyFetch(cwd))) {
      fail(
        "uncommitted",
        "the repo is a partial clone, which this git (older than 2.44) may fetch objects for from its remote",
      );
    } else {
      const status = await runGit(cwd, [
        "status",
        "--porcelain=v1",
        "-z",
        "--no-renames",
        "--untracked-files=all",
      ]);
      if (status.code !== 0) {
        fail("uncommitted", failure(status, "the working tree could not be compared by git"));
      } else {
        // One NUL-terminated record `XY <path>` per path: with --no-renames,
        // none carries a second path.
        repo.uncommitted = status.stdout.toString("latin1").split("\0").length - 1;
      }
    }

    if (history !== undefined) fail("behind_main", history);
    else if (head.kind === "error") fail("behind_main", head.reason);
    else {
      const main = await runGit(cwd, [
        "rev-parse",
        "--verify",
        "--quiet",
        "refs/remotes/origin/main^{commit}",
      ]);
      if (main.code === 0) {
        const range = head.kind === "unborn" ? line(main) : `${head.oid}..${line(main)}`;
        const behind = await runGit(cwd, ["rev-list", "--count", range, "--"]);
        const n = count(behind);
        if (n === undefined) {
          fail(
            "behind_main",
            failure(behind, "the commits behind origin/main could not be counted"),
          );
        } else {
          repo.behind_main = n;
        }
      } else if (main.spawnError !== undefined) {
        fail("behind_main", main.spawnError);
      } else {
        const any = await runGit(cwd, [
          "rev-parse",
          "--verify",
          "--quiet",
          "refs/remotes/origin/main",
        ]);
        if (any.code === 0) fail("behind_main", "refs/remotes/origin/main is not a commit");
        // Otherwise there is no origin/main, which the null means.
      }
    }
  }
  return result;
}
