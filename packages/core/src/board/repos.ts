import { basename, resolve } from "node:path";
import {
  blockedAmong,
  type GitResult,
  gitCanRefuseLazyFetch,
  isPartialClone,
  locateRepoRoot,
  type RepoScopeResult,
  runGit,
  shownWarning,
  unreadReaching,
  unreadWarnings,
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
   * directory), and a rename as the two paths it touches. `git status` runs
   * the clean filters the repository configures and looks into its
   * submodules, as it does for anyone who runs it there.
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

type Ref = { kind: "missing" } | { kind: "oid"; oid: string } | { kind: "error"; reason: string };

const ORIGIN_MAIN = "refs/remotes/origin/main";

const SHALLOW = "the repo is a shallow clone, so its history is cut short";

// The bytes of git's output without its last newline.
function lineBytes(result: GitResult): Buffer {
  const out = result.stdout;
  return out.length > 0 && out[out.length - 1] === 0x0a ? out.subarray(0, out.length - 1) : out;
}

// The text of git's output without its last newline.
function line(result: GitResult): string {
  return lineBytes(result).toString("utf8");
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

// The text of a name git printed, or undefined when it is not valid UTF-8 (a
// name that would otherwise read the same as another one).
function utf8Name(bytes: Buffer): string | undefined {
  try {
    return UTF8.decode(bytes);
  } catch {
    return undefined;
  }
}

function failure(result: GitResult, reason: string): string {
  return result.spawnError ?? reason;
}

function count(result: GitResult): number | undefined {
  const text = line(result);
  return result.code === 0 && /^(0|[1-9]\d*)$/.test(text) ? Number(text) : undefined;
}

// The ref named exactly `name`. Not rev-parse, which takes refs/tags/<name>
// or refs/heads/<name> for a full name that is not there; a ref git cannot
// read is told apart from one that is not there.
async function readRef(cwd: string, name: string): Promise<Ref> {
  const listed = await runGit(cwd, ["for-each-ref", "--format=%(objectname) %(refname)", name]);
  if (listed.code !== 0) {
    return { kind: "error", reason: failure(listed, `${name} could not be read`) };
  }
  for (const record of listed.stdout.toString("utf8").split("\n")) {
    const space = record.indexOf(" ");
    if (space !== -1 && record.slice(space + 1) === name) {
      return { kind: "oid", oid: record.slice(0, space) };
    }
  }
  if (listed.stderr.toString("utf8").includes(`broken ref ${name}`)) {
    return { kind: "error", reason: `${name} is a broken ref` };
  }
  return { kind: "missing" };
}

// HEAD's commit; or that there is none yet, when HEAD names a branch that
// does not exist (a new repository, or an orphan branch).
async function headOf(cwd: string, symbolic: GitResult): Promise<Head> {
  const commit = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (commit.code === 0) return { kind: "commit", oid: line(commit) };
  if (commit.spawnError !== undefined) return { kind: "error", reason: commit.spawnError };
  const branch = symbolic.code === 0 ? utf8Name(lineBytes(symbolic)) : undefined;
  if (branch !== undefined) {
    const ref = await readRef(cwd, branch);
    if (ref.kind === "missing") return { kind: "unborn" };
    if (ref.kind === "error") return ref;
  }
  return { kind: "error", reason: "HEAD does not name a commit" };
}

// Whether the index holds a submodule, which git status looks into.
async function hasSubmodule(cwd: string): Promise<boolean | undefined> {
  const staged = await runGit(cwd, ["ls-files", "-z", "--stage"]);
  if (staged.code !== 0) return undefined;
  return staged.stdout
    .toString("latin1")
    .split("\0")
    .some((record) => record.startsWith("160000 "));
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
    // A git older than 2.44 fetches what a partial clone lacks whatever
    // GIT_NO_LAZY_FETCH says.
    const mayFetch = !(await gitCanRefuseLazyFetch(cwd));
    const partial = mayFetch && (await isPartialClone(cwd));

    const symbolic = await runGit(cwd, ["symbolic-ref", "-q", "HEAD"]);
    const head = await headOf(cwd, symbolic);
    if (head.kind === "commit") repo.head = head.oid;
    else if (head.kind === "error") fail("head", head.reason);

    // 1 is a detached HEAD, which the null means.
    if (symbolic.code === 0) {
      const name = utf8Name(lineBytes(symbolic));
      if (name === undefined) fail("branch", "the name of HEAD's branch is not valid UTF-8");
      else repo.branch = name.replace(/^refs\/heads\//, "");
    } else if (symbolic.code !== 1) {
      fail("branch", failure(symbolic, "HEAD could not be read"));
    }

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

    // Only "true" and "false" are answers: a git that does not know the
    // option prints it back.
    const shallow = await runGit(cwd, ["rev-parse", "--is-shallow-repository"]);
    const answer = shallow.code === 0 ? line(shallow) : undefined;
    const history =
      answer === "false"
        ? undefined
        : answer === "true"
          ? SHALLOW
          : failure(shallow, "could not tell whether the history of the repo is complete");

    if (head.kind === "unborn") repo.commits = 0;
    else if (head.kind === "error") fail("commits", head.reason);
    else if (history !== undefined) fail("commits", history);
    else {
      const commits = await runGit(cwd, ["rev-list", "--count", head.oid, "--"]);
      const n = count(commits);
      if (n === undefined) fail("commits", failure(commits, "the commits could not be counted"));
      else repo.commits = n;
    }

    const worktree = await worktreeOf(path);
    if (!worktree.ok) fail("files", `the working tree ${worktree.reason}`);
    else {
      // As a file_count of "**" does: a file that cannot be followed first,
      // then a directory git could not list in full.
      const blocked =
        blockedAmong(worktree.scope, [...worktree.scope.entries.keys()]) ??
        unreadReaching(worktree.scope, () => true);
      if (blocked !== undefined) fail("files", blocked);
      else repo.files = worktree.scope.entries.size;
    }

    const submodule = mayFetch && !partial ? await hasSubmodule(cwd) : false;
    if (partial) {
      fail(
        "uncommitted",
        "the repo is a partial clone, which this git (older than 2.44) may fetch objects for from its remote",
      );
    } else if (submodule === undefined) {
      fail("uncommitted", "the index could not be read by git");
    } else if (submodule) {
      fail(
        "uncommitted",
        "the repo has a submodule, which git status looks into, and this git (older than 2.44) may fetch objects for it from its remote",
      );
    } else {
      const status = await runGit(cwd, [
        "status",
        "--porcelain=v1",
        "-z",
        "--no-renames",
        "--untracked-files=all",
      ]);
      const [unread] = unreadWarnings(status);
      if (status.code !== 0) {
        fail("uncommitted", failure(status, "the working tree could not be compared by git"));
      } else if (unread !== undefined) {
        fail(
          "uncommitted",
          `git could not compare all of the working tree ("${shownWarning(unread)}")`,
        );
      } else {
        // One NUL-terminated record `XY <path>` per path: with --no-renames,
        // none carries a second path.
        repo.uncommitted = status.stdout.toString("latin1").split("\0").length - 1;
      }
    }

    if (history !== undefined) fail("behind_main", history);
    else if (head.kind === "error") fail("behind_main", head.reason);
    else {
      const main = await readRef(cwd, ORIGIN_MAIN);
      if (main.kind === "error") fail("behind_main", main.reason);
      else if (main.kind === "oid") {
        const commit = await runGit(cwd, [
          "rev-parse",
          "--verify",
          "--quiet",
          `${main.oid}^{commit}`,
        ]);
        if (commit.code !== 0) {
          fail("behind_main", await notACommit(cwd, main.oid, partial));
        } else {
          const range = head.kind === "unborn" ? line(commit) : `${head.oid}..${line(commit)}`;
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
        }
      }
      // A missing origin/main is what the null means.
    }
  }
  return result;
}

// Why origin/main, which names `oid`, gives no commit. Whether the object is
// there is not asked of a partial clone that this git may fetch it for.
async function notACommit(cwd: string, oid: string, partial: boolean): Promise<string> {
  if (partial) return `${ORIGIN_MAIN} is not a commit, or is not in the repository`;
  const there = await runGit(cwd, ["cat-file", "-e", oid]);
  return there.code === 0
    ? `${ORIGIN_MAIN} is not a commit`
    : `${ORIGIN_MAIN} points at an object that is not in the repository`;
}
