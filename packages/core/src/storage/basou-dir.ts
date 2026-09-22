import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Absolute paths to the standard `.basou/` directory layout, derived from a
 * given repository root. The shape mirrors the canonical `.basou/` tree
 * (see `docs/spec/workspace.md`). `root` is the `.basou/` directory itself
 * (i.e. `repositoryRoot/.basou`).
 *
 * `files` exposes the well-known top-level files inside `.basou/`. Each path
 * is computed but not created — they are written by their respective
 * subsystems (e.g. `writeManifest` for `manifest.yaml`).
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
  readonly locks: string;
  readonly logs: string;
  /**
   * Per-session git observations: what each vendor session changed on disk,
   * accumulated by the hooks while it runs and consumed by the import that
   * merges it into the session's related files. Working state, not a record —
   * see `session/observation.ts`.
   *
   * Lives UNDER `tmp/` on purpose. `basou init` only appends its ignore block
   * when the file carries no basou block yet, so a store initialized before
   * this directory existed never learns to ignore a new top-level entry — and
   * these files carry absolute machine paths. `.basou/tmp/` is in every
   * generation of that block, so the placement is what keeps them out of git
   * rather than an upgrade step nobody runs.
   */
  readonly observations: string;
  readonly raw: string;
  readonly tmp: string;
  readonly files: {
    readonly manifest: string;
    readonly status: string;
    readonly handoff: string;
    readonly decisions: string;
    readonly orientation: string;
  };
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
    locks: join(root, "locks"),
    logs: join(root, "logs"),
    raw: join(root, "raw"),
    tmp: join(root, "tmp"),
    observations: join(root, "tmp", "observations"),
    files: {
      manifest: join(root, "manifest.yaml"),
      status: join(root, "status.json"),
      handoff: join(root, "handoff.md"),
      decisions: join(root, "decisions.md"),
      orientation: join(root, "orientation.md"),
    },
  };
}

// Labels for sub-paths inside `.basou/`. Used in pathless error messages so
// the surface area for absolute-path leakage is bounded by this map.
const PATH_LABELS = {
  sessions: ".basou/sessions",
  tasks: ".basou/tasks",
  approvalsPending: ".basou/approvals/pending",
  approvalsResolved: ".basou/approvals/resolved",
  locks: ".basou/locks",
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

  // lstat (not stat) so that a symlink at `.basou` is detected as a symlink
  // and rejected; following the link could place Basou state outside the
  // git repository root, violating the workspace-root invariant.
  let existing: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    existing = await lstat(paths.root);
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
    mkdirLabeled(paths.locks, PATH_LABELS.locks),
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
