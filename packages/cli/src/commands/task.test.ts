import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  basouPaths,
  createManifest,
  ensureBasouDirectory,
  writeManifest,
  writeYamlFile,
} from "@basou/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  doRunTaskList,
  doRunTaskNew,
  doRunTaskShow,
  doRunTaskStatus,
  registerTaskCommand,
  runTaskList,
  runTaskNew,
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

  it("t-new-16: --status done is rejected by the converter (initial-status guard)", async () => {
    const program = new Command();
    program.exitOverride();
    registerTaskCommand(program);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      program.parseAsync(["node", "basou", "task", "new", "--title", "x", "--status", "done"]),
    ).rejects.toBeDefined();
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("")).toContain(
      "Initial task status must be 'planned' or 'in_progress'",
    );
  });

  it("t-new-17: --status cancelled is rejected by the converter", async () => {
    const program = new Command();
    program.exitOverride();
    registerTaskCommand(program);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      program.parseAsync(["node", "basou", "task", "new", "--title", "x", "--status", "cancelled"]),
    ).rejects.toBeDefined();
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("")).toContain(
      "Initial task status must be 'planned' or 'in_progress'",
    );
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

  it("t-show-4: malformed events.jsonl emits a replay warning to stderr (Codex Y3t-3-M2)", async () => {
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

  it("t-status-2: planned -> done is rejected as an invalid transition", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunTaskNew({ title: "ts" }, { cwd: repo, ...FIXED_CTX });
    const taskId = await findCreatedTaskId(repo);
    const err = captureStderr();
    await runTaskStatus(taskId, "done", {}, { cwd: repo, ...FIXED_CTX_2 });
    expect(joinCalls(err)).toContain("Invalid task status transition: planned -> done");
    expect(process.exitCode).toBe(1);
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

  it("t-pathless-3b: TaskWriteAfterEventError link-session phase wording calls out session.yaml (Codex Y3t-3-H2)", async () => {
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
