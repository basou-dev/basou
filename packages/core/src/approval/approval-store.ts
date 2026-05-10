import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { findErrorCode } from "../lib/error-codes.js";
import { type Approval, ApprovalSchema } from "../schemas/approval.schema.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import { readYamlFile } from "../storage/yaml-store.js";

/** Which side of `.basou/approvals/` an approval YAML lives on. */
export type ApprovalLocation = "pending" | "resolved";

/** Result returned by {@link loadApproval}: the parsed approval and where it was found. */
export type LoadedApproval = {
  approval: Approval;
  location: ApprovalLocation;
};

/**
 * Locate and load the approval YAML for `approvalId`. Searches resolved
 * first so that a duplicated YAML (the crash-window scenario where both
 * pending and resolved exist for the same id) returns the resolved-side
 * record — matching the dedupe rule used by `approval list` and
 * `resolveApprovalId`. Returns null if neither directory contains the
 * YAML. Throws with a pathless message on read or schema-validation
 * failure.
 */
export async function loadApproval(
  paths: BasouPaths,
  approvalId: string,
): Promise<LoadedApproval | null> {
  for (const location of ["resolved", "pending"] as const) {
    const filePath = join(paths.approvals[location], `${approvalId}.yaml`);
    let raw: unknown;
    try {
      raw = await readYamlFile(filePath);
    } catch (error: unknown) {
      // ENOENT (i.e. "YAML file not found") → continue to the other directory.
      if (error instanceof Error && error.message === "YAML file not found") continue;
      throw new Error("Failed to read approval", { cause: error });
    }
    const result = ApprovalSchema.safeParse(raw);
    if (!result.success) {
      throw new Error("Failed to read approval", { cause: result.error });
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
 * should use {@link loadApproval} per ID.
 */
export async function enumerateApprovals(paths: BasouPaths): Promise<{
  pending: string[];
  resolved: string[];
}> {
  const [pending, resolved] = await Promise.all([
    enumerateIds(paths.approvals.pending),
    enumerateIds(paths.approvals.resolved),
  ]);
  return { pending, resolved };
}

async function enumerateIds(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    const dirents = await readdir(dir, { withFileTypes: true });
    entries = dirents
      .filter((e) => e.isFile() && e.name.endsWith(".yaml"))
      .map((e) => e.name.slice(0, -".yaml".length));
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) return [];
    throw new Error("Failed to enumerate approvals", { cause: error });
  }
  return entries;
}

/**
 * Return true when an approval is in `pending` state and its `expires_at`
 * timestamp has elapsed. Used by `basou approval list` / `show` to surface
 * a `(expired)` label without mutating the YAML file. Y-2 Section 9.5
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
