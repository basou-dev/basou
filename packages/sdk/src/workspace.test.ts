import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ensureBasouDirectory } from "@basou/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AmbiguousIdError, WorkspaceNotFoundError } from "./errors.js";
import { openWorkspace } from "./workspace.js";

// Fixtures are written as JSON, which is valid YAML, so the core readers
// (yaml-parsed) accept them without pulling `yaml` into the SDK's own deps.
function toYaml(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

const WS_ID = "ws_01HXABCDEF1234567890ABCWS1";
const SES_DONE = "ses_01HXABCDEF1234567890ABCSEA";
const SES_AMB1 = "ses_01HXABCDEF1234567890ABCAM1";
const SES_AMB2 = "ses_01HXABCDEF1234567890ABCAM2";
const TASK_ID = "task_01HXABCDEF1234567890ABCTK1";
// APPR_DUP exists in BOTH pending/ and resolved/ (a stale pending file left
// after resolution); APPR_PENDING is genuinely pending.
const APPR_DUP = "appr_01HXABCDEF1234567890ABCAP1";
const APPR_PENDING = "appr_01HXABCDEF1234567890ABCAP2";

let root: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "basou-sdk-test-"));
});

afterEach(async () => {
  if (root !== undefined) {
    await rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

function getRoot(): string {
  if (root === undefined) throw new Error("root not initialized");
  return root;
}

function manifestYaml(): string {
  return toYaml({
    schema_version: "0.1.0",
    basou_version: "0.1.0",
    workspace: {
      id: WS_ID,
      name: "sdk-test-workspace",
      created_at: "2026-05-01T00:00:00+09:00",
      updated_at: "2026-05-01T00:00:00+09:00",
    },
    project: {},
    capabilities: { enabled: [] },
    approval: { default_risk_level: "low" },
    adapters: { "claude-code": { enabled: false } },
    git: { events_log: "ignore" },
  });
}

function sessionYaml(id: string, status: string): string {
  return toYaml({
    schema_version: "0.1.0",
    session: {
      id,
      workspace_id: WS_ID,
      source: { kind: "codex-import", version: "0.1.0" },
      started_at: "2026-05-10T00:00:00.000Z",
      ended_at: "2026-05-10T00:10:00.000Z",
      status,
      working_directory: "/tmp/fixture",
      invocation: { command: "codex", args: [], exit_code: null },
      related_files: [],
      events_log: "events.jsonl",
    },
  });
}

function eventLine(obj: Record<string, unknown>): string {
  return `${JSON.stringify({ schema_version: "0.1.0", source: "codex-import", ...obj })}\n`;
}

async function writeSession(
  paths: { sessions: string },
  id: string,
  status: string,
  events: string,
): Promise<void> {
  const dir = join(paths.sessions, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "session.yaml"), sessionYaml(id, status));
  await writeFile(join(dir, "events.jsonl"), events);
}

/** Scaffold a populated `.basou/` and return the repo root that holds it. */
async function setupWorkspace(): Promise<string> {
  const repoRoot = getRoot();
  const paths = await ensureBasouDirectory(repoRoot);
  await writeFile(paths.files.manifest, manifestYaml());

  const doneEvents =
    eventLine({
      id: "evt_01HXABCDEF1234567890ABCEV1",
      session_id: SES_DONE,
      type: "session_started",
      occurred_at: "2026-05-10T00:00:00.000Z",
    }) +
    eventLine({
      id: "evt_01HXABCDEF1234567890ABCEV2",
      session_id: SES_DONE,
      type: "command_executed",
      occurred_at: "2026-05-10T00:00:30.000Z",
      command: "bash",
      args: ["-c", "ls"],
      cwd: "/tmp/fixture",
      exit_code: 0,
      duration_ms: 1500,
    }) +
    eventLine({
      id: "evt_01HXABCDEF1234567890ABCEV3",
      session_id: SES_DONE,
      type: "session_ended",
      occurred_at: "2026-05-10T00:10:00.000Z",
    });
  await writeSession(paths, SES_DONE, "completed", doneEvents);
  // Two sessions sharing a prefix, to exercise ambiguous resolution.
  await writeSession(paths, SES_AMB1, "completed", "");
  await writeSession(paths, SES_AMB2, "completed", "");

  const taskYaml = toYaml({
    schema_version: "0.1.0",
    task: {
      id: TASK_ID,
      title: "fixture task",
      status: "planned",
      created_at: "2026-05-10T00:00:00.000Z",
      updated_at: "2026-05-10T00:00:00.000Z",
      workspace_id: WS_ID,
      created_in_session: SES_DONE,
      linked_sessions: [SES_DONE],
    },
  });
  await writeFile(join(paths.tasks, `${TASK_ID}.md`), `---\n${taskYaml}\n---\nbody\n`);

  const approval = (id: string, status: string): string =>
    toYaml({
      schema_version: "0.1.0",
      id,
      session_id: SES_DONE,
      created_at: "2026-05-10T00:00:00.000Z",
      status,
      risk_level: "low",
      action: { kind: "command" },
      reason: "fixture approval",
    });
  await writeFile(
    join(paths.approvals.resolved, `${APPR_DUP}.yaml`),
    approval(APPR_DUP, "approved"),
  );
  await writeFile(join(paths.approvals.pending, `${APPR_DUP}.yaml`), approval(APPR_DUP, "pending"));
  await writeFile(
    join(paths.approvals.pending, `${APPR_PENDING}.yaml`),
    approval(APPR_PENDING, "pending"),
  );

  return repoRoot;
}

describe("openWorkspace", () => {
  it("throws WorkspaceNotFoundError when there is no .basou/", async () => {
    await expect(openWorkspace(getRoot())).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });

  it("reads the manifest and a fresh status snapshot", async () => {
    const ws = await openWorkspace(await setupWorkspace());
    const manifest = await ws.manifest();
    expect(manifest.workspace.id).toBe(WS_ID);
    const status = await ws.status();
    expect(status.directories_present.sessions).toBe(true);
  });

  it("lists sessions with their suspect classification", async () => {
    const ws = await openWorkspace(await setupWorkspace());
    const sessions = await ws.listSessions();
    expect(sessions.map((s) => s.sessionId)).toContain(SES_DONE);
    const done = sessions.find((s) => s.sessionId === SES_DONE);
    expect(done?.session.session.status).toBe("completed");
    expect(done?.suspect).toBe(false);
  });

  it("resolves a session by full id and by unique prefix", async () => {
    const ws = await openWorkspace(await setupWorkspace());
    expect((await ws.getSession(SES_DONE))?.sessionId).toBe(SES_DONE);
    // Unique prefix (the SEA-ending id) without the ses_ prefix.
    expect((await ws.getSession("01HXABCDEF1234567890ABCSEA"))?.sessionId).toBe(SES_DONE);
  });

  it("returns null for an unknown session and throws on an ambiguous prefix", async () => {
    const ws = await openWorkspace(await setupWorkspace());
    expect(await ws.getSession("ses_01HXABCDEF1234567890ABCZZZ")).toBeNull();
    await expect(ws.getSession("01HXABCDEF1234567890ABCAM")).rejects.toBeInstanceOf(
      AmbiguousIdError,
    );
  });

  it("reads a session's events eagerly and as a stream", async () => {
    const ws = await openWorkspace(await setupWorkspace());
    const events = await ws.readEvents(SES_DONE);
    expect(events.map((e) => e.type)).toEqual([
      "session_started",
      "command_executed",
      "session_ended",
    ]);
    const streamed = [];
    for await (const e of ws.streamEvents(SES_DONE)) streamed.push(e.type);
    expect(streamed).toEqual(["session_started", "command_executed", "session_ended"]);
  });

  it("returns an empty event list for an unknown session", async () => {
    const ws = await openWorkspace(await setupWorkspace());
    expect(await ws.readEvents("ses_01HXABCDEF1234567890ABCZZZ")).toEqual([]);
  });

  it("lists and resolves tasks", async () => {
    const ws = await openWorkspace(await setupWorkspace());
    const tasks = await ws.listTasks();
    expect(tasks.map((t) => t.task.task.id)).toContain(TASK_ID);
    expect((await ws.getTask("01HXABCDEF1234567890ABCTK1"))?.task.task.title).toBe("fixture task");
    expect(await ws.getTask("task_01HXABCDEF1234567890ABCZZZ")).toBeNull();
  });

  it("computes stats across the workspace's sessions", async () => {
    const ws = await openWorkspace(await setupWorkspace());
    const stats = await ws.stats({ timeZone: "UTC" });
    expect(stats.totals.sessionCount).toBe(3);
    expect(stats.totals.commandCount).toBe(1);
  });

  it("renders the handoff and decisions markdown", async () => {
    const ws = await openWorkspace(await setupWorkspace());
    expect(typeof (await ws.renderHandoff())).toBe("string");
    expect(typeof (await ws.renderDecisions())).toBe("string");
  });

  it("injects a clock for time-sensitive reads", async () => {
    const fixed = new Date("2026-05-10T01:00:00.000Z");
    const ws = await openWorkspace(await setupWorkspace(), { now: () => fixed });
    const stats = await ws.stats();
    expect(stats.generatedAt).toBe(fixed.toISOString());
  });

  it("lists approvals, reporting a resolved-and-stale-pending id once", async () => {
    const ws = await openWorkspace(await setupWorkspace());
    const { pending, resolved } = await ws.listApprovals();
    // APPR_DUP is in both dirs: it must appear only under resolved.
    expect(resolved.map((a) => a.approval.id)).toEqual([APPR_DUP]);
    expect(resolved[0]?.location).toBe("resolved");
    expect(pending.map((a) => a.approval.id)).toEqual([APPR_PENDING]);
    expect(pending.map((a) => a.approval.id)).not.toContain(APPR_DUP);
  });

  it("gets an approval by exact id (resolved-first), null when unknown", async () => {
    const ws = await openWorkspace(await setupWorkspace());
    expect((await ws.getApproval(APPR_DUP))?.location).toBe("resolved");
    expect((await ws.getApproval(APPR_PENDING))?.location).toBe("pending");
    expect(await ws.getApproval("appr_01HXABCDEF1234567890ABCZZZ")).toBeNull();
  });

  it("normalizes a relative root to an absolute path", async () => {
    const repoRoot = await setupWorkspace();
    const cwd = process.cwd();
    try {
      process.chdir(repoRoot);
      // A relative "." must be resolved to the absolute cwd (= resolve(".")),
      // not stored verbatim. Compared to process.cwd() rather than repoRoot to
      // avoid tmpdir symlink differences on some platforms.
      const ws = await openWorkspace(".");
      expect(isAbsolute(ws.root)).toBe(true);
      expect(ws.root).toBe(process.cwd());
    } finally {
      process.chdir(cwd);
    }
  });

  it("wraps the underlying cause on WorkspaceNotFoundError", async () => {
    const error = await openWorkspace(getRoot()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceNotFoundError);
    expect((error as WorkspaceNotFoundError).root).toBe(getRoot());
    expect((error as WorkspaceNotFoundError).cause).toBeDefined();
  });
});
