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
import { guardReads, openWorkspace, toStoreError, type Workspace } from "./workspace.js";

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
    // The prefix is on `.input` as given, with its `ses_` and its spaces.
    const given = " ses_01HXABCDEF1234567890ABCAM ";
    const error = await ws.getSession(given).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AmbiguousIdError);
    expect((error as AmbiguousIdError).input).toBe(given);
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

type StoreName = "sessions" | "tasks" | "approvals";

/**
 * Every method of a workspace: the stores whose refusal it throws, and a call
 * that drives it to completion and returns what `toEqual` can compare. Keyed
 * by the methods of `Workspace`, so a method added without a row here does not
 * compile, and the first test below checks the object itself.
 */
const METHODS: {
  [K in Exclude<keyof Workspace, "root">]: {
    stores: readonly StoreName[];
    call: (ws: Workspace) => Promise<unknown>;
  };
} = {
  manifest: { stores: [], call: async (ws) => (await ws.manifest()).workspace.id },
  // status throws for no store: it reports a refused directory as missing,
  // which "status of a symlinked .basou/approvals" checks.
  status: { stores: [], call: async (ws) => (await ws.status()).workspace },
  listSessions: {
    stores: ["sessions"],
    call: async (ws) => (await ws.listSessions()).map((s) => s.sessionId),
  },
  getSession: {
    stores: ["sessions"],
    call: async (ws) => (await ws.getSession(SES_DONE))?.sessionId,
  },
  readEvents: {
    stores: ["sessions"],
    call: async (ws) => (await ws.readEvents(SES_DONE)).map((e) => e.id),
  },
  streamEvents: {
    stores: ["sessions"],
    call: async (ws) => {
      const ids: string[] = [];
      for await (const event of ws.streamEvents(SES_DONE)) ids.push(event.id);
      return ids;
    },
  },
  listTasks: {
    stores: ["tasks"],
    call: async (ws) => (await ws.listTasks()).map((t) => t.task.task.id),
  },
  getTask: {
    stores: ["tasks"],
    call: async (ws) => (await ws.getTask(TASK_ID))?.task.task.title,
  },
  listApprovals: {
    stores: ["approvals"],
    call: async (ws) => {
      const { pending, resolved } = await ws.listApprovals();
      return [pending.map((a) => a.approval.id), resolved.map((a) => a.approval.id)];
    },
  },
  getApproval: {
    stores: ["approvals"],
    call: async (ws) => (await ws.getApproval(APPR_PENDING))?.location,
  },
  stats: {
    stores: ["sessions"],
    call: async (ws) => (await ws.stats({ timeZone: "UTC" })).totals.sessionCount,
  },
  renderHandoff: { stores: ["sessions", "tasks", "approvals"], call: (ws) => ws.renderHandoff() },
  renderDecisions: { stores: ["sessions"], call: (ws) => ws.renderDecisions() },
  renderReport: {
    stores: ["sessions", "tasks", "approvals"],
    call: (ws) => ws.renderReport({ timeZone: "UTC" }),
  },
};

describe("every method of a workspace", () => {
  const methodNames = Object.keys(METHODS) as Array<keyof typeof METHODS>;
  // The methods that take an argument (an id, or options); the others take none.
  const ONE_PARAMETER = new Set([
    "getSession",
    "readEvents",
    "streamEvents",
    "getTask",
    "getApproval",
    "stats",
    "renderReport",
  ]);

  it("keeps its name and its number of parameters", async () => {
    const ws = await openWorkspace(await setupWorkspace());
    for (const name of methodNames) {
      expect(ws[name].name, name).toBe(name);
      expect(ws[name].length, name).toBe(ONE_PARAMETER.has(name) ? 1 : 0);
    }
  });

  it("returns a promise or a stream as it is called, even when the clock throws", async () => {
    const broken = new Error("clock broke");
    const ws = await openWorkspace(await setupWorkspace(), {
      now: () => {
        throw broken;
      },
    });
    for (const name of methodNames) {
      let result: unknown;
      expect(() => {
        result = (ws[name] as (arg: string) => unknown)(SES_DONE);
      }, name).not.toThrow();
      // Let it finish, so nothing is left running.
      if (result instanceof Promise) {
        await result.catch(() => undefined);
      } else {
        const events: unknown[] = [];
        for await (const event of result as AsyncIterable<unknown>) events.push(event);
      }
    }
    // The clock fails the reads that use it through their promise.
    await expect(ws.listSessions()).rejects.toBe(broken);
    await expect(ws.stats()).rejects.toBe(broken);
  });
});

describe("a directory of the store that is not followed", () => {
  // One clock for the baseline and the refused workspace, so rendered output compares.
  const clock = { now: () => new Date("2026-05-11T00:00:00.000Z") };
  const methods = Object.entries(METHODS);

  // Held for `instanceof` only, so typed by what it constructs, not by its
  // constructor's parameters, which the SDK does not guarantee.
  type StoreError = abstract new (...args: never) => StoreUnsafeError;
  const STORE_ERRORS: Record<StoreName, StoreError> = {
    sessions: SessionStoreUnsafeError,
    tasks: TaskStoreUnsafeError,
    approvals: ApprovalStoreUnsafeError,
  };
  // `missing`: the keys of `status().directories_present` that turn false
  // when the directory is replaced; every other key stays as it was.
  type Directory = { relative: string; store: StoreName; missing: readonly string[] };
  const SESSIONS: Directory = { relative: "sessions", store: "sessions", missing: ["sessions"] };
  const directories: readonly Directory[] = [
    SESSIONS,
    { relative: "tasks", store: "tasks", missing: ["tasks"] },
    { relative: "tasks/archive", store: "tasks", missing: [] },
    {
      relative: "approvals",
      store: "approvals",
      missing: ["approvals_pending", "approvals_resolved"],
    },
    { relative: "approvals/pending", store: "approvals", missing: ["approvals_pending"] },
    { relative: "approvals/resolved", store: "approvals", missing: ["approvals_resolved"] },
  ];

  async function replaceWithSymlink(repoRoot: string, relative: string): Promise<void> {
    const inside = join(repoRoot, ".basou", relative);
    await mkdir(inside, { recursive: true });
    const moved = join(repoRoot, "moved");
    await rename(inside, moved);
    await symlink(moved, inside);
  }

  async function replaceWithFile(repoRoot: string, relative: string): Promise<void> {
    const inside = join(repoRoot, ".basou", relative);
    await rm(inside, { recursive: true, force: true });
    await writeFile(inside, "");
  }

  type Baseline = { results: Map<string, unknown>; present: Record<string, boolean> };

  /**
   * What every method returns on the untouched fixture, and the directories
   * `status` reports there, to compare against.
   */
  async function baseline(): Promise<Baseline> {
    const ws = await openWorkspace(await setupWorkspace(), clock);
    const results = new Map<string, unknown>();
    for (const [name, { call }] of methods) results.set(name, await call(ws));
    const present = (await ws.status()).directories_present;
    await rm(getRoot(), { recursive: true, force: true });
    await mkdir(getRoot());
    return { results, present };
  }

  /**
   * Each method that reads the directory's store throws its refusal, retyped
   * once with core's error as the cause; each other method returns what it
   * returned on the untouched fixture; and `status` reports the directory's
   * keys as missing and every other key as before.
   */
  async function expectStoreRefused(
    ws: Workspace,
    { store, missing }: Directory,
    message: string,
    expected: Baseline,
  ): Promise<void> {
    expect((await ws.status()).directories_present).toEqual({
      ...expected.present,
      ...Object.fromEntries(missing.map((key) => [key, false])),
    });
    const error = STORE_ERRORS[store];
    for (const [name, { stores, call }] of methods) {
      if (!stores.includes(store)) {
        expect(await call(ws), name).toEqual(expected.results.get(name));
        continue;
      }
      const thrown = await call(ws).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(thrown, name).toBeInstanceOf(error);
      expect(thrown, name).toBeInstanceOf(StoreUnsafeError);
      expect(thrown, name).toBeInstanceOf(BasouSdkError);
      // The three are siblings: catching one store's error catches no other's.
      for (const other of Object.values(STORE_ERRORS)) {
        if (other !== error) expect(thrown, `${name} vs ${other.name}`).not.toBeInstanceOf(other);
      }
      const refusal = thrown as StoreUnsafeError;
      expect(refusal.name, name).toBe(error.name);
      expect(refusal.message, name).toBe(message);
      expect(refusal.root, name).toBe(ws.root);
      expect(refusal.cause, name).toBeInstanceOf(Error);
      expect(refusal.cause, name).not.toBeInstanceOf(BasouSdkError);
      expect((refusal.cause as Error).message, name).toBe(message);
      // The cause is the error core's store check threw, not a copy of it.
      expect((refusal.cause as Error).stack, name).toContain("assertStoreDirectorySafe");
    }
  }

  it("classifies every method of a workspace by the stores it reads", async () => {
    const ws = await openWorkspace(await setupWorkspace());
    expect(Object.keys(ws).sort()).toEqual(["root", ...Object.keys(METHODS)].sort());
  });

  for (const directory of directories) {
    const label = `.basou/${directory.relative}`;
    const error = STORE_ERRORS[directory.store];

    // POSIX only: creating a symlink needs privileges on Windows.
    it.skipIf(process.platform === "win32")(
      `a ${label} that is a symlink makes the reads of that store throw ${error.name}`,
      async () => {
        const expected = await baseline();
        const repoRoot = await setupWorkspace();
        await replaceWithSymlink(repoRoot, directory.relative);
        const ws = await openWorkspace(repoRoot, clock);
        await expectStoreRefused(
          ws,
          directory,
          `${label} is a symlink; refusing to operate`,
          expected,
        );
      },
    );

    it(`a ${label} that is a file makes the reads of that store throw ${error.name}`, async () => {
      const expected = await baseline();
      const repoRoot = await setupWorkspace();
      await replaceWithFile(repoRoot, directory.relative);
      const ws = await openWorkspace(repoRoot, clock);
      await expectStoreRefused(ws, directory, `${label} exists but is not a directory`, expected);
    });
  }

  it("is checked on each call, so a workspace opened before the store was replaced throws it", async () => {
    const expected = await baseline();
    const repoRoot = await setupWorkspace();
    const ws = await openWorkspace(repoRoot, clock);
    expect((await ws.listSessions()).map((s) => s.sessionId)).toContain(SES_DONE);
    await replaceWithFile(repoRoot, "sessions");
    await expectStoreRefused(
      ws,
      SESSIONS,
      ".basou/sessions exists but is not a directory",
      expected,
    );
  });

  it("a session lookup given an empty id, or ses_ alone, yields nothing without reading", async () => {
    const repoRoot = await setupWorkspace();
    await replaceWithFile(repoRoot, "sessions");
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

  it("a task lookup given an empty id, or task_ alone, yields null without reading", async () => {
    const repoRoot = await setupWorkspace();
    await replaceWithFile(repoRoot, "tasks");
    const ws = await openWorkspace(repoRoot);
    for (const id of ["", "   ", "task_", " task_ "]) {
      expect(await ws.getTask(id), JSON.stringify(id)).toBeNull();
    }
    await expect(ws.getTask("task_0")).rejects.toBeInstanceOf(TaskStoreUnsafeError);
  });

  it("an approval lookup given a string that is not an approval id reads nothing", async () => {
    const repoRoot = await setupWorkspace();
    await replaceWithFile(repoRoot, "approvals");
    const ws = await openWorkspace(repoRoot);
    for (const id of ["", "appr_", APPR_PENDING.slice(0, -1), `${APPR_PENDING} `]) {
      expect(await ws.getApproval(id), JSON.stringify(id)).toBeNull();
    }
    await expect(ws.getApproval(APPR_PENDING)).rejects.toBeInstanceOf(ApprovalStoreUnsafeError);
  });

  it("an approval lookup does not leave the store: a path in the id is not followed", async () => {
    const repoRoot = await setupWorkspace();
    // A well-formed approval outside the store, where `../` from pending/ leads.
    const outside = join(repoRoot, "outside");
    await mkdir(outside);
    await writeFile(
      join(outside, "evil.yaml"),
      toYaml({
        schema_version: "0.1.0",
        id: APPR_PENDING,
        session_id: SES_DONE,
        created_at: "2026-05-10T00:00:00.000Z",
        status: "pending",
        risk_level: "low",
        action: { kind: "command" },
        reason: "outside the store",
      }),
    );
    const ws = await openWorkspace(repoRoot);
    // pending/ is .basou/approvals/pending, so three levels up is the repo root.
    expect(await ws.getApproval("../../../outside/evil")).toBeNull();
    expect((await ws.getApproval(APPR_PENDING))?.approval.reason).toBe("fixture approval");
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

describe("toStoreError", () => {
  const ROOT = "/repo";

  it("retypes core's refusal of a store directory, with the refusal as the cause", () => {
    const refusal = new Error(".basou/tasks/archive exists but is not a directory");
    const retyped = toStoreError(ROOT, refusal);
    expect(retyped).toBeInstanceOf(TaskStoreUnsafeError);
    expect((retyped as TaskStoreUnsafeError).root).toBe(ROOT);
    expect((retyped as TaskStoreUnsafeError).cause).toBe(refusal);
  });

  it("does not retype an SDK error, so a refusal is retyped once", () => {
    const retyped = toStoreError(
      ROOT,
      new Error(".basou/sessions is a symlink; refusing to operate"),
    );
    expect(retyped).toBeInstanceOf(SessionStoreUnsafeError);
    // It carries core's message, which would match again.
    expect(toStoreError(ROOT, retyped)).toBe(retyped);
    // Any SDK error, not only a store refusal, is left as it is.
    const sdkError = new BasouSdkError(".basou/sessions is a symlink; refusing to operate");
    expect(toStoreError(ROOT, sdkError)).toBe(sdkError);
  });

  it("returns any other error, or a thrown value that is not an Error, unchanged", () => {
    const other = new Error(".basou/sessions is a symlink");
    expect(toStoreError(ROOT, other)).toBe(other);
    expect(toStoreError(ROOT, ".basou/sessions is a symlink; refusing to operate")).toBe(
      ".basou/sessions is a symlink; refusing to operate",
    );
  });
});

describe("guardReads", () => {
  const ROOT = "/repo";
  const REFUSAL = ".basou/sessions is a symlink; refusing to operate";

  it("retypes a refusal a read throws as it is called", () => {
    const reads = guardReads(ROOT, {
      read: (): Promise<unknown> => {
        throw new Error(REFUSAL);
      },
    });
    expect(() => reads.read()).toThrow(SessionStoreUnsafeError);
  });

  it("passes an early break on to the stream it wraps", async () => {
    let closed = false;
    const reads = guardReads(ROOT, {
      stream: (): AsyncIterable<number> =>
        (async function* () {
          try {
            yield 1;
            yield 2;
          } finally {
            closed = true;
          }
        })(),
    });
    const seen: number[] = [];
    for await (const value of reads.stream()) {
      seen.push(value);
      break;
    }
    expect(seen).toEqual([1]);
    expect(closed).toBe(true);
  });
});

// POSIX only: creating a symlink needs privileges on Windows.
describe.skipIf(process.platform === "win32")("an approval file that is not followed", () => {
  it("is left out of listApprovals, reported, and looked up as null by getApproval", async () => {
    const repoRoot = await setupWorkspace();
    const pending = join(repoRoot, ".basou", "approvals", "pending", `${APPR_PENDING}.yaml`);
    const outside = join(repoRoot, "outside.yaml");
    await rename(pending, outside);
    await symlink(outside, pending);
    const diagnostics: Array<{ message: string; id?: string }> = [];
    const ws = await openWorkspace(repoRoot, { onDiagnostic: (d) => diagnostics.push(d) });

    expect(await ws.getApproval(APPR_PENDING)).toBeNull();
    const listed = await ws.listApprovals();
    expect(listed.pending.map((a) => a.approval.id)).not.toContain(APPR_PENDING);
    expect(diagnostics).toContainEqual({
      message: "skipped: approval_file_not_a_file (pending)",
      id: APPR_PENDING,
    });
  });

  it("does not hide a file on the other side: a symlinked resolved file leaves the pending one", async () => {
    const repoRoot = await setupWorkspace();
    // APPR_DUP has a file on both sides; its resolved one becomes a symlink.
    const resolved = join(repoRoot, ".basou", "approvals", "resolved", `${APPR_DUP}.yaml`);
    const outside = join(repoRoot, "outside.yaml");
    await rename(resolved, outside);
    await symlink(outside, resolved);
    const diagnostics: Array<{ message: string; id?: string }> = [];
    const ws = await openWorkspace(repoRoot, { onDiagnostic: (d) => diagnostics.push(d) });

    const loaded = await ws.getApproval(APPR_DUP);
    expect(loaded?.location).toBe("pending");
    expect(loaded?.approval.status).toBe("pending");
    const listed = await ws.listApprovals();
    expect(listed.pending.map((a) => a.approval.id)).toContain(APPR_DUP);
    expect(listed.resolved.map((a) => a.approval.id)).not.toContain(APPR_DUP);
    // The file passed over is named with its side, so it is not mistaken for
    // the approval that is listed.
    expect(diagnostics).toEqual([
      { message: "skipped: approval_file_not_a_file (resolved)", id: APPR_DUP },
    ]);
  });
});

// POSIX only: creating a symlink needs privileges on Windows.
describe.skipIf(process.platform === "win32")("status of a symlinked .basou/approvals", () => {
  it("reports both approval directories as missing, and the others as present", async () => {
    const repoRoot = await setupWorkspace();
    const approvals = join(repoRoot, ".basou", "approvals");
    const moved = join(repoRoot, "moved-approvals");
    await rename(approvals, moved);
    await symlink(moved, approvals);
    const ws = await openWorkspace(repoRoot);
    const { directories_present: present } = await ws.status();
    expect(present.approvals_pending).toBe(false);
    expect(present.approvals_resolved).toBe(false);
    expect(present.sessions).toBe(true);
    expect(present.tasks).toBe(true);
  });
});
