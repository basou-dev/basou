import type { SimpleGit } from "simple-git";
import { isGitNotFound, safeSimpleGit } from "./snapshot.js";

/**
 * Reflog subjects of the entries in which this repository CREATED a commit:
 * a commit (initial, amended, or a merge commit), a cherry-pick, a revert, a
 * pick replayed by a rebase, and a merge that git committed itself. Every other
 * entry only moves HEAD to a commit that already existed -- a pull or merge
 * that fast-forwarded to commits made elsewhere, a checkout, a reset -- and
 * says nothing about who wrote what.
 */
const COMMIT_CREATED =
  /^(?:commit(?: \((?:initial|amend|merge)\))?|cherry-pick|revert|(?:rebase|pull --rebase)(?: -i)? \((?:pick|reword|edit|squash|fixup|continue)\)): |^(?:merge|pull)\b[^:]*: Merge made by /;

/** What the HEAD reflog says was created in this repository since a point in time. */
export type OwnCommitPaths = {
  /**
   * Paths changed by those commits, repository-relative. A merge commit
   * contributes only what it resolved (its combined diff), not what it brought
   * in from the other side.
   */
  paths: Set<string>;
  /**
   * How many reflog entries of ANY kind fall in the window. Zero while HEAD has
   * moved means the reflog was not written (reflogs off, or expired), so an
   * empty `paths` proves nothing.
   */
  entriesSince: number;
};

/**
 * The paths changed by the commits this repository created at or after
 * `sinceMs`, read from the HEAD reflog. HEAD's reflog records every commit made
 * while HEAD pointed at any branch, so one read covers them all.
 *
 * Reflog times have one-second resolution; an entry is in the window when its
 * second is not before `sinceMs`'s second, so a commit made in the same second
 * as the start is kept rather than dropped.
 *
 * Returns `null` when the reflog cannot be read (an unborn HEAD, a broken
 * repository): absence of evidence, which the caller must not treat as
 * "nothing was created".
 */
export async function getOwnCommitPaths(
  repoRoot: string,
  sinceMs: number,
): Promise<OwnCommitPaths | null> {
  let git: SimpleGit;
  try {
    git = safeSimpleGit(repoRoot);
  } catch (error: unknown) {
    if (isGitNotFound(error)) {
      throw new Error("Git executable not found in PATH. Install git first.", { cause: error });
    }
    throw new Error("Not a git repository", { cause: error });
  }

  let reflog: string;
  try {
    // One entry per line: reflog subjects are single-line. `%gd` under
    // `--date=unix` is `HEAD@{<seconds>}`, the time of the ref update itself,
    // which is what matters here -- a pulled commit keeps its author's dates.
    reflog = await git.raw(["log", "-g", "--date=unix", "--format=%H%x1f%gd%x1f%gs", "HEAD"]);
  } catch {
    return null;
  }

  const sinceSecond = Math.floor(sinceMs / 1000);
  const created = new Set<string>();
  let entriesSince = 0;
  for (const line of reflog.split("\n")) {
    const [sha, selector, subject] = line.split("\x1f");
    if (sha === undefined || selector === undefined || subject === undefined) continue;
    const second = Number(/\{(\d+)\}$/.exec(selector)?.[1]);
    if (!Number.isFinite(second) || second < sinceSecond) continue;
    entriesSince += 1;
    if (COMMIT_CREATED.test(subject)) created.add(sha);
  }
  if (created.size === 0) return { paths: new Set(), entriesSince };

  let raw: string;
  try {
    // `--cc` makes a merge commit list only the paths where it differs from
    // every parent (what was resolved) and leaves other commits' diffs as they
    // are; `--no-renames` names both sides of a rename; `-z` keeps real names.
    raw = await git.raw([
      "log",
      "--no-walk=unsorted",
      "--cc",
      "--format=",
      "--name-only",
      "--no-renames",
      "-z",
      ...created,
    ]);
  } catch {
    return null;
  }
  // With an empty `--format` git writes nothing between commits: the output is
  // one run of NUL-terminated paths.
  const paths = new Set<string>();
  for (const path of raw.split("\0")) {
    if (path.length > 0) paths.add(path);
  }
  return { paths, entriesSince };
}
