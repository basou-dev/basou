import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { findErrorCode } from "../lib/error-codes.js";
import { type Approval, ApprovalSchema } from "../schemas/approval.schema.js";
import { normalizeApprovalTimestamps } from "../schemas/iso-timestamp.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import { assertStoreDirectorySafe } from "../storage/store-dir.js";
import { readYamlFile } from "../storage/yaml-store.js";

/** Which side of `.basou/approvals/` an approval YAML lives on. */
export type ApprovalLocation = "pending" | "resolved";

/** Result returned by {@link loadApproval}: the parsed approval and where it was found. */
export type LoadedApproval = {
  approval: Approval;
  location: ApprovalLocation;
};

/**
 * What stands at `<pending|resolved>/<approval_id>.yaml`. Only a `file` (a
 * regular file) is read. A `symlink`, whatever it points to, and anything else
 * that is not a regular file (`not_a_file`: a directory, for instance) is not
 * followed: basou never creates one, so it is left out of the listing and
 * looked up as absent, and nothing is read through it.
 */
export type ApprovalEntryKind = "file" | "symlink" | "not_a_file" | "missing";

/** An entry named as an approval that {@link enumerateApprovals} does not follow. */
export type UnfollowedApprovalEntry = {
  id: string;
  location: ApprovalLocation;
  kind: "symlink" | "not_a_file";
};

/**
 * Refuse to operate on the approval store when `.basou/approvals`,
 * `.basou/approvals/pending` or `.basou/approvals/resolved` is a symlink or
 * not a directory, so no approval is read from or written to a place outside
 * the store through it. basou never creates such an entry. An absent
 * directory passes. {@link loadApproval} and {@link enumerateApprovals} make
 * this check first, and every command that resolves an approval reaches the
 * store through one of them.
 *
 * Throws the `assertStoreDirectorySafe` errors, naming `.basou/approvals`,
 * `.basou/approvals/pending` or `.basou/approvals/resolved`.
 */
export async function assertApprovalStoreSafe(paths: BasouPaths): Promise<void> {
  await assertStoreDirectorySafe(join(paths.root, "approvals"), ".basou/approvals");
  await assertStoreDirectorySafe(paths.approvals.pending, ".basou/approvals/pending");
  await assertStoreDirectorySafe(paths.approvals.resolved, ".basou/approvals/resolved");
}

/**
 * Classify the entry at `<pending|resolved>/<approvalId>.yaml` (see
 * {@link ApprovalEntryKind}) without following it. `approvalId` is used as a
 * file name as given, so a caller passes an id from {@link enumerateApprovals}
 * or one it has checked. The store itself is not checked here; the callers
 * that read it have already run {@link assertApprovalStoreSafe}.
 *
 * Throws `Error("Failed to read approval", { cause })` on an lstat failure
 * other than ENOENT.
 */
export async function inspectApprovalEntry(
  paths: BasouPaths,
  location: ApprovalLocation,
  approvalId: string,
): Promise<ApprovalEntryKind> {
  try {
    return classifyEntry(await lstat(join(paths.approvals[location], `${approvalId}.yaml`)));
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) return "missing";
    throw new Error("Failed to read approval", { cause: error });
  }
}

/**
 * Locate and load the approval YAML for `approvalId`. Searches resolved
 * first so that a duplicated YAML (the crash-window scenario where both
 * pending and resolved exist for the same id) returns the resolved-side
 * record — matching the dedupe rule used by `approval list` and
 * `resolveApprovalId`. Only a regular file is read: an entry that is a
 * symlink or not a file is passed over as if absent ({@link ApprovalEntryKind}),
 * so a regular file on the other side is still found. Returns null if neither
 * directory contains a readable YAML. Throws with a pathless message on read or
 * schema-validation failure, and the {@link assertApprovalStoreSafe} errors
 * before anything is read.
 */
export async function loadApproval(
  paths: BasouPaths,
  approvalId: string,
): Promise<LoadedApproval | null> {
  await assertApprovalStoreSafe(paths);
  for (const location of ["resolved", "pending"] as const) {
    if ((await inspectApprovalEntry(paths, location, approvalId)) !== "file") continue;
    const filePath = join(paths.approvals[location], `${approvalId}.yaml`);
    let raw: unknown;
    try {
      raw = await readYamlFile(filePath);
    } catch (error: unknown) {
      // ENOENT (i.e. "YAML file not found") → continue to the other directory.
      if (error instanceof Error && error.message === "YAML file not found") continue;
      throw new Error("Failed to read approval", { cause: error });
    }
    const result = ApprovalSchema.safeParse(normalizeApprovalTimestamps(raw));
    if (!result.success) {
      throw new Error("Failed to read approval", { cause: result.error });
    }
    // Defensive id check: a hand-edited YAML whose `id` field disagrees
    // with the filename-derived id would otherwise let the CLI render or
    // mutate one approval while citing another. Treat the mismatch as a
    // read failure rather than silently picking one side.
    if (result.data.id !== approvalId) {
      throw new Error("Failed to read approval", {
        cause: new Error(
          `Approval id mismatch: filename id ${approvalId} vs YAML body id ${result.data.id}`,
        ),
      });
    }
    return { approval: result.data, location };
  }
  return null;
}

/**
 * Enumerate approval IDs by inspecting `<id>.yaml` filenames in pending
 * and resolved. ENOENT on either directory is treated as empty (e.g. a
 * workspace that has no resolved approvals yet). YAML parse and schema
 * validation are NOT performed; callers that need the parsed approval
 * should use {@link loadApproval} per ID. Throws the
 * {@link assertApprovalStoreSafe} errors before anything is listed.
 *
 * `pending` and `resolved` hold the ids of regular files only, the entries
 * {@link loadApproval} reads. A `<id>.yaml` that is a symlink or not a file is
 * returned in `unfollowed` instead, so a caller can report it rather than let
 * it vanish.
 */
export async function enumerateApprovals(paths: BasouPaths): Promise<{
  pending: string[];
  resolved: string[];
  unfollowed: UnfollowedApprovalEntry[];
}> {
  await assertApprovalStoreSafe(paths);
  const [pending, resolved] = await Promise.all([
    enumerateEntries(paths.approvals.pending, "pending"),
    enumerateEntries(paths.approvals.resolved, "resolved"),
  ]);
  return {
    pending: pending.files,
    resolved: resolved.files,
    unfollowed: [...pending.unfollowed, ...resolved.unfollowed],
  };
}

async function enumerateEntries(
  dir: string,
  location: ApprovalLocation,
): Promise<{ files: string[]; unfollowed: UnfollowedApprovalEntry[] }> {
  const files: string[] = [];
  const unfollowed: UnfollowedApprovalEntry[] = [];
  try {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (!dirent.name.endsWith(".yaml")) continue;
      const id = dirent.name.slice(0, -".yaml".length);
      // The dirent type is the entry's own (a symlink is not followed). Where
      // it is neither a file nor a symlink, which includes a filesystem that
      // reports no type at all, lstat decides, so the listing agrees with what
      // `loadApproval` reads.
      let kind: ApprovalEntryKind;
      if (dirent.isFile()) kind = "file";
      else if (dirent.isSymbolicLink()) kind = "symlink";
      else {
        try {
          kind = classifyEntry(await lstat(join(dir, dirent.name)));
        } catch (error: unknown) {
          if (findErrorCode(error, "ENOENT")) continue;
          throw error;
        }
      }
      if (kind === "file") files.push(id);
      else if (kind !== "missing") unfollowed.push({ id, location, kind });
    }
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) return { files: [], unfollowed: [] };
    throw new Error("Failed to enumerate approvals", { cause: error });
  }
  return { files, unfollowed };
}

function classifyEntry(entry: Awaited<ReturnType<typeof lstat>>): ApprovalEntryKind {
  if (entry.isSymbolicLink()) return "symlink";
  return entry.isFile() ? "file" : "not_a_file";
}

/**
 * Return true when an approval is in `pending` state and its `expires_at`
 * timestamp has elapsed. Used by `basou approval list` / `show` to surface
 * a `(expired)` label without mutating the YAML file. Approval expiry uses
 * lazy-evaluation semantics; actual `approval_expired` event firing is
 * deferred to a later step.
 *
 * `now` is taken as a parameter so a single CLI invocation can share one
 * "now" across every record it inspects (avoids boundary races where two
 * reads of `Date.now()` straddle an expiry instant).
 */
export function isLazyExpired(approval: Approval, now: Date): boolean {
  if (approval.status !== "pending") return false;
  if (approval.expires_at === null) return false;
  const expiresMs = Date.parse(approval.expires_at);
  if (!Number.isFinite(expiresMs)) return false;
  return expiresMs < now.getTime();
}
