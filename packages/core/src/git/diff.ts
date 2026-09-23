import type { SimpleGit } from "simple-git";
import { isGitNotFound, safeSimpleGit } from "./snapshot.js";

/**
 * Status classification used by the `file_changed` event schema. Limited to
 * the four classes that simple-git's `git diff --name-status` reliably
 * surfaces; copy / unmerged / typechange entries are intentionally dropped
 * to keep the event payload shape narrow.
 */
export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed";

/**
 * Single file-level change observed between two refs. `old_path` is set
 * only for `renamed` entries (the previous path of the file).
 */
export type FileChange = {
  path: string;
  old_path?: string;
  status: FileChangeStatus;
};

/**
 * Result of {@link getDiff}. The `changed_files` array is in git's natural
 * `--name-status` order; callers requiring deterministic ordering should
 * sort by `path` themselves.
 */
export type DiffResult = {
  changed_files: FileChange[];
};

/**
 * Compute the file-level diff between two git refs.
 *
 * Returns a list of changed file paths classified by status (added /
 * modified / deleted / renamed). Diff content is intentionally NOT
 * returned — `file_changed` events record paths only, and raw diff bodies
 * are excluded so the trace cannot inadvertently leak source code that may
 * be sensitive. Use `git show <ref>` to obtain the underlying diff.
 *
 * Pathless contract: every thrown message is a fixed string from the set
 * {`Not a git repository`, `Git executable not found in PATH. Install git
 * first.`, `Invalid ref`, `Failed to compute git diff`}; native errors are
 * preserved on `Error.cause`.
 *
 * Special cases:
 * - `baseRef === headRef` short-circuits to an empty result
 * - copy / unmerged / typechange / unknown status codes are skipped
 *
 * @param repoRoot absolute path to the git repository root
 * @param baseRef base ref (e.g. session-start HEAD sha)
 * @param headRef head ref (e.g. session-end HEAD sha)
 */
export async function getDiff(
  repoRoot: string,
  baseRef: string,
  headRef: string,
): Promise<DiffResult> {
  let git: SimpleGit;
  try {
    git = safeSimpleGit(repoRoot);
  } catch (error: unknown) {
    if (isGitNotFound(error)) {
      throw new Error("Git executable not found in PATH. Install git first.", { cause: error });
    }
    throw new Error("Not a git repository", { cause: error });
  }

  if (baseRef === headRef) return { changed_files: [] };

  let raw: string;
  try {
    raw = await git.raw(["diff", "--name-status", `${baseRef}..${headRef}`]);
  } catch (error: unknown) {
    throw translateDiffError(error);
  }

  return { changed_files: parseDiffNameStatus(raw) };
}

/**
 * Files that differ between `baseRef` and the WORKING TREE — committed and
 * uncommitted alike, in one question to git.
 *
 * This is the net change a session produced, which is not the same as the
 * union of "what it committed" and "what it left dirty": a file created and
 * then committed, then modified again, is one `added` entry relative to the
 * base, not an `added` plus a `modified`. Asking git for the net directly is
 * what keeps the two halves from having to be reconciled by hand.
 *
 * Untracked files are NOT included — `git diff` never reports them — so a
 * caller that wants them unions this with {@link getWorkingTreeChanges}.
 *
 * {@link getDiff} does NOT set `core.quotePath=false` and still returns git's
 * quoted rendering for a non-ASCII path. That is a separate defect on a
 * shipped path (`basou run` / `exec` write those paths into `file_changed`
 * events) and is deliberately not changed here.
 *
 * Pathless contract and error vocabulary are identical to {@link getDiff}.
 *
 * @param repoRoot absolute path to the git repository root
 * @param baseRef the ref the session started from (e.g. its session-start HEAD)
 */
export async function getChangesSince(repoRoot: string, baseRef: string): Promise<FileChange[]> {
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
    // `core.quotePath=false` so a non-ASCII path comes back as itself rather
    // than as git's octal-escaped, double-quoted rendering. The caller unions
    // this with `git status`, which reports the same path RAW; without this
    // the two answers spell one file two ways, and nothing downstream —
    // deduplication, or subtracting what was already dirty — can match them.
    raw = await git.raw(["-c", "core.quotePath=false", "diff", "--name-status", baseRef]);
  } catch (error: unknown) {
    throw translateDiffError(error);
  }
  return parseDiffNameStatus(raw);
}

/**
 * Map a simple-git failure onto this module's fixed error vocabulary. Shared
 * by {@link getDiff} and {@link getChangesSince} so the two cannot drift into
 * reporting the same git failure differently.
 */
function translateDiffError(error: unknown): Error {
  if (isGitNotFound(error)) {
    return new Error("Git executable not found in PATH. Install git first.", { cause: error });
  }
  const message = error instanceof Error ? error.message : "";
  if (/not a git repository/i.test(message)) {
    return new Error("Not a git repository", { cause: error });
  }
  // Git words the same failure differently depending on how the ref was
  // spelled: a NAME that does not resolve is an "unknown revision" / "ambiguous
  // argument", while a SHA that no longer exists (the base commit of a session
  // whose branch was rebased or gc'd) is a "bad object", and the two-dot form
  // is an "Invalid revision range". All four are one thing to a caller — the
  // ref it asked about is not there.
  if (
    message.includes("bad revision") ||
    message.includes("unknown revision") ||
    message.includes("ambiguous argument") ||
    message.includes("bad object") ||
    message.includes("Invalid revision range")
  ) {
    return new Error("Invalid ref", { cause: error });
  }
  return new Error("Failed to compute git diff", { cause: error });
}

function parseDiffNameStatus(raw: string): FileChange[] {
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  const changes: FileChange[] = [];
  for (const line of lines) {
    const parts = line.split("\t");
    const code = parts[0];
    if (code === undefined || code.length === 0) continue;
    if (code.startsWith("R") && parts.length >= 3) {
      const newPath = parts[2];
      const oldPath = parts[1];
      if (newPath === undefined) continue;
      changes.push({
        path: newPath,
        status: "renamed",
        ...(oldPath !== undefined ? { old_path: oldPath } : {}),
      });
    } else if (code === "A" && parts[1]) {
      changes.push({ path: parts[1], status: "added" });
    } else if (code === "M" && parts[1]) {
      changes.push({ path: parts[1], status: "modified" });
    } else if (code === "D" && parts[1]) {
      changes.push({ path: parts[1], status: "deleted" });
    }
    // C / U / T / X (copy / unmerged / typechange / unknown) are skipped:
    // the file_changed status enum does not cover them in v0.1.
  }
  return changes;
}
