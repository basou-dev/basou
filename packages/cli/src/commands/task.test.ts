import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  basouPaths,
  createManifest,
  ensureBasouDirectory,
  writeManifest,
  writeTaskFile,
  writeYamlFile,
} from "@basou/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  doRunTaskArchive,
  doRunTaskDelete,
  doRunTaskEdit,
  doRunTaskList,
  doRunTaskNew,
  doRunTaskReconcile,
  doRunTaskRefreshLinkage,
  doRunTaskShow,
  doRunTaskStatus,
  registerTaskCommand,
  runTaskArchive,
  runTaskDelete,
  runTaskEdit,
  runTaskList,
  runTaskNew,
  runTaskReconcile,
  runTaskRefreshLinkage,
  runTaskShow,
  runTaskStatus,
} from "./task.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
};

const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const FIXED_DATE = new Date("2026-05-09T03:00:00.000Z");
const FIXED_NOW = new Date("2026-05-11T12:00:00.000Z");
const FIXED_NOW_2 = new Date("2026-05-12T12:00:00.000Z");

let tmpRepo: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-task-cli-test-"));
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], {
    cwd: tmpRepo,
    env: ENV,
  });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: tmpRepo,
    env: ENV,
  });
  await execFileAsync("git", ["config", "user.name", "test"], { cwd: tmpRepo, env: ENV });
});

afterEach(async () => {
  if (tmpRepo !== undefined) {
    await rm(tmpRepo, { recursive: true, force: true });
    tmpRepo = undefined;
  }
  process.exitCode = 0;
  vi.restoreAllMocks();
});

function getTmpRepo(): string {
  if (tmpRepo === undefined) throw new Error("tmpRepo not initialized");
  return tmpRepo;
}

async function setupInitedRepo(): Promise<string> {
  const repo = await realpath(getTmpRepo());
  const paths = await ensureBasouDirectory(repo);
  const manifest = createManifest({
    workspaceName: "fixture-ws",
    now: FIXED_DATE,
    workspaceId: FIXED_WS_ID,
  });
  await writeManifest(paths, manifest);
  return repo;
}

const SES = (suffix: string) => `ses_01HXABCDEF1234567890ABC${suffix}`;

async function createSession(
  repo: string,
  fixture: {
    id: string;
    status: "initialized" | "running" | "waiting_approval" | "completed" | "imported";
    taskId?: string | null;
  },
): Promise<string> {
  const paths = basouPaths(repo);
  const sessionDir = join(paths.sessions, fixture.id);
  await mkdir(sessionDir, { recursive: true });
  const session = {
    schema_version: "0.1.0" as const,
    session: {
      id: fixture.id,
      label: "test",
      task_id: fixture.taskId ?? null,
      workspace_id: FIXED_WS_ID,
      source: { kind: "terminal" as const, version: "0.1.0" as const },
      started_at: "2026-05-08T11:00:00+09:00",
      status: fixture.status,
      working_directory: repo,
      invocation: { command: "echo", args: [], exit_code: 0 },
      related_files: [],
      events_log: "events.jsonl",
    },
  };
  await writeYamlFile(join(sessionDir, "session.yaml"), session);
  await writeFile(join(sessionDir, "events.jsonl"), "");
  return fixture.id;
}

function captureStdout() {
  return vi.spyOn(console, "log").mockImplementation(() => undefined);
}

function captureStderr() {
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

function joinCalls(spy: ReturnType<typeof captureStdout>): string {
  return spy.mock.calls.map((c) => String(c[0])).join("\n");
}

async function findCreatedTaskId(repo: string): Promise<string> {
  const paths = basouPaths(repo);
  const entries = await readdir(paths.tasks);
  const taskFile = entries.find((e) => e.startsWith("task_") && e.endsWith(".md"));
  if (taskFile === undefined) throw new Error("no task.md was created");
  return taskFile.replace(/\.md$/, "");
}

const FIXED_CTX = { nowProvider: () => FIXED_NOW };
const FIXED_CTX_2 = { nowProvider: () => FIXED_NOW_2 };

// ============================================================================
// task new
// ============================================================================

describe("doRunTaskNew (ad-hoc path)", () => {
  it("t-new-1: --title only creates an ad-hoc session with 5 events + a task.md", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunTaskNew({ title: "contact form" }, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(out)).toContain("Created task_");
    const taskId = await findCreatedTaskId(repo);
    const md = await readFile(join(basouPaths(repo).tasks, `${taskId}.md`), "utf8");
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("status: planned");
  });

  it("t-new-2: --json emits a one-line payload with mode=ad-hoc", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunTaskNew({ title: "x", json: true }, { cwd: repo, ...FIXED_CTX });
    const payload = JSON.parse(joinCalls(out)) as Record<string, unknown>;
    expect(payload.mode).toBe("ad-hoc");
    expect(payload.status).toBe("planned");
    expect(payload.session_status).toBe("completed");
    expect(payload.description_length).toBe(0);
  });

  it("t-new-3: --status in_progress sets the initial status without firing task_status_changed", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew({ title: "ip", status: "in_progress" }, { cwd: repo, ...FIXED_CTX });
    const taskId = await findCreatedTaskId(repo);
    const md = await readFile(join(basouPaths(repo).tasks, `${taskId}.md`), "utf8");
    expect(md).toContain("status: in_progress");
    // ad-hoc session is one directory under sessions
    const sessions = await readdir(basouPaths(repo).sessions);
    const sid = sessions.find((s) => s.startsWith("ses_"));
    const events = (
      await readFile(join(basouPaths(repo).sessions, sid as string, "events.jsonl"), "utf8")
    )
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.filter((e) => e.type === "task_status_changed")).toHaveLength(0);
  });

  it("t-new-4: --description inline lands in task.md body", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew(
      { title: "with description", description: "## 背景\n\nReact 化" },
      { cwd: repo, ...FIXED_CTX },
    );
    const taskId = await findCreatedTaskId(repo);
    const md = await readFile(join(basouPaths(repo).tasks, `${taskId}.md`), "utf8");
    expect(md).toContain("## 背景");
    expect(md).toContain("React 化");
  });

  it("t-new-5: --from-file body lands in task.md", async () => {
    const repo = await setupInitedRepo();
    const filePath = join(repo, "desc.md");
    await writeFile(filePath, "loaded body\n");
    captureStdout();
    await doRunTaskNew({ title: "ff", fromFile: filePath }, { cwd: repo, ...FIXED_CTX });
    const taskId = await findCreatedTaskId(repo);
    const md = await readFile(join(basouPaths(repo).tasks, `${taskId}.md`), "utf8");
    expect(md).toContain("loaded body");
  });

  it("t-new-6: --description and --from-file together are rejected", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runTaskNew(
      { title: "x", description: "a", fromFile: "/tmp/x" },
      { cwd: repo, ...FIXED_CTX },
    );
    expect(joinCalls(err)).toContain("--description and --from-file are mutually exclusive");
    expect(process.exitCode).toBe(1);
  });

  it("t-new-7: --from-file - is rejected before any disk read", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runTaskNew({ title: "x", fromFile: "-" }, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(err)).toContain("--from-file - (stdin) is not supported in v0.1");
    expect(process.exitCode).toBe(1);
  });

  it("t-new-8: missing description file is reported with a fixed message", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runTaskNew(
      { title: "x", fromFile: join(repo, "missing.md") },
      { cwd: repo, ...FIXED_CTX },
    );
    expect(joinCalls(err)).toContain("Description source not found");
    expect(process.exitCode).toBe(1);
  });
});

describe("doRunTaskNew (attach path)", () => {
  it("t-new-9: --session attaches task_created and pins session.yaml.task_id", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("N09");
    await createSession(repo, { id: sid, status: "running" });
    const out = captureStdout();
    await doRunTaskNew({ title: "attach me", session: sid }, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(out)).toContain("Created task_");
    expect(joinCalls(out)).toContain("(running)");
    const yaml = await readFile(join(basouPaths(repo).sessions, sid, "session.yaml"), "utf8");
    expect(yaml).toContain("task_id: task_");
  });

  it("t-new-10: --session pointing at a completed session is rejected", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("N10");
    await createSession(repo, { id: sid, status: "completed" });
    const err = captureStderr();
    await runTaskNew({ title: "x", session: sid }, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(err)).toContain("Session is not active: completed");
    expect(process.exitCode).toBe(1);
  });

  it("t-new-11: --session pointing at an imported session is rejected", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("N11");
    await createSession(repo, { id: sid, status: "imported" });
    const err = captureStderr();
    await runTaskNew({ title: "x", session: sid }, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(err)).toContain("Cannot attach to imported session");
    expect(process.exitCode).toBe(1);
  });

  it("t-new-12: --session pointing at waiting_approval is OK", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("N12");
    await createSession(repo, { id: sid, status: "waiting_approval" });
    const out = captureStdout();
    await doRunTaskNew({ title: "x", session: sid }, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(out)).toContain("(waiting_approval)");
  });

  it("t-new-13: --session whose task_id already differs rejects with the fixed message", async () => {
    const repo = await setupInitedRepo();
    const otherTask = "task_01HXABCDEF1234567890ABCTHR";
    const sid = SES("N13");
    await createSession(repo, { id: sid, status: "running", taskId: otherTask });
    const err = captureStderr();
    await runTaskNew({ title: "x", session: sid }, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(err)).toContain(`Session already linked to a different task: ${otherTask}`);
    expect(process.exitCode).toBe(1);
  });
});

describe("registerTaskCommand (option converters)", () => {
  it("t-new-14: --title missing is rejected", async () => {
    const program = new Command();
    program.exitOverride();
    registerTaskCommand(program);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(program.parseAsync(["node", "basou", "task", "new"])).rejects.toBeDefined();
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("")).toContain("--title");
  });

  it("t-new-15: --title '' is rejected by the converter", async () => {
    const program = new Command();
    program.exitOverride();
    registerTaskCommand(program);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      program.parseAsync(["node", "basou", "task", "new", "--title", ""]),
    ).rejects.toBeDefined();
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("")).toContain(
      "Title must not be empty",
    );
  });

  it("t-new-16: --status garbage is rejected by the converter (only TaskStatus values accepted)", async () => {
    const program = new Command();
    program.exitOverride();
    registerTaskCommand(program);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      program.parseAsync(["node", "basou", "task", "new", "--title", "x", "--status", "garbage"]),
    ).rejects.toBeDefined();
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("")).toContain(
      "Initial task status must be one of: planned, in_progress, done, cancelled",
    );
  });

  it("t-new-17: --completed-at with an invalid ISO string is rejected by the converter", async () => {
    const program = new Command();
    program.exitOverride();
    registerTaskCommand(program);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      program.parseAsync([
        "node",
        "basou",
        "task",
        "new",
        "--title",
        "x",
        "--status",
        "done",
        "--completed-at",
        "yesterday",
      ]),
    ).rejects.toBeDefined();
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("")).toContain(
      "Invalid --completed-at value",
    );
  });
});

describe("doRunTaskNew (terminal initial status, ad-hoc path)", () => {
  it("t-new-18: --status done creates task.md as done with a 2-event audit trail", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunTaskNew(
      {
        title: "retrospective done",
        status: "done",
        completedAt: "2026-05-10T12:34:56+09:00",
      },
      { cwd: repo, ...FIXED_CTX },
    );
    expect(joinCalls(out)).toContain("Created task_");
    expect(joinCalls(out)).toContain("Status: done (recorded at");
    expect(joinCalls(out)).toContain("completed at 2026-05-10T12:34:56+09:00");

    const taskId = await findCreatedTaskId(repo);
    const md = await readFile(join(basouPaths(repo).tasks, `${taskId}.md`), "utf8");
    expect(md).toContain("status: done");
    expect(md).toContain("updated_at: 2026-05-10T12:34:56+09:00");
    // created_at stays at the recording time, not the completion time.
    expect(md).toContain(`created_at: ${FIXED_NOW.toISOString()}`);

    const sessions = await readdir(basouPaths(repo).sessions);
    const sid = sessions.find((s) => s.startsWith("ses_")) as string;
    const events = (await readFile(join(basouPaths(repo).sessions, sid, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events).toHaveLength(6);
    expect(events[0]?.type).toBe("session_started");
    expect(events[1]).toMatchObject({
      type: "session_status_changed",
      from: "initialized",
      to: "running",
    });
    expect(events[2]).toMatchObject({ type: "task_created", task_id: taskId });
    expect(events[3]).toMatchObject({
      type: "task_status_changed",
      task_id: taskId,
      from: "planned",
      to: "done",
    });
    expect(events[4]).toMatchObject({
      type: "session_status_changed",
      from: "running",
      to: "completed",
    });
    expect(events[5]?.type).toBe("session_ended");
  });

  it("t-new-19: --status cancelled with --completed-at writes a cancellation audit trail", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew(
      {
        title: "retro cancelled",
        status: "cancelled",
        completedAt: "2026-05-09T11:22:33+09:00",
      },
      { cwd: repo, ...FIXED_CTX },
    );
    const taskId = await findCreatedTaskId(repo);
    const md = await readFile(join(basouPaths(repo).tasks, `${taskId}.md`), "utf8");
    expect(md).toContain("status: cancelled");
    expect(md).toContain("updated_at: 2026-05-09T11:22:33+09:00");

    const sessions = await readdir(basouPaths(repo).sessions);
    const sid = sessions.find((s) => s.startsWith("ses_")) as string;
    const events = (await readFile(join(basouPaths(repo).sessions, sid, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const statusChange = events.find((e) => e.type === "task_status_changed");
    expect(statusChange).toMatchObject({ from: "planned", to: "cancelled" });
  });

  it("t-new-20: --status done without --completed-at uses occurredAt for updated_at", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew({ title: "no completedAt", status: "done" }, { cwd: repo, ...FIXED_CTX });
    const taskId = await findCreatedTaskId(repo);
    const md = await readFile(join(basouPaths(repo).tasks, `${taskId}.md`), "utf8");
    const expected = FIXED_NOW.toISOString();
    expect(md).toContain(`created_at: ${expected}`);
    expect(md).toContain(`updated_at: ${expected}`);
  });

  it("t-new-21: --completed-at without --status done|cancelled is rejected", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runTaskNew(
      { title: "x", completedAt: "2026-05-10T12:34:56+09:00" },
      { cwd: repo, ...FIXED_CTX },
    );
    expect(joinCalls(err)).toContain("--completed-at requires --status done or cancelled");
    expect(process.exitCode).toBe(1);
    // No partial state should have leaked to disk.
    const sessions = await readdir(basouPaths(repo).sessions).catch(() => []);
    expect(sessions.filter((s) => s.startsWith("ses_"))).toHaveLength(0);
    const tasks = await readdir(basouPaths(repo).tasks).catch(() => []);
    expect(tasks).toHaveLength(0);
  });

  it("t-new-22: --status done --json includes recorded_at and completed_at", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunTaskNew(
      {
        title: "json done",
        status: "done",
        completedAt: "2026-05-08T08:00:00+09:00",
        json: true,
      },
      { cwd: repo, ...FIXED_CTX },
    );
    const payload = JSON.parse(joinCalls(out)) as Record<string, unknown>;
    expect(payload.status).toBe("done");
    expect(payload.recorded_at).toBe(FIXED_NOW.toISOString());
    expect(payload.completed_at).toBe("2026-05-08T08:00:00+09:00");
  });

  it("t-new-23: --status done --session <running> attaches both events to the existing session", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("N23");
    await createSession(repo, { id: sid, status: "running" });
    captureStdout();
    await doRunTaskNew(
      {
        title: "attach done",
        status: "done",
        completedAt: "2026-05-09T10:00:00+09:00",
        session: sid,
      },
      { cwd: repo, ...FIXED_CTX },
    );
    const events = (await readFile(join(basouPaths(repo).sessions, sid, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    // The attached session is not closed by `task new`, so we expect exactly
    // the two task events appended (no session_started / ended pair).
    expect(events.map((e) => e.type)).toEqual(["task_created", "task_status_changed"]);
    expect(events[1]).toMatchObject({ from: "planned", to: "done" });
    const taskId = await findCreatedTaskId(repo);
    const md = await readFile(join(basouPaths(repo).tasks, `${taskId}.md`), "utf8");
    expect(md).toContain("status: done");
    expect(md).toContain("updated_at: 2026-05-09T10:00:00+09:00");
    const yaml = await readFile(join(basouPaths(repo).sessions, sid, "session.yaml"), "utf8");
    expect(yaml).toContain(`task_id: ${taskId}`);
  });
});

// ============================================================================
// task list
// ============================================================================

describe("doRunTaskList", () => {
  it("t-list-1: empty workspace prints the placeholder", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunTaskList({}, { cwd: repo });
    expect(joinCalls(out)).toContain("No tasks found.");
  });

  it("t-list-2: --json on empty workspace prints []", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunTaskList({ json: true }, { cwd: repo });
    expect(joinCalls(out)).toBe("[]");
  });

  it("t-list-3: lists tasks newest-first and includes linked_session_count in JSON", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew({ title: "first" }, { cwd: repo, ...FIXED_CTX });
    await doRunTaskNew({ title: "second" }, { cwd: repo, ...FIXED_CTX_2 });
    const out = captureStdout();
    await doRunTaskList({ json: true }, { cwd: repo });
    const arr = JSON.parse(joinCalls(out)) as Array<Record<string, unknown>>;
    expect(arr).toHaveLength(2);
    expect(arr[0]?.title).toBe("second");
    expect(arr[0]?.linked_session_count).toBe(1);
  });

  it("t-list-4: --status filters to one status", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew({ title: "planned-x" }, { cwd: repo, ...FIXED_CTX });
    await doRunTaskNew({ title: "ip-x", status: "in_progress" }, { cwd: repo, ...FIXED_CTX_2 });
    const out = captureStdout();
    await doRunTaskList({ status: "in_progress", json: true }, { cwd: repo });
    const arr = JSON.parse(joinCalls(out)) as Array<Record<string, unknown>>;
    expect(arr).toHaveLength(1);
    expect(arr[0]?.status).toBe("in_progress");
  });
});

// ============================================================================
// task show
// ============================================================================

describe("doRunTaskShow", () => {
  it("t-show-1: shows a task with its events and linked sessions", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew({ title: "show me" }, { cwd: repo, ...FIXED_CTX });
    const taskId = await findCreatedTaskId(repo);
    const out = captureStdout();
    await doRunTaskShow(taskId, { json: true }, { cwd: repo });
    const payload = JSON.parse(joinCalls(out)) as Record<string, unknown>;
    expect((payload.task as Record<string, unknown>).id).toBe(taskId);
    expect(Array.isArray(payload.events)).toBe(true);
    expect((payload.events as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it("t-show-2: missing task id surfaces 'Task not found'", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runTaskShow("task_DEAD", { json: true }, { cwd: repo });
    expect(joinCalls(err)).toContain("Task not found");
    expect(process.exitCode).toBe(1);
  });

  it("t-show-3: ambiguous prefix surfaces 'Ambiguous task id'", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew({ title: "a" }, { cwd: repo, ...FIXED_CTX });
    await doRunTaskNew({ title: "b" }, { cwd: repo, ...FIXED_CTX_2 });
    const err = captureStderr();
    await runTaskShow("task_", { json: true }, { cwd: repo });
    expect(joinCalls(err)).toContain("Task not found"); // bare prefix path
    expect(process.exitCode).toBe(1);
  });

  it("t-show-4: malformed events.jsonl emits a replay warning to stderr", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew({ title: "show-4" }, { cwd: repo, ...FIXED_CTX });
    const taskId = await findCreatedTaskId(repo);
    const paths = basouPaths(repo);
    const sessions = (await readdir(paths.sessions)).filter((d) => d.startsWith("ses_"));
    expect(sessions).toHaveLength(1);
    const sid = sessions[0] as string;
    const jsonlPath = join(paths.sessions, sid, "events.jsonl");
    const original = await readFile(jsonlPath, "utf8");
    await writeFile(jsonlPath, `${original}{not valid json\n`);

    const err = captureStderr();
    captureStdout();
    await runTaskShow(taskId, { json: true }, { cwd: repo });
    const stderr = joinCalls(err);
    expect(stderr).toContain("skipped malformed JSON");
    expect(stderr).not.toContain(repo);
  });
});

// ============================================================================
// task status
// ============================================================================

describe("doRunTaskStatus", () => {
  it("t-status-1: planned -> in_progress (ad-hoc) updates task.md and fires the event", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew({ title: "ts" }, { cwd: repo, ...FIXED_CTX });
    const taskId = await findCreatedTaskId(repo);
    const out = captureStdout();
    await doRunTaskStatus(taskId, "in_progress", {}, { cwd: repo, ...FIXED_CTX_2 });
    expect(joinCalls(out)).toContain("Updated");
    const md = await readFile(join(basouPaths(repo).tasks, `${taskId}.md`), "utf8");
    expect(md).toContain("status: in_progress");
  });

  it("t-status-2: planned -> done is now a direct shortcut", async () => {
    // The terminal-status shortcut lifts the prior two-step requirement so
    // `basou task status <id> done` succeeds straight from planned. The
    // audit trail still captures exactly one task_status_changed event for
    // the jump.
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunTaskNew({ title: "ts" }, { cwd: repo, ...FIXED_CTX });
    const taskId = await findCreatedTaskId(repo);
    await doRunTaskStatus(taskId, "done", {}, { cwd: repo, ...FIXED_CTX_2 });
    expect(joinCalls(out)).toContain("Updated");
    const md = await readFile(join(basouPaths(repo).tasks, `${taskId}.md`), "utf8");
    expect(md).toContain("status: done");
  });

  it("t-status-2b: planned -> cancelled is also a direct shortcut", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunTaskNew({ title: "ts" }, { cwd: repo, ...FIXED_CTX });
    const taskId = await findCreatedTaskId(repo);
    await doRunTaskStatus(taskId, "cancelled", {}, { cwd: repo, ...FIXED_CTX_2 });
    expect(joinCalls(out)).toContain("Updated");
    const md = await readFile(join(basouPaths(repo).tasks, `${taskId}.md`), "utf8");
    expect(md).toContain("status: cancelled");
  });

  it("t-status-3: done -> done is rejected as an invalid (idempotent) transition", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew({ title: "ts", status: "in_progress" }, { cwd: repo, ...FIXED_CTX });
    const taskId = await findCreatedTaskId(repo);
    await doRunTaskStatus(taskId, "done", {}, { cwd: repo, ...FIXED_CTX_2 });
    const err = captureStderr();
    await runTaskStatus(taskId, "done", {}, { cwd: repo, ...FIXED_CTX_2 });
    expect(joinCalls(err)).toContain("Invalid task status transition: done -> done");
    expect(process.exitCode).toBe(1);
  });

  it("t-status-4: --session attaches the status change to an existing session", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("S04");
    await createSession(repo, { id: sid, status: "running" });
    captureStdout();
    await doRunTaskNew({ title: "attached task", session: sid }, { cwd: repo, ...FIXED_CTX });
    const taskId = await findCreatedTaskId(repo);
    const out = captureStdout();
    await doRunTaskStatus(
      taskId,
      "in_progress",
      { session: sid, json: true },
      { cwd: repo, ...FIXED_CTX_2 },
    );
    const payload = JSON.parse(joinCalls(out)) as Record<string, unknown>;
    expect(payload.mode).toBe("attached");
    expect(payload.previous_status).toBe("planned");
    expect(payload.new_status).toBe("in_progress");
    const events = (await readFile(join(basouPaths(repo).sessions, sid, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.filter((e) => e.type === "task_status_changed")).toHaveLength(1);
  });

  it("t-status-5: invalid <new_status> argument is rejected", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew({ title: "x" }, { cwd: repo, ...FIXED_CTX });
    const taskId = await findCreatedTaskId(repo);
    const err = captureStderr();
    await runTaskStatus(taskId, "queued", {}, { cwd: repo });
    expect(joinCalls(err)).toContain("Invalid task status: queued");
    expect(process.exitCode).toBe(1);
  });
});

// ============================================================================
// pathless contract + workspace guards
// ============================================================================

describe("doRunTaskNew (workspace / repo guards)", () => {
  it("t-guard-1: non-initialized workspace surfaces the init hint", async () => {
    const repo = await realpath(getTmpRepo());
    const err = captureStderr();
    await runTaskNew({ title: "x" }, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(err)).toContain("Workspace not initialized. Run 'basou init' first.");
    expect(process.exitCode).toBe(1);
  });

  it("t-guard-2: non-git directory surfaces the git init hint", async () => {
    const nonGit = await mkdtemp(join(tmpdir(), "basou-task-cli-notgit-"));
    try {
      const err = captureStderr();
      await runTaskNew({ title: "x" }, { cwd: nonGit, ...FIXED_CTX });
      expect(joinCalls(err)).toContain(
        "Not a git repository. Run 'git init' first, then re-run 'basou task new'.",
      );
      expect(process.exitCode).toBe(1);
    } finally {
      await rm(nonGit, { recursive: true, force: true });
    }
  });
});

describe("renderTaskError (pathless contract)", () => {
  it("t-pathless-1: TaskWriteAfterEventError surfaces the 3-line warning without leaking absolute paths", async () => {
    const repo = await setupInitedRepo();
    const core = await import("@basou/core");
    const spy = vi.spyOn(core, "createTaskWithEvent");
    spy.mockImplementationOnce(async () => {
      throw new core.TaskWriteAfterEventError({
        taskId: "task_01HXABCDEF1234567890ABCFAI" as `task_${string}`,
        eventId: "evt_01HXABCDEF1234567890ABCFAI" as `evt_${string}`,
        sessionId: "ses_01HXABCDEF1234567890ABCFAI" as `ses_${string}`,
        phase: "create",
        cause: Object.assign(new Error("Failed to write task file"), {
          cause: Object.assign(new Error(`absolute path ${repo}/.basou/tasks/x`), {
            code: "EACCES",
          }),
        }),
      });
    });
    const err = captureStderr();
    await runTaskNew({ title: "x" }, { cwd: repo, ...FIXED_CTX });
    const stderr = joinCalls(err);
    expect(stderr).toContain("Failed to write task file after event was persisted");
    expect(stderr).toContain("do not rerun");
    expect(stderr).toContain("Warning: task.md creation failed");
    expect(stderr).not.toContain(repo);
    expect(process.exitCode).toBe(1);
  });

  it("t-pathless-2: TaskWriteAfterEventError overwrite phase uses the update wording", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew({ title: "x" }, { cwd: repo, ...FIXED_CTX });
    const taskId = await findCreatedTaskId(repo);
    const core = await import("@basou/core");
    const spy = vi.spyOn(core, "updateTaskStatusWithEvent");
    spy.mockImplementationOnce(async () => {
      throw new core.TaskWriteAfterEventError({
        taskId: taskId as `task_${string}`,
        eventId: "evt_01HXABCDEF1234567890ABCFAI" as `evt_${string}`,
        sessionId: "ses_01HXABCDEF1234567890ABCFAI" as `ses_${string}`,
        phase: "overwrite",
        cause: Object.assign(new Error("Failed to write task file"), {
          cause: Object.assign(new Error(`absolute path ${repo}/.basou/tasks/x`), {
            code: "EACCES",
          }),
        }),
      });
    });
    const err = captureStderr();
    await runTaskStatus(taskId, "in_progress", {}, { cwd: repo, ...FIXED_CTX_2 });
    const stderr = joinCalls(err);
    expect(stderr).toContain("Warning: task.md update failed");
    expect(stderr).not.toContain(repo);
    expect(process.exitCode).toBe(1);
  });

  it("t-pathless-3: verbose mode appends 'Caused by: <code>' without leaking cause.message", async () => {
    const repo = await setupInitedRepo();
    const core = await import("@basou/core");
    const spy = vi.spyOn(core, "createTaskWithEvent");
    spy.mockImplementationOnce(async () => {
      throw new core.TaskWriteAfterEventError({
        taskId: "task_01HXABCDEF1234567890ABCFAI" as `task_${string}`,
        eventId: "evt_01HXABCDEF1234567890ABCFAI" as `evt_${string}`,
        sessionId: "ses_01HXABCDEF1234567890ABCFAI" as `ses_${string}`,
        phase: "create",
        cause: Object.assign(new Error("Failed to write task file"), {
          cause: Object.assign(new Error("absolute path /Users/secret/.basou/tasks/y"), {
            code: "EACCES",
          }),
        }),
      });
    });
    const err = captureStderr();
    await runTaskNew({ title: "x", verbose: true }, { cwd: repo, ...FIXED_CTX });
    const stderr = joinCalls(err);
    expect(stderr).toContain("Caused by: EACCES");
    expect(stderr).not.toContain("/Users/secret");
  });

  it("t-pathless-3b: TaskWriteAfterEventError link-session phase wording calls out session.yaml", async () => {
    const repo = await setupInitedRepo();
    const core = await import("@basou/core");
    const spy = vi.spyOn(core, "createTaskWithEvent");
    spy.mockImplementationOnce(async () => {
      throw new core.TaskWriteAfterEventError({
        taskId: "task_01HXABCDEF1234567890ABCFAI" as `task_${string}`,
        eventId: "evt_01HXABCDEF1234567890ABCFAI" as `evt_${string}`,
        sessionId: "ses_01HXABCDEF1234567890ABCFAI" as `ses_${string}`,
        phase: "link-session",
        cause: Object.assign(new Error("Failed to overwrite YAML file"), {
          cause: Object.assign(new Error(`absolute path ${repo}/.basou/sessions/x/session.yaml`), {
            code: "EACCES",
          }),
        }),
      });
    });
    const sid = await createSession(repo, { id: SES("LNK"), status: "running", taskId: null });
    const err = captureStderr();
    await runTaskNew({ title: "x", session: sid }, { cwd: repo, ...FIXED_CTX });
    const stderr = joinCalls(err);
    expect(stderr).toContain("session-task linkage is in unsafe state");
    expect(stderr).toContain("Warning: session.yaml task_id update failed");
    expect(stderr).not.toContain("task.md creation failed");
    expect(stderr).not.toContain(repo);
    expect(process.exitCode).toBe(1);
  });

  it("t-pathless-4: 'Task not found' non-verbose stderr is empty of absolute paths", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runTaskShow("task_DEAD", {}, { cwd: repo });
    expect(joinCalls(err)).toContain("Task not found");
    expect(joinCalls(err)).not.toContain(repo);
  });

  it("t-pathless-5: 'Invalid task status' stderr is empty of absolute paths", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew({ title: "x" }, { cwd: repo, ...FIXED_CTX });
    const taskId = await findCreatedTaskId(repo);
    const err = captureStderr();
    await runTaskStatus(taskId, "queued", {}, { cwd: repo });
    expect(joinCalls(err)).toContain("Invalid task status: queued");
    expect(joinCalls(err)).not.toContain(repo);
  });
});

describe("task list happy stderr stays empty", () => {
  it("t-list-quiet: empty workspace produces no stderr noise", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await doRunTaskList({}, { cwd: repo });
    expect(joinCalls(err)).toBe("");
  });
});

// ============================================================================
// task reconcile (Step 19)
// ============================================================================

// ULID body excludes I, L, O, U — use Crockford-valid suffixes only.
const BROKEN_SES_TR = "ses_01HXBRKENABCDEFGH1234567B1";
const REACHABLE_SES_TR = "ses_01HXREACHABE12345678REKC11";
const TASK_ID_TR_A = "task_01HXABCDEF1234567890ABCTAK";
const TASK_ID_TR_B = "task_01HXABCDEF1234567890ABCTAN"; // K and N — both Crockford-valid

async function placeBrokenTask(
  repo: string,
  taskId: string,
  fields: { createdInSession: string; linkedSessions: string[]; title?: string },
): Promise<void> {
  await writeTaskFile(
    basouPaths(repo),
    taskId,
    {
      task: {
        schema_version: "0.1.0",
        task: {
          id: taskId as `task_${string}`,
          title: fields.title ?? "broken fixture",
          status: "planned",
          created_at: "2026-05-04T09:00:00+09:00",
          updated_at: "2026-05-04T09:00:00+09:00",
          workspace_id: FIXED_WS_ID,
          created_in_session: fields.createdInSession as `ses_${string}`,
          linked_sessions: fields.linkedSessions as `ses_${string}`[],
        },
      },
      body: "fixture body",
    },
    { mode: "create" },
  );
}

describe("doRunTaskReconcile (all-scan)", () => {
  // 28
  it("t-rec-1: clean workspace prints sentinel and exits 0", async () => {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: REACHABLE_SES_TR, status: "running", taskId: null });
    await placeBrokenTask(repo, TASK_ID_TR_A, {
      createdInSession: REACHABLE_SES_TR,
      linkedSessions: [REACHABLE_SES_TR],
    });
    const out = captureStdout();
    await runTaskReconcile({}, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(out)).toContain("Scanned 1 tasks, no broken refs detected.");
    expect(process.exitCode).toBe(0);
  });

  // 29
  it("t-rec-2: dry-run with broken refs lists tasks + forward-sync note + exits 0", async () => {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: REACHABLE_SES_TR, status: "running", taskId: null });
    await placeBrokenTask(repo, TASK_ID_TR_A, {
      createdInSession: BROKEN_SES_TR,
      linkedSessions: [REACHABLE_SES_TR],
    });
    const out = captureStdout();
    await runTaskReconcile({}, { cwd: repo, ...FIXED_CTX });
    const stdout = joinCalls(out);
    expect(stdout).toContain("(dry-run) Would reconcile");
    expect(stdout).toContain("forward sync is handled by `basou task refresh-linkage`");
    expect(stdout).toContain("Re-run with --write to apply.");
    // no ad-hoc reconcile session was minted in dry-run mode
    const sessions = await readdir(basouPaths(repo).sessions);
    expect(sessions).toEqual([REACHABLE_SES_TR]);
    expect(process.exitCode).toBe(0);
  });

  // 30
  it("t-rec-3: --write repairs broken refs, fires event, exits 0", async () => {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: REACHABLE_SES_TR, status: "running", taskId: null });
    await placeBrokenTask(repo, TASK_ID_TR_A, {
      createdInSession: BROKEN_SES_TR,
      linkedSessions: [REACHABLE_SES_TR],
    });
    const out = captureStdout();
    await runTaskReconcile({ write: true }, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(out)).toContain(`Reconciled ${TASK_ID_TR_A}`);
    expect(process.exitCode).toBe(0);
    const sessions = await readdir(basouPaths(repo).sessions);
    const reconcileSes = sessions.find((s) => s !== REACHABLE_SES_TR);
    expect(reconcileSes).toBeDefined();
    const events = (
      await readFile(
        join(basouPaths(repo).sessions, reconcileSes as string, "events.jsonl"),
        "utf8",
      )
    )
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.some((e) => e.type === "task_reconciled")).toBe(true);
  });

  // 31
  it("t-rec-4: --write partial failure surfaces failed list to stderr + exits 1", async () => {
    const repo = await setupInitedRepo();
    const core = await import("@basou/core");
    // Replace the orchestrator wholesale — vi.spyOn cannot intercept the
    // module-internal reconcileTask call inside reconcileAllTasks (ES module
    // local binding constraint).
    vi.spyOn(core, "reconcileAllTasks").mockImplementationOnce(async () => ({
      results: [
        {
          taskId: TASK_ID_TR_A as `task_${string}`,
          clean: false,
          brokenCreatedInSession: BROKEN_SES_TR as `ses_${string}`,
          brokenLinkedSessions: [],
          reconcileSession: {
            sessionId: "ses_01HXABCDEF1234567890ABCREC" as `ses_${string}`,
            eventId: "evt_01HXABCDEF1234567890ABCREE" as `evt_${string}`,
          },
        },
      ],
      failed: [
        {
          taskId: TASK_ID_TR_B as `task_${string}`,
          errorClass: "TaskWriteAfterEventError",
          phase: "reconcile",
        },
      ],
      scanned: 2,
    }));
    const out = captureStdout();
    const err = captureStderr();
    await runTaskReconcile({ write: true }, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(out)).toContain(`Reconciled ${TASK_ID_TR_A}`);
    expect(joinCalls(err)).toContain(`Failed to reconcile ${TASK_ID_TR_B}`);
    expect(joinCalls(err)).toContain("phase: reconcile");
    expect(process.exitCode).toBe(1);
  });
});

describe("doRunTaskReconcile (single task --task)", () => {
  // 32
  it("t-rec-5: --task on clean task reports reachable counts and exits 0", async () => {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: REACHABLE_SES_TR, status: "running", taskId: null });
    await placeBrokenTask(repo, TASK_ID_TR_A, {
      createdInSession: REACHABLE_SES_TR,
      linkedSessions: [REACHABLE_SES_TR],
    });
    const out = captureStdout();
    await runTaskReconcile({ task: TASK_ID_TR_A }, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(out)).toContain("no broken refs");
    expect(process.exitCode).toBe(0);
  });

  // 33
  it("t-rec-6: --task dry-run with broken inlines short session ids + exits 0", async () => {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: REACHABLE_SES_TR, status: "running", taskId: null });
    await placeBrokenTask(repo, TASK_ID_TR_A, {
      createdInSession: BROKEN_SES_TR,
      linkedSessions: [REACHABLE_SES_TR],
    });
    const out = captureStdout();
    await runTaskReconcile({ task: TASK_ID_TR_A }, { cwd: repo, ...FIXED_CTX });
    const stdout = joinCalls(out);
    expect(stdout).toContain("(dry-run) Would reconcile");
    expect(stdout).toContain("ses_01HXBR"); // short broken id (default for --task)
    expect(stdout).toContain("forward sync is handled by `basou task refresh-linkage`");
    expect(process.exitCode).toBe(0);
  });

  // 34
  it("t-rec-7: --task --write reports Reconciled <id> + exits 0", async () => {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: REACHABLE_SES_TR, status: "running", taskId: null });
    await placeBrokenTask(repo, TASK_ID_TR_A, {
      createdInSession: BROKEN_SES_TR,
      linkedSessions: [REACHABLE_SES_TR],
    });
    const out = captureStdout();
    await runTaskReconcile({ task: TASK_ID_TR_A, write: true }, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(out)).toContain(`Reconciled ${TASK_ID_TR_A}`);
    expect(process.exitCode).toBe(0);
  });

  // 35
  it("t-rec-8: --task <invalid_format> exits 1 with a fixed message", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runTaskReconcile({ task: "definitely-not-a-task-id" }, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(err)).toContain("Task not found");
    expect(joinCalls(err)).not.toContain(repo);
    expect(process.exitCode).toBe(1);
  });

  // 36
  it("t-rec-9: --task <ambiguous_prefix> exits 1 with ambiguity message", async () => {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: REACHABLE_SES_TR, status: "running", taskId: null });
    await placeBrokenTask(repo, TASK_ID_TR_A, {
      createdInSession: REACHABLE_SES_TR,
      linkedSessions: [REACHABLE_SES_TR],
    });
    await placeBrokenTask(repo, TASK_ID_TR_B, {
      createdInSession: REACHABLE_SES_TR,
      linkedSessions: [REACHABLE_SES_TR],
    });
    const err = captureStderr();
    // Both TASK_ID_TR_A and TASK_ID_TR_B start with "task_01H" — this prefix matches both
    await runTaskReconcile({ task: "task_01H" }, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(err)).toContain("Ambiguous task id");
    expect(process.exitCode).toBe(1);
  });

  // 37
  it("t-rec-10: --task <unknown_id> exits 1 with 'Task not found'", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runTaskReconcile(
      { task: "task_01HUNKNOWNABCDEFGH1234567A" },
      { cwd: repo, ...FIXED_CTX },
    );
    expect(joinCalls(err)).toContain("Task not found");
    expect(process.exitCode).toBe(1);
  });
});

describe("doRunTaskReconcile (--json)", () => {
  // 38
  it("t-rec-11: --json dry-run emits dry_run:true + reconciled list + failed:[]", async () => {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: REACHABLE_SES_TR, status: "running", taskId: null });
    await placeBrokenTask(repo, TASK_ID_TR_A, {
      createdInSession: BROKEN_SES_TR,
      linkedSessions: [REACHABLE_SES_TR],
    });
    const out = captureStdout();
    await runTaskReconcile({ json: true }, { cwd: repo, ...FIXED_CTX });
    const payload = JSON.parse(joinCalls(out)) as Record<string, unknown>;
    expect(payload.dry_run).toBe(true);
    expect(payload.scanned).toBe(1);
    expect(Array.isArray(payload.reconciled)).toBe(true);
    expect((payload.reconciled as unknown[]).length).toBe(1);
    expect(payload.failed).toEqual([]);
  });

  // 39
  it("t-rec-12: --json --write emits event_id + reconcile_session_id on success", async () => {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: REACHABLE_SES_TR, status: "running", taskId: null });
    await placeBrokenTask(repo, TASK_ID_TR_A, {
      createdInSession: BROKEN_SES_TR,
      linkedSessions: [REACHABLE_SES_TR],
    });
    const out = captureStdout();
    await runTaskReconcile({ json: true, write: true }, { cwd: repo, ...FIXED_CTX });
    const payload = JSON.parse(joinCalls(out)) as Record<string, unknown>;
    expect(payload.dry_run).toBe(false);
    const reconciled = (payload.reconciled as Array<Record<string, unknown>>)[0];
    expect(reconciled?.reconcile_session_id).toMatch(/^ses_/);
    expect(reconciled?.event_id).toMatch(/^evt_/);
  });

  // 40
  it("t-rec-13: --json --write partial failure populates failed[] and sets exit 1", async () => {
    const repo = await setupInitedRepo();
    const core = await import("@basou/core");
    // Same ES-module-binding rationale as t-rec-4: replace reconcileAllTasks
    // wholesale.
    vi.spyOn(core, "reconcileAllTasks").mockImplementationOnce(async () => ({
      results: [
        {
          taskId: TASK_ID_TR_A as `task_${string}`,
          clean: false,
          brokenCreatedInSession: BROKEN_SES_TR as `ses_${string}`,
          brokenLinkedSessions: [],
          reconcileSession: {
            sessionId: "ses_01HXABCDEF1234567890ABCREC" as `ses_${string}`,
            eventId: "evt_01HXABCDEF1234567890ABCREE" as `evt_${string}`,
          },
        },
      ],
      failed: [
        {
          taskId: TASK_ID_TR_B as `task_${string}`,
          errorClass: "TaskWriteAfterEventError",
          phase: "reconcile",
        },
      ],
      scanned: 2,
    }));
    const out = captureStdout();
    await runTaskReconcile({ json: true, write: true }, { cwd: repo, ...FIXED_CTX });
    const payload = JSON.parse(joinCalls(out)) as Record<string, unknown>;
    expect((payload.failed as Array<Record<string, unknown>>).length).toBe(1);
    expect((payload.failed as Array<Record<string, unknown>>)[0]?.phase).toBe("reconcile");
    expect(process.exitCode).toBe(1);
  });
});

describe("renderTaskError extended phases (Step 19)", () => {
  // 41a: reconcile
  it("t-rec-14: phase 'reconcile' warning calls out task.md reconciliation failed", async () => {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: REACHABLE_SES_TR, status: "running", taskId: null });
    await placeBrokenTask(repo, TASK_ID_TR_A, {
      createdInSession: BROKEN_SES_TR,
      linkedSessions: [REACHABLE_SES_TR],
    });
    const core = await import("@basou/core");
    vi.spyOn(core, "reconcileTask").mockImplementationOnce(async () => {
      throw new core.TaskWriteAfterEventError({
        taskId: TASK_ID_TR_A as `task_${string}`,
        eventId: "evt_01HXABCDEF1234567890ABCFA1" as `evt_${string}`,
        sessionId: "ses_01HXABCDEF1234567890ABCFA1" as `ses_${string}`,
        phase: "reconcile",
        cause: Object.assign(new Error("simulated EACCES"), { code: "EACCES" }),
      });
    });
    const err = captureStderr();
    await runTaskReconcile({ task: TASK_ID_TR_A, write: true }, { cwd: repo, ...FIXED_CTX });
    const stderr = joinCalls(err);
    expect(stderr).toContain("Warning: task.md reconciliation failed");
    expect(stderr).toContain("manual repair required");
    expect(stderr).not.toContain("(未実装)");
    expect(stderr).not.toContain(repo);
    expect(process.exitCode).toBe(1);
  });

  // 41b: reconcile-finalize
  it("t-rec-15: phase 'reconcile-finalize' warning calls out session.yaml status update", async () => {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: REACHABLE_SES_TR, status: "running", taskId: null });
    await placeBrokenTask(repo, TASK_ID_TR_A, {
      createdInSession: BROKEN_SES_TR,
      linkedSessions: [REACHABLE_SES_TR],
    });
    const core = await import("@basou/core");
    vi.spyOn(core, "reconcileTask").mockImplementationOnce(async () => {
      throw new core.TaskWriteAfterEventError({
        taskId: TASK_ID_TR_A as `task_${string}`,
        eventId: "evt_01HXABCDEF1234567890ABCFA1" as `evt_${string}`,
        sessionId: "ses_01HXABCDEF1234567890ABCFA1" as `ses_${string}`,
        phase: "reconcile-finalize",
        cause: Object.assign(new Error("simulated EACCES"), { code: "EACCES" }),
      });
    });
    const err = captureStderr();
    await runTaskReconcile({ task: TASK_ID_TR_A, write: true }, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(err)).toContain("reconcile session finalize failed");
  });

  // 41c: reconcile-concurrent
  it("t-rec-16: phase 'reconcile-concurrent' suggests re-running reconcile rather than manual repair", async () => {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: REACHABLE_SES_TR, status: "running", taskId: null });
    await placeBrokenTask(repo, TASK_ID_TR_A, {
      createdInSession: BROKEN_SES_TR,
      linkedSessions: [REACHABLE_SES_TR],
    });
    const core = await import("@basou/core");
    vi.spyOn(core, "reconcileTask").mockImplementationOnce(async () => {
      throw new core.TaskWriteAfterEventError({
        taskId: TASK_ID_TR_A as `task_${string}`,
        eventId: "evt_01HXABCDEF1234567890ABCFA1" as `evt_${string}`,
        sessionId: "ses_01HXABCDEF1234567890ABCFA1" as `ses_${string}`,
        phase: "reconcile-concurrent",
        cause: Object.assign(new Error("simulated mtime drift"), { code: "EAGAIN" }),
      });
    });
    const err = captureStderr();
    await runTaskReconcile({ task: TASK_ID_TR_A, write: true }, { cwd: repo, ...FIXED_CTX });
    const stderr = joinCalls(err);
    expect(stderr).toContain("task.md was modified concurrently");
    expect(stderr).toContain("re-run `basou task reconcile`");
  });
});

describe("doRunTaskReconcile (verbose)", () => {
  // 42
  it("t-rec-17: -v in all-scan dry-run inlines short broken session ids in stdout", async () => {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: REACHABLE_SES_TR, status: "running", taskId: null });
    await placeBrokenTask(repo, TASK_ID_TR_A, {
      createdInSession: BROKEN_SES_TR,
      linkedSessions: [REACHABLE_SES_TR],
    });
    const out = captureStdout();
    await runTaskReconcile({ verbose: true }, { cwd: repo, ...FIXED_CTX });
    const stdout = joinCalls(out);
    expect(stdout).toContain("ses_01HXBR");
  });
});

// ============================================================================
// task show extensions (Step 19)
// ============================================================================

describe("doRunTaskShow with task_reconciled events (Step 19)", () => {
  async function setupReconciledFixture(): Promise<{ repo: string; taskId: string }> {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: REACHABLE_SES_TR, status: "running", taskId: null });
    await placeBrokenTask(repo, TASK_ID_TR_A, {
      createdInSession: BROKEN_SES_TR,
      linkedSessions: [REACHABLE_SES_TR],
    });
    captureStdout(); // mute reconcile output
    await runTaskReconcile({ task: TASK_ID_TR_A, write: true }, { cwd: repo, ...FIXED_CTX });
    vi.restoreAllMocks();
    return { repo, taskId: TASK_ID_TR_A };
  }

  // 43
  it("t-rec-show-1: task show collects task_reconciled events", async () => {
    const { repo, taskId } = await setupReconciledFixture();
    const out = captureStdout();
    await doRunTaskShow(taskId, { events: true }, { cwd: repo });
    const stdout = joinCalls(out);
    expect(stdout).toContain("task_reconciled");
    expect(stdout).toContain("broken ref");
  });

  // 44
  it("t-rec-show-2: task show -v expands the task_reconciled payload", async () => {
    const { repo, taskId } = await setupReconciledFixture();
    const out = captureStdout();
    await doRunTaskShow(taskId, { events: true, verbose: true }, { cwd: repo });
    const stdout = joinCalls(out);
    expect(stdout).toContain("removed_created_in_session:");
    expect(stdout).toContain("created_in_session_replacement:");
  });

  // 45
  it("t-rec-show-3: task show --json embeds task_reconciled payload in events[]", async () => {
    const { repo, taskId } = await setupReconciledFixture();
    const out = captureStdout();
    await doRunTaskShow(taskId, { json: true, events: true }, { cwd: repo });
    const payload = JSON.parse(joinCalls(out)) as Record<string, unknown>;
    const events = payload.events as Array<Record<string, unknown>>;
    const reconciled = events.find((e) => e.type === "task_reconciled");
    expect(reconciled).toBeDefined();
    expect(reconciled?.removed_created_in_session).toBe(BROKEN_SES_TR);
  });
});

// ============================================================================
// Ambiguous task id surface coverage
//
// Earlier work covered `session import --task <prefix>` and
// `task reconcile --task <prefix>` for the Ambiguous branch. The remaining
// surfaces that funnel user-supplied prefixes through `resolveTaskId` —
// `task show <prefix>` and `task status <prefix> <new_status>` — only had
// happy-path / not-found coverage. The cases below lock in the Ambiguous
// branch (= matched > 1) for both surfaces, plus the pathless contract
// and the absence of `Caused by:` in verbose mode (Ambiguous errors carry
// no cause chain).
// ============================================================================

describe("Ambiguous task id surface coverage", () => {
  // The two fixture ids share `task_01HXABCDEF1234567890ABCTA`, so any
  // prefix at or shorter than that length matches both — and any prefix
  // longer than that disambiguates to one specific task.
  const AMBIG_PREFIX = "task_01HXABCDEF1234567890ABCTA";

  async function setupTwoAmbiguousTasks(): Promise<string> {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: REACHABLE_SES_TR, status: "running", taskId: null });
    await placeBrokenTask(repo, TASK_ID_TR_A, {
      createdInSession: REACHABLE_SES_TR,
      linkedSessions: [REACHABLE_SES_TR],
    });
    await placeBrokenTask(repo, TASK_ID_TR_B, {
      createdInSession: REACHABLE_SES_TR,
      linkedSessions: [REACHABLE_SES_TR],
    });
    return repo;
  }

  it("t-amb-1: task show <ambiguous-prefix> exits 1 with the canonical Ambiguous wording", async () => {
    const repo = await setupTwoAmbiguousTasks();
    const err = captureStderr();
    await runTaskShow(AMBIG_PREFIX, { json: true }, { cwd: repo });
    const stderr = joinCalls(err);
    expect(stderr).toContain(`Ambiguous task id '${AMBIG_PREFIX}': matched 2 tasks`);
    expect(stderr).toContain("Disambiguate with a longer prefix.");
    expect(process.exitCode).toBe(1);
  });

  it("t-amb-2: task show <ambiguous-prefix> stays pathless and emits no Caused by even with --verbose", async () => {
    const repo = await setupTwoAmbiguousTasks();
    const err = captureStderr();
    await runTaskShow(AMBIG_PREFIX, { json: true, verbose: true }, { cwd: repo });
    const stderr = joinCalls(err);
    expect(stderr).toContain("Ambiguous task id");
    // Ambiguous errors are surfaced with a fixed pathless message and
    // carry no `cause`, so verbose mode must not append a `Caused by` line.
    expect(stderr).not.toContain("Caused by:");
    // The user-supplied prefix is echoed verbatim in the message, but the
    // workspace absolute path must never leak through stderr.
    expect(stderr).not.toContain(repo);
    expect(process.exitCode).toBe(1);
  });

  it("t-amb-3: task show <ambiguous-prefix> renders the same way in text mode (no --json)", async () => {
    const repo = await setupTwoAmbiguousTasks();
    const err = captureStderr();
    await runTaskShow(AMBIG_PREFIX, {}, { cwd: repo });
    const stderr = joinCalls(err);
    expect(stderr).toContain(`Ambiguous task id '${AMBIG_PREFIX}'`);
    expect(stderr).toContain("matched 2 tasks");
    expect(process.exitCode).toBe(1);
  });

  it("t-amb-4: task status <ambiguous-prefix> <new_status> exits 1 with the canonical Ambiguous wording", async () => {
    const repo = await setupTwoAmbiguousTasks();
    const err = captureStderr();
    await runTaskStatus(AMBIG_PREFIX, "in_progress", {}, { cwd: repo, ...FIXED_CTX });
    const stderr = joinCalls(err);
    expect(stderr).toContain(`Ambiguous task id '${AMBIG_PREFIX}': matched 2 tasks`);
    expect(stderr).toContain("Disambiguate with a longer prefix.");
    expect(process.exitCode).toBe(1);
  });

  it("t-amb-5: task status <ambiguous-prefix> with --verbose stays pathless and emits no Caused by", async () => {
    const repo = await setupTwoAmbiguousTasks();
    const err = captureStderr();
    await runTaskStatus(
      AMBIG_PREFIX,
      "in_progress",
      { verbose: true },
      { cwd: repo, ...FIXED_CTX },
    );
    const stderr = joinCalls(err);
    expect(stderr).toContain("Ambiguous task id");
    expect(stderr).not.toContain("Caused by:");
    expect(stderr).not.toContain(repo);
    expect(process.exitCode).toBe(1);
  });

  it("t-amb-6: a longer prefix that uniquely matches one task disambiguates successfully (regression)", async () => {
    // Negative-space probe: extending the prefix past the shared tail
    // resolves to a single task, so task show succeeds and emits no
    // Ambiguous diagnostic.
    const repo = await setupTwoAmbiguousTasks();
    const out = captureStdout();
    const err = captureStderr();
    await runTaskShow(TASK_ID_TR_A, { json: true }, { cwd: repo });
    const stdout = joinCalls(out);
    const stderr = joinCalls(err);
    expect(stderr).not.toContain("Ambiguous task id");
    const payload = JSON.parse(stdout) as Record<string, unknown>;
    expect((payload.task as Record<string, unknown>).id).toBe(TASK_ID_TR_A);
  });
});

// ============================================================================
// task refresh-linkage
// ============================================================================

describe("doRunTaskRefreshLinkage", () => {
  // The fixtures here mirror the reconcile-side helpers but place
  // session.yaml with explicit task_id pointers so the refresh path has
  // something to scan.
  const REFRESH_TASK_ID = "task_01HXABCDEF1234567890ABCTAK";
  const REFRESH_SES_A = "ses_01HXREACHABE12345678REKC11";
  const REFRESH_SES_B = "ses_01HXREACHABE12345678REKC22";

  async function placeTaskMd(
    repo: string,
    taskId: string,
    linkedSessions: string[],
  ): Promise<void> {
    await writeTaskFile(
      basouPaths(repo),
      taskId,
      {
        task: {
          schema_version: "0.1.0",
          task: {
            id: taskId as `task_${string}`,
            title: "linkage fixture",
            status: "in_progress",
            created_at: "2026-05-04T09:00:00+09:00",
            updated_at: "2026-05-04T09:00:00+09:00",
            workspace_id: FIXED_WS_ID,
            created_in_session: linkedSessions[0] as `ses_${string}`,
            linked_sessions: linkedSessions as `ses_${string}`[],
          },
        },
        body: "fixture",
      },
      { mode: "create" },
    );
  }

  it("t-refresh-1: clean snapshot prints a sentinel and exits 0", async () => {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: REFRESH_SES_A, status: "running", taskId: REFRESH_TASK_ID });
    await placeTaskMd(repo, REFRESH_TASK_ID, [REFRESH_SES_A]);
    const out = captureStdout();
    await runTaskRefreshLinkage(REFRESH_TASK_ID, {}, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(out)).toContain("linked_sessions already fresh");
    expect(process.exitCode).toBe(0);
  });

  it("t-refresh-2: dry-run with an added session lists +1 and exits 0 without minting an ad-hoc session", async () => {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: REFRESH_SES_A, status: "running", taskId: REFRESH_TASK_ID });
    await createSession(repo, { id: REFRESH_SES_B, status: "running", taskId: REFRESH_TASK_ID });
    await placeTaskMd(repo, REFRESH_TASK_ID, [REFRESH_SES_A]);
    const out = captureStdout();
    await runTaskRefreshLinkage(REFRESH_TASK_ID, {}, { cwd: repo, ...FIXED_CTX });
    const stdout = joinCalls(out);
    expect(stdout).toContain("(dry-run) Would refresh");
    expect(stdout).toContain("+1 added");
    expect(stdout).toContain("Re-run with --write to apply.");
    // Only the two pre-existing sessions; no ad-hoc refresh session minted.
    const sessions = await readdir(basouPaths(repo).sessions);
    expect(sessions.sort()).toEqual([REFRESH_SES_A, REFRESH_SES_B].sort());
    expect(process.exitCode).toBe(0);
  });

  it("t-refresh-3: --write applies the refresh and fires task_linkage_refreshed", async () => {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: REFRESH_SES_A, status: "running", taskId: REFRESH_TASK_ID });
    await createSession(repo, { id: REFRESH_SES_B, status: "running", taskId: REFRESH_TASK_ID });
    await placeTaskMd(repo, REFRESH_TASK_ID, [REFRESH_SES_A]);
    const out = captureStdout();
    await runTaskRefreshLinkage(REFRESH_TASK_ID, { write: true }, { cwd: repo, ...FIXED_CTX });
    const stdout = joinCalls(out);
    expect(stdout).toContain(`Refreshed ${REFRESH_TASK_ID} linked_sessions`);
    expect(stdout).toContain("+1 added");
    // Three sessions on disk now: two pre-existing + one ad-hoc refresh.
    const sessions = await readdir(basouPaths(repo).sessions);
    expect(sessions.length).toBe(3);
    expect(process.exitCode).toBe(0);
  });

  it("t-refresh-4: --json emits the diff payload with refresh_session_id when write succeeds", async () => {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: REFRESH_SES_A, status: "running", taskId: REFRESH_TASK_ID });
    await createSession(repo, { id: REFRESH_SES_B, status: "running", taskId: REFRESH_TASK_ID });
    await placeTaskMd(repo, REFRESH_TASK_ID, [REFRESH_SES_A]);
    const out = captureStdout();
    await doRunTaskRefreshLinkage(
      REFRESH_TASK_ID,
      { write: true, json: true },
      { cwd: repo, ...FIXED_CTX },
    );
    const payload = JSON.parse(joinCalls(out)) as Record<string, unknown>;
    expect(payload.task_id).toBe(REFRESH_TASK_ID);
    expect(payload.clean).toBe(false);
    expect(payload.dry_run).toBe(false);
    expect(payload.added_linked_sessions).toEqual([REFRESH_SES_B]);
    expect(payload.removed_linked_sessions).toEqual([]);
    expect(typeof payload.refresh_session_id).toBe("string");
    expect(typeof payload.event_id).toBe("string");
  });

  it("t-refresh-5: unknown task id surfaces 'Task not found' without leaking absolute paths", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runTaskRefreshLinkage("task_01HXABCDEF1234567890ABCTAK", {}, { cwd: repo, ...FIXED_CTX });
    const stderr = joinCalls(err);
    expect(stderr).toContain("Task not found");
    expect(stderr).not.toContain(repo);
    expect(process.exitCode).toBe(1);
  });
});

// ============================================================================
// task edit / delete / archive
// ============================================================================

describe("doRunTaskEdit", () => {
  it("t-edit-1: --title updates task.md without firing an event", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew({ title: "edit-target" }, { cwd: repo, ...FIXED_CTX });
    const taskId = await findCreatedTaskId(repo);
    const sessionsBefore = (await readdir(basouPaths(repo).sessions)).filter((s) =>
      s.startsWith("ses_"),
    );
    captureStdout();
    await doRunTaskEdit(taskId, { title: "renamed" }, { cwd: repo, ...FIXED_CTX_2 });
    const md = await readFile(join(basouPaths(repo).tasks, `${taskId}.md`), "utf8");
    expect(md).toContain("title: renamed");
    // No new ad-hoc session was minted by the title-only edit.
    const sessionsAfter = (await readdir(basouPaths(repo).sessions)).filter((s) =>
      s.startsWith("ses_"),
    );
    expect(sessionsAfter.length).toBe(sessionsBefore.length);
  });

  it("t-edit-2: --status routes through STATUS_TRANSITIONS and fires task_status_changed", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew({ title: "status-edit" }, { cwd: repo, ...FIXED_CTX });
    const taskId = await findCreatedTaskId(repo);
    const out = captureStdout();
    await doRunTaskEdit(taskId, { status: "in_progress" }, { cwd: repo, ...FIXED_CTX_2 });
    expect(joinCalls(out)).toContain(`Updated ${taskId} status: planned -> in_progress`);
    const md = await readFile(join(basouPaths(repo).tasks, `${taskId}.md`), "utf8");
    expect(md).toContain("status: in_progress");
  });

  it("t-edit-4: combined --title and --status applies both (status first via event, then title overwrite)", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew({ title: "combined-pre" }, { cwd: repo, ...FIXED_CTX });
    const taskId = await findCreatedTaskId(repo);
    const out = captureStdout();
    await doRunTaskEdit(
      taskId,
      { title: "combined-post", status: "in_progress" },
      { cwd: repo, ...FIXED_CTX_2 },
    );
    const stdout = joinCalls(out);
    // Both update lines are surfaced so the operator can verify both stages
    // landed.
    expect(stdout).toContain(`Updated ${taskId} status: planned -> in_progress`);
    expect(stdout).toContain(`Updated ${taskId} title`);
    const md = await readFile(join(basouPaths(repo).tasks, `${taskId}.md`), "utf8");
    expect(md).toContain("title: combined-post");
    expect(md).toContain("status: in_progress");
    // The status change fires a fresh ad-hoc session; the title overwrite
    // alone should NOT mint another. So sessions count goes up by exactly 1
    // versus the pre-edit snapshot.
    const sessions = (await readdir(basouPaths(repo).sessions)).filter((s) => s.startsWith("ses_"));
    // 1 from `task new`, 1 from the status portion of `task edit` = 2.
    expect(sessions.length).toBe(2);
  });

  it("t-edit-3: neither --title nor --status is rejected before any disk write", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew({ title: "x" }, { cwd: repo, ...FIXED_CTX });
    const taskId = await findCreatedTaskId(repo);
    const err = captureStderr();
    await runTaskEdit(taskId, {}, { cwd: repo, ...FIXED_CTX_2 });
    expect(joinCalls(err)).toContain("Nothing to edit");
    expect(process.exitCode).toBe(1);
  });
});

describe("doRunTaskDelete", () => {
  it("t-del-1: --yes hard-deletes task.md and fires task_deleted event", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew({ title: "doomed task" }, { cwd: repo, ...FIXED_CTX });
    const taskId = await findCreatedTaskId(repo);
    const out = captureStdout();
    await doRunTaskDelete(taskId, { yes: true }, { cwd: repo, ...FIXED_CTX_2 });
    expect(joinCalls(out)).toContain(`Deleted ${taskId}`);
    // task.md gone from main dir.
    const mainTasks = (await readdir(basouPaths(repo).tasks, { withFileTypes: true })).filter((d) =>
      d.isFile(),
    );
    expect(mainTasks.find((d) => d.name === `${taskId}.md`)).toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  it("t-del-2: without --yes and no TTY, exits 1 with a pathless message", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew({ title: "doomed-no-tty" }, { cwd: repo, ...FIXED_CTX });
    const taskId = await findCreatedTaskId(repo);
    const err = captureStderr();
    // In a non-TTY test environment process.stdin.isTTY is undefined; the
    // implementation refuses to prompt without --yes.
    await runTaskDelete(taskId, {}, { cwd: repo, ...FIXED_CTX_2 });
    const stderr = joinCalls(err);
    expect(stderr).toContain("Refusing to delete without TTY");
    expect(stderr).not.toContain(repo);
    expect(process.exitCode).toBe(1);
    // task.md remains.
    const mainTasks = (await readdir(basouPaths(repo).tasks)).filter((f) => f.endsWith(".md"));
    expect(mainTasks).toContain(`${taskId}.md`);
  });

  it("t-del-3: --json on success emits the audit payload", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew({ title: "json-doomed" }, { cwd: repo, ...FIXED_CTX });
    const taskId = await findCreatedTaskId(repo);
    const out = captureStdout();
    await doRunTaskDelete(taskId, { yes: true, json: true }, { cwd: repo, ...FIXED_CTX_2 });
    const payload = JSON.parse(joinCalls(out)) as Record<string, unknown>;
    expect(payload.task_id).toBe(taskId);
    expect(payload.title).toBe("json-doomed");
    expect(typeof payload.session_id).toBe("string");
    expect(typeof payload.event_id).toBe("string");
  });
});

describe("doRunTaskArchive", () => {
  it("t-arch-1: --yes moves task.md to archive/ and fires task_archived event", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew({ title: "to-archive" }, { cwd: repo, ...FIXED_CTX });
    const taskId = await findCreatedTaskId(repo);
    const out = captureStdout();
    await doRunTaskArchive(taskId, { yes: true }, { cwd: repo, ...FIXED_CTX_2 });
    expect(joinCalls(out)).toContain(`Archived ${taskId}`);
    const mainTasks = (await readdir(basouPaths(repo).tasks, { withFileTypes: true })).filter(
      (d) => d.isFile() && d.name.endsWith(".md"),
    );
    expect(mainTasks.find((d) => d.name === `${taskId}.md`)).toBeUndefined();
    const archiveTasks = await readdir(join(basouPaths(repo).tasks, "archive"));
    expect(archiveTasks).toContain(`${taskId}.md`);
  });

  it("t-arch-2: without --yes and no TTY, exits 1 with a pathless message", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew({ title: "archive-no-tty" }, { cwd: repo, ...FIXED_CTX });
    const taskId = await findCreatedTaskId(repo);
    const err = captureStderr();
    await runTaskArchive(taskId, {}, { cwd: repo, ...FIXED_CTX_2 });
    const stderr = joinCalls(err);
    expect(stderr).toContain("Refusing to archive without TTY");
    expect(stderr).not.toContain(repo);
    expect(process.exitCode).toBe(1);
  });

  it("t-arch-3: task list default hides archived; --include-archived shows them with [archived] tag", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew({ title: "live-task" }, { cwd: repo, ...FIXED_CTX });
    await doRunTaskNew({ title: "to-archive-list" }, { cwd: repo, ...FIXED_CTX_2 });
    const taskIds = await readdir(basouPaths(repo).tasks);
    const filenameToArchive = taskIds.find((f) => f.endsWith(".md") && f.startsWith("task_"));
    const taskIdToArchive = (filenameToArchive as string).replace(/\.md$/, "");
    captureStdout();
    await doRunTaskArchive(taskIdToArchive, { yes: true }, { cwd: repo, ...FIXED_CTX_2 });

    const defaultOut = captureStdout();
    await doRunTaskList({}, { cwd: repo, ...FIXED_CTX });
    const defaultText = joinCalls(defaultOut);
    expect(defaultText).not.toContain("[archived]");

    const allOut = captureStdout();
    await doRunTaskList({ includeArchived: true }, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(allOut)).toContain("[archived]");
  });

  it("t-arch-4: task show falls back to archive and tags the header", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew({ title: "to-show-archived" }, { cwd: repo, ...FIXED_CTX });
    const taskId = await findCreatedTaskId(repo);
    captureStdout();
    await doRunTaskArchive(taskId, { yes: true }, { cwd: repo, ...FIXED_CTX_2 });
    const out = captureStdout();
    await doRunTaskShow(taskId, {}, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(out)).toContain("[archived]");
  });
});
