import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type ProcessRunner,
  type RunOptions,
  type RunResult,
  basouPaths,
  createManifest,
  ensureBasouDirectory,
  writeManifest,
} from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runExec } from "./exec.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
};

const FIXED_DATE = new Date("2026-05-04T09:00:00.000Z");
const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;

let tmpRepo: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-exec-cli-test-"));
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], {
    cwd: tmpRepo,
    env: ENV,
  });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: tmpRepo,
    env: ENV,
  });
  await execFileAsync("git", ["config", "user.name", "test"], { cwd: tmpRepo, env: ENV });
  // Need at least one commit so getSnapshot succeeds in the default tests.
  await execFileAsync("git", ["commit", "--allow-empty", "-m", "init"], {
    cwd: tmpRepo,
    env: ENV,
  });
});

afterEach(async () => {
  if (tmpRepo !== undefined) {
    await rm(tmpRepo, { recursive: true, force: true });
    tmpRepo = undefined;
  }
  vi.restoreAllMocks();
});

function getTmpRepo(): string {
  if (tmpRepo === undefined) throw new Error("tmpRepo not initialized");
  return tmpRepo;
}

async function setupInitedRepo(): Promise<string> {
  const repo = getTmpRepo();
  const paths = await ensureBasouDirectory(repo);
  const manifest = createManifest({
    workspaceName: "client-foo-lp",
    now: FIXED_DATE,
    workspaceId: FIXED_WS_ID,
  });
  await writeManifest(paths, manifest);
  return repo;
}

function makeFakeRunner(result: Partial<RunResult>): ProcessRunner {
  const baseResult: RunResult = {
    command: "node",
    args: [],
    cwd: "/tmp",
    exit_code: 0,
    signal: null,
    stdout: "",
    stderr: "",
    started_at: FIXED_DATE.toISOString(),
    ended_at: FIXED_DATE.toISOString(),
    duration_ms: 0,
    pid: 12345,
    ...result,
  };
  return {
    run: async (cmd, args, options) => ({
      ...baseResult,
      command: cmd,
      args: [...args],
      cwd: options.cwd,
    }),
  };
}

async function readEventsLines(repo: string, sessionId: string): Promise<string[]> {
  const paths = basouPaths(repo);
  const eventsPath = join(paths.sessions, sessionId, "events.jsonl");
  const content = await readFile(eventsPath, "utf8");
  return content.trim().split("\n");
}

async function findOnlySessionId(repo: string): Promise<string> {
  const paths = basouPaths(repo);
  const entries = await readdir(paths.sessions);
  if (entries.length !== 1) throw new Error(`expected 1 session, got ${entries.length}`);
  const id = entries[0];
  if (id === undefined) throw new Error("no session id");
  return id;
}

describe("runExec", () => {
  // 1
  it("records 5 events on the happy path with --no-snapshot", async () => {
    const repo = await setupInitedRepo();
    const runner = makeFakeRunner({ exit_code: 0 });
    const exitCode = await runExec(
      "node",
      ["-e", "process.exit(0)"],
      { cwd: repo, snapshot: false },
      { runner, now: () => FIXED_DATE },
    );
    expect(exitCode).toBe(0);
    const sessionId = await findOnlySessionId(repo);
    const lines = await readEventsLines(repo, sessionId);
    expect(lines).toHaveLength(5);
    const types = lines.map((l) => JSON.parse(l).type);
    expect(types).toEqual([
      "session_started",
      "session_status_changed",
      "command_executed",
      "session_status_changed",
      "session_ended",
    ]);
  });

  // 2
  it("marks session as failed when child exits non-zero", async () => {
    const repo = await setupInitedRepo();
    const runner = makeFakeRunner({ exit_code: 1 });
    const exitCode = await runExec(
      "node",
      ["-e", "process.exit(1)"],
      { cwd: repo, snapshot: false },
      { runner, now: () => FIXED_DATE },
    );
    expect(exitCode).toBe(1);
    const sessionId = await findOnlySessionId(repo);
    const lines = await readEventsLines(repo, sessionId);
    const ce = JSON.parse(lines[2] ?? "{}");
    expect(ce.exit_code).toBe(1);
    const sc2 = JSON.parse(lines[3] ?? "{}");
    expect(sc2.to).toBe("failed");
  });

  // 3 (Y3m-H2)
  it("finalizes session as failed when runner.run throws (spawn-time error)", async () => {
    const repo = await setupInitedRepo();
    const runner: ProcessRunner = {
      run: async () => {
        throw new Error("Command not found", { cause: { code: "ENOENT" } });
      },
    };
    await expect(
      runExec(
        "nonexistent-cmd",
        [],
        { cwd: repo, snapshot: false },
        { runner, now: () => FIXED_DATE },
      ),
    ).rejects.toThrow("Command not found");
    const sessionId = await findOnlySessionId(repo);
    const lines = await readEventsLines(repo, sessionId);
    const types = lines.map((l) => JSON.parse(l).type);
    // started, status->running, command_executed (failed), status->failed, session_ended
    expect(types).toEqual([
      "session_started",
      "session_status_changed",
      "command_executed",
      "session_status_changed",
      "session_ended",
    ]);
    const ce = JSON.parse(lines[2] ?? "{}");
    expect(ce.exit_code).toBeNull();
  });

  // 4 (Y3m-H4)
  it("rejects invalid timeout fail-fast without creating a session", async () => {
    const repo = await setupInitedRepo();
    const runner = makeFakeRunner({ exit_code: 0 });
    await expect(
      runExec(
        "node",
        [],
        { cwd: repo, timeout: "0s", snapshot: false },
        { runner, now: () => FIXED_DATE },
      ),
    ).rejects.toThrow(/Invalid duration/);
    // No session should have been created.
    const paths = basouPaths(repo);
    const entries = await readdir(paths.sessions);
    expect(entries).toHaveLength(0);
  });

  // 5 (Y3m-H3)
  it("fails before creating a session when run from a non-git directory", async () => {
    const nonGit = await mkdtemp(join(tmpdir(), "basou-exec-nongit-"));
    try {
      const runner = makeFakeRunner({ exit_code: 0 });
      await expect(
        runExec("node", [], { cwd: nonGit, snapshot: false }, { runner, now: () => FIXED_DATE }),
      ).rejects.toThrow(/Not a git repository\. Run 'git init'/);
    } finally {
      await rm(nonGit, { recursive: true, force: true });
    }
  });

  // 6
  it("throws when .basou is missing (assertBasouRootSafe)", async () => {
    const repo = getTmpRepo();
    const runner = makeFakeRunner({ exit_code: 0 });
    await expect(
      runExec("node", [], { cwd: repo, snapshot: false }, { runner, now: () => FIXED_DATE }),
    ).rejects.toThrow();
    // No session entry created.
    await expect(access(join(repo, ".basou", "sessions"))).rejects.toThrow();
  });

  // 7
  it("records 7 events when git_snapshot is on (default)", async () => {
    const repo = await setupInitedRepo();
    const runner = makeFakeRunner({ exit_code: 0 });
    await runExec("node", [], { cwd: repo }, { runner, now: () => FIXED_DATE });
    const sessionId = await findOnlySessionId(repo);
    const lines = await readEventsLines(repo, sessionId);
    expect(lines).toHaveLength(7);
    const types = lines.map((l) => JSON.parse(l).type);
    expect(types).toEqual([
      "session_started",
      "git_snapshot",
      "session_status_changed",
      "command_executed",
      "git_snapshot",
      "session_status_changed",
      "session_ended",
    ]);
  });

  // 8 (Y3m-H5)
  it("records signal and exit code 130 on parent SIGINT (POSIX 128+2)", async () => {
    const repo = await setupInitedRepo();
    // Emulate parent SIGINT: the runner sees the controller already aborted
    // when it returns, and the result.signal is "SIGTERM" from the child kill.
    // We simulate by having the runner observe signal emission via a hook.
    const runner: ProcessRunner = {
      run: async (_cmd, _args, options: RunOptions): Promise<RunResult> => {
        // Trigger signal handler that runExec installed.
        process.emit("SIGINT");
        // Wait one microtask so the abort propagates.
        await Promise.resolve();
        return {
          command: "node",
          args: [],
          cwd: options.cwd,
          exit_code: null,
          signal: "SIGTERM",
          stdout: "",
          stderr: "",
          started_at: FIXED_DATE.toISOString(),
          ended_at: FIXED_DATE.toISOString(),
          duration_ms: 0,
          pid: 1,
        };
      },
    };
    const exitCode = await runExec(
      "node",
      [],
      { cwd: repo, snapshot: false },
      { runner, now: () => FIXED_DATE },
    );
    expect(exitCode).toBe(130); // 128 + 2 (SIGINT)
    const sessionId = await findOnlySessionId(repo);
    const lines = await readEventsLines(repo, sessionId);
    const ce = JSON.parse(lines[2] ?? "{}");
    expect(ce.signal).toBe("SIGTERM");
    expect(ce.received_signal).toBe("SIGINT");
    const sc2 = JSON.parse(lines[3] ?? "{}");
    expect(sc2.to).toBe("interrupted");
  });
});
