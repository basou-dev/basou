import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Absolute paths to the standard `.basou/` directory layout, derived from a
 * given repository root. The shape mirrors Y-2 Section 1.2's `.basou/` tree.
 * `root` is the `.basou/` directory itself (i.e. `repositoryRoot/.basou`).
 *
 * All fields are deeply readonly; consumers must not mutate the returned
 * object.
 */
export type BasouPaths = {
  readonly root: string;
  readonly sessions: string;
  readonly tasks: string;
  readonly approvals: {
    readonly pending: string;
    readonly resolved: string;
  };
  readonly logs: string;
  readonly raw: string;
  readonly tmp: string;
};

/**
 * Compute absolute paths to the standard `.basou/` directory layout under
 * `repositoryRoot`. Pure: performs no I/O and is safe to call before the
 * directory exists.
 *
 * @param repositoryRoot Absolute path to the git repository root (the
 *   parent directory of `.basou/`). Caller is responsible for resolving
 *   `process.cwd()` or running `git rev-parse --show-toplevel` upstream;
 *   this function does not validate that the path exists or is a git
 *   repository.
 */
export function basouPaths(repositoryRoot: string): BasouPaths {
  const root = join(repositoryRoot, ".basou");
  const approvalsBase = join(root, "approvals");
  return {
    root,
    sessions: join(root, "sessions"),
    tasks: join(root, "tasks"),
    approvals: {
      pending: join(approvalsBase, "pending"),
      resolved: join(approvalsBase, "resolved"),
    },
    logs: join(root, "logs"),
    raw: join(root, "raw"),
    tmp: join(root, "tmp"),
  };
}

// Labels for sub-paths inside `.basou/`. Used in pathless error messages so
// the surface area for absolute-path leakage is bounded by this map.
const PATH_LABELS = {
  sessions: ".basou/sessions",
  tasks: ".basou/tasks",
  approvalsPending: ".basou/approvals/pending",
  approvalsResolved: ".basou/approvals/resolved",
  logs: ".basou/logs",
  raw: ".basou/raw",
  tmp: ".basou/tmp",
} as const;

/**
 * Create the standard `.basou/` directory layout under `repositoryRoot`.
 *
 * Idempotent: a no-op on an already-initialized layout. Returns the resolved
 * {@link BasouPaths} so callers can immediately use them.
 *
 * Throws if `repositoryRoot/.basou` (or any required subdirectory) exists
 * but is not a directory, or if filesystem permissions prevent creation.
 * All thrown error messages are pathless; the original native error is
 * attached as `cause` for diagnostics.
 *
 * @param repositoryRoot Absolute path to the git repository root. See
 *   {@link basouPaths} for the contract on this parameter.
 */
export async function ensureBasouDirectory(repositoryRoot: string): Promise<BasouPaths> {
  const paths = basouPaths(repositoryRoot);

  let existing: Awaited<ReturnType<typeof stat>> | undefined;
  try {
    existing = await stat(paths.root);
  } catch (error: unknown) {
    if (!hasErrorCode(error) || error.code !== "ENOENT") {
      throw new Error("Failed to inspect .basou directory", { cause: error });
    }
  }
  if (existing !== undefined && !existing.isDirectory()) {
    throw new Error("Basou root .basou exists but is not a directory");
  }

  await Promise.all([
    mkdirLabeled(paths.sessions, PATH_LABELS.sessions),
    mkdirLabeled(paths.tasks, PATH_LABELS.tasks),
    mkdirLabeled(paths.approvals.pending, PATH_LABELS.approvalsPending),
    mkdirLabeled(paths.approvals.resolved, PATH_LABELS.approvalsResolved),
    mkdirLabeled(paths.logs, PATH_LABELS.logs),
    mkdirLabeled(paths.raw, PATH_LABELS.raw),
    mkdirLabeled(paths.tmp, PATH_LABELS.tmp),
  ]);

  return paths;
}

async function mkdirLabeled(target: string, label: string): Promise<void> {
  try {
    await mkdir(target, { recursive: true });
  } catch (error: unknown) {
    if (hasErrorCode(error) && (error.code === "ENOTDIR" || error.code === "EEXIST")) {
      throw new Error(`${label} exists but is not a directory`, { cause: error });
    }
    throw new Error(`Failed to create ${label}`, { cause: error });
  }
}

function hasErrorCode(error: unknown): error is Error & { code: string } {
  if (!(error instanceof Error)) return false;
  const codeProp = (error as unknown as Record<string, unknown>).code;
  return typeof codeProp === "string";
}
