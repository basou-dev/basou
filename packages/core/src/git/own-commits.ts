import type { SimpleGit } from "simple-git";
import { isGitNotFound, safeSimpleGit } from "./snapshot.js";

/**
 * Reflog subjects of the entries in which this repository CREATED a commit, as
 * git itself writes them: a commit (initial, amended, a merge commit, or one
 * that concludes a cherry-pick), a cherry-pick, a revert, a patch applied by
 * `git am`, a pick replayed by a rebase or by `git pull --rebase` (whatever its
 * options were spelled as, a URL included), and a merge that git committed
 * itself. Every other entry only moves a ref to a commit that already existed
 * -- a pull or merge that fast-forwarded to commits made elsewhere,
 * `cherry-pick --ff`, a checkout, a reset, a branch created at an existing
 * commit -- and says nothing about who wrote what. (`git replay` creates
 * commits too, but records only where each ref ends; see {@link REPLAY}.)
 *
 * The part after `pull` may contain colons (`git@host:org/repo`, a refspec
 * `main:refs/...`). It cannot run on into the message: what closes it is a
 * space, a parenthesised step and a colon, and a ref name holds neither a space
 * nor a colon.
 */
const COMMIT_CREATED =
  /^(?:commit(?: \((?:initial|amend|merge|cherry-pick)\))?|cherry-pick|revert|am|(?:rebase|pull)\b.*? \((?:pick|reword|edit|squash|fixup|continue|merge)\)): |^(?:merge|pull)\b.*?: Merge made by /;

/**
 * `cherry-pick --ff` moves HEAD to the picked commit itself; nothing is
 * created. Git writes the same subject for a real pick of a commit whose own
 * subject is "fast-forward", and that pick is missed.
 */
const FAST_FORWARD_PICK = /^cherry-pick: fast-forward$/;

/**
 * `git replay` writes one entry per ref it moves, at the commit the ref ends
 * at; the commits it replayed below that one appear in no reflog. They are the
 * commits between where it replayed onto -- `--onto <sha>` in the subject, or
 * else the ref's previous value, which is where `--advance` starts -- and the
 * entry's commit.
 */
const REPLAY = /^replay\b(?:.*? --onto ([0-9a-f]+)\b)?/;

/**
 * How many commits one `git log` call is given. Every sha is an argument, and a
 * session that creates tens of thousands of commits would otherwise exceed the
 * system's argument-list limit.
 */
const COMMITS_PER_CALL = 1000;

/** What the reflogs say was created in this repository since a point in time. */
export type OwnCommitPaths = {
  /**
   * Paths changed by those commits, repository-relative. A merge commit
   * contributes only the paths where it differs from every parent (its
   * combined diff), not what it brought in from the other side.
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
 * `sinceMs`, read from the reflogs of HEAD and of every local branch. HEAD's
 * reflog belongs to one worktree; the branches' reflogs are shared by all of
 * them, so a commit made on a branch in another worktree of the same
 * repository is found there.
 *
 * Reflog times have one-second resolution; an entry is in the window when its
 * second is not before `sinceMs`'s second, so a commit made in the same second
 * as the start is kept rather than dropped.
 *
 * Throws when git fails. The caller cannot tell a failed read from "nothing was
 * created", so it must not treat either as the other.
 *
 * @param commitsPerCall how many commits one `git log` call is given (tests)
 */
export async function getOwnCommitPaths(
  repoRoot: string,
  sinceMs: number,
  commitsPerCall: number = COMMITS_PER_CALL,
): Promise<OwnCommitPaths> {
  let git: SimpleGit;
  try {
    git = safeSimpleGit(repoRoot);
  } catch (error: unknown) {
    if (isGitNotFound(error)) {
      throw new Error("Git executable not found in PATH. Install git first.", { cause: error });
    }
    throw new Error("Not a git repository", { cause: error });
  }

  // One entry per line: reflog subjects are single-line. Git interleaves the
  // refs' entries, but each ref's own entries keep their order, newest first,
  // so the next entry of the same ref is that ref's previous value. `%gd` under
  // `--date=unix` is
  // `<ref>@{<seconds>}`, the time stored with the ref update. Git takes it from
  // the committer identity, so it is the time of the update unless the
  // operation was given a date: `GIT_COMMITTER_DATE`, or a commit that `rebase
  // --continue` concludes under `--committer-date-is-author-date` (that step
  // carries the author date; the picks around it do not). A pulled commit's
  // own dates never enter into it.
  //
  // `--no-show-signature` because `log.showSignature` would verify every
  // commit in every reflog on each call. A branch with no reflog is left out;
  // `--ignore-missing` leaves out a branch ref that is broken (empty, or naming
  // a missing object) instead of failing the whole read over it; `--` keeps a
  // file or directory named `HEAD` (or `head` on a case-insensitive file
  // system) from making `HEAD` ambiguous.
  let reflog: string;
  try {
    reflog = await git.raw([
      "log",
      "-g",
      "--ignore-missing",
      "--no-show-signature",
      "--date=unix",
      "--format=%H%x1f%gd%x1f%gs",
      "HEAD",
      "--branches",
      "--",
    ]);
  } catch (error: unknown) {
    throw new Error("Failed to read the reflog", { cause: error });
  }

  const sinceSecond = Math.floor(sinceMs / 1000);
  const entries: { sha: string; ref: string; second: number; subject: string }[] = [];
  for (const line of reflog.split("\n")) {
    const [sha, selector, subject] = line.split("\x1f");
    if (sha === undefined || selector === undefined || subject === undefined) continue;
    const match = /^(.*)@\{(\d+)\}$/.exec(selector);
    if (match === null) continue;
    entries.push({ sha, ref: match[1] ?? "", second: Number(match[2]), subject });
  }

  const created = new Set<string>();
  let entriesSince = 0;
  for (const [i, entry] of entries.entries()) {
    if (entry.second < sinceSecond) continue;
    entriesSince += 1;
    if (COMMIT_CREATED.test(entry.subject) && !FAST_FORWARD_PICK.test(entry.subject)) {
      created.add(entry.sha);
      continue;
    }
    const replay = REPLAY.exec(entry.subject);
    if (replay === null) continue;
    const from = replay[1] ?? entries.slice(i + 1).find((other) => other.ref === entry.ref)?.sha;
    if (from === undefined) {
      created.add(entry.sha);
      continue;
    }
    let replayed: string;
    try {
      replayed = await git.raw(["rev-list", entry.sha, "--not", from, "--"]);
    } catch (error: unknown) {
      throw new Error("Failed to read the reflog", { cause: error });
    }
    for (const sha of replayed.split("\n")) {
      if (sha.length > 0) created.add(sha);
    }
  }

  const paths = new Set<string>();
  const shas = [...created];
  for (let start = 0; start < shas.length; start += commitsPerCall) {
    let raw: string;
    try {
      // `--cc` makes a merge commit list only the paths where it differs from
      // every parent and leaves other commits' diffs as they are;
      // `--no-renames` names both sides of a rename; `-z` keeps real names.
      // `--root` and `--no-show-signature` hold the output to that whatever the
      // repository's `log.showRoot` and `log.showSignature` say: the first
      // would drop a root commit's files, the second would write signature
      // checks into the stream of paths.
      raw = await git.raw([
        "log",
        "--no-walk=unsorted",
        "--no-show-signature",
        "--root",
        "--cc",
        "--format=",
        "--name-only",
        "--no-renames",
        "-z",
        ...shas.slice(start, start + commitsPerCall),
        "--",
      ]);
    } catch (error: unknown) {
      throw new Error("Failed to read the reflog", { cause: error });
    }
    // With an empty `--format` git writes nothing between commits: the output
    // is one run of NUL-terminated paths.
    for (const path of raw.split("\0")) {
      if (path.length > 0) paths.add(path);
    }
  }
  return { paths, entriesSince };
}
