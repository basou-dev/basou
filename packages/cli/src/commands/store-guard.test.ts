import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  basouPaths,
  createManifest,
  createTaskWithEvent,
  ensureBasouDirectory,
  type PrefixedId,
  writeManifest,
  writeYamlFile,
} from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runApprovalApprove, runApprovalReject } from "./approval.js";
import { runDecisionCapture, runDecisionRecord, runDecisionVoid } from "./decision.js";
import { runDecisionGaps } from "./decision-gaps.js";
import { runHandoffGenerate } from "./handoff.js";
import { runImportClaudeCode } from "./import.js";
import { runNote } from "./note.js";
import { runOrient } from "./orient.js";
import { runRefresh } from "./refresh.js";
import { runReportGenerate } from "./report.js";
import { runReviewRecord } from "./review.js";
import { runSessionImport, runSessionNote, runSessionRechain } from "./session.js";
import {
  runTaskArchive,
  runTaskDelete,
  runTaskEdit,
  runTaskNew,
  runTaskReconcile,
  runTaskRefreshLinkage,
  runTaskStatus,
} from "./task.js";

// The commands outside `basou task` and `basou approval` that read the task or
// approval store, driven through their CLI entry points against a store whose
// directory is a symlink. The core functions underneath are tested directly in
// @basou/core; this pins that each command stops on the refusal and writes
// nothing, as docs/spec/workspace.md lists.

const execFileAsync = promisify(execFile);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const FIXED_DATE = new Date("2026-05-09T03:00:00.000Z");
const TASK_ID = "task_01HXABCDEF1234567890ABCTK1" as PrefixedId<"task">;
const APPROVAL_ID = "appr_01HXABCDEF1234567890ABCAP1";

let tmp: string | undefined;

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), "basou-store-guard-test-")));
});

afterEach(async () => {
  if (tmp !== undefined) {
    await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
  process.exitCode = 0;
  vi.restoreAllMocks();
});

function getTmp(): string {
  if (tmp === undefined) throw new Error("tmp not initialized");
  return tmp;
}

/** A workspace with one task, one pending approval and one Claude transcript to import. */
async function setupRepo(): Promise<string> {
  const repo = join(getTmp(), "repo");
  await mkdir(repo);
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: repo, env: ENV });
  const paths = await ensureBasouDirectory(repo);
  const manifest = createManifest({
    workspaceName: "fixture-ws",
    now: FIXED_DATE,
    workspaceId: FIXED_WS_ID,
  });
  await writeManifest(paths, manifest);
  const created = await createTaskWithEvent({
    mode: "ad-hoc",
    paths,
    manifest,
    occurredAt: "2026-05-09T03:00:00.000Z",
    taskId: TASK_ID,
    title: "fixture task",
    initialStatus: "planned",
    description: "",
    workingDirectory: repo,
  });
  await writeYamlFile(join(paths.approvals.pending, `${APPROVAL_ID}.yaml`), {
    schema_version: "0.2.0",
    id: APPROVAL_ID,
    session_id: created.sessionId,
    created_at: "2026-05-09T03:00:00.000Z",
    status: "pending",
    risk_level: "low",
    action: { kind: "command" },
    reason: "fixture approval",
    expires_at: null,
  });
  const transcripts = join(getTmp(), "claude", repo.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(transcripts, { recursive: true });
  await writeFile(
    join(transcripts, "claude-sess-1.jsonl"),
    [
      {
        type: "user",
        timestamp: "2026-05-10T00:00:00.000Z",
        cwd: repo,
        sessionId: "claude-sess-1",
        message: { role: "user", content: [{ type: "text", text: "go" }] },
      },
      {
        type: "assistant",
        timestamp: "2026-05-10T00:00:01.000Z",
        cwd: repo,
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n"),
  );
  return repo;
}

function ctxFor(repo: string) {
  return {
    cwd: repo,
    nowProvider: () => FIXED_DATE,
    claudeProjectsDir: join(getTmp(), "claude"),
    codexSessionsDir: join(getTmp(), "codex"),
    hostsConfigPath: join(getTmp(), "hosts.yaml"),
    portfolioConfigPath: join(getTmp(), "portfolio.yaml"),
  };
}

/** A session import payload that names the fixture task. */
async function writeImportPayload(): Promise<string> {
  const file = join(getTmp(), "import.json");
  const sessionId = "ses_01HXABCDEF1234567890ABCNW1";
  await writeFile(
    file,
    JSON.stringify({
      schema_version: "0.2.0",
      session: {
        id: sessionId,
        workspace_id: FIXED_WS_ID,
        task_id: TASK_ID,
        source: { kind: "claude-code-adapter", version: "0.1.0" },
        started_at: "2026-05-08T11:00:00+09:00",
        status: "completed",
        working_directory: "/srv/example-project",
        invocation: { command: "claude", args: [], exit_code: 0 },
        related_files: [],
      },
      events: [
        {
          schema_version: "0.2.0",
          type: "session_started",
          id: "evt_01HXABCDEF1234567890ABCEV2",
          session_id: sessionId,
          occurred_at: "2026-05-08T11:00:00+09:00",
          source: "claude-code-adapter",
        },
      ],
    }),
  );
  return file;
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

type Command = [string, (repo: string) => Promise<void>];

const BOTH_STORES: Command[] = [
  ["orient", (repo) => runOrient({}, ctxFor(repo))],
  ["orient --refresh", (repo) => runOrient({ refresh: true }, ctxFor(repo))],
  ["handoff generate", (repo) => runHandoffGenerate({}, ctxFor(repo))],
  ["report generate", (repo) => runReportGenerate({}, ctxFor(repo))],
  ["refresh", (repo) => runRefresh({}, ctxFor(repo))],
];
const TASK_STORE_ONLY: Command[] = [
  ["decision gaps", (repo) => runDecisionGaps({}, ctxFor(repo))],
  [
    "session import",
    async (repo) =>
      runSessionImport({ format: "json", from: await writeImportPayload() }, ctxFor(repo)),
  ],
];

const STORES: Array<[string, Command[]]> = [
  ["tasks", [...BOTH_STORES, ...TASK_STORE_ONLY]],
  ["tasks/archive", [...BOTH_STORES, ...TASK_STORE_ONLY]],
  ["approvals", BOTH_STORES],
  ["approvals/pending", BOTH_STORES],
  ["approvals/resolved", BOTH_STORES],
];

// POSIX only: creating a symlink needs privileges on Windows.
describe.skipIf(process.platform === "win32")("a store directory that is a symlink", () => {
  it("control: with the store intact every command succeeds, and refresh imports the transcript", async () => {
    for (const [name, run] of [...BOTH_STORES, ...TASK_STORE_ONLY]) {
      await rm(join(getTmp(), "repo"), { recursive: true, force: true });
      await rm(join(getTmp(), "claude"), { recursive: true, force: true });
      const repo = await setupRepo();
      const sessionsBefore = (await readdir(basouPaths(repo).sessions)).length;
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      process.exitCode = 0;
      await run(repo);
      expect(process.exitCode, `${name}: ${err.mock.calls.join(" | ")}`).not.toBe(1);
      if (name === "refresh") {
        expect((await readdir(basouPaths(repo).sessions)).length).toBe(sessionsBefore + 1);
      }
      vi.restoreAllMocks();
    }
  });

  for (const [relative, commands] of STORES) {
    const label = `.basou/${relative}`;

    it(`${label}: each command stops with the refusal and writes nothing`, async () => {
      for (const [name, run] of commands) {
        await rm(join(getTmp(), "repo"), { recursive: true, force: true });
        await rm(join(getTmp(), "outside"), { recursive: true, force: true });
        await rm(join(getTmp(), "claude"), { recursive: true, force: true });
        const repo = await setupRepo();
        const paths = basouPaths(repo);
        const inside = join(paths.root, relative);
        const outside = join(getTmp(), "outside");
        await mkdir(inside, { recursive: true });
        await rename(inside, outside);
        await symlink(outside, inside);
        const outsideBefore = await snapshot(outside);
        const sessionsBefore = await snapshot(paths.sessions);

        vi.spyOn(console, "log").mockImplementation(() => undefined);
        const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
        process.exitCode = 0;
        await run(repo);
        expect(process.exitCode, name).toBe(1);
        expect(err.mock.calls.map((c) => String(c[0])).join("\n"), name).toContain(
          `${label} is a symlink; refusing to operate`,
        );
        expect(await snapshot(outside), name).toEqual(outsideBefore);
        // Nothing imported, no session started: the sessions are as they were.
        expect(await snapshot(paths.sessions), name).toEqual(sessionsBefore);
        vi.restoreAllMocks();
      }
    });
  }
});

// POSIX only: creating a symlink needs privileges on Windows.
describe.skipIf(process.platform === "win32")("refresh --dry-run with a symlinked store", () => {
  for (const relative of [
    "tasks",
    "tasks/archive",
    "approvals",
    "approvals/pending",
    "approvals/resolved",
  ]) {
    it(`is not stopped by a symlinked .basou/${relative}, and writes nothing`, async () => {
      const repo = await setupRepo();
      const paths = basouPaths(repo);
      const inside = join(paths.root, relative);
      const outside = join(getTmp(), "outside");
      await mkdir(inside, { recursive: true });
      await rename(inside, outside);
      await symlink(outside, inside);
      const sessionsBefore = await snapshot(paths.sessions);
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      process.exitCode = 0;
      await runRefresh({ dryRun: true }, ctxFor(repo));
      expect(process.exitCode).not.toBe(1);
      expect(err.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain(
        "refusing to operate",
      );
      expect(await snapshot(paths.sessions)).toEqual(sessionsBefore);
    });
  }
});

// Commands that take a lock, against a `.basou/locks` that is a symlink: each
// stops before it writes anything, rather than creating its lockfile behind
// the link (or, for the ones that import or start a session first, after
// writing that). The lock itself is tested in @basou/core.

/** A running session with one pending approval, for the commands that attach to one. */
const RUNNING_SESSION_ID = "ses_01HXABCDEF1234567890ABCRN1";
const RUNNING_APPROVAL_ID = "appr_01HXABCDEF1234567890ABCAP2";

async function addRunningSession(repo: string): Promise<void> {
  const paths = basouPaths(repo);
  const dir = join(paths.sessions, RUNNING_SESSION_ID);
  await mkdir(dir, { recursive: true });
  await writeYamlFile(join(dir, "session.yaml"), {
    schema_version: "0.1.0",
    session: {
      id: RUNNING_SESSION_ID,
      task_id: null,
      workspace_id: FIXED_WS_ID,
      source: { kind: "claude-code-adapter", version: "0.1.0" },
      started_at: "2026-05-09T02:00:00.000Z",
      status: "running",
      working_directory: "~/projects/example",
      invocation: { command: "claude", args: [], exit_code: null },
      related_files: [],
      events_log: "events.jsonl",
      summary: null,
    },
  });
  await writeFile(join(dir, "events.jsonl"), "");
  await writeYamlFile(join(paths.approvals.pending, `${RUNNING_APPROVAL_ID}.yaml`), {
    schema_version: "0.2.0",
    id: RUNNING_APPROVAL_ID,
    session_id: RUNNING_SESSION_ID,
    created_at: "2026-05-09T03:00:00.000Z",
    status: "pending",
    risk_level: "low",
    action: { kind: "command" },
    reason: "fixture approval",
    expires_at: null,
  });
}

/** Record one decision through `decision capture` and return its id. */
async function captureOneDecision(repo: string): Promise<string> {
  const file = join(getTmp(), "decision.json");
  await writeFile(file, JSON.stringify([{ title: "to be voided", kind: "decision" }]));
  const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
  await runDecisionCapture({ file, json: true }, ctxFor(repo));
  const id = /decision_[0-9A-HJKMNP-TV-Z]{26}/.exec(out.mock.calls.join("\n"))?.[0];
  out.mockRestore();
  if (id === undefined) throw new Error("no decision captured");
  return id;
}

type LockTaker = {
  name: string;
  /** Run before `.basou/locks` is swapped; returns what `run` needs, if anything. */
  prepare?: (repo: string) => Promise<string | undefined>;
  run: (repo: string, prepared: string | undefined) => Promise<unknown>;
  /** Store directories the command needs to find its input in. */
  needs?: Array<"tasks" | "sessions">;
};

const LOCK_TAKERS: LockTaker[] = [
  { name: "refresh", run: (repo) => runRefresh({}, ctxFor(repo)) },
  { name: "orient --refresh", run: (repo) => runOrient({ refresh: true }, ctxFor(repo)) },
  {
    name: "import claude-code --all",
    run: (repo) => runImportClaudeCode({ all: true }, ctxFor(repo)),
  },
  { name: "task new", run: (repo) => runTaskNew({ title: "another task" }, ctxFor(repo)) },
  {
    name: "task status",
    run: (repo) => runTaskStatus(TASK_ID, "in_progress", {}, ctxFor(repo)),
    needs: ["tasks"],
  },
  {
    name: "task edit",
    run: (repo) => runTaskEdit(TASK_ID, { title: "renamed" }, ctxFor(repo)),
    needs: ["tasks"],
  },
  {
    name: "task archive",
    prepare: async (repo) => {
      await runTaskStatus(TASK_ID, "done", {}, ctxFor(repo));
      return undefined;
    },
    run: (repo) => runTaskArchive(TASK_ID, { yes: true }, ctxFor(repo)),
    needs: ["tasks", "sessions"],
  },
  {
    name: "task delete",
    run: (repo) => runTaskDelete(TASK_ID, { yes: true }, ctxFor(repo)),
    needs: ["tasks", "sessions"],
  },
  { name: "task reconcile", run: (repo) => runTaskReconcile({}, ctxFor(repo)), needs: ["tasks"] },
  {
    name: "task reconcile --write",
    run: (repo) => runTaskReconcile({ write: true }, ctxFor(repo)),
    needs: ["tasks", "sessions"],
  },
  {
    name: "task refresh-linkage",
    run: (repo) => runTaskRefreshLinkage(TASK_ID, {}, ctxFor(repo)),
    needs: ["tasks", "sessions"],
  },
  {
    name: "decision record",
    run: (repo) => runDecisionRecord({ title: "a decision" }, ctxFor(repo)),
  },
  {
    name: "decision capture",
    prepare: async () => {
      const file = join(getTmp(), "capture.json");
      await writeFile(file, JSON.stringify([{ title: "captured", kind: "decision" }]));
      return file;
    },
    run: (repo, file) => runDecisionCapture({ file: file ?? "" }, ctxFor(repo)),
  },
  {
    name: "decision void",
    prepare: (repo) => captureOneDecision(repo),
    run: (repo, id) => runDecisionVoid(id ?? "", {}, ctxFor(repo)),
    needs: ["sessions"],
  },
  {
    name: "review record",
    prepare: async (repo) => {
      const file = join(getTmp(), "review.json");
      await writeFile(file, JSON.stringify({ reviewer: "test", target: "branch", repos: [repo] }));
      return file;
    },
    run: (repo, file) => runReviewRecord({ file: file ?? "" }, ctxFor(repo)),
  },
  { name: "note", run: (repo) => runNote("a note", {}, ctxFor(repo)) },
  {
    name: "note --session",
    prepare: async (repo) => {
      await addRunningSession(repo);
      return undefined;
    },
    run: (repo) => runNote("a note", { session: RUNNING_SESSION_ID }, ctxFor(repo)),
    needs: ["sessions"],
  },
  {
    name: "session note",
    prepare: async (repo) => {
      await addRunningSession(repo);
      return undefined;
    },
    run: (repo) => runSessionNote(RUNNING_SESSION_ID, { body: "a note" }, ctxFor(repo)),
    needs: ["sessions"],
  },
  {
    name: "approval approve",
    prepare: async (repo) => {
      await addRunningSession(repo);
      return undefined;
    },
    run: (repo) => runApprovalApprove(RUNNING_APPROVAL_ID, {}, ctxFor(repo)),
    needs: ["sessions"],
  },
  {
    name: "approval reject",
    prepare: async (repo) => {
      await addRunningSession(repo);
      return undefined;
    },
    run: (repo) => runApprovalReject(RUNNING_APPROVAL_ID, { reason: "no" }, ctxFor(repo)),
    needs: ["sessions"],
  },
  {
    name: "session rechain --all",
    run: (repo) => runSessionRechain({ all: true }, ctxFor(repo)),
    needs: ["sessions"],
  },
];

/**
 * The directories a command can create lazily. A stripped-down store lacks
 * the ones the command does not read its input from, so a command that
 * creates one before it checks the lock store is caught.
 */
const LAZY_DIRECTORIES = ["tasks", "sessions", "approvals/resolved", "tmp"] as const;

// POSIX only: creating a symlink needs privileges on Windows.
describe.skipIf(process.platform === "win32")("a .basou/locks that is a symlink", () => {
  async function freshRepo(): Promise<string> {
    await rm(join(getTmp(), "repo"), { recursive: true, force: true });
    await rm(join(getTmp(), "outside"), { recursive: true, force: true });
    await rm(join(getTmp(), "claude"), { recursive: true, force: true });
    return setupRepo();
  }

  it("control: with the locks directory intact every command succeeds", async () => {
    for (const taker of LOCK_TAKERS) {
      const repo = await freshRepo();
      const prepared = await taker.prepare?.(repo);
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      process.exitCode = 0;
      await taker.run(repo, prepared);
      expect(process.exitCode, `${taker.name}: ${err.mock.calls.join(" | ")}`).not.toBe(1);
      vi.restoreAllMocks();
    }
  });

  for (const stripped of [false, true]) {
    const store = stripped ? "a stripped-down store" : "the full store";
    it(`on ${store}, each command stops with the refusal and writes nothing`, async () => {
      for (const taker of LOCK_TAKERS) {
        const repo = await freshRepo();
        const prepared = await taker.prepare?.(repo);
        const paths = basouPaths(repo);
        if (stripped) {
          for (const relative of LAZY_DIRECTORIES) {
            if ((taker.needs as readonly string[] | undefined)?.includes(relative)) continue;
            await rm(join(paths.root, relative), { recursive: true, force: true });
          }
        }
        const outside = join(getTmp(), "outside");
        await rename(paths.locks, outside);
        await symlink(outside, paths.locks);
        const before = await snapshot(paths.root);

        const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
        process.exitCode = 0;
        await taker.run(repo, prepared);
        expect(process.exitCode, taker.name).toBe(1);
        expect(err.mock.calls.map((c) => String(c[0])).join("\n"), taker.name).toContain(
          ".basou/locks is a symlink; refusing to operate",
        );
        // Stopped once, up front: no per-record row, no partial result.
        expect(out.mock.calls, taker.name).toEqual([]);
        expect(await readdir(outside), taker.name).toEqual([]);
        // No session, task, event or directory was written in the store either.
        expect(await snapshot(paths.root), taker.name).toEqual(before);
        vi.restoreAllMocks();
      }
    });
  }

  it("refresh is stopped even with nothing to import", async () => {
    const repo = await freshRepo();
    await rm(join(getTmp(), "claude"), { recursive: true, force: true });
    const paths = basouPaths(repo);
    const outside = join(getTmp(), "outside");
    await rename(paths.locks, outside);
    await symlink(outside, paths.locks);
    const before = await snapshot(paths.root);
    for (const [name, run] of [
      ["refresh", () => runRefresh({}, ctxFor(repo))],
      ["orient --refresh", () => runOrient({ refresh: true }, ctxFor(repo))],
    ] as const) {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      process.exitCode = 0;
      await run();
      expect(process.exitCode, name).toBe(1);
      expect(err.mock.calls.map((c) => String(c[0])).join("\n"), name).toContain(
        ".basou/locks is a symlink; refusing to operate",
      );
      vi.restoreAllMocks();
    }
    expect(await snapshot(paths.root)).toEqual(before);
  });
});

// POSIX only: creating a symlink needs privileges on Windows.
describe.skipIf(process.platform === "win32")("a dry run with a symlinked .basou/locks", () => {
  const DRY_RUNS: Command[] = [
    [
      "import claude-code --all --dry-run",
      (repo) => runImportClaudeCode({ all: true, dryRun: true }, ctxFor(repo)),
    ],
    ["refresh --dry-run", (repo) => runRefresh({ dryRun: true }, ctxFor(repo))],
  ];

  it("takes no lock and is not stopped, and writes nothing", async () => {
    for (const [name, run] of DRY_RUNS) {
      await rm(join(getTmp(), "repo"), { recursive: true, force: true });
      await rm(join(getTmp(), "outside"), { recursive: true, force: true });
      await rm(join(getTmp(), "claude"), { recursive: true, force: true });
      const repo = await setupRepo();
      const paths = basouPaths(repo);
      const outside = join(getTmp(), "outside");
      await rename(paths.locks, outside);
      await symlink(outside, paths.locks);
      const before = await snapshot(paths.sessions);
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      process.exitCode = 0;
      await run(repo);
      expect(process.exitCode, name).not.toBe(1);
      expect(err.mock.calls.map((c) => String(c[0])).join("\n"), name).not.toContain(
        "refusing to operate",
      );
      expect(await readdir(outside), name).toEqual([]);
      expect(await snapshot(paths.sessions), name).toEqual(before);
      vi.restoreAllMocks();
    }
  });
});
