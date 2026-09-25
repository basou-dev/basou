import type { SimpleGit } from "simple-git";
import type { FileChange } from "./diff.js";
import { isGitNotFound, safeSimpleGit } from "./snapshot.js";

/**
 * Files that differ from `HEAD` in the working tree right now — the half of a
 * session's work that {@link getDiff} cannot see, because it has not been
 * committed yet.
 *
 * A session is observed from two angles that must be UNIONED, not chosen
 * between: `getDiff(baseHead, HEAD)` covers what the session committed, and
 * this covers what it left uncommitted. Either alone reports a session that
 * ends mid-change (or one that commits everything) as having touched nothing.
 *
 * Ignored files are excluded — git's own `status` omits them, which is what
 * makes this safe to run over a repository with a build tree: `dist/` and
 * friends are ignored by the repository's own rules, so they never enter a
 * session's file list.
 *
 * Conflicted entries are skipped, matching {@link getDiff}'s treatment of the
 * `U` status code: the `file_changed` status enum has no class for them.
 *
 * Pathless contract: every thrown message is a fixed string from the set
 * {`Not a git repository`, `Git executable not found in PATH. Install git
 * first.`, `Failed to read git status`}; native errors are preserved on
 * `Error.cause`.
 *
 * @param repoRoot absolute path to the git repository root
 */
export async function getWorkingTreeChanges(repoRoot: string): Promise<FileChange[]> {
  let git: SimpleGit;
  try {
    git = safeSimpleGit(repoRoot);
  } catch (error: unknown) {
    if (isGitNotFound(error)) {
      throw new Error("Git executable not found in PATH. Install git first.", { cause: error });
    }
    throw new Error("Not a git repository", { cause: error });
  }

  let status: Awaited<ReturnType<SimpleGit["status"]>>;
  try {
    status = await git.status();
  } catch (error: unknown) {
    if (isGitNotFound(error)) {
      throw new Error("Git executable not found in PATH. Install git first.", { cause: error });
    }
    const message = error instanceof Error ? error.message : "";
    if (/not a git repository/i.test(message)) {
      throw new Error("Not a git repository", { cause: error });
    }
    throw new Error("Failed to read git status", { cause: error });
  }

  // One entry per path, first classification wins. The order below is the
  // precedence: a renamed path also appears in `status.files`, and a staged
  // deletion also appears as `modified` in some git versions, so the more
  // specific class is recorded first and the later pass cannot overwrite it.
  const byPath = new Map<string, FileChange>();
  const put = (change: FileChange): void => {
    if (!byPath.has(change.path)) byPath.set(change.path, change);
  };

  const conflicted = new Set(status.conflicted);
  for (const entry of status.renamed) {
    if (conflicted.has(entry.to)) continue;
    put({ path: entry.to, status: "renamed", old_path: entry.from });
  }
  for (const path of status.deleted) {
    if (conflicted.has(path)) continue;
    put({ path, status: "deleted" });
  }
  // `created` = added to the index; `not_added` = untracked. Both are new
  // files as far as a reader of the session is concerned.
  for (const path of [...status.created, ...status.not_added]) {
    if (conflicted.has(path)) continue;
    put({ path, status: "added" });
  }
  for (const path of status.modified) {
    if (conflicted.has(path)) continue;
    put({ path, status: "modified" });
  }

  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Every path `git status` names, whatever its two status letters say: staged
 * or not, conflicted, a type change, untracked (every file inside an untracked
 * directory, not the directory).
 *
 * Unlike {@link getWorkingTreeChanges}, which keeps only the entries the
 * `file_changed` event has a class for, this drops none, and it reads git's own
 * `-z` records instead of simple-git's status parser, which trims each one, so
 * a name with a leading or trailing space survives. `--no-renames` lists both
 * names of a rename as entries of their own; `--no-optional-locks` keeps a run
 * from a hook from taking the index lock.
 *
 * Throws the same fixed strings as {@link getWorkingTreeChanges}.
 */
export async function getStatusPaths(repoRoot: string): Promise<string[]> {
  let git: SimpleGit;
  try {
    git = safeSimpleGit(repoRoot);
  } catch (error: unknown) {
    if (isGitNotFound(error)) {
      throw new Error("Git executable not found in PATH. Install git first.", { cause: error });
    }
    throw new Error("Not a git repository", { cause: error });
  }

  let raw: string;
  try {
    raw = await git.raw([
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "--no-renames",
      "--untracked-files=all",
    ]);
  } catch (error: unknown) {
    if (isGitNotFound(error)) {
      throw new Error("Git executable not found in PATH. Install git first.", { cause: error });
    }
    const message = error instanceof Error ? error.message : "";
    if (/not a git repository/i.test(message)) {
      throw new Error("Not a git repository", { cause: error });
    }
    throw new Error("Failed to read git status", { cause: error });
  }

  // Each record is `XY <path>`; with `--no-renames` none carries a second path.
  // A trailing slash is a nested repository, which names no file.
  const paths: string[] = [];
  for (const record of raw.split("\0")) {
    const path = record.slice(3);
    if (path.length === 0 || path.endsWith("/")) continue;
    paths.push(path);
  }
  return paths;
}

/**
 * `HEAD`'s commit sha, or `null` when the repository has no commits yet (an
 * unborn branch — a `git init` nobody has committed into). The null case is a
 * legitimate state for a young repository, not a failure, so it is a value
 * rather than a throw; a caller then has only the working tree to observe.
 *
 * Throws the same fixed strings as {@link getWorkingTreeChanges} when the path
 * is not a repository or git is missing.
 */
export async function readHeadSha(repoRoot: string): Promise<string | null> {
  let git: SimpleGit;
  try {
    git = safeSimpleGit(repoRoot);
  } catch (error: unknown) {
    if (isGitNotFound(error)) {
      throw new Error("Git executable not found in PATH. Install git first.", { cause: error });
    }
    throw new Error("Not a git repository", { cause: error });
  }

  let inside: boolean;
  try {
    inside = await git.checkIsRepo();
  } catch (error: unknown) {
    if (isGitNotFound(error)) {
      throw new Error("Git executable not found in PATH. Install git first.", { cause: error });
    }
    throw new Error("Failed to read git status", { cause: error });
  }
  if (!inside) throw new Error("Not a git repository");

  try {
    const head = (await git.revparse(["HEAD"])).trimEnd();
    return head.length > 0 ? head : null;
  } catch {
    // The only expected failure here is an unborn HEAD; a genuinely broken
    // repository would already have failed `checkIsRepo` above.
    return null;
  }
}

/**
 * Paths git does not track yet — the one thing `git diff <base>` cannot report,
 * whatever base it is given.
 *
 * Returned as {@link FileChange} entries with status `added`, so a caller can
 * union them with a diff without a second shape. Ignored files stay out, as
 * they do in {@link getWorkingTreeChanges}.
 *
 * Without `--directory`, git names each file inside an untracked directory
 * rather than the directory itself; a directory entry would become a
 * `related_files` entry that names no file. One case is reported as a
 * directory regardless: an untracked NESTED repository, which git will not
 * look inside. Those entries are dropped — a nested repository is its own
 * repository, and if it belongs to the workspace the roster names it and it is
 * observed on its own terms.
 *
 * Same fixed error vocabulary as {@link getWorkingTreeChanges}.
 */
export async function getUntrackedFiles(repoRoot: string): Promise<FileChange[]> {
  let git: SimpleGit;
  try {
    git = safeSimpleGit(repoRoot);
  } catch (error: unknown) {
    if (isGitNotFound(error)) {
      throw new Error("Git executable not found in PATH. Install git first.", { cause: error });
    }
    throw new Error("Not a git repository", { cause: error });
  }

  let raw: string;
  try {
    // `-z` gives NUL-separated, UNQUOTED paths, matching the diff side, which
    // asks git with `-z` too.
    raw = await git.raw([
      "-c",
      "core.quotePath=false",
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
  } catch (error: unknown) {
    if (isGitNotFound(error)) {
      throw new Error("Git executable not found in PATH. Install git first.", { cause: error });
    }
    const message = error instanceof Error ? error.message : "";
    if (/not a git repository/i.test(message)) {
      throw new Error("Not a git repository", { cause: error });
    }
    throw new Error("Failed to read git status", { cause: error });
  }

  const changes: FileChange[] = [];
  for (const path of raw.split("\0")) {
    if (path.length === 0) continue;
    // A trailing slash is a directory git would not descend into (a nested
    // repository); naming it as a changed file would be a lie about a path.
    if (path.endsWith("/")) continue;
    changes.push({ path, status: "added" });
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The sha of the empty tree in this repository's object format, for use as the
 * base of a repository that had NO commits when the session started.
 *
 * Diffing against it answers "everything that exists now is new", which is the
 * truth for an unborn base — and it is the only way the work survives the
 * session committing it, after which the working tree is clean and says
 * nothing. Computed rather than hard-coded because the well-known constant is
 * the sha-1 value and a sha-256 repository has a different one.
 */
export async function readEmptyTreeSha(repoRoot: string): Promise<string> {
  let git: SimpleGit;
  try {
    git = safeSimpleGit(repoRoot);
  } catch (error: unknown) {
    if (isGitNotFound(error)) {
      throw new Error("Git executable not found in PATH. Install git first.", { cause: error });
    }
    throw new Error("Not a git repository", { cause: error });
  }
  try {
    return (await git.raw(["hash-object", "-t", "tree", "/dev/null"])).trimEnd();
  } catch (error: unknown) {
    throw new Error("Failed to read git status", { cause: error });
  }
}
