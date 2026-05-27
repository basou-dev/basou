import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  appendEvent,
  basouPaths,
  type RunOptions as CoreRunOptions,
  createManifest,
  ensureBasouDirectory,
  type ProcessRunner,
  type RunResult,
  writeManifest,
} from "@basou/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunContext, registerRunCommand, runClaudeCode } from "./run.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
};

const FIXED_DATE = new Date("2026-05-09T03:00:00.000Z");
const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;

let tmpRepo: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-run-cli-test-"));
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], {
    cwd: tmpRepo,
    env: ENV,
  });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: tmpRepo,
    env: ENV,
  });
  await execFileAsync("git", ["config", "user.name", "test"], { cwd: tmpRepo, env: ENV });
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

type FakeRunner = ProcessRunner & { lastArgs?: readonly string[] };

function makeFakeRunner(result: Partial<RunResult>): FakeRunner {
  const baseResult: RunResult = {
    command: "claude-code",
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
  const runner: FakeRunner = {
    run: async (cmd, args, options) => {
      runner.lastArgs = [...args];
      return {
        ...baseResult,
        command: cmd,
        args: [...args],
        cwd: options.cwd,
      };
    },
  };
  return runner;
}

const okResolve = async (): Promise<{ command: string }> => ({ command: "claude-code" });

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

describe("runClaudeCode", () => {
  // 1
  it("records 5 events on the happy path with --no-snapshot", async () => {
    const repo = await setupInitedRepo();
    const runner = makeFakeRunner({ exit_code: 0 });
    const exitCode = await runClaudeCode(
      [],
      { cwd: repo, snapshot: false },
      { runner, now: () => FIXED_DATE, resolveCommand: okResolve },
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
    // Adapter source is recorded on lifecycle events, not the command.
    const started = JSON.parse(lines[0] ?? "{}");
    expect(started.source).toBe("claude-code-adapter");
    const cmdExec = JSON.parse(lines[2] ?? "{}");
    expect(cmdExec.source).toBe("terminal-recording");
  });

  // 2
  it("marks session as failed when claude-code exits non-zero", async () => {
    const repo = await setupInitedRepo();
    const runner = makeFakeRunner({ exit_code: 2 });
    const exitCode = await runClaudeCode(
      [],
      { cwd: repo, snapshot: false },
      { runner, now: () => FIXED_DATE, resolveCommand: okResolve },
    );
    expect(exitCode).toBe(2);
    const sessionId = await findOnlySessionId(repo);
    const lines = await readEventsLines(repo, sessionId);
    const sc2 = JSON.parse(lines[3] ?? "{}");
    expect(sc2.to).toBe("failed");
  });

  // 3
  it("finalizes session as failed when runner.run throws (spawn-time error)", async () => {
    const repo = await setupInitedRepo();
    const runner: ProcessRunner = {
      run: async () => {
        throw new Error("Command not found", { cause: { code: "ENOENT" } });
      },
    };
    await expect(
      runClaudeCode(
        [],
        { cwd: repo, snapshot: false },
        { runner, now: () => FIXED_DATE, resolveCommand: okResolve },
      ),
    ).rejects.toThrow("Command not found");
    const sessionId = await findOnlySessionId(repo);
    const lines = await readEventsLines(repo, sessionId);
    const types = lines.map((l) => JSON.parse(l).type);
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

  // 4 — entry-fail pattern: a missing CLI must not leave a session entry
  it("throws and creates no session when claude-code is not on PATH", async () => {
    const repo = await setupInitedRepo();
    const runner = makeFakeRunner({ exit_code: 0 });
    const failingResolve = async (): Promise<{ command: string }> => {
      throw new Error("Claude Code CLI not found in PATH. Install claude-code (or claude) first.");
    };
    await expect(
      runClaudeCode(
        [],
        { cwd: repo, snapshot: false },
        { runner, now: () => FIXED_DATE, resolveCommand: failingResolve },
      ),
    ).rejects.toThrow("Claude Code CLI not found in PATH.");
    const paths = basouPaths(repo);
    const entries = await readdir(paths.sessions);
    expect(entries).toHaveLength(0);
  });

  // 5
  it("fails before creating a session when run from a non-git directory", async () => {
    const nonGit = await mkdtemp(join(tmpdir(), "basou-run-nongit-"));
    try {
      const runner = makeFakeRunner({ exit_code: 0 });
      await expect(
        runClaudeCode(
          [],
          { cwd: nonGit, snapshot: false },
          { runner, now: () => FIXED_DATE, resolveCommand: okResolve },
        ),
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
      runClaudeCode(
        [],
        { cwd: repo, snapshot: false },
        { runner, now: () => FIXED_DATE, resolveCommand: okResolve },
      ),
    ).rejects.toThrow();
    await expect(access(join(repo, ".basou", "sessions"))).rejects.toThrow();
  });

  // 7
  it("records 7 events when git_snapshot is on (default, HEAD unchanged)", async () => {
    const repo = await setupInitedRepo();
    const runner = makeFakeRunner({ exit_code: 0 });
    await runClaudeCode(
      [],
      { cwd: repo },
      { runner, now: () => FIXED_DATE, resolveCommand: okResolve },
    );
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
    // file_changed events stay at 0 for an unchanged HEAD; the only paths
    // that surface in related_files are basou's own untracked files (the
    // gitignore for `.basou/sessions/` is wired up by `basou init`, not by
    // the test fixture used here).
    const fcCount = lines.filter((l) => JSON.parse(l).type === "file_changed").length;
    expect(fcCount).toBe(0);
  });

  // 8 — committed change between pre/post HEAD generates file_changed events
  it("emits file_changed events and updates related_files on a committed change", async () => {
    const repo = await setupInitedRepo();
    // Fake runner makes a real commit so that pre and post HEAD differ.
    const runner: ProcessRunner = {
      run: async (cmd, args, options) => {
        await writeFile(join(options.cwd, "added.txt"), "hello\n");
        await execFileAsync("git", ["add", "added.txt"], { cwd: options.cwd, env: ENV });
        await execFileAsync("git", ["commit", "-m", "add file"], { cwd: options.cwd, env: ENV });
        return {
          command: cmd,
          args: [...args],
          cwd: options.cwd,
          exit_code: 0,
          signal: null,
          stdout: "",
          stderr: "",
          started_at: FIXED_DATE.toISOString(),
          ended_at: FIXED_DATE.toISOString(),
          duration_ms: 0,
          pid: 1,
        };
      },
    };
    await runClaudeCode(
      [],
      { cwd: repo },
      { runner, now: () => FIXED_DATE, resolveCommand: okResolve },
    );
    const sessionId = await findOnlySessionId(repo);
    const lines = await readEventsLines(repo, sessionId);
    const types = lines.map((l) => JSON.parse(l).type);
    expect(types).toEqual([
      "session_started",
      "git_snapshot",
      "session_status_changed",
      "command_executed",
      "git_snapshot",
      "file_changed",
      "session_status_changed",
      "session_ended",
    ]);
    const fc = JSON.parse(lines[5] ?? "{}");
    expect(fc.path).toBe("added.txt");
    expect(fc.change_type).toBe("added");
    expect(fc.source).toBe("git-capability");
    const yaml = await readFile(join(basouPaths(repo).sessions, sessionId, "session.yaml"), "utf8");
    expect(yaml).toContain("added.txt");
  });

  // 9
  it("records signal and exit code 130 on parent SIGINT (POSIX 128+2)", async () => {
    const repo = await setupInitedRepo();
    const runner: ProcessRunner = {
      run: async (_cmd, _args, options: CoreRunOptions): Promise<RunResult> => {
        process.emit("SIGINT");
        await Promise.resolve();
        return {
          command: "claude-code",
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
    const exitCode = await runClaudeCode(
      [],
      { cwd: repo, snapshot: false },
      { runner, now: () => FIXED_DATE, resolveCommand: okResolve },
    );
    expect(exitCode).toBe(130);
    const sessionId = await findOnlySessionId(repo);
    const lines = await readEventsLines(repo, sessionId);
    const ce = JSON.parse(lines[2] ?? "{}");
    expect(ce.signal).toBe("SIGTERM");
    expect(ce.received_signal).toBe("SIGINT");
    const sc2 = JSON.parse(lines[3] ?? "{}");
    expect(sc2.to).toBe("interrupted");
  });

  // 10
  it("kills activeChild via the parent exit hook (last-resort cleanup)", async () => {
    const repo = await setupInitedRepo();
    let capturedExitHandler: (() => void) | undefined;
    const killSpy = vi.fn();
    const fakeChild = { kill: killSpy } as unknown as ChildProcess;
    const runner: ProcessRunner = {
      run: async (cmd, args, options: CoreRunOptions): Promise<RunResult> => {
        options.onSpawn?.(fakeChild);
        capturedExitHandler?.();
        return {
          command: cmd,
          args: [...args],
          cwd: options.cwd,
          exit_code: 0,
          signal: null,
          stdout: "",
          stderr: "",
          started_at: FIXED_DATE.toISOString(),
          ended_at: FIXED_DATE.toISOString(),
          duration_ms: 0,
          pid: 1,
        };
      },
    };
    await runClaudeCode(
      [],
      { cwd: repo, snapshot: false },
      {
        runner,
        now: () => FIXED_DATE,
        resolveCommand: okResolve,
        onExitHookInstalled: (h) => {
          capturedExitHandler = h;
        },
      },
    );
    expect(killSpy).toHaveBeenCalledWith("SIGKILL");
    expect(killSpy).toHaveBeenCalledTimes(1);
  });

  // 11
  it("propagates appendEvent failure during git_snapshot (does not silently skip)", async () => {
    const repo = await setupInitedRepo();
    const runner = makeFakeRunner({ exit_code: 0 });
    const fakeAppend = async (sessionDir: string, event: unknown): Promise<void> => {
      if ((event as { type?: string })?.type === "git_snapshot") {
        throw new Error("Failed to append event to events.jsonl", {
          cause: { code: "ENOSPC" },
        });
      }
      return appendEvent(sessionDir, event);
    };
    await expect(
      runClaudeCode(
        [],
        { cwd: repo },
        { runner, now: () => FIXED_DATE, resolveCommand: okResolve, appendEvent: fakeAppend },
      ),
    ).rejects.toThrow(/Failed to append event/);
  });

  // 12
  it("emits a pathless skip warning when getSnapshot fails (no commits)", async () => {
    const noCommitRepo = await mkdtemp(join(tmpdir(), "basou-run-nocommit-"));
    try {
      await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], {
        cwd: noCommitRepo,
        env: ENV,
      });
      const paths = await ensureBasouDirectory(noCommitRepo);
      const manifest = createManifest({
        workspaceName: "nocommit-test",
        now: FIXED_DATE,
        workspaceId: FIXED_WS_ID,
      });
      await writeManifest(paths, manifest);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const runner = makeFakeRunner({ exit_code: 0 });
      const exitCode = await runClaudeCode(
        [],
        { cwd: noCommitRepo },
        { runner, now: () => FIXED_DATE, resolveCommand: okResolve },
      );
      expect(exitCode).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith("git_snapshot skipped: no commits in repository");
      const sessionId = await findOnlySessionId(noCommitRepo);
      const lines = await readEventsLines(noCommitRepo, sessionId);
      expect(lines).toHaveLength(5);
    } finally {
      await rm(noCommitRepo, { recursive: true, force: true });
    }
  });

  // 13 — getDiff capability skip via DI: warning + pre+post snapshot union
  it("emits a pathless file_changed skip warning and preserves snapshot union when getDiff throws", async () => {
    const repo = await setupInitedRepo();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Force a committed change so pre/post HEAD differ; without DI, getDiff
    // would observe the change and emit a file_changed event. Here the DI
    // overrides getDiff to throw so we exercise the capability-skip path.
    const runner: ProcessRunner = {
      run: async (cmd, args, options) => {
        await writeFile(join(options.cwd, "added.txt"), "x\n");
        await execFileAsync("git", ["add", "added.txt"], { cwd: options.cwd, env: ENV });
        await execFileAsync("git", ["commit", "-m", "add"], { cwd: options.cwd, env: ENV });
        return {
          command: cmd,
          args: [...args],
          cwd: options.cwd,
          exit_code: 0,
          signal: null,
          stdout: "",
          stderr: "",
          started_at: FIXED_DATE.toISOString(),
          ended_at: FIXED_DATE.toISOString(),
          duration_ms: 0,
          pid: 1,
        };
      },
    };
    const failingGetDiff = async (): Promise<never> => {
      throw new Error("Failed to compute git diff", { cause: { code: "EIO" } });
    };
    await runClaudeCode(
      [],
      { cwd: repo },
      {
        runner,
        now: () => FIXED_DATE,
        resolveCommand: okResolve,
        getDiff: failingGetDiff,
      },
    );
    expect(warnSpy).toHaveBeenCalledWith("file_changed skipped: failed to compute git diff");
    const sessionId = await findOnlySessionId(repo);
    const lines = await readEventsLines(repo, sessionId);
    const fileChanged = lines.filter((l) => JSON.parse(l).type === "file_changed");
    expect(fileChanged).toHaveLength(0);
    // related_files retains the pre+post snapshot union — the freshly
    // committed file shows up via the post-snapshot `staged`/`unstaged`
    // observation rather than the (now-skipped) diff.
    const yaml = await readFile(join(basouPaths(repo).sessions, sessionId, "session.yaml"), "utf8");
    // No file_changed event was emitted, so the diff path didn't contribute,
    // but related_files is non-empty from the snapshot side (untracked
    // .basou/ paths plus any other observed dirty entries).
    expect(yaml).not.toMatch(/related_files:\s*\[\s*\]/);
  });

  // 14 — appendEvent failure during file_changed propagates
  it("propagates appendEvent failure during file_changed", async () => {
    const repo = await setupInitedRepo();
    const runner: ProcessRunner = {
      run: async (cmd, args, options) => {
        await writeFile(join(options.cwd, "added.txt"), "x\n");
        await execFileAsync("git", ["add", "added.txt"], { cwd: options.cwd, env: ENV });
        await execFileAsync("git", ["commit", "-m", "add"], { cwd: options.cwd, env: ENV });
        return {
          command: cmd,
          args: [...args],
          cwd: options.cwd,
          exit_code: 0,
          signal: null,
          stdout: "",
          stderr: "",
          started_at: FIXED_DATE.toISOString(),
          ended_at: FIXED_DATE.toISOString(),
          duration_ms: 0,
          pid: 1,
        };
      },
    };
    const fakeAppend = async (sessionDir: string, event: unknown): Promise<void> => {
      if ((event as { type?: string })?.type === "file_changed") {
        throw new Error("Failed to append event to events.jsonl", {
          cause: { code: "ENOSPC" },
        });
      }
      return appendEvent(sessionDir, event);
    };
    await expect(
      runClaudeCode(
        [],
        { cwd: repo },
        { runner, now: () => FIXED_DATE, resolveCommand: okResolve, appendEvent: fakeAppend },
      ),
    ).rejects.toThrow(/Failed to append event/);
  });

  // 15-17 — argv ordering tests exercise the real commander parse path so
  //         the contract (--no-snapshot before vs after `claude-code`,
  //         `--` separator) is pinned end-to-end. The ctx is plumbed through
  //         registerRunCommand into the action callback, then process.exit
  //         is replaced by a throw so the test can resume after the action.
  type ExitSentinel = { code: number };
  const installExitTrap = (): ExitSentinel => {
    const sentinel: ExitSentinel = { code: -1 };
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      // Lock the first observed exit code: action callbacks may surface a
      // second `process.exit(1)` from their own catch block when the trap
      // throws the sentinel error, but the contract is what the action
      // *intended* to exit with on its happy path.
      if (sentinel.code === -1) {
        sentinel.code = typeof code === "number" ? code : 0;
      }
      throw new Error(`__exit_${typeof code === "number" ? code : 0}__`);
    });
    return sentinel;
  };

  async function runViaParseAsync(argv: readonly string[], ctx: RunContext): Promise<ExitSentinel> {
    const program = new Command();
    program.name("basou").enablePositionalOptions();
    registerRunCommand(program, ctx);
    const sentinel = installExitTrap();
    try {
      await program.parseAsync(["node", "basou", ...argv]);
    } catch (error: unknown) {
      // Swallow only the synthetic exit thrown by the trap. Real failures
      // surface through expect().rejects.toThrow in dedicated tests above.
      if (error instanceof Error && error.message.startsWith("__exit_")) {
        // expected: process.exit was called via the trap
      } else {
        throw error;
      }
    }
    return sentinel;
  }

  // 15 — `basou run --no-snapshot claude-code` parses --no-snapshot as a run
  //       option and emits 5 events (no git_snapshot pre/post).
  it("parses --no-snapshot as a basou option when placed before `claude-code`", async () => {
    const repo = await setupInitedRepo();
    const runner = makeFakeRunner({ exit_code: 0 });
    const sentinel = await runViaParseAsync(
      ["run", "--no-snapshot", "--cwd", repo, "claude-code"],
      {
        runner,
        now: () => FIXED_DATE,
        resolveCommand: okResolve,
      },
    );
    expect(sentinel.code).toBe(0);
    expect(runner.lastArgs).toEqual([]);
    const sessionId = await findOnlySessionId(repo);
    const lines = await readEventsLines(repo, sessionId);
    expect(lines).toHaveLength(5);
  });

  // 16 — `basou run --cwd <repo> claude-code --no-snapshot` consumes
  //       --no-snapshot on the claude-code subsubcommand (the option is
  //       redeclared there for symmetry with placement before the
  //       subsubcommand name). The child receives an empty argv and
  //       snapshot is off, mirroring case 15. To force passthrough, use
  //       the `--` separator (case 17).
  it("consumes --no-snapshot when placed after `claude-code` (no passthrough)", async () => {
    const repo = await setupInitedRepo();
    const runner = makeFakeRunner({ exit_code: 0 });
    const sentinel = await runViaParseAsync(
      ["run", "--cwd", repo, "claude-code", "--no-snapshot"],
      { runner, now: () => FIXED_DATE, resolveCommand: okResolve },
    );
    expect(sentinel.code).toBe(0);
    expect(runner.lastArgs).toEqual([]);
    const sessionId = await findOnlySessionId(repo);
    const lines = await readEventsLines(repo, sessionId);
    expect(lines).toHaveLength(5);
  });

  // 17 — `basou run --cwd <repo> claude-code -- --some-flag` forwards the
  //       trailing flag via the `--` separator; snapshot stays on (7
  //       events).
  it("forwards args after `--` to the child while leaving snapshot on", async () => {
    const repo = await setupInitedRepo();
    const runner = makeFakeRunner({ exit_code: 0 });
    const sentinel = await runViaParseAsync(
      ["run", "--cwd", repo, "claude-code", "--", "--some-flag"],
      { runner, now: () => FIXED_DATE, resolveCommand: okResolve },
    );
    expect(sentinel.code).toBe(0);
    // The `--` separator itself is consumed by commander; the remaining
    // `--some-flag` reaches the child unchanged.
    expect(runner.lastArgs).toEqual(["--some-flag"]);
    const sessionId = await findOnlySessionId(repo);
    const lines = await readEventsLines(repo, sessionId);
    expect(lines).toHaveLength(7);
  });

  // 18 — dirty-no-commit case
  it("captures dirty paths in related_files when no commit happens", async () => {
    const repo = await setupInitedRepo();
    const runner: ProcessRunner = {
      run: async (cmd, args, options) => {
        // Stage / leave dirty without committing.
        await writeFile(join(options.cwd, "dirty-staged.txt"), "s\n");
        await execFileAsync("git", ["add", "dirty-staged.txt"], {
          cwd: options.cwd,
          env: ENV,
        });
        await writeFile(join(options.cwd, "dirty-untracked.txt"), "u\n");
        return {
          command: cmd,
          args: [...args],
          cwd: options.cwd,
          exit_code: 0,
          signal: null,
          stdout: "",
          stderr: "",
          started_at: FIXED_DATE.toISOString(),
          ended_at: FIXED_DATE.toISOString(),
          duration_ms: 0,
          pid: 1,
        };
      },
    };
    await runClaudeCode(
      [],
      { cwd: repo },
      { runner, now: () => FIXED_DATE, resolveCommand: okResolve },
    );
    const sessionId = await findOnlySessionId(repo);
    const lines = await readEventsLines(repo, sessionId);
    const fileChanged = lines.filter((l) => JSON.parse(l).type === "file_changed");
    expect(fileChanged).toHaveLength(0);
    const yaml = await readFile(join(basouPaths(repo).sessions, sessionId, "session.yaml"), "utf8");
    expect(yaml).toContain("dirty-staged.txt");
    expect(yaml).toContain("dirty-untracked.txt");
  });
});
