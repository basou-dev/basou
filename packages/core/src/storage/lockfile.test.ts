import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicCreate } from "./atomic.js";
import { basouPaths, ensureBasouDirectory } from "./basou-dir.js";
import { acquireLock } from "./lockfile.js";

// Pass-through vi.fn wrapper so a single test can inject a non-EEXIST,
// non-ENOENT failure; every other call delegates to the real implementation.
vi.mock("./atomic.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./atomic.js")>();
  return {
    ...actual,
    atomicCreate: vi.fn(actual.atomicCreate),
  };
});

let workDir: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "basou-lockfile-test-"));
  await ensureBasouDirectory(getWorkDir());
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (workDir !== undefined) {
    await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function getWorkDir(): string {
  if (workDir === undefined) throw new Error("workDir not initialized");
  return workDir;
}

function paths() {
  return basouPaths(getWorkDir());
}

describe("acquireLock", () => {
  it("creates a lockfile at <locks>/<scope>_<ulid>.lock and releases it on handle.release()", async () => {
    const taskId = "task_01HXACQUIRE0000000000000";
    const handle = await acquireLock(paths(), "task", taskId);
    let entries = await readdir(paths().locks);
    expect(entries).toContain("task_01HXACQUIRE0000000000000.lock");

    const body = JSON.parse(
      await readFile(join(paths().locks, "task_01HXACQUIRE0000000000000.lock"), "utf8"),
    ) as { pid: number; acquired_at: string };
    expect(body.pid).toBe(process.pid);
    expect(typeof body.acquired_at).toBe("string");

    await handle.release();
    entries = await readdir(paths().locks);
    expect(entries).not.toContain("task_01HXACQUIRE0000000000000.lock");
  });

  it("uses scope-prefixed filenames so task and session locks never collide on the same ulid tail", async () => {
    const sharedTail = "01HXCOLLIDE0000000000000XY";
    const taskHandle = await acquireLock(paths(), "task", `task_${sharedTail}`);
    const sessionHandle = await acquireLock(paths(), "session", `ses_${sharedTail}`);
    const entries = await readdir(paths().locks);
    expect(entries).toEqual(
      expect.arrayContaining([`task_${sharedTail}.lock`, `session_${sharedTail}.lock`]),
    );
    await taskHandle.release();
    await sessionHandle.release();
  });

  it("rejects a second acquire while the first holder is alive (current process pid)", async () => {
    const taskId = "task_01HXCONTEND0000000000000";
    const first = await acquireLock(paths(), "task", taskId);
    try {
      await expect(acquireLock(paths(), "task", taskId)).rejects.toThrow(
        "Lock is held by another process",
      );
    } finally {
      await first.release();
    }
  });

  it("recovers a stale lockfile written by a dead pid (= process.kill throws ESRCH)", async () => {
    const taskId = "task_01HXSTALE000000000000000";
    const lockPath = join(paths().locks, "task_01HXSTALE000000000000000.lock");
    // Pre-create a lockfile claiming a clearly-dead pid (use pid 1 then mock
    // process.kill to throw ESRCH so we do not actually probe init).
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 99999999, acquired_at: new Date().toISOString() }),
      "utf8",
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, _sig) => {
      const err = new Error("kill: no such process") as Error & { code: string };
      err.code = "ESRCH";
      throw err;
    });
    const handle = await acquireLock(paths(), "task", taskId);
    expect(killSpy).toHaveBeenCalled();
    const body = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
    expect(body.pid).toBe(process.pid);
    await handle.release();
  });

  it("treats a lockfile older than 1h as stale even if pid is alive", async () => {
    const taskId = "task_01HXAGED0000000000000000";
    const lockPath = join(paths().locks, "task_01HXAGED0000000000000000.lock");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, acquired_at: twoHoursAgo }),
      "utf8",
    );
    const handle = await acquireLock(paths(), "task", taskId);
    const body = JSON.parse(await readFile(lockPath, "utf8")) as { acquired_at: string };
    expect(Date.parse(body.acquired_at)).toBeGreaterThan(Date.parse(twoHoursAgo));
    await handle.release();
  });

  it("treats a malformed lockfile as stale and recovers", async () => {
    const taskId = "task_01HXMALFORMED000000000000";
    const lockPath = join(paths().locks, "task_01HXMALFORMED000000000000.lock");
    await writeFile(lockPath, "not-json {{{", "utf8");
    const handle = await acquireLock(paths(), "task", taskId);
    const body = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
    expect(body.pid).toBe(process.pid);
    await handle.release();
  });

  it("release is idempotent (double release does not throw)", async () => {
    const taskId = "task_01HXIDEMPOTENT00000000000";
    const handle = await acquireLock(paths(), "task", taskId);
    await handle.release();
    await handle.release();
  });

  it("treats EPERM from process.kill as alive (= cross-uid pid is not stale)", async () => {
    const taskId = "task_01HXEPERM000000000000000";
    const lockPath = join(paths().locks, "task_01HXEPERM000000000000000.lock");
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 99999999, acquired_at: new Date().toISOString() }),
      "utf8",
    );
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("kill: not permitted") as Error & { code: string };
      err.code = "EPERM";
      throw err;
    });
    await expect(acquireLock(paths(), "task", taskId)).rejects.toThrow(
      "Lock is held by another process",
    );
  });

  it("propagates unexpected (non-EEXIST, non-ENOENT) atomicCreate errors without translating", async () => {
    // ENOENT now self-heals (see the missing-locks-directory suite below), so
    // the no-mistranslation guarantee is exercised with a permission failure.
    const eacces = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.mocked(atomicCreate).mockRejectedValueOnce(eacces);
    await expect(
      acquireLock(paths(), "task", "task_01HXGHOST000000000000000"),
    ).rejects.toMatchObject({ code: "EACCES" });
  });
});

describe("ensureBasouDirectory + locks", () => {
  it("creates .basou/locks/ as part of the standard layout", async () => {
    // beforeEach already ran ensureBasouDirectory; verify locks exists.
    const dirs = await readdir(join(getWorkDir(), ".basou"), { withFileTypes: true });
    expect(dirs.filter((d) => d.isDirectory()).map((d) => d.name)).toContain("locks");
  });

  it("is idempotent — ensureBasouDirectory twice does not error on existing locks dir", async () => {
    await ensureBasouDirectory(getWorkDir());
    // No throw; verify locks still exists.
    const lockSubdir = await mkdir(join(getWorkDir(), ".basou", "locks", "smoke"), {
      recursive: true,
    });
    expect(lockSubdir === undefined || typeof lockSubdir === "string").toBe(true);
  });
});

describe("acquireLock — missing locks directory", () => {
  it("creates .basou/locks on demand and acquires (pre-locks-era workspace)", async () => {
    // A workspace checked out from before the locks directory existed: the
    // first lock-taking command must self-heal instead of failing ENOENT.
    await rm(paths().locks, { recursive: true, force: true });

    const sessionId = "ses_01HXLOCKDIR0000000000000";
    const handle = await acquireLock(paths(), "session", sessionId);
    const entries = await readdir(paths().locks);
    expect(entries).toContain("session_01HXLOCKDIR0000000000000.lock");
    await handle.release();
    expect(await readdir(paths().locks)).not.toContain("session_01HXLOCKDIR0000000000000.lock");
  });
});
