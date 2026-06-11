import { mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findErrorCode } from "../lib/error-codes.js";
import { atomicCreate } from "./atomic.js";
import type { BasouPaths } from "./basou-dir.js";

/**
 * The two lock scopes basou uses. `task` guards the read-modify-write window
 * around a single `task.md`; `session` guards the events.jsonl append plus
 * surrounding `session.yaml` mutation for a single session. Two scopes use
 * different lockfile names so they never collide on disk.
 */
export type LockScope = "task" | "session";

/**
 * Any lock older than this is treated as stale and force-released even if the
 * holding pid is still alive. basou CLI invocations hold a lock for ms to a
 * few seconds at most, so an hour is a 10000x safety margin; the upper bound
 * is also our defence against pid reuse (a different process happening to
 * receive a long-dead pid).
 */
const STALE_LOCK_MAX_AGE_MS = 60 * 60 * 1000;

type LockFileBody = {
  pid: number;
  acquired_at: string;
};

export type LockHandle = {
  /**
   * Release the lock by unlinking the lockfile. Best-effort: any unlink error
   * is swallowed so a doubled release does not raise, and disk state never
   * holds a stranded lockfile after the caller's `finally` block.
   */
  release: () => Promise<void>;
};

/**
 * Acquire an advisory lock at `<paths.locks>/<scope>_<id>.lock` for the
 * lifetime of the returned handle. Lockfile body records the holder's pid
 * and acquire timestamp so a competitor can detect stale locks left by a
 * SIGINT'd CLI run and recover automatically.
 *
 * Acquisition strategy:
 *   1. {@link atomicCreate} the lockfile (POSIX link(2) + EEXIST).
 *      On ENOENT (a workspace from before `.basou/locks/` existed), create
 *      the directory and retry once; a retry failure throws the pathless
 *      `"Failed to acquire lock"`.
 *   2. On EEXIST, probe the existing lockfile via {@link isStaleLock}.
 *      - If stale (= holder pid is dead or lock is older than
 *        {@link STALE_LOCK_MAX_AGE_MS}), `unlink` the stale file and retry
 *        the atomic create once.
 *      - If still EEXIST after the retry (= another competitor won the race),
 *        throw `"Lock is held by another process"`.
 *      - If the holder is alive, throw `"Lock is held by another process"`
 *        without retrying.
 *
 * The caller MUST call `release()` (typically from a `finally` block); the
 * `process.exit()` path or a fatal crash relies on stale-lock detection on
 * the next acquire to recover.
 */
export async function acquireLock(
  paths: BasouPaths,
  scope: LockScope,
  resourceId: string,
): Promise<LockHandle> {
  const lockPath = lockfilePath(paths, scope, resourceId);
  const body: LockFileBody = {
    pid: process.pid,
    acquired_at: new Date().toISOString(),
  };
  const serialised = JSON.stringify(body);

  try {
    await atomicCreate(lockPath, serialised);
  } catch (error: unknown) {
    // A workspace checked out (or created) before the locks directory
    // existed lacks `.basou/locks/`; create it and retry once rather than
    // failing every lock-taking command on such a workspace.
    if (findErrorCode(error, "ENOENT")) {
      try {
        await mkdir(dirname(lockPath), { recursive: true });
        await atomicCreate(lockPath, serialised);
        return {
          release: async () => {
            await unlink(lockPath).catch(() => undefined);
          },
        };
      } catch (retryError: unknown) {
        throw new Error("Failed to acquire lock", { cause: retryError });
      }
    }
    if (!findErrorCode(error, "EEXIST")) {
      throw error;
    }
    const stale = await isStaleLock(lockPath);
    if (!stale) {
      throw new Error("Lock is held by another process", { cause: error });
    }
    // Best-effort cleanup of the stale lockfile, then a single retry. A
    // second EEXIST means another competitor beat us to the cleared lock;
    // surface that as a normal "held" failure rather than looping.
    await unlink(lockPath).catch(() => undefined);
    try {
      await atomicCreate(lockPath, serialised);
    } catch (retryError: unknown) {
      throw new Error("Lock is held by another process", { cause: retryError });
    }
  }

  return {
    release: async () => {
      await unlink(lockPath).catch(() => undefined);
    },
  };
}

/**
 * Read the lockfile at `lockPath` and decide whether the holder is dead or
 * the lock is too old to trust. Used by {@link acquireLock} on EEXIST to
 * recover from SIGINT'd CLI runs that left the lockfile behind.
 *
 * Stale predicates (any of these = stale):
 *   - lockfile body unreadable or malformed
 *   - `acquired_at` is older than {@link STALE_LOCK_MAX_AGE_MS}
 *   - `process.kill(pid, 0)` throws ESRCH (holder pid is dead)
 *
 * EPERM from `process.kill` means the pid is alive but owned by a different
 * uid; we treat that as alive so cross-user lockfile takeover does not happen
 * by accident.
 */
async function isStaleLock(lockPath: string): Promise<boolean> {
  let body: LockFileBody;
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return true;
    const candidate = parsed as Partial<LockFileBody>;
    if (typeof candidate.pid !== "number" || typeof candidate.acquired_at !== "string") {
      return true;
    }
    body = { pid: candidate.pid, acquired_at: candidate.acquired_at };
  } catch {
    // Unreadable lockfile (e.g. truncated mid-write) counts as stale so we
    // can recover instead of looping forever on EEXIST.
    return true;
  }
  const ageMs = Date.now() - Date.parse(body.acquired_at);
  if (!Number.isFinite(ageMs) || ageMs > STALE_LOCK_MAX_AGE_MS) {
    return true;
  }
  try {
    process.kill(body.pid, 0);
    return false;
  } catch (error: unknown) {
    if (findErrorCode(error, "ESRCH")) return true;
    // EPERM or any other surface — pid is alive (or unknown), keep the lock.
    return false;
  }
}

function lockfilePath(paths: BasouPaths, scope: LockScope, resourceId: string): string {
  // Strip the type prefix to keep the lockfile name compact (`task_01HX...` →
  // `01HX...`, `ses_01HX...` → `01HX...`). The scope literal at the start of
  // the filename keeps task/session lockfiles disjoint even when the ULID
  // tails happen to coincide.
  const sep = resourceId.indexOf("_");
  const ulid = sep >= 0 ? resourceId.slice(sep + 1) : resourceId;
  return join(paths.locks, `${scope}_${ulid}.lock`);
}
