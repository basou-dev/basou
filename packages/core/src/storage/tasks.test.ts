import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  updateTaskStatusWithEvent,
  writeTaskFile,
} from "./tasks.js";
import { writeYamlFile } from "./yaml-store.js";

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

  it("rejects planned -> done (Codex Y3t-H5)", async () => {
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
        newStatus: "done",
        workingDirectory: getWorkDir(),
      }),
    ).rejects.toThrow("Invalid task status transition: planned -> done");
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
