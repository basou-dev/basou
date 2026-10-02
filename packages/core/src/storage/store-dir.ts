import { lstat } from "node:fs/promises";
import { findErrorCode } from "../lib/error-codes.js";

/**
 * Refuse to operate on a directory of the `.basou/` store that is a symlink or
 * not a directory, so nothing is read from or written to a place outside the
 * store through it. basou never creates such an entry. The guards of the
 * individual stores build on it: `assertSessionStoreSafe`,
 * `assertTaskStoreSafe` and `assertApprovalStoreSafe`.
 *
 * `label` names the directory relative to the repository root, such as
 * `.basou/tasks`; the errors carry it and no absolute path.
 *
 * An absent directory passes: an empty or stripped-down workspace has none,
 * and the writers that need it create it.
 *
 * Throws `"<label> is a symlink; refusing to operate"`, `"<label> exists but
 * is not a directory"`, or `Error("Failed to inspect <label>", { cause })` on
 * any other lstat failure.
 *
 * Like `assertBasouRootSafe`, this detects an entry already swapped; it does
 * not race-proof the filesystem.
 */
export async function assertStoreDirectorySafe(path: string, label: string): Promise<void> {
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(path);
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) return;
    throw new Error(`Failed to inspect ${label}`, { cause: error });
  }
  if (entry.isSymbolicLink()) {
    throw new Error(`${label} is a symlink; refusing to operate`);
  }
  if (!entry.isDirectory()) {
    throw new Error(`${label} exists but is not a directory`);
  }
}
