import { type FileHandle, open } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";
import {
  blockedAmong,
  codeReason,
  type GitResult,
  gitCanRefuseLazyFetch,
  isAbsent,
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
export const BOARD_REPOS_METHOD = 2;

/**
 * One repository the manifest declares, measured where it is checked out.
 *
 * A `null` means the value could not be measured, and then `not_found` has an
 * entry at `repos[<path>].<field>`, or at `repos[<path>]` when nothing of the
 * repository could be measured. Some values are `null` with a meaning of
 * their own and no entry: `branch` when HEAD is detached; `head` and
 * `last_commit` when the repository has no commit yet (`commits` is then 0);
 * `base`, `behind` and `ahead` when `refs/remotes/origin/HEAD` names no
 * branch and there is no `refs/remotes/origin/main`; `fetched_at` when
 * FETCH_HEAD does not show the base fetched from origin at the commit it is
 * at now.
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
  /**
   * The branch of origin HEAD is compared with, as `origin/<branch>`: the one
   * `refs/remotes/origin/HEAD` names (set by a clone, or by
   * `git remote set-head origin --auto`), or `origin/main` when it names none
   * (it is not set, or is not a symbolic ref).
   */
  base: string | null;
  /** The commits on `base` HEAD does not have, as of the last fetch. */
  behind: number | null;
  /**
   * The commits HEAD has that `base` does not, as of the last fetch. Not only
   * those not pushed: those of a branch pushed and not merged into `base`,
   * and those that came into it as other commits (by a squash or a rebase).
   */
  ahead: number | null;
  /**
   * When FETCH_HEAD (this worktree's) was last written, in UTC, if it holds
   * the line of `base`'s branch fetched from origin's URL at the commit
   * `base` is at now: as a rule, when this checkout last fetched it. A later
   * fetch with `--append` moves the time and leaves the line, and a remote
   * whose URL is origin's writes the same line as origin. Null otherwise: no
   * fetch since the clone, a fetch that failed (it empties FETCH_HEAD), a
   * fetch since from another URL or of other branches only, or `base` moved
   * since without a fetch here (a push, or a fetch in another worktree).
   * Neither in the digest nor compared with the previous record, as a fetch
   * that brings nothing moves it too.
   */
  fetched_at: string | null;
};

/**
 * When each commit reachable from HEAD was authored, as git recorded it (ISO
 * 8601 with its offset), or why that is not known. For the effort section,
 * which counts commits by day.
 */
export type AuthorDates = { ok: true; dates: string[] } | { ok: false; reason: string };

export type BoardReposResult = {
  repos: BoardRepo[];
  notFound: { at: string; reason: string }[];
  /** By the manifest's path, for each repository it declares. */
  authorDates: Map<string, AuthorDates>;
};

type Head =
  | { kind: "commit"; oid: string }
  | { kind: "unborn" }
  | { kind: "error"; reason: string };

type Ref = { kind: "missing" } | { kind: "oid"; oid: string } | { kind: "error"; reason: string };

const ORIGIN_HEAD = "refs/remotes/origin/HEAD";

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

const ORIGIN_BRANCHES = "refs/remotes/origin/";

// The full name of origin's default branch: the branch origin/HEAD names
// (`named`), or origin/main when origin/HEAD names none: it is not set, as
// after `git remote add` and a fetch, or is not a symbolic ref.
async function defaultBranchOf(
  cwd: string,
): Promise<{ kind: "name"; name: string; named: boolean } | { kind: "error"; reason: string }> {
  const named = await runGit(cwd, ["symbolic-ref", "-q", ORIGIN_HEAD]);
  if (named.code === 0) {
    const name = utf8Name(lineBytes(named));
    if (name === undefined) {
      return { kind: "error", reason: `the branch ${ORIGIN_HEAD} names is not valid UTF-8` };
    }
    // Only a hand-made origin/HEAD names a ref of something else.
    return name.startsWith(ORIGIN_BRANCHES)
      ? { kind: "name", name, named: true }
      : { kind: "error", reason: `${ORIGIN_HEAD} names ${name}, which is not a branch of origin` };
  }
  // 1 is a ref that is not symbolic, or not there.
  if (named.code === 1 && named.spawnError === undefined) {
    return { kind: "name", name: ORIGIN_MAIN, named: false };
  }
  return { kind: "error", reason: failure(named, `${ORIGIN_HEAD} could not be read`) };
}

type Base =
  | { kind: "none" }
  | { kind: "branch"; name: string; ref: Ref }
  | { kind: "error"; reason: string };

// The branch of origin HEAD is compared with, by its full name, and the ref
// as it was read; `none` when origin/HEAD names no branch and there is no
// origin/main, which is what a null base means.
async function baseOf(cwd: string): Promise<Base> {
  const target = await defaultBranchOf(cwd);
  if (target.kind === "error") return target;
  const ref = await readRef(cwd, target.name);
  if (ref.kind === "missing" && !target.named) return { kind: "none" };
  return { kind: "branch", name: target.name, ref };
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
  const result: BoardReposResult = { repos: [], notFound: [], authorDates: new Map() };
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
      base: null,
      behind: null,
      ahead: null,
      fetched_at: null,
    };
    result.repos.push(repo);
    const located = await locateRepoRoot(resolve(root, path));
    if (!located.ok) {
      const reason = `the repo '${path}' ${located.reason}`;
      result.notFound.push({ at, reason });
      result.authorDates.set(path, { ok: false, reason });
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

    if (head.kind === "unborn") {
      repo.commits = 0;
      result.authorDates.set(path, { ok: true, dates: [] });
    } else if (head.kind === "error") {
      fail("commits", head.reason);
      result.authorDates.set(path, { ok: false, reason: head.reason });
    } else if (history !== undefined) {
      fail("commits", history);
      result.authorDates.set(path, { ok: false, reason: history });
    } else {
      const commits = await runGit(cwd, ["rev-list", "--count", head.oid, "--"]);
      const n = count(commits);
      if (n === undefined) fail("commits", failure(commits, "the commits could not be counted"));
      else repo.commits = n;
      const authored = await runGit(cwd, [
        "log",
        "--no-show-signature",
        "--format=%aI",
        head.oid,
        "--",
      ]);
      const dates = authored.stdout
        .toString("utf8")
        .split("\n")
        .filter((d) => d !== "");
      result.authorDates.set(
        path,
        authored.code === 0 && dates.every((d) => !Number.isNaN(Date.parse(d)))
          ? { ok: true, dates }
          : {
              ok: false,
              reason: failure(authored, "the dates of the commits could not be read"),
            },
      );
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

    const base = await baseOf(cwd);
    if (base.kind === "error") fail("base", base.reason);
    else if (base.kind === "branch") repo.base = base.name.slice(REMOTES.length);

    const compared =
      history !== undefined
        ? both({ ok: false, reason: history })
        : head.kind === "error"
          ? both({ ok: false, reason: head.reason })
          : await againstBase(cwd, head, partial, base);
    for (const field of ["behind", "ahead"] as const) {
      const counted = compared[field];
      if (counted.ok) repo[field] = counted.count;
      else fail(field, counted.reason);
    }

    if (base.kind === "error") fail("fetched_at", base.reason);
    else if (base.kind === "branch") {
      const fetched = await fetchedAt(cwd, located.root, base.name, base.ref);
      if (fetched.ok) repo.fetched_at = fetched.at;
      else fail("fetched_at", fetched.reason);
    }
  }
  return result;
}

const REMOTES = "refs/remotes/";

type Counted = { ok: true; count: number | null } | { ok: false; reason: string };

const both = (counted: Counted): { behind: Counted; ahead: Counted } => ({
  behind: counted,
  ahead: counted,
});

// The commits on the base HEAD does not have, and those HEAD has that the
// base does not: null when there is no base, which is what the null means;
// or why they could not be counted.
async function againstBase(
  cwd: string,
  head: Exclude<Head, { kind: "error" }>,
  partial: boolean,
  base: Base,
): Promise<{ behind: Counted; ahead: Counted }> {
  if (base.kind === "error") return both({ ok: false, reason: base.reason });
  if (base.kind === "none") return both({ ok: true, count: null });
  const { name, ref } = base;
  if (ref.kind === "error") return both({ ok: false, reason: ref.reason });
  // Missing only when origin/HEAD names it: then there is no origin/main to fall back to.
  if (ref.kind === "missing") {
    return both({ ok: false, reason: `${ORIGIN_HEAD} names ${name}, which is not there` });
  }
  const commit = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref.oid}^{commit}`]);
  if (commit.code !== 0) {
    return both({ ok: false, reason: await notACommit(cwd, name, ref.oid, partial) });
  }
  const tip = line(commit);
  if (head.kind === "unborn") {
    return {
      behind: await countCommits(cwd, tip, `the commits behind ${name} could not be counted`),
      ahead: { ok: true, count: 0 },
    };
  }
  return {
    behind: await countCommits(
      cwd,
      `${head.oid}..${tip}`,
      `the commits behind ${name} could not be counted`,
    ),
    ahead: await countCommits(
      cwd,
      `${tip}..${head.oid}`,
      `the commits ahead of ${name} could not be counted`,
    ),
  };
}

async function countCommits(cwd: string, range: string, reason: string): Promise<Counted> {
  const listed = await runGit(cwd, ["rev-list", "--count", range, "--"]);
  const n = count(listed);
  return n === undefined ? { ok: false, reason: failure(listed, reason) } : { ok: true, count: n };
}

// When this checkout last fetched the base `name`, at `ref`, from origin: the
// time FETCH_HEAD was last written, when it holds the line git writes for
// that branch of origin's URL at the commit the base is at now. Null when it
// does not (a failed fetch leaves it empty but still moves its time), or
// when there is no such commit or no URL of origin to look for; or why it
// could not be told.
async function fetchedAt(
  cwd: string,
  root: Buffer,
  name: string,
  ref: Ref,
): Promise<{ ok: true; at: string | null } | { ok: false; reason: string }> {
  if (ref.kind === "error") return { ok: false, reason: ref.reason };
  if (ref.kind === "missing") return { ok: true, at: null };
  const { oid } = ref;
  const where = await runGit(cwd, ["rev-parse", "--git-path", "FETCH_HEAD"]);
  if (where.code !== 0) {
    return { ok: false, reason: failure(where, "where FETCH_HEAD is could not be read") };
  }
  const url = await runGit(cwd, ["remote", "get-url", "origin"]);
  // No exit code: git could not be started, or a signal stopped it.
  if (url.code === null) {
    return { ok: false, reason: failure(url, "the URL of origin could not be read") };
  }
  // origin has no URL (it is not a remote): no line can be from it. git reads
  // its config first, so one it cannot read has stopped the commands before.
  if (url.code !== 0) return { ok: true, at: null };
  // Relative to the root, except in a linked worktree.
  const given = lineBytes(where);
  const path = isAbsolute(given.toString("latin1"))
    ? given
    : Buffer.concat([root, Buffer.from(sep), given]);
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (error: unknown) {
    return isAbsent(error)
      ? { ok: true, at: null }
      : { ok: false, reason: `FETCH_HEAD ${codeReason(error)}` };
  }
  try {
    const written = (await handle.stat()).mtime;
    const lines = (await handle.readFile()).toString("latin1").split("\n");
    // As bytes, one character each: a branch name is UTF-8.
    const branch = Buffer.from(name.slice(ORIGIN_BRANCHES.length), "utf8").toString("latin1");
    const note = `branch '${branch}' of ${fetchHeadUrl(lineBytes(url).toString("latin1"))}`;
    const found = lines.some(
      (l) => l === `${oid}\t\t${note}` || l === `${oid}\tnot-for-merge\t${note}`,
    );
    return { ok: true, at: found ? written.toISOString() : null };
  } catch (error: unknown) {
    return { ok: false, reason: `FETCH_HEAD ${codeReason(error)}` };
  } finally {
    await handle.close();
  }
}

// A URL as git writes it in FETCH_HEAD: without the user (and password) a
// URL with a scheme or one of the form `user@host:path` names, then without
// the slashes at its end, then without one `.git` at its end.
function fetchHeadUrl(url: string): string {
  let shown = url;
  const at = url.indexOf("@");
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  // A local path has no ':', or a '/' before its first one.
  if (at !== -1 && colon !== -1 && (slash === -1 || colon < slash)) {
    const rest = url.slice(at + 1);
    const scheme = url.indexOf("://");
    if (scheme === -1) {
      if (rest.includes(":")) shown = rest;
    } else {
      const path = url.indexOf("/", scheme + 3);
      // A scheme of letters, digits, '+', '.' and '-', and the '@' before the path.
      if (/^[A-Za-z0-9+.-]*$/.test(url.slice(0, scheme)) && (path === -1 || at < path)) {
        shown = url.slice(0, scheme + 3) + rest;
      }
    }
  }
  const trimmed = shown.replace(/\/+$/, "");
  return trimmed.length > 5 && trimmed.endsWith(".git") ? trimmed.slice(0, -4) : trimmed;
}

// Why the default branch `name`, which names `oid`, gives no commit. Whether
// the object is there is not asked of a partial clone that this git may fetch
// it for.
async function notACommit(
  cwd: string,
  name: string,
  oid: string,
  partial: boolean,
): Promise<string> {
  if (partial) return `${name} is not a commit, or is not in the repository`;
  const there = await runGit(cwd, ["cat-file", "-e", oid]);
  return there.code === 0
    ? `${name} is not a commit`
    : `${name} points at an object that is not in the repository`;
}
