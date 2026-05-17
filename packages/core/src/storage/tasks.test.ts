import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import type { PrefixedId } from "../ids/ulid.js";
import type { Manifest } from "../schemas/manifest.schema.js";
import { type BasouPaths, ensureBasouDirectory } from "./basou-dir.js";
import {
  TaskWriteAfterEventError,
  createTaskWithEvent,
  enumerateTaskIds,
  loadTaskEntries,
  readTaskFile,
  reconcileAllTasks,
  reconcileTask,
  updateTaskStatusWithEvent,
  writeTaskFile,
} from "./tasks.js";
import { overwriteYamlFile, writeYamlFile } from "./yaml-store.js";

vi.mock("./yaml-store.js", async () => {
  const actual = await vi.importActual<typeof import("./yaml-store.js")>("./yaml-store.js");
  return {
    ...actual,
    overwriteYamlFile: vi.fn(actual.overwriteYamlFile),
  };
});

const WS_ID = "ws_01HXABCDEF1234567890ABCWS1" as const;
const TASK_ID_A = "task_01HXABCDEF1234567890ABCTAK" as PrefixedId<"task">;
const TASK_ID_B = "task_01HXABCDEF1234567890ABCTBK" as PrefixedId<"task">;
const SES_ID_RUNNING = "ses_01HXABCDEF1234567890ABCRNG" as PrefixedId<"ses">;
const SES_ID_COMPLETED = "ses_01HXABCDEF1234567890ABCCMP" as PrefixedId<"ses">;
const SES_ID_OTHER = "ses_01HXABCDEF1234567890ABCTHR" as PrefixedId<"ses">;
const OCC_AT = "2026-05-11T12:00:00+09:00";

let workDir: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "basou-tasks-test-"));
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

async function setupPaths(): Promise<BasouPaths> {
  return ensureBasouDirectory(getWorkDir());
}

function makeManifest(): Manifest {
  return {
    schema_version: "0.1.0",
    basou_version: "0.1.0",
    workspace: {
      id: WS_ID,
      name: "test-workspace",
      created_at: OCC_AT,
      updated_at: OCC_AT,
    },
    project: {},
    capabilities: { enabled: [] },
    approval: { default_risk_level: "low" },
    adapters: { "claude-code": { enabled: false } },
    git: { events_log: "ignore" },
  };
}

function makeRawTaskMd(overrides: Record<string, unknown> = {}): string {
  const yaml = stringifyYaml({
    schema_version: "0.1.0",
    task: {
      id: TASK_ID_A,
      title: "fixture task",
      status: "planned",
      created_at: OCC_AT,
      updated_at: OCC_AT,
      workspace_id: WS_ID,
      created_in_session: SES_ID_RUNNING,
      linked_sessions: [SES_ID_RUNNING],
      ...overrides,
    },
  });
  return `---\n${yaml}---\n\nfixture body\n`;
}

async function placeRunningSession(
  paths: BasouPaths,
  sessionId: PrefixedId<"ses">,
  options: { taskId?: PrefixedId<"task"> | null; status?: string } = {},
): Promise<void> {
  const sessionDir = join(paths.sessions, sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeYamlFile(join(sessionDir, "session.yaml"), {
    schema_version: "0.1.0",
    session: {
      id: sessionId,
      label: "test session",
      task_id: options.taskId ?? null,
      workspace_id: WS_ID,
      source: { kind: "terminal", version: "0.1.0" },
      started_at: OCC_AT,
      status: options.status ?? "running",
      working_directory: getWorkDir(),
      invocation: { command: "echo", args: [], exit_code: null },
      related_files: [],
      events_log: "events.jsonl",
    },
  });
  await writeFile(join(sessionDir, "events.jsonl"), "");
}

// ============================================================================
// readTaskFile / writeTaskFile
// ============================================================================

describe("readTaskFile", () => {
  it("parses a valid task.md with front matter and body", async () => {
    const paths = await setupPaths();
    await writeFile(join(paths.tasks, `${TASK_ID_A}.md`), makeRawTaskMd());
    const doc = await readTaskFile(paths, TASK_ID_A);
    expect(doc.task.task.id).toBe(TASK_ID_A);
    expect(doc.body).toBe("fixture body\n");
  });

  it("rejects a BOM-prefixed task.md (Codex Y3t-M3)", async () => {
    const paths = await setupPaths();
    await writeFile(join(paths.tasks, `${TASK_ID_A}.md`), `﻿${makeRawTaskMd()}`);
    await expect(readTaskFile(paths, TASK_ID_A)).rejects.toThrow("Invalid task file format");
  });

  it("normalises CRLF to LF before delimiter scanning", async () => {
    const paths = await setupPaths();
    const crlf = makeRawTaskMd().replace(/\n/g, "\r\n");
    await writeFile(join(paths.tasks, `${TASK_ID_A}.md`), crlf);
    const doc = await readTaskFile(paths, TASK_ID_A);
    expect(doc.task.task.id).toBe(TASK_ID_A);
  });

  it("ignores '---' lines that appear inside the markdown body", async () => {
    const paths = await setupPaths();
    const yaml = stringifyYaml({
      schema_version: "0.1.0",
      task: {
        id: TASK_ID_A,
        title: "with markers in body",
        status: "planned",
        created_at: OCC_AT,
        updated_at: OCC_AT,
        workspace_id: WS_ID,
        created_in_session: SES_ID_RUNNING,
        linked_sessions: [SES_ID_RUNNING],
      },
    });
    const raw = `---\n${yaml}---\n\nintro\n\n---\nmore body\n`;
    await writeFile(join(paths.tasks, `${TASK_ID_A}.md`), raw);
    const doc = await readTaskFile(paths, TASK_ID_A);
    expect(doc.body).toContain("---");
    expect(doc.body).toContain("more body");
  });

  it("throws Task file not found for ENOENT", async () => {
    const paths = await setupPaths();
    await expect(readTaskFile(paths, TASK_ID_A)).rejects.toThrow("Task file not found");
  });

  it("throws Invalid task file format when the opening delimiter is missing", async () => {
    const paths = await setupPaths();
    await writeFile(join(paths.tasks, `${TASK_ID_A}.md`), "no front matter here\n");
    await expect(readTaskFile(paths, TASK_ID_A)).rejects.toThrow("Invalid task file format");
  });

  it("throws Failed to read task file when the YAML fails schema validation", async () => {
    const paths = await setupPaths();
    // title is required + must be non-empty
    await writeFile(join(paths.tasks, `${TASK_ID_A}.md`), makeRawTaskMd({ title: "" }));
    await expect(readTaskFile(paths, TASK_ID_A)).rejects.toThrow("Failed to read task file");
  });
});

describe("writeTaskFile", () => {
  it("creates a new task.md with the create mode", async () => {
    const paths = await setupPaths();
    await writeTaskFile(
      paths,
      TASK_ID_A,
      {
        task: {
          schema_version: "0.1.0",
          task: {
            id: TASK_ID_A,
            title: "hello",
            status: "planned",
            created_at: OCC_AT,
            updated_at: OCC_AT,
            workspace_id: WS_ID,
            created_in_session: SES_ID_RUNNING,
            linked_sessions: [SES_ID_RUNNING],
          },
        },
        body: "body text",
      },
      { mode: "create" },
    );
    const raw = await readFile(join(paths.tasks, `${TASK_ID_A}.md`), "utf8");
    expect(raw.startsWith("---\n")).toBe(true);
    expect(raw).toContain("body text");
  });

  it("rejects collisions in create mode with the fixed message", async () => {
    const paths = await setupPaths();
    await writeFile(join(paths.tasks, `${TASK_ID_A}.md`), makeRawTaskMd());
    await expect(
      writeTaskFile(
        paths,
        TASK_ID_A,
        {
          task: {
            schema_version: "0.1.0",
            task: {
              id: TASK_ID_A,
              title: "second",
              status: "planned",
              created_at: OCC_AT,
              updated_at: OCC_AT,
              workspace_id: WS_ID,
              created_in_session: SES_ID_RUNNING,
              linked_sessions: [SES_ID_RUNNING],
            },
          },
          body: "",
        },
        { mode: "create" },
      ),
    ).rejects.toThrow("Task file already exists");
  });

  it("overwrites an existing task.md in overwrite mode", async () => {
    const paths = await setupPaths();
    await writeFile(join(paths.tasks, `${TASK_ID_A}.md`), makeRawTaskMd());
    await writeTaskFile(
      paths,
      TASK_ID_A,
      {
        task: {
          schema_version: "0.1.0",
          task: {
            id: TASK_ID_A,
            title: "fixture task",
            status: "in_progress",
            created_at: OCC_AT,
            updated_at: OCC_AT,
            workspace_id: WS_ID,
            created_in_session: SES_ID_RUNNING,
            linked_sessions: [SES_ID_RUNNING],
          },
        },
        body: "",
      },
      { mode: "overwrite" },
    );
    const raw = await readFile(join(paths.tasks, `${TASK_ID_A}.md`), "utf8");
    expect(raw).toContain("status: in_progress");
  });

  it("does not leak the tmp file after a successful create write", async () => {
    const paths = await setupPaths();
    await writeTaskFile(
      paths,
      TASK_ID_A,
      {
        task: {
          schema_version: "0.1.0",
          task: {
            id: TASK_ID_A,
            title: "tmp leak guard",
            status: "planned",
            created_at: OCC_AT,
            updated_at: OCC_AT,
            workspace_id: WS_ID,
            created_in_session: SES_ID_RUNNING,
            linked_sessions: [SES_ID_RUNNING],
          },
        },
        body: "",
      },
      { mode: "create" },
    );
    const entries = await readdir(paths.tasks);
    const tmpFiles = entries.filter((e) => e.includes(".tmp."));
    expect(tmpFiles).toEqual([]);
  });
});

// ============================================================================
// enumerateTaskIds / loadTaskEntries
// ============================================================================

describe("enumerateTaskIds", () => {
  it("returns an empty list when the tasks directory is empty", async () => {
    const paths = await setupPaths();
    expect(await enumerateTaskIds(paths)).toEqual([]);
  });

  it("returns an empty list when the tasks directory does not exist", async () => {
    // Don't run ensureBasouDirectory: paths.tasks is missing.
    const paths = (await setupPaths()) as BasouPaths;
    await rm(paths.tasks, { recursive: true, force: true });
    expect(await enumerateTaskIds(paths)).toEqual([]);
  });

  it("skips files whose names are not valid task ids (Codex Y3t-M5)", async () => {
    const paths = await setupPaths();
    await writeFile(join(paths.tasks, "task_bad.md"), "junk");
    await writeFile(join(paths.tasks, "README.md"), "junk");
    await writeFile(join(paths.tasks, "other.json"), "junk");
    await writeFile(join(paths.tasks, `${TASK_ID_A}.md`), makeRawTaskMd());
    const ids = await enumerateTaskIds(paths);
    expect(ids).toEqual([TASK_ID_A]);
  });

  it("returns ids in ULID-ascending order", async () => {
    const paths = await setupPaths();
    await writeFile(join(paths.tasks, `${TASK_ID_B}.md`), makeRawTaskMd({ id: TASK_ID_B }));
    await writeFile(join(paths.tasks, `${TASK_ID_A}.md`), makeRawTaskMd());
    const ids = await enumerateTaskIds(paths);
    expect(ids).toEqual([TASK_ID_A, TASK_ID_B]);
  });
});

describe("loadTaskEntries", () => {
  it("returns valid documents and surfaces invalid files via onSkip", async () => {
    const paths = await setupPaths();
    await writeFile(join(paths.tasks, `${TASK_ID_A}.md`), makeRawTaskMd());
    await writeFile(join(paths.tasks, `${TASK_ID_B}.md`), "no front matter\n");
    const skips: Array<[string, string]> = [];
    const entries = await loadTaskEntries(paths, {
      onSkip: (id, reason) => skips.push([id, reason]),
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.task.task.id).toBe(TASK_ID_A);
    expect(skips).toContainEqual([TASK_ID_B, "task_file_invalid"]);
  });

  it("sorts entries by created_at ascending", async () => {
    const paths = await setupPaths();
    await writeFile(
      join(paths.tasks, `${TASK_ID_A}.md`),
      makeRawTaskMd({ created_at: "2026-05-04T09:00:00+09:00" }),
    );
    await writeFile(
      join(paths.tasks, `${TASK_ID_B}.md`),
      makeRawTaskMd({ id: TASK_ID_B, created_at: "2026-05-03T09:00:00+09:00" }),
    );
    const entries = await loadTaskEntries(paths);
    expect(entries.map((e) => e.task.task.id)).toEqual([TASK_ID_B, TASK_ID_A]);
  });
});

// ============================================================================
// createTaskWithEvent
// ============================================================================

describe("createTaskWithEvent (ad-hoc)", () => {
  it("writes 5 lifecycle events + the task_created target and creates task.md", async () => {
    const paths = await setupPaths();
    const result = await createTaskWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: OCC_AT,
      taskId: TASK_ID_A,
      title: "first task",
      initialStatus: "planned",
      description: "background section",
      workingDirectory: getWorkDir(),
    });
    expect(result.taskId).toBe(TASK_ID_A);
    expect(result.sessionStatus).toBe("completed");
    const doc = await readTaskFile(paths, TASK_ID_A);
    expect(doc.task.task.status).toBe("planned");
    expect(doc.task.task.created_in_session).toBe(result.sessionId);
    expect(doc.body).toContain("background section");

    const events = (await readFile(join(paths.sessions, result.sessionId, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.map((e) => e.type)).toEqual([
      "session_started",
      "session_status_changed",
      "task_created",
      "session_status_changed",
      "session_ended",
    ]);

    const yaml = await readFile(join(paths.sessions, result.sessionId, "session.yaml"), "utf8");
    expect(yaml).toContain(`task_id: ${TASK_ID_A}`);
  });

  it("starts the task in_progress without firing task_status_changed", async () => {
    const paths = await setupPaths();
    const result = await createTaskWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: OCC_AT,
      taskId: TASK_ID_A,
      title: "in-flight task",
      initialStatus: "in_progress",
      description: "",
      workingDirectory: getWorkDir(),
    });
    const doc = await readTaskFile(paths, TASK_ID_A);
    expect(doc.task.task.status).toBe("in_progress");
    const events = (await readFile(join(paths.sessions, result.sessionId, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.filter((e) => e.type === "task_status_changed")).toHaveLength(0);
  });

  it("starts the task done by emitting task_created + task_status_changed in the same ad-hoc session", async () => {
    const paths = await setupPaths();
    const completedAt = "2026-05-10T12:34:56+09:00";
    const result = await createTaskWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: OCC_AT,
      taskId: TASK_ID_A,
      title: "retro done",
      initialStatus: "done",
      description: "",
      workingDirectory: getWorkDir(),
      completedAt,
    });
    const doc = await readTaskFile(paths, TASK_ID_A);
    expect(doc.task.task.status).toBe("done");
    // task.md.updated_at reflects the backdated completion time while
    // created_at stays at the ad-hoc session timestamp.
    expect(doc.task.task.updated_at).toBe(completedAt);
    expect(doc.task.task.created_at).toBe(OCC_AT);
    const events = (await readFile(join(paths.sessions, result.sessionId, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.map((e) => e.type)).toEqual([
      "session_started",
      "session_status_changed",
      "task_created",
      "task_status_changed",
      "session_status_changed",
      "session_ended",
    ]);
    // All events share the recording time (occurred_at = OCC_AT); the
    // backdated completion time is only reflected in task.md.updated_at.
    for (const e of events) {
      expect(e.occurred_at).toBe(OCC_AT);
    }
    expect(events[3]).toMatchObject({ from: "planned", to: "done", task_id: TASK_ID_A });
  });

  it("starts the task cancelled with a 2-event audit trail", async () => {
    const paths = await setupPaths();
    const result = await createTaskWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: OCC_AT,
      taskId: TASK_ID_A,
      title: "abandoned",
      initialStatus: "cancelled",
      description: "",
      workingDirectory: getWorkDir(),
    });
    const doc = await readTaskFile(paths, TASK_ID_A);
    expect(doc.task.task.status).toBe("cancelled");
    // No completedAt supplied -> updated_at falls back to occurredAt.
    expect(doc.task.task.updated_at).toBe(OCC_AT);
    const events = (await readFile(join(paths.sessions, result.sessionId, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.filter((e) => e.type === "task_status_changed")).toHaveLength(1);
    expect(events.find((e) => e.type === "task_status_changed")).toMatchObject({
      from: "planned",
      to: "cancelled",
    });
  });

  it("ignores completedAt for non-terminal initialStatus (planned)", async () => {
    const paths = await setupPaths();
    await createTaskWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: OCC_AT,
      taskId: TASK_ID_A,
      title: "still planned",
      initialStatus: "planned",
      description: "",
      workingDirectory: getWorkDir(),
      // A direct caller might supply a stray completedAt; the orchestrator
      // must NOT honor it for a non-terminal status — task.md.updated_at
      // stays pinned to occurredAt so a non-completed task cannot be
      // backdated by accident.
      completedAt: "2026-05-10T12:34:56+09:00",
    });
    const doc = await readTaskFile(paths, TASK_ID_A);
    expect(doc.task.task.updated_at).toBe(OCC_AT);
  });
});

describe("createTaskWithEvent (attach)", () => {
  it("appends task_created and pins session.yaml.task_id", async () => {
    const paths = await setupPaths();
    await placeRunningSession(paths, SES_ID_RUNNING);
    const result = await createTaskWithEvent({
      mode: "attach",
      paths,
      occurredAt: OCC_AT,
      sessionId: SES_ID_RUNNING,
      taskId: TASK_ID_A,
      title: "attached task",
      initialStatus: "planned",
      description: "",
    });
    expect(result.sessionId).toBe(SES_ID_RUNNING);
    const yaml = await readFile(join(paths.sessions, SES_ID_RUNNING, "session.yaml"), "utf8");
    expect(yaml).toContain(`task_id: ${TASK_ID_A}`);
    const events = (await readFile(join(paths.sessions, SES_ID_RUNNING, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("task_created");
  });

  it("rejects attach when the session is already linked to a different task", async () => {
    const paths = await setupPaths();
    await placeRunningSession(paths, SES_ID_RUNNING, { taskId: TASK_ID_B });
    await expect(
      createTaskWithEvent({
        mode: "attach",
        paths,
        occurredAt: OCC_AT,
        sessionId: SES_ID_RUNNING,
        taskId: TASK_ID_A,
        title: "x",
        initialStatus: "planned",
        description: "",
      }),
    ).rejects.toThrow(`Session already linked to a different task: ${TASK_ID_B}`);
  });

  it("rejects attach when the target session is completed", async () => {
    const paths = await setupPaths();
    await placeRunningSession(paths, SES_ID_COMPLETED, { status: "completed" });
    await expect(
      createTaskWithEvent({
        mode: "attach",
        paths,
        occurredAt: OCC_AT,
        sessionId: SES_ID_COMPLETED,
        taskId: TASK_ID_A,
        title: "x",
        initialStatus: "planned",
        description: "",
      }),
    ).rejects.toThrow("Session is not active: completed");
  });

  it("rejects attach when the session is already linked to the same task (duplicate)", async () => {
    const paths = await setupPaths();
    await placeRunningSession(paths, SES_ID_RUNNING, { taskId: TASK_ID_A });
    await expect(
      createTaskWithEvent({
        mode: "attach",
        paths,
        occurredAt: OCC_AT,
        sessionId: SES_ID_RUNNING,
        taskId: TASK_ID_A,
        title: "x",
        initialStatus: "planned",
        description: "",
      }),
    ).rejects.toThrow(`Task already exists: ${TASK_ID_A}`);
  });

  it("attach with terminal initialStatus appends both task_created and task_status_changed", async () => {
    const paths = await setupPaths();
    await placeRunningSession(paths, SES_ID_RUNNING);
    const completedAt = "2026-05-09T10:00:00+09:00";
    await createTaskWithEvent({
      mode: "attach",
      paths,
      occurredAt: OCC_AT,
      sessionId: SES_ID_RUNNING,
      taskId: TASK_ID_A,
      title: "attached done",
      initialStatus: "done",
      description: "",
      completedAt,
    });
    const events = (await readFile(join(paths.sessions, SES_ID_RUNNING, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    // Two events in order: task_created followed by task_status_changed
    // (planned → done). The lifecycle events live on the parent session and
    // are NOT minted here because attach paths reuse an existing session.
    expect(events.map((e) => e.type)).toEqual(["task_created", "task_status_changed"]);
    expect(events[1]).toMatchObject({ from: "planned", to: "done", task_id: TASK_ID_A });
    const doc = await readTaskFile(paths, TASK_ID_A);
    expect(doc.task.task.status).toBe("done");
    expect(doc.task.task.updated_at).toBe(completedAt);
    const yaml = await readFile(join(paths.sessions, SES_ID_RUNNING, "session.yaml"), "utf8");
    expect(yaml).toContain(`task_id: ${TASK_ID_A}`);
  });
});

// ============================================================================
// updateTaskStatusWithEvent
// ============================================================================

describe("updateTaskStatusWithEvent (transition rules)", () => {
  it("allows planned -> in_progress (ad-hoc)", async () => {
    const paths = await setupPaths();
    await createTaskWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: OCC_AT,
      taskId: TASK_ID_A,
      title: "transitions",
      initialStatus: "planned",
      description: "",
      workingDirectory: getWorkDir(),
    });
    const result = await updateTaskStatusWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: "2026-05-12T12:00:00+09:00",
      taskId: TASK_ID_A,
      newStatus: "in_progress",
      workingDirectory: getWorkDir(),
    });
    expect(result.previousStatus).toBe("planned");
    expect(result.newStatus).toBe("in_progress");
    const doc = await readTaskFile(paths, TASK_ID_A);
    expect(doc.task.task.status).toBe("in_progress");
    expect(doc.task.task.updated_at).toBe("2026-05-12T12:00:00+09:00");
    expect(doc.task.task.linked_sessions).toHaveLength(2);
  });

  it("allows planned -> done directly (Y-3z #59 / B-B3 shortcut)", async () => {
    // Y-3z #59 lifts the prior `planned -> in_progress -> done` two-step
    // requirement so a task that finished without an explicit in-progress
    // phase can close in a single CLI call. The 1 transition = 1 event
    // invariant is preserved — the resulting task.md records a single
    // `task_status_changed` event with from=planned / to=done.
    const paths = await setupPaths();
    await createTaskWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: OCC_AT,
      taskId: TASK_ID_A,
      title: "transitions",
      initialStatus: "planned",
      description: "",
      workingDirectory: getWorkDir(),
    });
    const result = await updateTaskStatusWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: "2026-05-17T12:00:00+09:00",
      taskId: TASK_ID_A,
      newStatus: "done",
      workingDirectory: getWorkDir(),
    });
    expect(result.previousStatus).toBe("planned");
    expect(result.newStatus).toBe("done");
    const doc = await readTaskFile(paths, TASK_ID_A);
    expect(doc.task.task.status).toBe("done");
  });

  it("allows planned -> cancelled directly (Y-3z #59 / B-B3 shortcut)", async () => {
    const paths = await setupPaths();
    await createTaskWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: OCC_AT,
      taskId: TASK_ID_A,
      title: "transitions",
      initialStatus: "planned",
      description: "",
      workingDirectory: getWorkDir(),
    });
    const result = await updateTaskStatusWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: "2026-05-17T12:00:00+09:00",
      taskId: TASK_ID_A,
      newStatus: "cancelled",
      workingDirectory: getWorkDir(),
    });
    expect(result.previousStatus).toBe("planned");
    expect(result.newStatus).toBe("cancelled");
    const doc = await readTaskFile(paths, TASK_ID_A);
    expect(doc.task.task.status).toBe("cancelled");
  });

  it("still rejects planned -> planned (no-op self-transition)", async () => {
    // Y-3z #59 only adds the two terminal shortcuts; the self-edge from
    // planned to planned is still disallowed so the audit trail stays
    // strictly monotonic in the status field.
    const paths = await setupPaths();
    await createTaskWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: OCC_AT,
      taskId: TASK_ID_A,
      title: "transitions",
      initialStatus: "planned",
      description: "",
      workingDirectory: getWorkDir(),
    });
    await expect(
      updateTaskStatusWithEvent({
        mode: "ad-hoc",
        paths,
        manifest: makeManifest(),
        occurredAt: OCC_AT,
        taskId: TASK_ID_A,
        newStatus: "planned",
        workingDirectory: getWorkDir(),
      }),
    ).rejects.toThrow("Invalid task status transition: planned -> planned");
  });

  it("rejects done -> done (no-op idempotent)", async () => {
    const paths = await setupPaths();
    await createTaskWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: OCC_AT,
      taskId: TASK_ID_A,
      title: "x",
      initialStatus: "in_progress",
      description: "",
      workingDirectory: getWorkDir(),
    });
    await updateTaskStatusWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: OCC_AT,
      taskId: TASK_ID_A,
      newStatus: "done",
      workingDirectory: getWorkDir(),
    });
    await expect(
      updateTaskStatusWithEvent({
        mode: "ad-hoc",
        paths,
        manifest: makeManifest(),
        occurredAt: OCC_AT,
        taskId: TASK_ID_A,
        newStatus: "done",
        workingDirectory: getWorkDir(),
      }),
    ).rejects.toThrow("Invalid task status transition: done -> done");
  });

  it("rejects in_progress -> in_progress (self-edge regression)", async () => {
    // Self-edges in every status row are disallowed so a no-op CLI call
    // still surfaces an error rather than appending a duplicate event.
    const paths = await setupPaths();
    await createTaskWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: OCC_AT,
      taskId: TASK_ID_A,
      title: "x",
      initialStatus: "in_progress",
      description: "",
      workingDirectory: getWorkDir(),
    });
    await expect(
      updateTaskStatusWithEvent({
        mode: "ad-hoc",
        paths,
        manifest: makeManifest(),
        occurredAt: OCC_AT,
        taskId: TASK_ID_A,
        newStatus: "in_progress",
        workingDirectory: getWorkDir(),
      }),
    ).rejects.toThrow("Invalid task status transition: in_progress -> in_progress");
  });

  it("rejects cancelled -> cancelled (terminal self-edge regression)", async () => {
    // cancelled is terminal — re-cancelling must reject so the audit
    // trail does not gain a no-op event.
    const paths = await setupPaths();
    await createTaskWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: OCC_AT,
      taskId: TASK_ID_A,
      title: "x",
      initialStatus: "planned",
      description: "",
      workingDirectory: getWorkDir(),
    });
    // planned -> cancelled is now a direct shortcut (B-B3), used here only
    // to land the task in `cancelled` before we probe the self-edge.
    await updateTaskStatusWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: OCC_AT,
      taskId: TASK_ID_A,
      newStatus: "cancelled",
      workingDirectory: getWorkDir(),
    });
    await expect(
      updateTaskStatusWithEvent({
        mode: "ad-hoc",
        paths,
        manifest: makeManifest(),
        occurredAt: OCC_AT,
        taskId: TASK_ID_A,
        newStatus: "cancelled",
        workingDirectory: getWorkDir(),
      }),
    ).rejects.toThrow("Invalid task status transition: cancelled -> cancelled");
  });

  it("dedups linked_sessions when the same session changes status twice", async () => {
    const paths = await setupPaths();
    await placeRunningSession(paths, SES_ID_RUNNING);
    await createTaskWithEvent({
      mode: "attach",
      paths,
      occurredAt: OCC_AT,
      sessionId: SES_ID_RUNNING,
      taskId: TASK_ID_A,
      title: "x",
      initialStatus: "in_progress",
      description: "",
    });
    await updateTaskStatusWithEvent({
      mode: "attach",
      paths,
      occurredAt: "2026-05-12T12:00:00+09:00",
      sessionId: SES_ID_RUNNING,
      taskId: TASK_ID_A,
      newStatus: "done",
    });
    const doc = await readTaskFile(paths, TASK_ID_A);
    expect(doc.task.task.linked_sessions).toEqual([SES_ID_RUNNING]);
    expect(doc.task.task.status).toBe("done");
  });
});

describe("updateTaskStatusWithEvent (attach guards)", () => {
  it("rejects when the attach session is not linked to the task", async () => {
    const paths = await setupPaths();
    await createTaskWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: OCC_AT,
      taskId: TASK_ID_A,
      title: "x",
      initialStatus: "planned",
      description: "",
      workingDirectory: getWorkDir(),
    });
    await placeRunningSession(paths, SES_ID_OTHER); // task_id: null
    await expect(
      updateTaskStatusWithEvent({
        mode: "attach",
        paths,
        occurredAt: OCC_AT,
        sessionId: SES_ID_OTHER,
        taskId: TASK_ID_A,
        newStatus: "in_progress",
      }),
    ).rejects.toThrow(`Session is not linked to task: ${TASK_ID_A}`);
  });

  it("rejects when the attach session is linked to a different task", async () => {
    const paths = await setupPaths();
    await createTaskWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: OCC_AT,
      taskId: TASK_ID_A,
      title: "x",
      initialStatus: "planned",
      description: "",
      workingDirectory: getWorkDir(),
    });
    await placeRunningSession(paths, SES_ID_OTHER, { taskId: TASK_ID_B });
    await expect(
      updateTaskStatusWithEvent({
        mode: "attach",
        paths,
        occurredAt: OCC_AT,
        sessionId: SES_ID_OTHER,
        taskId: TASK_ID_A,
        newStatus: "in_progress",
      }),
    ).rejects.toThrow(`Session already linked to a different task: ${TASK_ID_B}`);
  });
});

// ============================================================================
// TaskWriteAfterEventError surface
// ============================================================================

describe("TaskWriteAfterEventError", () => {
  it("carries the phase and ids of the failed write", () => {
    const err = new TaskWriteAfterEventError({
      taskId: TASK_ID_A,
      eventId: "evt_01HXABCDEF1234567890ABCEVT" as PrefixedId<"evt">,
      sessionId: SES_ID_RUNNING,
      phase: "create",
      cause: new Error("simulated"),
    });
    expect(err.taskId).toBe(TASK_ID_A);
    expect(err.phase).toBe("create");
    expect(err.message).toBe("Failed to write task file after event was persisted");
  });
});

// ============================================================================
// Codex Y3t-3-H1: boundary validation
// ============================================================================

describe("createTaskWithEvent boundary validation (Codex Y3t-3-H1)", () => {
  it("rejects an unknown initialStatus before any event is written (ad-hoc)", async () => {
    // `done` and `cancelled` are now accepted (the orchestrator emits a
    // follow-up `task_status_changed` for terminal initial statuses); the
    // boundary parser still rejects truly invalid values like the string
    // below so a direct caller bypassing the CLI parser cannot smuggle a
    // garbage status past the runtime guard.
    const paths = await setupPaths();
    await expect(
      createTaskWithEvent({
        mode: "ad-hoc",
        paths,
        manifest: makeManifest(),
        occurredAt: OCC_AT,
        taskId: TASK_ID_A,
        title: "smuggled-garbage",
        // biome-ignore lint/suspicious/noExplicitAny: simulating a direct caller bypassing the CLI parser to verify the runtime boundary.
        initialStatus: "totally-not-a-status" as any,
        description: "",
        workingDirectory: getWorkDir(),
      }),
    ).rejects.toThrow();
    const sessionDirs = await readdir(paths.sessions);
    expect(sessionDirs.filter((d) => d.startsWith("ses_"))).toHaveLength(0);
    const taskFiles = await readdir(paths.tasks);
    expect(taskFiles).toHaveLength(0);
  });

  it("rejects an empty title before any event is written (ad-hoc)", async () => {
    const paths = await setupPaths();
    await expect(
      createTaskWithEvent({
        mode: "ad-hoc",
        paths,
        manifest: makeManifest(),
        occurredAt: OCC_AT,
        taskId: TASK_ID_A,
        title: "",
        initialStatus: "planned",
        description: "",
        workingDirectory: getWorkDir(),
      }),
    ).rejects.toThrow();
    const sessionDirs = await readdir(paths.sessions);
    expect(sessionDirs.filter((d) => d.startsWith("ses_"))).toHaveLength(0);
  });

  it("rejects an invalid completedAt before any event is written (ad-hoc)", async () => {
    // A direct (non-CLI) caller could supply a garbage timestamp; the
    // boundary parse must reject it before events.jsonl is written so the
    // orchestrator never leaves durable `task_created` events with no
    // schema-valid task.md to back them up.
    const paths = await setupPaths();
    await expect(
      createTaskWithEvent({
        mode: "ad-hoc",
        paths,
        manifest: makeManifest(),
        occurredAt: OCC_AT,
        taskId: TASK_ID_A,
        title: "smuggled-completedAt",
        initialStatus: "done",
        description: "",
        workingDirectory: getWorkDir(),
        completedAt: "yesterday",
      }),
    ).rejects.toThrow();
    const sessionDirs = await readdir(paths.sessions);
    expect(sessionDirs.filter((d) => d.startsWith("ses_"))).toHaveLength(0);
    const taskFiles = await readdir(paths.tasks);
    expect(taskFiles).toHaveLength(0);
  });

  it("rejects an empty label before any event is written (attach)", async () => {
    const paths = await setupPaths();
    await placeRunningSession(paths, SES_ID_RUNNING);
    await expect(
      createTaskWithEvent({
        mode: "attach",
        paths,
        occurredAt: OCC_AT,
        sessionId: SES_ID_RUNNING,
        taskId: TASK_ID_A,
        title: "ok-title",
        label: "",
        initialStatus: "planned",
        description: "",
      }),
    ).rejects.toThrow();
    const events = await readFile(join(paths.sessions, SES_ID_RUNNING, "events.jsonl"), "utf8");
    expect(events).toBe("");
  });
});

// ============================================================================
// Codex Y3t-3-H2 + Y3t-3-M3: staged-write failure injection
// ============================================================================

describe("staged-write failure injection (Codex Y3t-3-H2 / Y3t-3-M3)", () => {
  async function chmodTasksReadonly(paths: BasouPaths): Promise<void> {
    await chmod(paths.tasks, 0o555);
  }
  async function chmodTasksWritable(paths: BasouPaths): Promise<void> {
    await chmod(paths.tasks, 0o755);
  }
  // Type guards so we don't reach into TS-unsafe casts every time.

  it("ad-hoc create: events durable when task.md write fails (phase: 'create')", async () => {
    const paths = await setupPaths();
    await chmodTasksReadonly(paths);
    let captured: TaskWriteAfterEventError | undefined;
    try {
      await createTaskWithEvent({
        mode: "ad-hoc",
        paths,
        manifest: makeManifest(),
        occurredAt: OCC_AT,
        taskId: TASK_ID_A,
        title: "fail-task-md",
        initialStatus: "planned",
        description: "",
        workingDirectory: getWorkDir(),
      });
    } catch (error: unknown) {
      if (error instanceof TaskWriteAfterEventError) captured = error;
      else throw error;
    } finally {
      await chmodTasksWritable(paths);
    }
    expect(captured).toBeInstanceOf(TaskWriteAfterEventError);
    expect(captured?.phase).toBe("create");
    expect(captured?.taskId).toBe(TASK_ID_A);
    const events = (
      await readFile(join(paths.sessions, captured?.sessionId as string, "events.jsonl"), "utf8")
    )
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.some((e) => e.type === "task_created" && e.task_id === TASK_ID_A)).toBe(true);
  });

  it("attach create: events durable when task.md write fails (phase: 'create')", async () => {
    const paths = await setupPaths();
    await placeRunningSession(paths, SES_ID_RUNNING);
    await chmodTasksReadonly(paths);
    let captured: TaskWriteAfterEventError | undefined;
    try {
      await createTaskWithEvent({
        mode: "attach",
        paths,
        occurredAt: OCC_AT,
        sessionId: SES_ID_RUNNING,
        taskId: TASK_ID_A,
        title: "attach-fail",
        initialStatus: "planned",
        description: "",
      });
    } catch (error: unknown) {
      if (error instanceof TaskWriteAfterEventError) captured = error;
      else throw error;
    } finally {
      await chmodTasksWritable(paths);
    }
    expect(captured?.phase).toBe("create");
    expect(captured?.sessionId).toBe(SES_ID_RUNNING);
    const events = (await readFile(join(paths.sessions, SES_ID_RUNNING, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("task_created");
  });

  it("attach create: events durable when session.yaml link fails (phase: 'link-session')", async () => {
    const paths = await setupPaths();
    await placeRunningSession(paths, SES_ID_RUNNING);
    vi.mocked(overwriteYamlFile).mockImplementationOnce(async () => {
      throw new Error("Failed to overwrite YAML file", {
        cause: Object.assign(new Error("simulated EACCES"), { code: "EACCES" }),
      });
    });
    let captured: TaskWriteAfterEventError | undefined;
    try {
      await createTaskWithEvent({
        mode: "attach",
        paths,
        occurredAt: OCC_AT,
        sessionId: SES_ID_RUNNING,
        taskId: TASK_ID_A,
        title: "link-fail",
        initialStatus: "planned",
        description: "",
      });
    } catch (error: unknown) {
      if (error instanceof TaskWriteAfterEventError) captured = error;
      else throw error;
    }
    expect(captured?.phase).toBe("link-session");
    expect(captured?.taskId).toBe(TASK_ID_A);
    expect(captured?.sessionId).toBe(SES_ID_RUNNING);
    const events = (await readFile(join(paths.sessions, SES_ID_RUNNING, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("task_created");
    // task.md must NOT exist when link-session failed before task.md write.
    const taskFiles = await readdir(paths.tasks);
    expect(taskFiles).toHaveLength(0);
  });

  it("ad-hoc status overwrite: events durable when task.md overwrite fails (phase: 'overwrite')", async () => {
    const paths = await setupPaths();
    // First create the task successfully so a subsequent status change has a
    // task.md to overwrite.
    await createTaskWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: OCC_AT,
      taskId: TASK_ID_A,
      title: "to-progress",
      initialStatus: "planned",
      description: "",
      workingDirectory: getWorkDir(),
    });
    await chmodTasksReadonly(paths);
    let captured: TaskWriteAfterEventError | undefined;
    try {
      await updateTaskStatusWithEvent({
        mode: "ad-hoc",
        paths,
        manifest: makeManifest(),
        occurredAt: "2026-05-11T13:00:00+09:00",
        taskId: TASK_ID_A,
        newStatus: "in_progress",
        workingDirectory: getWorkDir(),
      });
    } catch (error: unknown) {
      if (error instanceof TaskWriteAfterEventError) captured = error;
      else throw error;
    } finally {
      await chmodTasksWritable(paths);
    }
    expect(captured?.phase).toBe("overwrite");
    const events = (
      await readFile(join(paths.sessions, captured?.sessionId as string, "events.jsonl"), "utf8")
    )
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.some((e) => e.type === "task_status_changed" && e.to === "in_progress")).toBe(
      true,
    );
  });
});

// ============================================================================
// reconcile (Y-3w / Step 19)
// ============================================================================

// ULID body: first char 0-7, remaining 25 chars Crockford (excludes I/L/O/U).
const BROKEN_SES_A = "ses_01HXBRKENABCDEFGH1234567B1" as PrefixedId<"ses">; // 26 body chars
const BROKEN_SES_B = "ses_01HXBRKENABCDEFGH1234567B2" as PrefixedId<"ses">;
const REACHABLE_SES_A = "ses_01HXREACHABE12345678REKC11" as PrefixedId<"ses">;
const REACHABLE_SES_B = "ses_01HXREACHABE12345678REKC22" as PrefixedId<"ses">;

async function placeTaskFile(
  paths: BasouPaths,
  taskId: PrefixedId<"task">,
  fields: {
    createdInSession: PrefixedId<"ses">;
    linkedSessions: ReadonlyArray<PrefixedId<"ses">>;
    title?: string;
  },
): Promise<void> {
  const yaml = stringifyYaml({
    schema_version: "0.1.0",
    task: {
      id: taskId,
      title: fields.title ?? "fixture task",
      status: "planned",
      created_at: OCC_AT,
      updated_at: OCC_AT,
      workspace_id: WS_ID,
      created_in_session: fields.createdInSession,
      linked_sessions: [...fields.linkedSessions],
    },
  });
  await writeFile(join(paths.tasks, `${taskId}.md`), `---\n${yaml}---\n\nfixture body\n`);
}

async function placeSessionDir(paths: BasouPaths, sessionId: PrefixedId<"ses">): Promise<void> {
  await mkdir(join(paths.sessions, sessionId), { recursive: true });
}

async function readReconciledEvent(
  paths: BasouPaths,
  sessionId: string,
): Promise<Record<string, unknown> | undefined> {
  const raw = await readFile(join(paths.sessions, sessionId, "events.jsonl"), "utf8");
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const ev = JSON.parse(line) as Record<string, unknown>;
    if (ev.type === "task_reconciled") return ev;
  }
  return undefined;
}

describe("reconcileTask (Step 19)", () => {
  // 1
  it("write: broken created_in_session only -> replaces + fires single event + updates task.md", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, REACHABLE_SES_A);
    await placeTaskFile(paths, TASK_ID_A, {
      createdInSession: BROKEN_SES_A,
      linkedSessions: [REACHABLE_SES_A],
    });
    const r = await reconcileTask(paths, makeManifest(), {
      taskId: TASK_ID_A,
      occurredAt: OCC_AT,
      workingDirectory: getWorkDir(),
      write: true,
    });
    expect(r.clean).toBe(false);
    expect(r.brokenCreatedInSession).toBe(BROKEN_SES_A);
    expect(r.brokenLinkedSessions).toEqual([]);
    expect(r.reconcileSession).not.toBeNull();
    const newSes = r.reconcileSession?.sessionId as string;
    const doc = await readTaskFile(paths, TASK_ID_A);
    expect(doc.task.task.created_in_session).toBe(newSes);
    expect(doc.task.task.linked_sessions).toContain(newSes);
    const ev = await readReconciledEvent(paths, newSes);
    expect(ev?.removed_created_in_session).toBe(BROKEN_SES_A);
    expect(ev?.created_in_session_replacement).toBe(newSes);
    expect(ev?.removed_linked_sessions).toEqual([]);
  });

  // 2
  it("write: broken linked_sessions only -> pops broken + appends reconcile session + fires single event", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, REACHABLE_SES_A);
    await placeTaskFile(paths, TASK_ID_A, {
      createdInSession: REACHABLE_SES_A,
      linkedSessions: [REACHABLE_SES_A, BROKEN_SES_A],
    });
    const r = await reconcileTask(paths, makeManifest(), {
      taskId: TASK_ID_A,
      occurredAt: OCC_AT,
      workingDirectory: getWorkDir(),
      write: true,
    });
    expect(r.brokenCreatedInSession).toBeNull();
    expect(r.brokenLinkedSessions).toEqual([BROKEN_SES_A]);
    const newSes = r.reconcileSession?.sessionId as string;
    const doc = await readTaskFile(paths, TASK_ID_A);
    expect(doc.task.task.created_in_session).toBe(REACHABLE_SES_A);
    expect(doc.task.task.linked_sessions).toEqual([REACHABLE_SES_A, newSes]);
    const ev = await readReconciledEvent(paths, newSes);
    expect(ev?.removed_created_in_session).toBeNull();
    expect(ev?.created_in_session_replacement).toBeNull();
    expect(ev?.removed_linked_sessions).toEqual([BROKEN_SES_A]);
  });

  // 3
  it("write: Pattern A+B (Y-3u milestone 20) records both in one event", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, REACHABLE_SES_A);
    await placeTaskFile(paths, TASK_ID_A, {
      createdInSession: BROKEN_SES_A,
      linkedSessions: [BROKEN_SES_A, REACHABLE_SES_A],
    });
    const r = await reconcileTask(paths, makeManifest(), {
      taskId: TASK_ID_A,
      occurredAt: OCC_AT,
      workingDirectory: getWorkDir(),
      write: true,
    });
    expect(r.brokenCreatedInSession).toBe(BROKEN_SES_A);
    expect(r.brokenLinkedSessions).toEqual([BROKEN_SES_A]);
    const newSes = r.reconcileSession?.sessionId as string;
    const doc = await readTaskFile(paths, TASK_ID_A);
    expect(doc.task.task.created_in_session).toBe(newSes);
    expect(doc.task.task.linked_sessions).toEqual([REACHABLE_SES_A, newSes]);
    const ev = await readReconciledEvent(paths, newSes);
    expect(ev?.removed_created_in_session).toBe(BROKEN_SES_A);
    expect(ev?.created_in_session_replacement).toBe(newSes);
    expect(ev?.removed_linked_sessions).toEqual([BROKEN_SES_A]);
  });

  // 4
  it("write: clean task returns { clean: true } without firing an event", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, REACHABLE_SES_A);
    await placeTaskFile(paths, TASK_ID_A, {
      createdInSession: REACHABLE_SES_A,
      linkedSessions: [REACHABLE_SES_A],
    });
    const r = await reconcileTask(paths, makeManifest(), {
      taskId: TASK_ID_A,
      occurredAt: OCC_AT,
      workingDirectory: getWorkDir(),
      write: true,
    });
    expect(r.clean).toBe(true);
    expect(r.reconcileSession).toBeNull();
    const sessionDirs = (await readdir(paths.sessions)).filter((d) => d !== REACHABLE_SES_A);
    expect(sessionDirs).toEqual([]);
  });

  // 5
  it("dry-run: broken refs reported, no event, task.md unchanged", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, REACHABLE_SES_A);
    await placeTaskFile(paths, TASK_ID_A, {
      createdInSession: BROKEN_SES_A,
      linkedSessions: [REACHABLE_SES_A, BROKEN_SES_B],
    });
    const before = await readFile(join(paths.tasks, `${TASK_ID_A}.md`), "utf8");
    const r = await reconcileTask(paths, makeManifest(), {
      taskId: TASK_ID_A,
      occurredAt: OCC_AT,
      workingDirectory: getWorkDir(),
      write: false,
    });
    expect(r.clean).toBe(false);
    expect(r.reconcileSession).toBeNull();
    expect(r.brokenCreatedInSession).toBe(BROKEN_SES_A);
    expect(r.brokenLinkedSessions).toEqual([BROKEN_SES_B]);
    const after = await readFile(join(paths.tasks, `${TASK_ID_A}.md`), "utf8");
    expect(after).toBe(before);
    const sessionDirs = (await readdir(paths.sessions)).filter((d) => d !== REACHABLE_SES_A);
    expect(sessionDirs).toEqual([]);
  });

  // 9
  it("dedup: broken pop + reconcile append preserves order with no duplicates", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, REACHABLE_SES_A);
    await placeSessionDir(paths, REACHABLE_SES_B);
    await placeTaskFile(paths, TASK_ID_A, {
      createdInSession: REACHABLE_SES_A,
      linkedSessions: [REACHABLE_SES_A, BROKEN_SES_A, REACHABLE_SES_B],
    });
    const r = await reconcileTask(paths, makeManifest(), {
      taskId: TASK_ID_A,
      occurredAt: OCC_AT,
      workingDirectory: getWorkDir(),
      write: true,
    });
    const newSes = r.reconcileSession?.sessionId as string;
    const doc = await readTaskFile(paths, TASK_ID_A);
    expect(doc.task.task.linked_sessions).toEqual([REACHABLE_SES_A, REACHABLE_SES_B, newSes]);
  });

  // 10
  it("targetEventBuilder emits source: local-cli with orchestrator-minted ids", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, REACHABLE_SES_A);
    await placeTaskFile(paths, TASK_ID_A, {
      createdInSession: BROKEN_SES_A,
      linkedSessions: [REACHABLE_SES_A],
    });
    const r = await reconcileTask(paths, makeManifest(), {
      taskId: TASK_ID_A,
      occurredAt: OCC_AT,
      workingDirectory: getWorkDir(),
      write: true,
    });
    const newSes = r.reconcileSession?.sessionId as string;
    const ev = await readReconciledEvent(paths, newSes);
    expect(ev?.source).toBe("local-cli");
    expect(ev?.session_id).toBe(newSes);
    expect(ev?.id).toBe(r.reconcileSession?.eventId);
  });

  // 11b (Codex review #3 M-1): invocation.args distinguishes single-task from scan
  it("scope: 'single' records [--task, id, --write] on the ad-hoc invocation", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, REACHABLE_SES_A);
    await placeTaskFile(paths, TASK_ID_A, {
      createdInSession: BROKEN_SES_A,
      linkedSessions: [REACHABLE_SES_A],
    });
    const r = await reconcileTask(paths, makeManifest(), {
      taskId: TASK_ID_A,
      occurredAt: OCC_AT,
      workingDirectory: getWorkDir(),
      write: true,
      scope: "single",
    });
    const newSes = r.reconcileSession?.sessionId as string;
    const yaml = await readFile(join(paths.sessions, newSes, "session.yaml"), "utf8");
    expect(yaml).toContain("- --task");
    expect(yaml).toContain(`- ${TASK_ID_A}`);
    expect(yaml).toContain("- --write");
  });

  it("scope: 'all' records [--write] on the ad-hoc invocation (no per-task id)", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, REACHABLE_SES_A);
    await placeTaskFile(paths, TASK_ID_A, {
      createdInSession: BROKEN_SES_A,
      linkedSessions: [REACHABLE_SES_A],
    });
    const r = await reconcileAllTasks(paths, makeManifest(), {
      occurredAt: () => OCC_AT,
      workingDirectory: getWorkDir(),
      write: true,
    });
    const newSes = r.results[0]?.reconcileSession?.sessionId as string;
    const yaml = await readFile(join(paths.sessions, newSes, "session.yaml"), "utf8");
    expect(yaml).toContain("- --write");
    expect(yaml).not.toContain("--task");
  });

  // 11
  it("reconcile session.yaml.task_id pins to the reconciled task", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, REACHABLE_SES_A);
    await placeTaskFile(paths, TASK_ID_A, {
      createdInSession: BROKEN_SES_A,
      linkedSessions: [REACHABLE_SES_A],
    });
    const r = await reconcileTask(paths, makeManifest(), {
      taskId: TASK_ID_A,
      occurredAt: OCC_AT,
      workingDirectory: getWorkDir(),
      write: true,
    });
    const newSes = r.reconcileSession?.sessionId as string;
    const yaml = await readFile(join(paths.sessions, newSes, "session.yaml"), "utf8");
    expect(yaml).toContain(`task_id: ${TASK_ID_A}`);
  });

  // 12
  it("created_in_session_replacement matches the new reconcile session id", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, REACHABLE_SES_A);
    await placeTaskFile(paths, TASK_ID_A, {
      createdInSession: BROKEN_SES_A,
      linkedSessions: [REACHABLE_SES_A],
    });
    const r = await reconcileTask(paths, makeManifest(), {
      taskId: TASK_ID_A,
      occurredAt: OCC_AT,
      workingDirectory: getWorkDir(),
      write: true,
    });
    const newSes = r.reconcileSession?.sessionId as string;
    const ev = await readReconciledEvent(paths, newSes);
    expect(ev?.created_in_session_replacement).toBe(newSes);
  });

  // 14
  it("Pattern A: removed_created_in_session: null + reconcile session appended (no empty array)", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, REACHABLE_SES_A);
    await placeTaskFile(paths, TASK_ID_A, {
      createdInSession: REACHABLE_SES_A,
      linkedSessions: [BROKEN_SES_A], // all linked entries broken
    });
    const r = await reconcileTask(paths, makeManifest(), {
      taskId: TASK_ID_A,
      occurredAt: OCC_AT,
      workingDirectory: getWorkDir(),
      write: true,
    });
    const newSes = r.reconcileSession?.sessionId as string;
    const doc = await readTaskFile(paths, TASK_ID_A);
    expect(doc.task.task.linked_sessions).toEqual([newSes]);
    expect(doc.task.task.linked_sessions.length).toBeGreaterThan(0);
    const ev = await readReconciledEvent(paths, newSes);
    expect(ev?.removed_created_in_session).toBeNull();
  });

  // 15
  it("Pattern B: reconcile session id appended to linked_sessions automatically", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, REACHABLE_SES_A);
    await placeTaskFile(paths, TASK_ID_A, {
      createdInSession: BROKEN_SES_A,
      linkedSessions: [REACHABLE_SES_A],
    });
    const r = await reconcileTask(paths, makeManifest(), {
      taskId: TASK_ID_A,
      occurredAt: OCC_AT,
      workingDirectory: getWorkDir(),
      write: true,
    });
    const newSes = r.reconcileSession?.sessionId as string;
    const doc = await readTaskFile(paths, TASK_ID_A);
    expect(doc.task.task.linked_sessions).toEqual([REACHABLE_SES_A, newSes]);
  });

  // 16
  it("idempotent: second reconcileTask is clean and fires no event", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, REACHABLE_SES_A);
    await placeTaskFile(paths, TASK_ID_A, {
      createdInSession: BROKEN_SES_A,
      linkedSessions: [REACHABLE_SES_A],
    });
    const first = await reconcileTask(paths, makeManifest(), {
      taskId: TASK_ID_A,
      occurredAt: OCC_AT,
      workingDirectory: getWorkDir(),
      write: true,
    });
    const dirsAfterFirst = (await readdir(paths.sessions)).length;
    const second = await reconcileTask(paths, makeManifest(), {
      taskId: TASK_ID_A,
      occurredAt: "2026-05-12T12:00:00+09:00",
      workingDirectory: getWorkDir(),
      write: true,
    });
    expect(first.clean).toBe(false);
    expect(second.clean).toBe(true);
    expect(second.reconcileSession).toBeNull();
    expect((await readdir(paths.sessions)).length).toBe(dirsAfterFirst);
  });

  // 21
  it("dedups duplicate broken linked_sessions on the event payload", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, REACHABLE_SES_A);
    await placeTaskFile(paths, TASK_ID_A, {
      createdInSession: REACHABLE_SES_A,
      linkedSessions: [BROKEN_SES_A, REACHABLE_SES_A, BROKEN_SES_A],
    });
    const r = await reconcileTask(paths, makeManifest(), {
      taskId: TASK_ID_A,
      occurredAt: OCC_AT,
      workingDirectory: getWorkDir(),
      write: true,
    });
    expect(r.brokenLinkedSessions).toEqual([BROKEN_SES_A]);
    const newSes = r.reconcileSession?.sessionId as string;
    const ev = await readReconciledEvent(paths, newSes);
    expect(ev?.removed_linked_sessions).toEqual([BROKEN_SES_A]);
  });

  // 22
  it("same broken id in created_in_session and linked_sessions (Y-3u milestone 20)", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, REACHABLE_SES_A);
    await placeTaskFile(paths, TASK_ID_A, {
      createdInSession: BROKEN_SES_A,
      linkedSessions: [BROKEN_SES_A, REACHABLE_SES_A],
    });
    const r = await reconcileTask(paths, makeManifest(), {
      taskId: TASK_ID_A,
      occurredAt: OCC_AT,
      workingDirectory: getWorkDir(),
      write: true,
    });
    expect(r.brokenCreatedInSession).toBe(BROKEN_SES_A);
    expect(r.brokenLinkedSessions).toEqual([BROKEN_SES_A]);
    const newSes = r.reconcileSession?.sessionId as string;
    const ev = await readReconciledEvent(paths, newSes);
    expect(ev?.removed_created_in_session).toBe(BROKEN_SES_A);
    expect(ev?.removed_linked_sessions).toEqual([BROKEN_SES_A]);
  });
});

describe("reconcileTask failure phases (Step 19)", () => {
  // 18
  it("phase: 'reconcile' when task.md overwrite fails after event commit", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, REACHABLE_SES_A);
    await placeTaskFile(paths, TASK_ID_A, {
      createdInSession: BROKEN_SES_A,
      linkedSessions: [REACHABLE_SES_A],
    });
    await chmod(paths.tasks, 0o555);
    let captured: TaskWriteAfterEventError | undefined;
    try {
      await reconcileTask(paths, makeManifest(), {
        taskId: TASK_ID_A,
        occurredAt: OCC_AT,
        workingDirectory: getWorkDir(),
        write: true,
      });
    } catch (error: unknown) {
      if (error instanceof TaskWriteAfterEventError) captured = error;
      else throw error;
    } finally {
      await chmod(paths.tasks, 0o755);
    }
    expect(captured?.phase).toBe("reconcile");
    expect(captured?.taskId).toBe(TASK_ID_A);
    const ev = await readReconciledEvent(paths, captured?.sessionId as string);
    expect(ev?.type).toBe("task_reconciled");
  });

  // 19
  it("phase: 'reconcile-finalize' when ad-hoc session finalize fails", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, REACHABLE_SES_A);
    await placeTaskFile(paths, TASK_ID_A, {
      createdInSession: BROKEN_SES_A,
      linkedSessions: [REACHABLE_SES_A],
    });
    vi.mocked(overwriteYamlFile).mockImplementationOnce(async () => {
      throw new Error("Failed to overwrite YAML file", {
        cause: Object.assign(new Error("simulated EACCES"), { code: "EACCES" }),
      });
    });
    let captured: TaskWriteAfterEventError | undefined;
    try {
      await reconcileTask(paths, makeManifest(), {
        taskId: TASK_ID_A,
        occurredAt: OCC_AT,
        workingDirectory: getWorkDir(),
        write: true,
      });
    } catch (error: unknown) {
      if (error instanceof TaskWriteAfterEventError) captured = error;
      else throw error;
    }
    expect(captured?.phase).toBe("reconcile-finalize");
    expect(captured?.taskId).toBe(TASK_ID_A);
    // task.md must NOT be overwritten when finalize failed before stage 7.
    const doc = await readTaskFile(paths, TASK_ID_A);
    expect(doc.task.task.created_in_session).toBe(BROKEN_SES_A);
  });

  // 20
  it("phase: 'reconcile-concurrent' when task.md mtime/hash changes between stage 4 and stage 6", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, REACHABLE_SES_A);
    await placeTaskFile(paths, TASK_ID_A, {
      createdInSession: BROKEN_SES_A,
      linkedSessions: [REACHABLE_SES_A],
    });
    let captured: TaskWriteAfterEventError | undefined;
    try {
      await reconcileTask(paths, makeManifest(), {
        taskId: TASK_ID_A,
        occurredAt: OCC_AT,
        workingDirectory: getWorkDir(),
        write: true,
        _onPhaseCompleted: async (phase) => {
          if (phase === "phase-5-bulk-write") {
            // Simulate a concurrent edit by rewriting task.md from the outside
            // with a different body before reconcile's stage 6 re-snapshot.
            const taskMdPath = join(paths.tasks, `${TASK_ID_A}.md`);
            const raw = await readFile(taskMdPath, "utf8");
            // Pad with an extra newline so both mtime and hash change.
            await new Promise((res) => setTimeout(res, 10));
            await writeFile(taskMdPath, `${raw}\nconcurrent edit\n`);
          }
        },
      });
    } catch (error: unknown) {
      if (error instanceof TaskWriteAfterEventError) captured = error;
      else throw error;
    }
    expect(captured?.phase).toBe("reconcile-concurrent");
    // The concurrent edit must NOT be clobbered by reconcile's stage 7.
    const doc = await readTaskFile(paths, TASK_ID_A);
    expect(doc.task.task.created_in_session).toBe(BROKEN_SES_A);
  });
});

describe("reconcileAllTasks (Step 19)", () => {
  // 7
  it("empty workspace: { results: [], failed: [], scanned: 0 }", async () => {
    const paths = await setupPaths();
    const r = await reconcileAllTasks(paths, makeManifest(), {
      occurredAt: () => OCC_AT,
      workingDirectory: getWorkDir(),
      write: true,
    });
    expect(r.results).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(r.scanned).toBe(0);
  });

  // 13
  it("write=true on a clean-only workspace mints no ad-hoc session", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, REACHABLE_SES_A);
    await placeTaskFile(paths, TASK_ID_A, {
      createdInSession: REACHABLE_SES_A,
      linkedSessions: [REACHABLE_SES_A],
    });
    const sessionsBefore = (await readdir(paths.sessions)).length;
    const r = await reconcileAllTasks(paths, makeManifest(), {
      occurredAt: () => OCC_AT,
      workingDirectory: getWorkDir(),
      write: true,
    });
    expect(r.results).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(r.scanned).toBe(1);
    expect((await readdir(paths.sessions)).length).toBe(sessionsBefore);
  });

  // 17
  it("malformed task.md is excluded from scanned and not reconciled", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, REACHABLE_SES_A);
    await placeTaskFile(paths, TASK_ID_A, {
      createdInSession: REACHABLE_SES_A,
      linkedSessions: [REACHABLE_SES_A],
    });
    await writeFile(join(paths.tasks, `${TASK_ID_B}.md`), "no front matter\n");
    const r = await reconcileAllTasks(paths, makeManifest(), {
      occurredAt: () => OCC_AT,
      workingDirectory: getWorkDir(),
      write: true,
    });
    expect(r.scanned).toBe(1);
    expect(r.failed).toEqual([]);
  });

  // 6
  it("isolated failure continues: one task fails, others succeed", async () => {
    const paths = await setupPaths();
    await placeSessionDir(paths, REACHABLE_SES_A);
    await placeTaskFile(paths, TASK_ID_A, {
      createdInSession: BROKEN_SES_A,
      linkedSessions: [REACHABLE_SES_A],
    });
    await placeTaskFile(paths, TASK_ID_B, {
      createdInSession: BROKEN_SES_B,
      linkedSessions: [REACHABLE_SES_A],
    });
    // Fail the SECOND ad-hoc finalize so TASK_ID_B reconcile blows up while
    // TASK_ID_A reconcile succeeds (enumerateTaskIds returns ULID-ascending).
    vi.mocked(overwriteYamlFile)
      .mockImplementationOnce(async (path, payload) => {
        const actual = await vi.importActual<typeof import("./yaml-store.js")>("./yaml-store.js");
        return actual.overwriteYamlFile(path, payload);
      })
      .mockImplementationOnce(async () => {
        throw new Error("Failed to overwrite YAML file", {
          cause: Object.assign(new Error("simulated EACCES"), { code: "EACCES" }),
        });
      });
    const r = await reconcileAllTasks(paths, makeManifest(), {
      occurredAt: () => OCC_AT,
      workingDirectory: getWorkDir(),
      write: true,
    });
    expect(r.scanned).toBe(2);
    expect(r.results.map((x) => x.taskId)).toEqual([TASK_ID_A]);
    expect(r.failed.map((x) => x.taskId)).toEqual([TASK_ID_B]);
    expect(r.failed[0]?.errorClass).toBe("TaskWriteAfterEventError");
    expect(r.failed[0]?.phase).toBe("reconcile-finalize");
  });

  // 8
  it("isolated failure continues across reconcile-finalize specifically", async () => {
    // Same path as #6 but spelled out to pin the phase classification.
    const paths = await setupPaths();
    await placeSessionDir(paths, REACHABLE_SES_A);
    await placeTaskFile(paths, TASK_ID_A, {
      createdInSession: BROKEN_SES_A,
      linkedSessions: [REACHABLE_SES_A],
    });
    await placeTaskFile(paths, TASK_ID_B, {
      createdInSession: BROKEN_SES_B,
      linkedSessions: [REACHABLE_SES_A],
    });
    let call = 0;
    vi.mocked(overwriteYamlFile).mockImplementation(async (path, payload) => {
      call += 1;
      if (call === 2) {
        throw new Error("Failed to overwrite YAML file", {
          cause: Object.assign(new Error("simulated EACCES"), { code: "EACCES" }),
        });
      }
      const actual = await vi.importActual<typeof import("./yaml-store.js")>("./yaml-store.js");
      return actual.overwriteYamlFile(path, payload);
    });
    const r = await reconcileAllTasks(paths, makeManifest(), {
      occurredAt: () => OCC_AT,
      workingDirectory: getWorkDir(),
      write: true,
    });
    expect(r.failed[0]?.phase).toBe("reconcile-finalize");
  });
});

// ============================================================================
// refreshTaskLinkedSessions — forward sync events -> task.md.linked_sessions[]
// ============================================================================

describe("refreshTaskLinkedSessions", () => {
  async function placeSessionWithTaskId(
    paths: BasouPaths,
    sessionId: PrefixedId<"ses">,
    taskId: PrefixedId<"task"> | null,
    status = "running",
  ): Promise<void> {
    await placeRunningSession(paths, sessionId, { taskId, status });
  }

  async function placeTaskWithLinkedSessions(
    paths: BasouPaths,
    linked: PrefixedId<"ses">[],
  ): Promise<void> {
    const yaml = stringifyYaml({
      schema_version: "0.1.0",
      task: {
        id: TASK_ID_A,
        title: "linkage fixture",
        status: "in_progress",
        created_at: OCC_AT,
        updated_at: OCC_AT,
        workspace_id: WS_ID,
        created_in_session: SES_ID_RUNNING,
        linked_sessions: linked,
      },
    });
    await writeFile(join(paths.tasks, `${TASK_ID_A}.md`), `---\n${yaml}---\n\nbody\n`);
  }

  it("reports clean when current snapshot already matches workspace truth", async () => {
    const { refreshTaskLinkedSessions } = await import("./tasks.js");
    const paths = await setupPaths();
    await placeSessionWithTaskId(paths, SES_ID_RUNNING, TASK_ID_A);
    await placeTaskWithLinkedSessions(paths, [SES_ID_RUNNING]);
    const result = await refreshTaskLinkedSessions(paths, makeManifest(), {
      taskId: TASK_ID_A,
      occurredAt: OCC_AT,
      workingDirectory: getWorkDir(),
      write: false,
    });
    expect(result.clean).toBe(true);
    expect(result.addedLinkedSessions).toEqual([]);
    expect(result.removedLinkedSessions).toEqual([]);
    expect(result.refreshSession).toBeNull();
    expect(result.finalCount).toBe(1);
  });

  it("detects an added session in dry-run without firing an event", async () => {
    const { refreshTaskLinkedSessions } = await import("./tasks.js");
    const paths = await setupPaths();
    await placeSessionWithTaskId(paths, SES_ID_RUNNING, TASK_ID_A);
    // SES_ID_OTHER also links to the task via session.yaml.task_id but is
    // not yet in task.md's linked_sessions snapshot.
    await placeSessionWithTaskId(paths, SES_ID_OTHER, TASK_ID_A);
    await placeTaskWithLinkedSessions(paths, [SES_ID_RUNNING]);
    const result = await refreshTaskLinkedSessions(paths, makeManifest(), {
      taskId: TASK_ID_A,
      occurredAt: OCC_AT,
      workingDirectory: getWorkDir(),
      write: false,
    });
    expect(result.clean).toBe(false);
    expect(result.addedLinkedSessions).toEqual([SES_ID_OTHER]);
    expect(result.removedLinkedSessions).toEqual([]);
    expect(result.refreshSession).toBeNull();
    // No ad-hoc session minted on dry-run.
    const sessions = await readdir(paths.sessions);
    expect(sessions.filter((s) => s.startsWith("ses_"))).toHaveLength(2);
  });

  it("write mode mints an ad-hoc session, fires task_linkage_refreshed, and updates task.md", async () => {
    const { refreshTaskLinkedSessions } = await import("./tasks.js");
    const paths = await setupPaths();
    await placeSessionWithTaskId(paths, SES_ID_RUNNING, TASK_ID_A);
    await placeSessionWithTaskId(paths, SES_ID_OTHER, TASK_ID_A);
    await placeTaskWithLinkedSessions(paths, [SES_ID_RUNNING]);
    const result = await refreshTaskLinkedSessions(paths, makeManifest(), {
      taskId: TASK_ID_A,
      occurredAt: OCC_AT,
      workingDirectory: getWorkDir(),
      write: true,
    });
    expect(result.clean).toBe(false);
    expect(result.refreshSession).not.toBeNull();
    const refreshSessionId = result.refreshSession?.sessionId as PrefixedId<"ses">;
    // task.md now contains both pre-existing linked sessions plus the new
    // refresh session that wrote the event.
    const doc = await readTaskFile(paths, TASK_ID_A);
    const linked = new Set(doc.task.task.linked_sessions);
    expect(linked.has(SES_ID_RUNNING)).toBe(true);
    expect(linked.has(SES_ID_OTHER)).toBe(true);
    expect(linked.has(refreshSessionId)).toBe(true);
    expect(doc.task.task.updated_at).toBe(OCC_AT);
    // events.jsonl on the ad-hoc session has the new event in the middle of
    // the 5-event lifecycle.
    const events = (await readFile(join(paths.sessions, refreshSessionId, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.map((e) => e.type)).toEqual([
      "session_started",
      "session_status_changed",
      "task_linkage_refreshed",
      "session_status_changed",
      "session_ended",
    ]);
    expect(events[2]).toMatchObject({
      type: "task_linkage_refreshed",
      task_id: TASK_ID_A,
      added_linked_sessions: [SES_ID_OTHER],
      removed_linked_sessions: [],
    });
  });

  it("removes a snapshot entry whose session.yaml no longer links to the task", async () => {
    const { refreshTaskLinkedSessions } = await import("./tasks.js");
    const paths = await setupPaths();
    // SES_ID_RUNNING is the anchor (always preserved), SES_ID_OTHER is in the
    // snapshot but its session.yaml does NOT link to TASK_ID_A.
    await placeSessionWithTaskId(paths, SES_ID_RUNNING, TASK_ID_A);
    await placeSessionWithTaskId(paths, SES_ID_OTHER, TASK_ID_B);
    await placeTaskWithLinkedSessions(paths, [SES_ID_RUNNING, SES_ID_OTHER]);
    const result = await refreshTaskLinkedSessions(paths, makeManifest(), {
      taskId: TASK_ID_A,
      occurredAt: OCC_AT,
      workingDirectory: getWorkDir(),
      write: true,
    });
    expect(result.clean).toBe(false);
    expect(result.removedLinkedSessions).toEqual([SES_ID_OTHER]);
    const doc = await readTaskFile(paths, TASK_ID_A);
    expect(doc.task.task.linked_sessions).not.toContain(SES_ID_OTHER);
    // Anchor is always preserved.
    expect(doc.task.task.linked_sessions).toContain(SES_ID_RUNNING);
  });

  it("preserves the anchor (created_in_session) even when its session.yaml no longer links to the task", async () => {
    const { refreshTaskLinkedSessions } = await import("./tasks.js");
    const paths = await setupPaths();
    // The anchor session has task_id cleared — that drift is reconcile's
    // concern, not refresh-linkage's. refresh-linkage must still preserve the
    // anchor in linked_sessions to honor the Y-2 §2.1 invariant.
    await placeSessionWithTaskId(paths, SES_ID_RUNNING, null);
    await placeTaskWithLinkedSessions(paths, [SES_ID_RUNNING]);
    const result = await refreshTaskLinkedSessions(paths, makeManifest(), {
      taskId: TASK_ID_A,
      occurredAt: OCC_AT,
      workingDirectory: getWorkDir(),
      write: false,
    });
    expect(result.clean).toBe(true);
    expect(result.finalCount).toBe(1);
  });
});

// ============================================================================
// editTask
// ============================================================================

describe("editTask", () => {
  it("updates title only without firing any event", async () => {
    const { editTask } = await import("./tasks.js");
    const paths = await setupPaths();
    await createTaskWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: OCC_AT,
      taskId: TASK_ID_A,
      title: "old title",
      initialStatus: "planned",
      description: "",
      workingDirectory: getWorkDir(),
    });
    const sessionsBefore = (await readdir(paths.sessions)).filter((s) => s.startsWith("ses_"));

    const result = await editTask({
      paths,
      taskId: TASK_ID_A,
      title: "new title",
      occurredAt: "2026-05-12T12:00:00+09:00",
    });
    expect(result.titleUpdated).toBe(true);
    expect(result.statusUpdated).toBe(false);
    expect(result.statusChangeSession).toBeNull();
    const doc = await readTaskFile(paths, TASK_ID_A);
    expect(doc.task.task.title).toBe("new title");
    expect(doc.task.task.updated_at).toBe("2026-05-12T12:00:00+09:00");
    // No new ad-hoc session was minted for a title-only edit.
    const sessionsAfter = (await readdir(paths.sessions)).filter((s) => s.startsWith("ses_"));
    expect(sessionsAfter.length).toBe(sessionsBefore.length);
  });

  it("updates status through updateTaskStatusWithEvent (event fired)", async () => {
    const { editTask } = await import("./tasks.js");
    const paths = await setupPaths();
    await createTaskWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: OCC_AT,
      taskId: TASK_ID_A,
      title: "the task",
      initialStatus: "planned",
      description: "",
      workingDirectory: getWorkDir(),
    });
    const result = await editTask({
      paths,
      taskId: TASK_ID_A,
      newStatus: "in_progress",
      occurredAt: "2026-05-12T12:00:00+09:00",
      manifest: makeManifest(),
      workingDirectory: getWorkDir(),
    });
    expect(result.statusUpdated).toBe(true);
    expect(result.previousStatus).toBe("planned");
    expect(result.newStatus).toBe("in_progress");
    expect(result.statusChangeSession).not.toBeNull();
    const doc = await readTaskFile(paths, TASK_ID_A);
    expect(doc.task.task.status).toBe("in_progress");
  });

  it("rejects when neither --title nor --status is given", async () => {
    const { editTask } = await import("./tasks.js");
    const paths = await setupPaths();
    await expect(
      editTask({
        paths,
        taskId: TASK_ID_A,
        occurredAt: OCC_AT,
      }),
    ).rejects.toThrow("Nothing to edit");
  });
});

// ============================================================================
// deleteTask
// ============================================================================

describe("deleteTask", () => {
  it("fires task_deleted event and unlinks task.md", async () => {
    const { deleteTask } = await import("./tasks.js");
    const paths = await setupPaths();
    await createTaskWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: OCC_AT,
      taskId: TASK_ID_A,
      title: "doomed task",
      initialStatus: "planned",
      description: "",
      workingDirectory: getWorkDir(),
    });
    const result = await deleteTask({
      paths,
      manifest: makeManifest(),
      taskId: TASK_ID_A,
      occurredAt: "2026-05-12T12:00:00+09:00",
      workingDirectory: getWorkDir(),
    });
    expect(result.title).toBe("doomed task");
    // task.md no longer in the main dir.
    const mainTasks = (await readdir(paths.tasks, { withFileTypes: true })).filter((d) =>
      d.isFile(),
    );
    expect(mainTasks.find((d) => d.name === `${TASK_ID_A}.md`)).toBeUndefined();
    // Event lives on the ad-hoc session that fired it.
    const events = (await readFile(join(paths.sessions, result.sessionId, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const deletedEvent = events.find((e) => e.type === "task_deleted");
    expect(deletedEvent).toMatchObject({
      task_id: TASK_ID_A,
      title: "doomed task",
    });
    // The ad-hoc session.yaml.task_id is NOT pinned to the deleted task —
    // pinning would create a guaranteed broken reference once the file is
    // gone.
    const yaml = await readFile(join(paths.sessions, result.sessionId, "session.yaml"), "utf8");
    expect(yaml).toContain("task_id: null");
  });

  it("rejects when the task does not exist", async () => {
    const { deleteTask } = await import("./tasks.js");
    const paths = await setupPaths();
    await expect(
      deleteTask({
        paths,
        manifest: makeManifest(),
        taskId: TASK_ID_A,
        occurredAt: OCC_AT,
        workingDirectory: getWorkDir(),
      }),
    ).rejects.toThrow("Task file not found");
  });
});

// ============================================================================
// archiveTask
// ============================================================================

describe("archiveTask", () => {
  it("moves task.md to archive/ and fires task_archived event", async () => {
    const { archiveTask, enumerateArchivedTaskIds } = await import("./tasks.js");
    const paths = await setupPaths();
    await createTaskWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: OCC_AT,
      taskId: TASK_ID_A,
      title: "to archive",
      initialStatus: "done",
      description: "",
      workingDirectory: getWorkDir(),
    });
    const result = await archiveTask({
      paths,
      manifest: makeManifest(),
      taskId: TASK_ID_A,
      occurredAt: "2026-05-12T12:00:00+09:00",
      workingDirectory: getWorkDir(),
    });
    expect(result.title).toBe("to archive");
    // Original task.md is gone from the main dir.
    const mainTasks = (await readdir(paths.tasks, { withFileTypes: true })).filter(
      (d) => d.isFile() && d.name.endsWith(".md"),
    );
    expect(mainTasks.find((d) => d.name === `${TASK_ID_A}.md`)).toBeUndefined();
    // archive dir contains the file now.
    const archivedIds = await enumerateArchivedTaskIds(paths);
    expect(archivedIds).toContain(TASK_ID_A);
    // Event session.yaml.task_id IS pinned (unlike delete) because the
    // task continues to exist at the new path.
    const yaml = await readFile(join(paths.sessions, result.sessionId, "session.yaml"), "utf8");
    expect(yaml).toContain(`task_id: ${TASK_ID_A}`);
  });

  it("includes the archive session in linked_sessions[] of the archived task.md", async () => {
    const { archiveTask, readTaskFileWithArchiveFallback } = await import("./tasks.js");
    const paths = await setupPaths();
    await createTaskWithEvent({
      mode: "ad-hoc",
      paths,
      manifest: makeManifest(),
      occurredAt: OCC_AT,
      taskId: TASK_ID_A,
      title: "linked archive",
      initialStatus: "planned",
      description: "",
      workingDirectory: getWorkDir(),
    });
    const result = await archiveTask({
      paths,
      manifest: makeManifest(),
      taskId: TASK_ID_A,
      occurredAt: "2026-05-12T12:00:00+09:00",
      workingDirectory: getWorkDir(),
    });
    const { doc, archived } = await readTaskFileWithArchiveFallback(paths, TASK_ID_A);
    expect(archived).toBe(true);
    expect(doc.task.task.linked_sessions).toContain(result.sessionId);
  });
});

// ============================================================================
// readTaskFileWithArchiveFallback
// ============================================================================

describe("readTaskFileWithArchiveFallback", () => {
  it("returns archived=false for a main-dir task", async () => {
    const { readTaskFileWithArchiveFallback } = await import("./tasks.js");
    const paths = await setupPaths();
    await writeFile(join(paths.tasks, `${TASK_ID_A}.md`), makeRawTaskMd());
    const { doc, archived } = await readTaskFileWithArchiveFallback(paths, TASK_ID_A);
    expect(archived).toBe(false);
    expect(doc.task.task.id).toBe(TASK_ID_A);
  });

  it("returns archived=true when the file only exists in archive/", async () => {
    const { readTaskFileWithArchiveFallback } = await import("./tasks.js");
    const paths = await setupPaths();
    await mkdir(join(paths.tasks, "archive"), { recursive: true });
    await writeFile(join(paths.tasks, "archive", `${TASK_ID_A}.md`), makeRawTaskMd());
    const { doc, archived } = await readTaskFileWithArchiveFallback(paths, TASK_ID_A);
    expect(archived).toBe(true);
    expect(doc.task.task.id).toBe(TASK_ID_A);
  });

  it("throws Task file not found when neither dir has the file", async () => {
    const { readTaskFileWithArchiveFallback } = await import("./tasks.js");
    const paths = await setupPaths();
    await expect(readTaskFileWithArchiveFallback(paths, TASK_ID_A)).rejects.toThrow(
      "Task file not found",
    );
  });
});
