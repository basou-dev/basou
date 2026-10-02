import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type Event, ensureBasouDirectory } from "@basou/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AmbiguousIdError,
  ApprovalStoreUnsafeError,
  BasouSdkError,
  SessionStoreUnsafeError,
  StoreUnsafeError,
  TaskStoreUnsafeError,
  WorkspaceNotFoundError,
} from "./errors.js";
import { openWorkspace, type Workspace } from "./workspace.js";

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

  // POSIX only: creating a symlink needs privileges on Windows.
  it.skipIf(process.platform === "win32")(
    "returns null for an entry named as a session that is a symlink, which is not followed",
    async () => {
      const root = await setupWorkspace();
      const linked = "ses_01HXABCDEF1234567890ABCSY1";
      const outside = join(root, "moved-session");
      await mkdir(outside);
      await symlink(outside, join(root, ".basou", "sessions", linked));
      const ws = await openWorkspace(root);
      expect(await ws.getSession(linked)).toBeNull();
      expect((await ws.listSessions()).map((s) => s.sessionId)).not.toContain(linked);
      // A prefix it shares with a real session is ambiguous.
      await expect(ws.getSession("01HXABCDEF1234567890ABCS")).rejects.toBeInstanceOf(
        AmbiguousIdError,
      );
    },
  );

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

  it("renders the work report markdown, honoring title and timezone", async () => {
    const ws = await openWorkspace(await setupWorkspace());
    const body = await ws.renderReport({ title: "Client X", timeZone: "UTC" });
    expect(typeof body).toBe("string");
    expect(body).toContain("# Report — Client X");
    expect(body).toContain("## Integrity");
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

describe("a .basou/sessions that is not followed", () => {
  const SYMLINK_MESSAGE = ".basou/sessions is a symlink; refusing to operate";
  const FILE_MESSAGE = ".basou/sessions exists but is not a directory";

  async function replaceStoreWithSymlink(repoRoot: string): Promise<void> {
    const sessions = join(repoRoot, ".basou", "sessions");
    const moved = join(repoRoot, "moved-sessions");
    await rename(sessions, moved);
    await symlink(moved, sessions);
  }

  async function replaceStoreWithFile(repoRoot: string): Promise<void> {
    const sessions = join(repoRoot, ".basou", "sessions");
    await rm(sessions, { recursive: true, force: true });
    await writeFile(sessions, "");
  }

  // Every read that needs the sessions, driven to completion.
  const sessionReads: ReadonlyArray<[string, (ws: Workspace) => Promise<unknown>]> = [
    ["listSessions", (ws) => ws.listSessions()],
    ["getSession", (ws) => ws.getSession(SES_DONE)],
    ["readEvents", (ws) => ws.readEvents(SES_DONE)],
    [
      "streamEvents",
      async (ws) => {
        const events: Event[] = [];
        for await (const event of ws.streamEvents(SES_DONE)) events.push(event);
        return events;
      },
    ],
    ["stats", (ws) => ws.stats({ timeZone: "UTC" })],
    ["renderHandoff", (ws) => ws.renderHandoff()],
    ["renderDecisions", (ws) => ws.renderDecisions()],
    ["renderReport", (ws) => ws.renderReport({ timeZone: "UTC" })],
  ];

  async function expectEachReadRefused(ws: Workspace, message: string): Promise<void> {
    for (const [name, read] of sessionReads) {
      const error = await read(ws).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error, name).toBeInstanceOf(SessionStoreUnsafeError);
      expect(error, name).toBeInstanceOf(BasouSdkError);
      const refusal = error as SessionStoreUnsafeError;
      expect(refusal.message, name).toBe(message);
      expect(refusal.name, name).toBe("SessionStoreUnsafeError");
      expect(refusal.root, name).toBe(ws.root);
      expect(refusal.cause, name).toBeInstanceOf(Error);
      expect(refusal.cause, name).not.toBeInstanceOf(BasouSdkError);
      expect((refusal.cause as Error).message, name).toBe(message);
      // The cause is the error core's store check threw, not a copy of it.
      expect((refusal.cause as Error).stack, name).toContain("assertSessionStoreSafe");
    }
  }

  async function expectOtherReadsUnaffected(ws: Workspace): Promise<void> {
    expect((await ws.manifest()).workspace.id).toBe(WS_ID);
    expect((await ws.status()).directories_present.tasks).toBe(true);
    expect((await ws.listTasks()).map((t) => t.task.task.id)).toEqual([TASK_ID]);
    expect((await ws.getTask(TASK_ID))?.task.task.title).toBe("fixture task");
    const { pending, resolved } = await ws.listApprovals();
    expect(pending.map((a) => a.approval.id)).toEqual([APPR_PENDING]);
    expect(resolved.map((a) => a.approval.id)).toEqual([APPR_DUP]);
    expect((await ws.getApproval(APPR_PENDING))?.location).toBe("pending");
  }

  // POSIX only: creating a symlink needs privileges on Windows.
  it.skipIf(process.platform === "win32")(
    "a symlink makes each read of the sessions throw SessionStoreUnsafeError",
    async () => {
      const repoRoot = await setupWorkspace();
      await replaceStoreWithSymlink(repoRoot);
      const ws = await openWorkspace(repoRoot);
      await expectEachReadRefused(ws, SYMLINK_MESSAGE);
      await expectOtherReadsUnaffected(ws);
    },
  );

  it("a file makes each read of the sessions throw SessionStoreUnsafeError", async () => {
    const repoRoot = await setupWorkspace();
    await replaceStoreWithFile(repoRoot);
    const ws = await openWorkspace(repoRoot);
    await expectEachReadRefused(ws, FILE_MESSAGE);
    await expectOtherReadsUnaffected(ws);
  });

  it("a session lookup given an empty id, or ses_ alone, yields nothing without reading", async () => {
    const repoRoot = await setupWorkspace();
    await replaceStoreWithFile(repoRoot);
    const ws = await openWorkspace(repoRoot);
    for (const id of ["", "   ", "ses_", " ses_ "]) {
      expect(await ws.getSession(id), JSON.stringify(id)).toBeNull();
      expect(await ws.readEvents(id), JSON.stringify(id)).toEqual([]);
      const streamed: Event[] = [];
      for await (const event of ws.streamEvents(id)) streamed.push(event);
      expect(streamed, JSON.stringify(id)).toEqual([]);
    }
    // Any id with something after the prefix reads the store, and is refused.
    await expect(ws.getSession("ses_0")).rejects.toBeInstanceOf(SessionStoreUnsafeError);
  });

  it("is checked on each call, so a workspace opened before the store was replaced throws it", async () => {
    const repoRoot = await setupWorkspace();
    const ws = await openWorkspace(repoRoot);
    expect((await ws.listSessions()).map((s) => s.sessionId)).toContain(SES_DONE);
    await replaceStoreWithFile(repoRoot);
    await expectEachReadRefused(ws, FILE_MESSAGE);
  });

  // POSIX only, and not as root, who is never denied the lstat.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a failure to inspect the store is not retyped",
    async () => {
      const repoRoot = await setupWorkspace();
      const ws = await openWorkspace(repoRoot);
      const basouDir = join(repoRoot, ".basou");
      await chmod(basouDir, 0o000);
      try {
        const error = await ws.listSessions().then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(BasouSdkError);
        expect((error as Error).message).toBe("Failed to inspect .basou/sessions");
      } finally {
        await chmod(basouDir, 0o755);
      }
    },
  );
});

describe("a directory of the task or approval store that is not followed", () => {
  type Reads = ReadonlyArray<[string, (ws: Workspace) => Promise<unknown>]>;
  // One clock for the baseline and the refused workspace, so rendered output compares.
  const clock = { now: () => new Date("2026-05-11T00:00:00.000Z") };

  const taskReads: Reads = [
    ["listTasks", (ws) => ws.listTasks()],
    ["getTask", (ws) => ws.getTask(TASK_ID)],
    ["renderHandoff", (ws) => ws.renderHandoff()],
    ["renderReport", (ws) => ws.renderReport({ timeZone: "UTC" })],
  ];
  const approvalReads: Reads = [
    ["listApprovals", (ws) => ws.listApprovals()],
    ["getApproval", (ws) => ws.getApproval(APPR_PENDING)],
    ["renderHandoff", (ws) => ws.renderHandoff()],
    ["renderReport", (ws) => ws.renderReport({ timeZone: "UTC" })],
  ];
  // What still reads, with the expected result in a form `toEqual` can check.
  const sessionReads: Reads = [
    ["manifest", async (ws) => (await ws.manifest()).workspace.id],
    ["listSessions", async (ws) => (await ws.listSessions()).map((s) => s.sessionId)],
    ["readEvents", async (ws) => (await ws.readEvents(SES_DONE)).length],
    ["stats", async (ws) => (await ws.stats({ timeZone: "UTC" })).totals.sessionCount],
    ["renderDecisions", (ws) => ws.renderDecisions()],
  ];
  const taskResults: Reads = [
    ["listTasks", async (ws) => (await ws.listTasks()).map((t) => t.task.task.id)],
    ["getTask", async (ws) => (await ws.getTask(TASK_ID))?.task.task.title],
  ];
  const approvalResults: Reads = [
    [
      "listApprovals",
      async (ws) => {
        const { pending, resolved } = await ws.listApprovals();
        return [pending.map((a) => a.approval.id), resolved.map((a) => a.approval.id)];
      },
    ],
    ["getApproval", async (ws) => (await ws.getApproval(APPR_PENDING))?.location],
  ];

  type Store = {
    relative: string;
    error: typeof TaskStoreUnsafeError;
    refused: Reads;
    unaffected: Reads;
  };
  const stores: Store[] = [
    {
      relative: "tasks",
      error: TaskStoreUnsafeError,
      refused: taskReads,
      unaffected: [...sessionReads, ...approvalResults],
    },
    {
      relative: "tasks/archive",
      error: TaskStoreUnsafeError,
      refused: taskReads,
      unaffected: [...sessionReads, ...approvalResults],
    },
    ...["approvals", "approvals/pending", "approvals/resolved"].map((relative) => ({
      relative,
      error: ApprovalStoreUnsafeError,
      refused: approvalReads,
      unaffected: [...sessionReads, ...taskResults],
    })),
  ];

  /** The results of `reads` on the untouched fixture, to compare against. */
  async function baseline(reads: Reads): Promise<unknown[]> {
    const ws = await openWorkspace(await setupWorkspace(), clock);
    const out: unknown[] = [];
    for (const [, read] of reads) out.push(await read(ws));
    await rm(getRoot(), { recursive: true, force: true });
    await mkdir(getRoot());
    return out;
  }

  async function expectEachReadRefused(
    ws: Workspace,
    reads: Reads,
    error: typeof TaskStoreUnsafeError,
    message: string,
  ): Promise<void> {
    for (const [name, read] of reads) {
      const thrown = await read(ws).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(thrown, name).toBeInstanceOf(error);
      expect(thrown, name).toBeInstanceOf(StoreUnsafeError);
      expect(thrown, name).toBeInstanceOf(BasouSdkError);
      const refusal = thrown as StoreUnsafeError;
      expect(refusal.name, name).toBe(error.name);
      expect(refusal.message, name).toBe(message);
      expect(refusal.root, name).toBe(ws.root);
      expect(refusal.cause, name).toBeInstanceOf(Error);
      expect(refusal.cause, name).not.toBeInstanceOf(BasouSdkError);
      expect((refusal.cause as Error).message, name).toBe(message);
    }
  }

  for (const { relative, error, refused, unaffected } of stores) {
    const label = `.basou/${relative}`;

    // POSIX only: creating a symlink needs privileges on Windows.
    it.skipIf(process.platform === "win32")(
      `a ${label} that is a symlink makes the reads of that store throw ${error.name}`,
      async () => {
        const expected = await baseline(unaffected);
        const repoRoot = await setupWorkspace();
        const inside = join(repoRoot, ".basou", relative);
        await mkdir(inside, { recursive: true });
        const moved = join(repoRoot, "moved");
        await rename(inside, moved);
        await symlink(moved, inside);
        const ws = await openWorkspace(repoRoot, clock);
        await expectEachReadRefused(
          ws,
          refused,
          error,
          `${label} is a symlink; refusing to operate`,
        );
        for (const [i, [name, read]] of unaffected.entries()) {
          expect(await read(ws), name).toEqual(expected[i]);
        }
      },
    );

    it(`a ${label} that is a file makes the reads of that store throw ${error.name}`, async () => {
      const expected = await baseline(unaffected);
      const repoRoot = await setupWorkspace();
      const inside = join(repoRoot, ".basou", relative);
      await rm(inside, { recursive: true, force: true });
      await writeFile(inside, "");
      const ws = await openWorkspace(repoRoot, clock);
      await expectEachReadRefused(ws, refused, error, `${label} exists but is not a directory`);
      for (const [i, [name, read]] of unaffected.entries()) {
        expect(await read(ws), name).toEqual(expected[i]);
      }
    });
  }

  it("a task lookup given an empty id, or task_ alone, yields null without reading", async () => {
    const repoRoot = await setupWorkspace();
    await rm(join(repoRoot, ".basou", "tasks"), { recursive: true, force: true });
    await writeFile(join(repoRoot, ".basou", "tasks"), "");
    const ws = await openWorkspace(repoRoot);
    for (const id of ["", "   ", "task_", " task_ "]) {
      expect(await ws.getTask(id), JSON.stringify(id)).toBeNull();
    }
    await expect(ws.getTask("task_0")).rejects.toBeInstanceOf(TaskStoreUnsafeError);
  });

  it("an approval lookup checks the store whatever the id", async () => {
    const repoRoot = await setupWorkspace();
    await rm(join(repoRoot, ".basou", "approvals"), { recursive: true, force: true });
    await writeFile(join(repoRoot, ".basou", "approvals"), "");
    const ws = await openWorkspace(repoRoot);
    await expect(ws.getApproval("")).rejects.toBeInstanceOf(ApprovalStoreUnsafeError);
  });

  it("a session store refusal is a StoreUnsafeError too", async () => {
    const repoRoot = await setupWorkspace();
    await rm(join(repoRoot, ".basou", "sessions"), { recursive: true, force: true });
    await writeFile(join(repoRoot, ".basou", "sessions"), "");
    const ws = await openWorkspace(repoRoot);
    const thrown = await ws.listSessions().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(SessionStoreUnsafeError);
    expect(thrown).toBeInstanceOf(StoreUnsafeError);
    expect(thrown).not.toBeInstanceOf(TaskStoreUnsafeError);
    expect(thrown).not.toBeInstanceOf(ApprovalStoreUnsafeError);
  });
});
