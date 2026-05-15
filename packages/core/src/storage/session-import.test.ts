import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify as stringifyYaml } from "yaml";
import type { Manifest } from "../schemas/manifest.schema.js";
import type { SessionImportPayload } from "../schemas/session-import.schema.js";
import { type BasouPaths, ensureBasouDirectory } from "./basou-dir.js";
import { importSessionFromJson } from "./session-import.js";

const LOCAL_WS_ID = "ws_01HXABCDEF1234567890ABCWS1" as const;
const FOREIGN_WS_ID = "ws_01HXABCDEF1234567890ABCWS2" as const;
const INPUT_SES_ID = "ses_01HXABCDEF1234567890ABCSE1" as const;
const INPUT_EVT_ID = "evt_01HXABCDEF1234567890ABCEV1" as const;

let workDir: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "basou-session-import-test-"));
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
      id: LOCAL_WS_ID,
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

function makePayload(
  overrides: {
    session?: Partial<SessionImportPayload["session"]>;
    events?: SessionImportPayload["events"];
    schema_version?: string;
  } = {},
): SessionImportPayload {
  const baseEvent: SessionImportPayload["events"][number] = {
    schema_version: "0.1.0",
    type: "session_started",
    id: INPUT_EVT_ID,
    session_id: INPUT_SES_ID,
    occurred_at: "2026-05-04T09:00:00+09:00",
    source: "claude-code-adapter",
  };
  return {
    schema_version: overrides.schema_version ?? "0.1.0",
    session: {
      id: INPUT_SES_ID,
      workspace_id: FOREIGN_WS_ID,
      source: { kind: "claude-code-adapter", version: "0.1.0" },
      started_at: "2026-05-04T09:00:00+09:00",
      status: "completed",
      working_directory: "/srv/example-project",
      invocation: { command: "claude", args: [], exit_code: 0 },
      related_files: [],
      ...overrides.session,
    },
    events: overrides.events ?? [baseEvent],
  };
}

async function readSessionYaml(
  paths: BasouPaths,
  sessionId: string,
): Promise<{ session: Record<string, unknown>; schema_version: string }> {
  const body = await readFile(join(paths.sessions, sessionId, "session.yaml"), "utf8");
  return parse(body) as { session: Record<string, unknown>; schema_version: string };
}

async function readEventsJsonl(
  paths: BasouPaths,
  sessionId: string,
): Promise<Record<string, unknown>[]> {
  const body = await readFile(join(paths.sessions, sessionId, "events.jsonl"), "utf8");
  if (body.length === 0) return [];
  return body
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("importSessionFromJson", () => {
  it("creates session.yaml + events.jsonl on the happy path", async () => {
    const paths = await setupPaths();
    const result = await importSessionFromJson(paths, makeManifest(), makePayload(), {});

    expect(result.eventCount).toBe(1);
    expect(result.finalStatus).toBe("imported");
    expect(result.sessionId.startsWith("ses_")).toBe(true);
    expect(result.sessionId).not.toBe(INPUT_SES_ID);

    const yaml = await readSessionYaml(paths, result.sessionId);
    expect(yaml.schema_version).toBe("0.1.0");
    expect(yaml.session.id).toBe(result.sessionId);
    expect(yaml.session.status).toBe("imported");
    expect(yaml.session.workspace_id).toBe(LOCAL_WS_ID);
    expect(yaml.session.events_log).toBe("events.jsonl");

    const events = await readEventsJsonl(paths, result.sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.session_id).toBe(result.sessionId);
    expect(typeof events[0]?.id).toBe("string");
    expect((events[0]?.id as string).startsWith("evt_")).toBe(true);
    expect(events[0]?.id).not.toBe(INPUT_EVT_ID);
  });

  it("discards the input session.id and assigns a fresh one", async () => {
    const paths = await setupPaths();
    const result = await importSessionFromJson(
      paths,
      makeManifest(),
      makePayload({ session: { id: INPUT_SES_ID } }),
      {},
    );
    expect(result.sessionId).not.toBe(INPUT_SES_ID);
    const yaml = await readSessionYaml(paths, result.sessionId);
    expect(yaml.session.id).toBe(result.sessionId);
  });

  it("rewrites every event id and session_id", async () => {
    const paths = await setupPaths();
    const events: SessionImportPayload["events"] = [
      {
        schema_version: "0.1.0",
        type: "session_started",
        id: "evt_01HXABCDEF1234567890ABCEV1",
        session_id: INPUT_SES_ID,
        occurred_at: "2026-05-04T09:00:00+09:00",
        source: "claude-code-adapter",
      },
      {
        schema_version: "0.1.0",
        type: "command_executed",
        id: "evt_01HXABCDEF1234567890ABCEV2",
        session_id: INPUT_SES_ID,
        occurred_at: "2026-05-04T09:00:01+09:00",
        source: "terminal-recording",
        command: "echo",
        args: ["hi"],
        cwd: "/srv/example-project",
        exit_code: 0,
        duration_ms: 1,
      },
    ];
    const result = await importSessionFromJson(paths, makeManifest(), makePayload({ events }), {});
    const wire = await readEventsJsonl(paths, result.sessionId);
    expect(wire).toHaveLength(2);
    expect(wire[0]?.session_id).toBe(result.sessionId);
    expect(wire[1]?.session_id).toBe(result.sessionId);
    expect(wire[0]?.id).not.toBe("evt_01HXABCDEF1234567890ABCEV1");
    expect(wire[1]?.id).not.toBe("evt_01HXABCDEF1234567890ABCEV2");
    expect(wire[0]?.id).not.toBe(wire[1]?.id);
  });

  it("overwrites workspace_id with the local manifest value", async () => {
    const paths = await setupPaths();
    const result = await importSessionFromJson(
      paths,
      makeManifest(),
      makePayload({ session: { workspace_id: FOREIGN_WS_ID } }),
      {},
    );
    const yaml = await readSessionYaml(paths, result.sessionId);
    expect(yaml.session.workspace_id).toBe(LOCAL_WS_ID);
  });

  it("overwrites session.status with 'imported' regardless of input", async () => {
    const paths = await setupPaths();
    const result = await importSessionFromJson(
      paths,
      makeManifest(),
      makePayload({ session: { status: "running" } }),
      {},
    );
    const yaml = await readSessionYaml(paths, result.sessionId);
    expect(yaml.session.status).toBe("imported");
    expect(result.finalStatus).toBe("imported");
  });

  it("preserves source.kind across the import (K1)", async () => {
    const paths = await setupPaths();
    const result = await importSessionFromJson(
      paths,
      makeManifest(),
      makePayload({
        session: { source: { kind: "human", version: "0.1.0" } },
      }),
      {},
    );
    const yaml = await readSessionYaml(paths, result.sessionId);
    expect((yaml.session.source as { kind: string }).kind).toBe("human");
    expect(result.finalSourceKind).toBe("human");
  });

  it("overwrites events_log with 'events.jsonl' even if input requested another path", async () => {
    const paths = await setupPaths();
    const result = await importSessionFromJson(
      paths,
      makeManifest(),
      makePayload({ session: { events_log: "../etc/passwd" } }),
      {},
    );
    const yaml = await readSessionYaml(paths, result.sessionId);
    expect(yaml.session.events_log).toBe("events.jsonl");
  });

  it("rejects non-chronological events and leaves no session directory behind", async () => {
    const paths = await setupPaths();
    const events: SessionImportPayload["events"] = [
      {
        schema_version: "0.1.0",
        type: "session_started",
        id: "evt_01HXABCDEF1234567890ABCEV1",
        session_id: INPUT_SES_ID,
        occurred_at: "2026-05-04T09:00:10+09:00",
        source: "claude-code-adapter",
      },
      {
        schema_version: "0.1.0",
        type: "session_ended",
        id: "evt_01HXABCDEF1234567890ABCEV2",
        session_id: INPUT_SES_ID,
        occurred_at: "2026-05-04T09:00:00+09:00",
        source: "claude-code-adapter",
      },
    ];
    await expect(
      importSessionFromJson(paths, makeManifest(), makePayload({ events }), {}),
    ).rejects.toThrow("Events are not in chronological order");
    const sessionDirs = await readdir(paths.sessions);
    expect(sessionDirs).toEqual([]);
  });

  it("applies labelOverride when supplied", async () => {
    const paths = await setupPaths();
    const result = await importSessionFromJson(paths, makeManifest(), makePayload(), {
      labelOverride: "override label",
    });
    const yaml = await readSessionYaml(paths, result.sessionId);
    expect(yaml.session.label).toBe("override label");
  });

  it("applies taskIdOverride when supplied", async () => {
    const paths = await setupPaths();
    const taskOverride = "task_01HXABCDEF1234567890ABCTK1";
    const result = await importSessionFromJson(
      paths,
      makeManifest(),
      makePayload({ session: { task_id: null } }),
      { taskIdOverride: taskOverride },
    );
    const yaml = await readSessionYaml(paths, result.sessionId);
    expect(yaml.session.task_id).toBe(taskOverride);
  });

  it("does not touch disk in dry-run mode", async () => {
    const paths = await setupPaths();
    const result = await importSessionFromJson(paths, makeManifest(), makePayload(), {
      dryRun: true,
    });
    expect(result.sessionId.startsWith("ses_")).toBe(true);
    const sessionDirs = await readdir(paths.sessions);
    expect(sessionDirs).toEqual([]);
  });

  it("creates an empty events.jsonl when the input has zero events", async () => {
    const paths = await setupPaths();
    const result = await importSessionFromJson(
      paths,
      makeManifest(),
      makePayload({ events: [] }),
      {},
    );
    expect(result.eventCount).toBe(0);
    const eventsPath = join(paths.sessions, result.sessionId, "events.jsonl");
    const info = await stat(eventsPath);
    expect(info.size).toBe(0);
  });

  it("preserves variant-specific cross-reference ids across rewrite", async () => {
    // approval_id chain across two events must remain joinable, and decision_id /
    // file paths / raw_ref must round-trip unchanged so handoff / decisions
    // renderers see the same references the exporter emitted.
    const APPROVAL_ID = "appr_01HXABCDEF1234567890ABCAP1";
    const DECISION_ID = "decision_01HXABCDEF1234567890ABCDC1";
    const FILE_PATH = "src/components/ContactForm.tsx";
    const OLD_PATH = "src/components/Contact.tsx";
    const RAW_REF = ".basou/raw/ses_xxx/adapter.jsonl";
    const paths = await setupPaths();
    const events: SessionImportPayload["events"] = [
      {
        schema_version: "0.1.0",
        type: "approval_requested",
        id: "evt_01HXABCDEF1234567890ABCEV1",
        session_id: INPUT_SES_ID,
        occurred_at: "2026-05-04T09:00:00+09:00",
        source: "human",
        approval_id: APPROVAL_ID,
        expires_at: null,
        risk_level: "medium",
        action: { kind: "shell_command" },
        reason: "needs review",
        status: "pending",
      },
      {
        schema_version: "0.1.0",
        type: "approval_approved",
        id: "evt_01HXABCDEF1234567890ABCEV2",
        session_id: INPUT_SES_ID,
        occurred_at: "2026-05-04T09:00:01+09:00",
        source: "human",
        approval_id: APPROVAL_ID,
      },
      {
        schema_version: "0.1.0",
        type: "decision_recorded",
        id: "evt_01HXABCDEF1234567890ABCEV3",
        session_id: INPUT_SES_ID,
        occurred_at: "2026-05-04T09:00:02+09:00",
        source: "human",
        decision_id: DECISION_ID,
        title: "Adopt zod",
      },
      {
        schema_version: "0.1.0",
        type: "file_changed",
        id: "evt_01HXABCDEF1234567890ABCEV4",
        session_id: INPUT_SES_ID,
        occurred_at: "2026-05-04T09:00:03+09:00",
        source: "git-capability",
        path: FILE_PATH,
        change_type: "renamed",
        old_path: OLD_PATH,
      },
      {
        schema_version: "0.1.0",
        type: "adapter_output",
        id: "evt_01HXABCDEF1234567890ABCEV5",
        session_id: INPUT_SES_ID,
        occurred_at: "2026-05-04T09:00:04+09:00",
        source: "claude-code-adapter",
        stream: "stdout",
        summary: "summary",
        raw_ref: RAW_REF,
      },
    ];
    const result = await importSessionFromJson(paths, makeManifest(), makePayload({ events }), {});
    const wire = await readEventsJsonl(paths, result.sessionId);
    expect(wire).toHaveLength(5);
    // approval chain still joinable on the imported side
    expect(wire[0]?.approval_id).toBe(APPROVAL_ID);
    expect(wire[1]?.approval_id).toBe(APPROVAL_ID);
    expect(wire[0]?.approval_id).toBe(wire[1]?.approval_id);
    // decision_id preserved
    expect(wire[2]?.decision_id).toBe(DECISION_ID);
    // file_changed path / old_path preserved (no path normalization on import)
    expect(wire[3]?.path).toBe(FILE_PATH);
    expect(wire[3]?.old_path).toBe(OLD_PATH);
    // adapter_output raw_ref preserved
    expect(wire[4]?.raw_ref).toBe(RAW_REF);
  });
});

describe("importSessionFromJson task_reconciled guard (Step 19 / Y-3w §H.7)", () => {
  const EXISTING_TASK_ID = "task_01HXABCDEF1234567890ABCTK1" as const;
  const UNKNOWN_TASK_ID = "task_01HXABCDEF1234567890ABCTK9" as const;
  const ANCHOR_SES_ID = "ses_01HXABCDEF1234567890ABCNCH" as const;

  async function placeExistingTask(paths: BasouPaths): Promise<void> {
    const yaml = stringifyYaml({
      schema_version: "0.1.0",
      task: {
        id: EXISTING_TASK_ID,
        title: "existing fixture task",
        status: "planned",
        created_at: "2026-05-04T09:00:00+09:00",
        updated_at: "2026-05-04T09:00:00+09:00",
        workspace_id: LOCAL_WS_ID,
        created_in_session: ANCHOR_SES_ID,
        linked_sessions: [ANCHOR_SES_ID],
      },
    });
    await writeFile(join(paths.tasks, `${EXISTING_TASK_ID}.md`), `---\n${yaml}---\nbody\n`);
  }

  // 47
  it("rejects an import whose task_reconciled references an unknown task_id", async () => {
    const paths = await setupPaths();
    const sessionsBefore = await readdir(paths.sessions);
    const payload = makePayload({
      events: [
        {
          schema_version: "0.1.0",
          type: "task_reconciled",
          id: INPUT_EVT_ID,
          session_id: INPUT_SES_ID,
          occurred_at: "2026-05-04T09:00:00+09:00",
          source: "claude-code-adapter",
          task_id: UNKNOWN_TASK_ID,
          removed_created_in_session: null,
          created_in_session_replacement: null,
          removed_linked_sessions: [],
        },
      ],
    });
    await expect(importSessionFromJson(paths, makeManifest(), payload, {})).rejects.toThrow(
      "Imported task_reconciled event references unknown task_id",
    );
    // No session dir written when the guard fires before mkdir.
    const sessionsAfter = await readdir(paths.sessions);
    expect(sessionsAfter).toEqual(sessionsBefore);
  });

  // 48
  it("accepts an import whose task_reconciled references an existing task_id", async () => {
    const paths = await setupPaths();
    await placeExistingTask(paths);
    const payload = makePayload({
      events: [
        {
          schema_version: "0.1.0",
          type: "task_reconciled",
          id: INPUT_EVT_ID,
          session_id: INPUT_SES_ID,
          occurred_at: "2026-05-04T09:00:00+09:00",
          source: "claude-code-adapter",
          task_id: EXISTING_TASK_ID,
          removed_created_in_session: null,
          created_in_session_replacement: null,
          removed_linked_sessions: [],
        },
      ],
    });
    const result = await importSessionFromJson(paths, makeManifest(), payload, {});
    expect(result.eventCount).toBe(1);
    const wire = await readEventsJsonl(paths, result.sessionId);
    expect(wire[0]?.type).toBe("task_reconciled");
    expect(wire[0]?.task_id).toBe(EXISTING_TASK_ID);
  });
});
