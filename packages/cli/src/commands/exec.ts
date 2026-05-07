import type { ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  ChildProcessRunner,
  type PrefixedId,
  type ProcessRunner,
  type RunResult,
  type Session,
  SessionSchema,
  appendEvent,
  assertBasouRootSafe,
  basouPaths,
  getSnapshot,
  overwriteYamlFile,
  parseDuration,
  prefixedUlid,
  readManifest,
  readYamlFile,
  resolveRepositoryRoot,
  writeYamlFile,
} from "@basou/core";
import type { Command } from "commander";

/**
 * `basou exec` orchestration: spawn an arbitrary child as a single new
 * Basou session and record its lifecycle (session_started, optional
 * git_snapshot pre, status_changed, command_executed, optional git_snapshot
 * post, status_changed, session_ended) to `events.jsonl`.
 *
 * Output is forwarded to the parent's terminal (`capture: "none"`); raw
 * stdout/stderr is intentionally not stored in events.jsonl or `.basou/raw/`.
 */
export type ExecOptions = {
  timeout?: string;
  cwd?: string;
  // commander turns `--no-snapshot` into `snapshot: false`. The default
  // (no flag) leaves this `undefined` (treated as `true` downstream).
  snapshot?: boolean;
  verbose?: boolean;
};

type ExecContext = {
  runner?: ProcessRunner;
  now?: () => Date;
};

export function registerExecCommand(program: Command): void {
  program
    .command("exec <command> [args...]")
    .description("Execute a command and record it as a Basou session")
    // Pass through unknown options/flags after the command name to the
    // child so callers can write `basou exec npm test --watch` instead of
    // `basou exec -- npm test --watch`. basou's own options (--timeout,
    // --no-snapshot, --cwd, -v) must come before the command name.
    .passThroughOptions()
    .option("--timeout <duration>", "Kill the child after this duration (e.g. 30s, 5m, 1h)")
    .option("--no-snapshot", "Skip git_snapshot before/after the command")
    .option("--cwd <path>", "Run from a Basou root other than process.cwd()")
    .option("-v, --verbose", "Show error causes")
    .action(async (command: string, args: string[], options: ExecOptions) => {
      try {
        const exitCode = await runExec(command, args, options);
        process.exit(exitCode);
      } catch (error: unknown) {
        renderExecError(error, options.verbose === true);
        process.exit(1);
      }
    });
}

export async function runExec(
  command: string,
  args: string[],
  options: ExecOptions,
  ctx: ExecContext = {},
): Promise<number> {
  const runner = ctx.runner ?? new ChildProcessRunner();
  const now = ctx.now ?? (() => new Date());
  const cwd = options.cwd ?? process.cwd();

  // 0. timeout option fail-fast: invalid timeout never creates a session.
  const timeout_ms = options.timeout !== undefined ? parseDuration(options.timeout) : undefined;

  // 1. Resolve repository root before touching anything; matches existing
  //    init/status semantics so subdir invocations still find `.basou/`.
  const repoRoot = await resolveRepositoryRootForExec(cwd);
  const paths = basouPaths(repoRoot);

  // 2. Workspace safety check (caller responsibility).
  await assertBasouRootSafe(paths.root);

  // 3. Read manifest to bind session.workspace_id.
  const manifest = await readManifest(paths);

  // 4. Build a fresh session and persist its initial state.
  const sessionId = prefixedUlid("ses");
  const sessionDir = join(paths.sessions, sessionId);
  await mkdir(sessionDir, { recursive: true });

  const startedAt = now().toISOString();
  const sessionYamlPath = join(sessionDir, "session.yaml");
  const session = buildInitialSession({
    id: sessionId,
    command,
    args,
    cwd,
    workspaceId: manifest.workspace.id,
    startedAt,
  });
  await writeYamlFile(sessionYamlPath, session);

  // 5. session_started.
  await appendEvent(sessionDir, {
    schema_version: "0.1.0",
    type: "session_started",
    id: prefixedUlid("evt"),
    session_id: sessionId,
    occurred_at: startedAt,
    source: "terminal-recording",
  });

  // 6. Optional pre-execute git_snapshot.
  if (options.snapshot !== false) {
    await tryAppendGitSnapshot(sessionDir, sessionId, repoRoot, now);
  }

  // 7. status_changed: initialized -> running.
  const runningAt = now().toISOString();
  await appendEvent(sessionDir, {
    schema_version: "0.1.0",
    type: "session_status_changed",
    id: prefixedUlid("evt"),
    session_id: sessionId,
    occurred_at: runningAt,
    source: "terminal-recording",
    from: "initialized",
    to: "running",
  });
  await mutateSessionYaml(sessionYamlPath, (s) => {
    s.session.status = "running";
  });

  // 8. Transient signal hooks: SIGINT / SIGTERM / exit. The exit hook is
  //    a synchronous last-resort SIGKILL if the parent exits abnormally.
  const controller = new AbortController();
  let signalReceived: NodeJS.Signals | null = null;
  let activeChild: ChildProcess | null = null;
  const signalHandler = (sig: NodeJS.Signals) => {
    if (signalReceived !== null) return;
    signalReceived = sig;
    controller.abort();
  };
  const exitHandler = () => {
    if (activeChild !== null) {
      try {
        activeChild.kill("SIGKILL");
      } catch {
        // swallow: best-effort cleanup
      }
    }
  };
  // Bind explicit signal names so `process.emit("SIGINT")` etc. produce the
  // right `received_signal` regardless of Node's listener-arg conventions.
  const onSigInt = () => signalHandler("SIGINT");
  const onSigTerm = () => signalHandler("SIGTERM");
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);
  process.on("exit", exitHandler);

  let result: RunResult;
  try {
    try {
      result = await runner.run(command, args, {
        cwd,
        capture: "none",
        ...(timeout_ms !== undefined ? { timeout_ms } : {}),
        signal: controller.signal,
        onSpawn: (child) => {
          activeChild = child;
        },
      });
    } catch (spawnError: unknown) {
      // Spawn-time error / pre-aborted / validation error: tear down the
      // session as failed before propagating so events.jsonl and session.yaml
      // are consistent even on error.
      await finalizeSessionAsFailed(sessionDir, sessionYamlPath, sessionId, {
        command,
        args,
        cwd,
        occurredAt: now().toISOString(),
        signalReceived,
      });
      throw spawnError;
    }
  } finally {
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    process.off("exit", exitHandler);
    activeChild = null;
  }

  const endedAt = now().toISOString();

  // 9. command_executed (with parent received_signal vs child terminating signal).
  await appendEvent(sessionDir, {
    schema_version: "0.1.0",
    type: "command_executed",
    id: prefixedUlid("evt"),
    session_id: sessionId,
    occurred_at: endedAt,
    source: "terminal-recording",
    command,
    args,
    cwd,
    exit_code: result.exit_code,
    ...(result.signal !== null ? { signal: result.signal } : {}),
    ...(signalReceived !== null ? { received_signal: signalReceived } : {}),
    duration_ms: result.duration_ms,
  });

  // 10. Optional post-execute git_snapshot (after command_executed so the
  //     event sequence reads chronologically: pre-snapshot, run, post-snapshot).
  if (options.snapshot !== false) {
    await tryAppendGitSnapshot(sessionDir, sessionId, repoRoot, now);
  }

  const finalStatus = decideFinalStatus(result, signalReceived);

  // 11. status_changed: running -> final.
  await appendEvent(sessionDir, {
    schema_version: "0.1.0",
    type: "session_status_changed",
    id: prefixedUlid("evt"),
    session_id: sessionId,
    occurred_at: endedAt,
    source: "terminal-recording",
    from: "running",
    to: finalStatus,
  });

  // 12. session_ended.
  await appendEvent(sessionDir, {
    schema_version: "0.1.0",
    type: "session_ended",
    id: prefixedUlid("evt"),
    session_id: sessionId,
    occurred_at: endedAt,
    source: "terminal-recording",
    ...(result.exit_code !== null ? { exit_code: result.exit_code } : {}),
  });

  // 13. Final session.yaml update (status / ended_at / invocation.exit_code).
  await mutateSessionYaml(sessionYamlPath, (s) => {
    s.session.status = finalStatus;
    s.session.ended_at = endedAt;
    s.session.invocation.exit_code = result.exit_code;
  });

  if (result.exit_code !== null) {
    return result.exit_code;
  }
  return signalToExitCode(signalReceived ?? result.signal);
}

function decideFinalStatus(
  result: { exit_code: number | null; signal: NodeJS.Signals | null },
  signalReceived: NodeJS.Signals | null,
): "completed" | "failed" | "interrupted" {
  if (signalReceived === "SIGINT" || signalReceived === "SIGTERM") return "interrupted";
  if (result.signal === "SIGINT" || result.signal === "SIGTERM" || result.signal === "SIGKILL") {
    return "interrupted";
  }
  if (result.exit_code === 0) return "completed";
  return "failed";
}

const SIGNUM_MAP: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};

function signalToExitCode(sig: NodeJS.Signals | null): number {
  if (sig === null) return 1;
  const num = SIGNUM_MAP[sig] ?? 1;
  return 128 + num;
}

async function tryAppendGitSnapshot(
  sessionDir: string,
  sessionId: string,
  repoRoot: string,
  now: () => Date,
): Promise<void> {
  try {
    const snapshot = await getSnapshot(repoRoot);
    await appendEvent(sessionDir, {
      schema_version: "0.1.0",
      type: "git_snapshot",
      id: prefixedUlid("evt"),
      session_id: sessionId,
      occurred_at: now().toISOString(),
      source: "git-capability",
      ...snapshot,
    });
  } catch (error: unknown) {
    const normalized = normalizeGitSnapshotSkipMessage(error);
    console.warn(normalized);
  }
}

function normalizeGitSnapshotSkipMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return `git_snapshot skipped: ${String(error)}`;
  }
  const msg = error.message;
  if (msg === "Not a git repository") {
    return "git_snapshot skipped: not in a git repository";
  }
  if (msg === "Git executable not found in PATH. Install git first.") {
    return "git_snapshot skipped: git executable not found";
  }
  if (msg === "No commits in repository") {
    return "git_snapshot skipped: no commits in repository";
  }
  return `git_snapshot skipped: ${msg}`;
}

function buildInitialSession(input: {
  id: PrefixedId<"ses">;
  command: string;
  args: string[];
  cwd: string;
  workspaceId: PrefixedId<"ws">;
  startedAt: string;
}): Session {
  const cmdline = [input.command, ...input.args].join(" ");
  return {
    schema_version: "0.1.0",
    session: {
      id: input.id,
      label: `basou exec ${cmdline} (${input.startedAt})`,
      task_id: null,
      workspace_id: input.workspaceId,
      source: { kind: "terminal", version: "0.1.0" },
      started_at: input.startedAt,
      status: "initialized",
      working_directory: input.cwd,
      invocation: {
        command: input.command,
        args: [...input.args],
        exit_code: null,
      },
      related_files: [],
      events_log: "events.jsonl",
    },
  };
}

async function mutateSessionYaml(
  filePath: string,
  mutator: (session: Session) => void,
): Promise<void> {
  const raw = await readYamlFile(filePath);
  const parsed = SessionSchema.parse(raw);
  mutator(parsed);
  // Re-validate after mutation to catch drift, then overwrite atomically.
  const validated = SessionSchema.parse(parsed);
  await overwriteYamlFile(filePath, validated);
}

async function finalizeSessionAsFailed(
  sessionDir: string,
  sessionYamlPath: string,
  sessionId: string,
  ctx: {
    command: string;
    args: string[];
    cwd: string;
    occurredAt: string;
    signalReceived: NodeJS.Signals | null;
  },
): Promise<void> {
  await appendEvent(sessionDir, {
    schema_version: "0.1.0",
    type: "command_executed",
    id: prefixedUlid("evt"),
    session_id: sessionId,
    occurred_at: ctx.occurredAt,
    source: "terminal-recording",
    command: ctx.command,
    args: ctx.args,
    cwd: ctx.cwd,
    exit_code: null,
    signal: null,
    ...(ctx.signalReceived !== null ? { received_signal: ctx.signalReceived } : {}),
    duration_ms: 0,
  });
  await appendEvent(sessionDir, {
    schema_version: "0.1.0",
    type: "session_status_changed",
    id: prefixedUlid("evt"),
    session_id: sessionId,
    occurred_at: ctx.occurredAt,
    source: "terminal-recording",
    from: "running",
    to: "failed",
  });
  await appendEvent(sessionDir, {
    schema_version: "0.1.0",
    type: "session_ended",
    id: prefixedUlid("evt"),
    session_id: sessionId,
    occurred_at: ctx.occurredAt,
    source: "terminal-recording",
  });
  await mutateSessionYaml(sessionYamlPath, (s) => {
    s.session.status = "failed";
    s.session.ended_at = ctx.occurredAt;
    s.session.invocation.exit_code = null;
  });
}

async function resolveRepositoryRootForExec(cwd: string): Promise<string> {
  try {
    return await resolveRepositoryRoot(cwd);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Not a git repository") {
      throw new Error("Not a git repository. Run 'git init' first, then re-run 'basou exec'.", {
        cause: error,
      });
    }
    throw error;
  }
}

function renderExecError(error: unknown, verbose: boolean): void {
  if (!(error instanceof Error)) {
    console.error(String(error));
    return;
  }
  console.error(error.message);
  if (verbose && error.cause instanceof Error) {
    const code = (error.cause as Error & { code?: unknown }).code;
    const label = typeof code === "string" ? code : error.cause.constructor.name;
    console.error(`Caused by: ${label}`);
  }
}
