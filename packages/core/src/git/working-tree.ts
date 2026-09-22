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
