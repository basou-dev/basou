import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { collectTaskReferences } from "../decision-gaps/decision-gaps.js";
import type { PrefixedId } from "../ids/ulid.js";
import { resolveTaskId } from "../lib/id-resolver.js";
import type { Manifest } from "../schemas/manifest.schema.js";
import { type BasouPaths, basouPaths, ensureBasouDirectory } from "./basou-dir.js";
import { assertStoreDirectorySafe } from "./store-dir.js";
import {
  archiveTask,
  assertTaskStoreSafe,
  createTaskWithEvent,
  deleteTask,
  editTask,
  enumerateArchivedTaskIds,
  enumerateTaskIds,
  loadTaskEntries,
  readTaskFile,
  readTaskFileWithArchiveFallback,
  reconcileAllTasks,
  reconcileTask,
  refreshTaskLinkedSessions,
  type TaskDocument,
  updateTaskStatusWithEvent,
  writeTaskFile,
} from "./tasks.js";

const WS_ID = "ws_01HXABCDEF1234567890ABCWS1" as const;
// Crockford base32 suffixes (no I/L/O/U), so every id is a valid task id.
const TASK = (suffix: string): PrefixedId<"task"> =>
  `task_01HXABCDEF1234567890ABC${suffix}` as PrefixedId<"task">;
const LIVE = TASK("TK1");
const ARCHIVED = TASK("TK2");
const NEW = TASK("TK3");
// Running sessions, so the attach forms of task creation (into a session with
// no task) and of a status change (in the session that carries the task) run.
const RUNNING = "ses_01HXABCDEF1234567890ABCRN1" as PrefixedId<"ses">;
const RUNNING_LIVE = "ses_01HXABCDEF1234567890ABCRN2" as PrefixedId<"ses">;
const AT = "2026-05-08T12:00:00+09:00";
const CWD = "/srv/example-project";

const IS_SYMLINK = (label: string): string => `${label} is a symlink; refusing to operate`;
const IS_FILE = (label: string): string => `${label} exists but is not a directory`;

let workDir: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "basou-store-dir-test-"));
});

afterEach(async () => {
  if (workDir !== undefined) {
    await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function getWorkDir(): string {
  if (workDir === undefined) throw new Error("workDir not initialized");
  return workDir;
}

function makeManifest(): Manifest {
  return {
    schema_version: "0.1.0",
    basou_version: "0.1.0",
    workspace: {
      id: WS_ID,
      name: "test-workspace",
      created_at: "2026-05-01T00:00:00+09:00",
      updated_at: "2026-05-01T00:00:00+09:00",
    },
    project: {},
    capabilities: { enabled: [] },
    approval: { default_risk_level: "low" },
    adapters: { "claude-code": { enabled: false } },
    git: { events_log: "ignore" },
  };
}

/** Every file under `dir`, with its bytes, so a test can prove nothing changed. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await readdir(dir, { recursive: true })).sort()) {
    try {
      out[name] = await readFile(join(dir, name), "utf8");
    } catch {
      out[name] = "<dir>";
    }
  }
  return out;
}

async function createTask(paths: BasouPaths, taskId: PrefixedId<"task">): Promise<void> {
  await createTaskWithEvent({
    mode: "ad-hoc",
    paths,
    manifest: makeManifest(),
    occurredAt: AT,
    taskId,
    title: `task ${taskId.slice(-3)}`,
    initialStatus: "planned",
    description: "",
    workingDirectory: CWD,
  });
}

let seeded: TaskDocument | undefined;

function seededDocument(): TaskDocument {
  if (seeded === undefined) throw new Error("no task seeded");
  return seeded;
}

/** A running session holding one unchained `session_started` line. */
async function writeRunningSession(
  paths: BasouPaths,
  id: PrefixedId<"ses">,
  taskId: PrefixedId<"task"> | null,
): Promise<void> {
  const dir = join(paths.sessions, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "session.yaml"),
    stringify({
      schema_version: "0.1.0",
      session: {
        id,
        label: "running fixture",
        task_id: taskId,
        workspace_id: WS_ID,
        source: { kind: "terminal", version: "0.1.0" },
        started_at: "2026-05-08T11:00:00+09:00",
        status: "running",
        working_directory: CWD,
        invocation: { command: "echo", args: [], exit_code: null },
        related_files: [],
        events_log: "events.jsonl",
      },
    }),
  );
  await writeFile(
    join(dir, "events.jsonl"),
    `${JSON.stringify({
      schema_version: "0.1.0",
      type: "session_started",
      id: "evt_01HXABCDEF1234567890ABCEV1",
      session_id: id,
      occurred_at: "2026-05-08T11:00:00+09:00",
      source: "terminal",
    })}\n`,
  );
}

/** A workspace holding one live task, one archived task and a running session. */
async function seedTasks(): Promise<BasouPaths> {
  const paths = await ensureBasouDirectory(getWorkDir());
  await writeRunningSession(paths, RUNNING, null);
  await writeRunningSession(paths, RUNNING_LIVE, LIVE);
  await createTask(paths, LIVE);
  seeded = await readTaskFile(paths, LIVE);
  await createTask(paths, ARCHIVED);
  await archiveTask({
    paths,
    manifest: makeManifest(),
    taskId: ARCHIVED,
    occurredAt: AT,
    workingDirectory: CWD,
  });
  return paths;
}

/**
 * Every exported operation on the task store, each in a form that succeeds on
 * the seeded workspace. Run against an unsafe store, every one must refuse.
 */
function taskOperations(paths: BasouPaths): Array<[string, () => Promise<unknown>]> {
  const manifest = makeManifest();
  return [
    ["readTaskFile", () => readTaskFile(paths, LIVE)],
    ["readTaskFileWithArchiveFallback", () => readTaskFileWithArchiveFallback(paths, ARCHIVED)],
    ["enumerateTaskIds", () => enumerateTaskIds(paths)],
    ["enumerateArchivedTaskIds", () => enumerateArchivedTaskIds(paths)],
    ["loadTaskEntries", () => loadTaskEntries(paths)],
    ["resolveTaskId", () => resolveTaskId(paths, LIVE, { includeArchived: true })],
    ["collectTaskReferences", () => collectTaskReferences(paths)],
    [
      "writeTaskFile",
      // The document is read while seeding, so nothing guarded runs first.
      () => writeTaskFile(paths, NEW, seededDocument(), { mode: "create" }),
    ],
    ["createTaskWithEvent", () => createTask(paths, NEW)],
    [
      "createTaskWithEvent (attach)",
      () =>
        createTaskWithEvent({
          mode: "attach",
          paths,
          occurredAt: AT,
          sessionId: RUNNING,
          taskId: NEW,
          title: "attached",
          initialStatus: "planned",
          description: "",
        }),
    ],
    [
      "updateTaskStatusWithEvent",
      () =>
        updateTaskStatusWithEvent({
          mode: "ad-hoc",
          paths,
          manifest,
          occurredAt: AT,
          taskId: LIVE,
          newStatus: "in_progress",
          workingDirectory: CWD,
        }),
    ],
    [
      "updateTaskStatusWithEvent (attach)",
      () =>
        updateTaskStatusWithEvent({
          mode: "attach",
          paths,
          occurredAt: AT,
          sessionId: RUNNING_LIVE,
          taskId: LIVE,
          newStatus: "in_progress",
        }),
    ],
    ["editTask", () => editTask({ paths, taskId: LIVE, title: "renamed", occurredAt: AT })],
    [
      "reconcileTask",
      () =>
        reconcileTask(paths, manifest, {
          taskId: LIVE,
          occurredAt: AT,
          workingDirectory: CWD,
          write: true,
        }),
    ],
    [
      "reconcileAllTasks",
      () =>
        reconcileAllTasks(paths, manifest, {
          occurredAt: () => AT,
          workingDirectory: CWD,
          write: true,
        }),
    ],
    [
      "refreshTaskLinkedSessions",
      () =>
        refreshTaskLinkedSessions(paths, manifest, {
          taskId: LIVE,
          occurredAt: AT,
          workingDirectory: CWD,
          write: true,
        }),
    ],
    [
      "archiveTask",
      () => archiveTask({ paths, manifest, taskId: LIVE, occurredAt: AT, workingDirectory: CWD }),
    ],
    [
      "deleteTask",
      () => deleteTask({ paths, manifest, taskId: LIVE, occurredAt: AT, workingDirectory: CWD }),
    ],
  ];
}

describe("assertStoreDirectorySafe", () => {
  it("passes a directory and an absent path", async () => {
    await expect(assertStoreDirectorySafe(getWorkDir(), ".basou/x")).resolves.toBeUndefined();
    await expect(
      assertStoreDirectorySafe(join(getWorkDir(), "absent"), ".basou/x"),
    ).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symlink, to a directory or dangling, naming only the label",
    async () => {
      const target = join(getWorkDir(), "target");
      await mkdir(target);
      await symlink(target, join(getWorkDir(), "to-dir"));
      await symlink(join(getWorkDir(), "nowhere"), join(getWorkDir(), "dangling"));
      for (const name of ["to-dir", "dangling"]) {
        const refusal = assertStoreDirectorySafe(join(getWorkDir(), name), ".basou/x");
        await expect(refusal).rejects.toThrow(new Error(IS_SYMLINK(".basou/x")));
      }
    },
  );

  it("refuses a file", async () => {
    await writeFile(join(getWorkDir(), "file"), "");
    await expect(assertStoreDirectorySafe(join(getWorkDir(), "file"), ".basou/x")).rejects.toThrow(
      new Error(IS_FILE(".basou/x")),
    );
  });

  it("reports any other lstat failure as a failure to inspect, with the cause", async () => {
    await writeFile(join(getWorkDir(), "file"), "");
    const error = await assertStoreDirectorySafe(
      join(getWorkDir(), "file", "child"),
      ".basou/x",
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Failed to inspect .basou/x");
    expect(((error as Error).cause as { code?: string }).code).toBe("ENOTDIR");
  });
});

describe("assertTaskStoreSafe", () => {
  it("passes when the task store is absent or holds directories", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    await expect(assertTaskStoreSafe(paths)).resolves.toBeUndefined();
    await mkdir(join(paths.tasks, "archive"));
    await expect(assertTaskStoreSafe(paths)).resolves.toBeUndefined();
    await rm(paths.tasks, { recursive: true });
    await expect(assertTaskStoreSafe(paths)).resolves.toBeUndefined();
  });

  it("refuses a .basou/tasks or a .basou/tasks/archive that is a file", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    await writeFile(join(paths.tasks, "archive"), "");
    await expect(assertTaskStoreSafe(paths)).rejects.toThrow(IS_FILE(".basou/tasks/archive"));
    await rm(paths.tasks, { recursive: true });
    await writeFile(paths.tasks, "");
    await expect(assertTaskStoreSafe(paths)).rejects.toThrow(IS_FILE(".basou/tasks"));
  });
});

/** The operation names, read without running anything (the closures are not called). */
const TASK_OPERATION_NAMES = taskOperations(basouPaths("/unused")).map(([name]) => name);

/** Run operation `name` against a freshly seeded workspace, after `mutate`. */
async function runOnFreshSeed(
  name: string,
  mutate: (paths: BasouPaths) => Promise<void>,
): Promise<{ paths: BasouPaths; result: Promise<unknown> }> {
  await rm(getWorkDir(), { recursive: true, force: true });
  await mkdir(getWorkDir());
  const paths = await seedTasks();
  await mutate(paths);
  const op = taskOperations(paths).find(([n]) => n === name);
  if (op === undefined) throw new Error(`no operation ${name}`);
  return { paths, result: op[1]() };
}

// POSIX only: creating a symlink needs privileges on Windows.
describe.skipIf(process.platform === "win32")("an unsafe task store", () => {
  it("control: every operation succeeds on the seeded workspace", async () => {
    for (const name of TASK_OPERATION_NAMES) {
      const { result } = await runOnFreshSeed(name, async () => {});
      await expect(
        result.then(() => "ok"),
        name,
      ).resolves.toBe("ok");
    }
  });

  for (const relative of ["tasks", "tasks/archive"] as const) {
    const label = `.basou/${relative}`;
    const outside = (): string => join(getWorkDir(), "outside");

    it(`${label} that is a symlink: every operation refuses and nothing is written`, async () => {
      for (const name of TASK_OPERATION_NAMES) {
        let outsideBefore: Record<string, string> = {};
        let sessionsBefore: Record<string, string> = {};
        const { paths, result } = await runOnFreshSeed(name, async (paths) => {
          // Move the directory out of the store and link it back in, so an
          // operation that followed the link would find what it looks for.
          const inside = join(paths.root, relative);
          await rename(inside, outside());
          await symlink(outside(), inside);
          outsideBefore = await snapshot(outside());
          sessionsBefore = await snapshot(paths.sessions);
        });
        await expect(result, name).rejects.toThrow(new Error(IS_SYMLINK(label)));
        expect(await snapshot(outside()), name).toEqual(outsideBefore);
        // No event was written before the refusal: no ad-hoc session appeared.
        expect(await snapshot(paths.sessions), name).toEqual(sessionsBefore);
      }
    });

    it(`${label} that is a file: every operation refuses and nothing is written`, async () => {
      for (const name of TASK_OPERATION_NAMES) {
        let sessionsBefore: Record<string, string> = {};
        const { paths, result } = await runOnFreshSeed(name, async (paths) => {
          const inside = join(paths.root, relative);
          await rm(inside, { recursive: true });
          await writeFile(inside, "");
          sessionsBefore = await snapshot(paths.sessions);
        });
        await expect(result, name).rejects.toThrow(new Error(IS_FILE(label)));
        expect(await snapshot(paths.sessions), name).toEqual(sessionsBefore);
      }
    });
  }

  // The operations that take a lock (the task's, or the attached session's)
  // check the store before taking it. Were a lock taken first, a lock held
  // elsewhere would be the error given.
  const LOCKING_OPERATIONS = [
    "createTaskWithEvent (attach)",
    "updateTaskStatusWithEvent",
    "updateTaskStatusWithEvent (attach)",
    "editTask",
    "reconcileTask",
    "refreshTaskLinkedSessions",
    "archiveTask",
    "deleteTask",
  ];
  const HELD_LOCKS = [
    `session_${RUNNING.slice("ses_".length)}.lock`,
    `session_${RUNNING_LIVE.slice("ses_".length)}.lock`,
    `task_${LIVE.slice("task_".length)}.lock`,
  ];

  /** Hold every lock an operation here could take, as a live holder (this process). */
  async function holdLocks(paths: BasouPaths): Promise<void> {
    for (const name of HELD_LOCKS) {
      await writeFile(
        join(paths.locks, name),
        JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }),
      );
    }
  }

  it("refuses before taking a lock: a lock held elsewhere is not the error", async () => {
    for (const name of LOCKING_OPERATIONS) {
      const { paths, result } = await runOnFreshSeed(name, async (paths) => {
        await rm(paths.tasks, { recursive: true });
        await writeFile(paths.tasks, "");
        await holdLocks(paths);
      });
      await expect(result, name).rejects.toThrow(new Error(IS_FILE(".basou/tasks")));
      expect((await readdir(paths.locks)).sort(), name).toEqual(HELD_LOCKS);
    }
  });

  it("control: with the store intact, the held lock is the error", async () => {
    for (const name of LOCKING_OPERATIONS) {
      const { result } = await runOnFreshSeed(name, holdLocks);
      await expect(result, name).rejects.toThrow("Lock is held by another process");
    }
  });
});

describe("an absent task store", () => {
  it("is created by the first task written into it, so no event is left without its task", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    await rm(paths.tasks, { recursive: true });
    await createTask(paths, NEW);
    const doc = await readTaskFile(paths, NEW);
    expect(doc.task.task.id).toBe(NEW);
    await rm(paths.tasks, { recursive: true });
    await writeTaskFile(paths, NEW, doc, { mode: "create" });
    expect(await readdir(paths.tasks)).toEqual([`${NEW}.md`]);
  });
});

// POSIX only, and not as root, who is never denied the mkdir.
describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a task store that cannot be created",
  () => {
    it("stops task creation before its event is recorded", async () => {
      const paths = await ensureBasouDirectory(getWorkDir());
      await rm(paths.tasks, { recursive: true });
      await writeRunningSession(paths, RUNNING, null);
      const sessionsBefore = await snapshot(paths.sessions);
      await chmod(paths.root, 0o555);
      try {
        await expect(createTask(paths, NEW)).rejects.toThrow("Failed to create .basou/tasks");
        await expect(
          createTaskWithEvent({
            mode: "attach",
            paths,
            occurredAt: AT,
            sessionId: RUNNING,
            taskId: NEW,
            title: "attached",
            initialStatus: "planned",
            description: "",
          }),
        ).rejects.toThrow("Failed to create .basou/tasks");
      } finally {
        await chmod(paths.root, 0o755);
      }
      expect(await snapshot(paths.sessions)).toEqual(sessionsBefore);
    });
  },
);
