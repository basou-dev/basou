import type { ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  ChildProcessRunner,
  type DiffResult,
  type GitSnapshot,
  type PrefixedId,
  type ProcessRunner,
  type RunResult,
  type Session,
  SessionSchema,
  assertBasouRootSafe,
  basouPaths,
  claudeCodeAdapterMetadata,
  appendEvent as coreAppendEvent,
  getDiff,
  getSnapshot,
  overwriteYamlFile,
  prefixedUlid,
  readManifest,
  readYamlFile,
  resolveClaudeCodeCommand,
  resolveRepositoryRoot,
  writeYamlFile,
} from "@basou/core";
import type { Command } from "commander";
import { isVerbose, renderCliError } from "../lib/error-render.js";

type AppendEventFn = typeof coreAppendEvent;
type ResolveCommandFn = typeof resolveClaudeCodeCommand;
type GetDiffFn = typeof getDiff;

/**
 * `basou run claude-code` orchestration: spawn claude-code as a single new
 * Basou session and record its lifecycle (session_started, optional
 * git_snapshot pre, status_changed, command_executed, optional git_snapshot
 * post, file_changed × N, status_changed, session_ended) to events.jsonl.
 *
 * The child inherits the parent's stdio (`capture: "none"`) so that
 * claude-code's interactive TTY remains usable; raw stdout/stderr is
 * intentionally NOT captured into events.jsonl or `.basou/raw/` in v0.1.
 */
export type RunOptions = {
  // commander turns `--no-snapshot` into `snapshot: false`. The default
  // (no flag) leaves this `undefined` (treated as `true` downstream).
  snapshot?: boolean;
  cwd?: string;
  verbose?: boolean;
};

export type RunContext = {
  runner?: ProcessRunner;
  now?: () => Date;
  appendEvent?: AppendEventFn;
  onExitHookInstalled?: (handler: () => void) => void;
  // Override the claude-code PATH lookup. Tests use this to skip real
  // `which` invocations and force success / failure deterministically.
  resolveCommand?: ResolveCommandFn;
  // Override the git diff capability. Tests use this to force capability
  // failure deterministically without rewriting the git fixture state.
  getDiff?: GetDiffFn;
};

/**
 * Wire the `basou run` command group into `program`. The optional `ctx` is
 * passed through to `runClaudeCode` so tests can intercept the action callback
 * (fake runner, fake clock, deterministic resolveCommand / getDiff). Production
 * callers omit it.
 *
 * Basou options (`--no-snapshot`, `--cwd`, `-v`) are defined on both the
 * `run` group and the inner `claude-code` subcommand. commander's
 * `passThroughOptions()` only forwards UNKNOWN options to args, so a
 * group-only definition would make `basou run claude-code --no-snapshot`
 * crash with "unknown option". Duplicating the definitions lets the option
 * be recognized regardless of position; only `--`-separated args go to the
 * child. v0.2+ adapter additions (codex / gemini) should consider
 * extracting a common-option helper rather than re-duplicating.
 */
export function registerRunCommand(program: Command, ctx: RunContext = {}): void {
  const runCommand = program
    .command("run")
    .description("Run an AI coding tool through Basou as a tracked session")
    // Required so the inner `claude-code` subcommand can pass through
    // arguments after `--` to the child without commander interpreting them
    // as run-group options.
    .enablePositionalOptions()
    .option("--no-snapshot", "Skip git_snapshot before/after the session")
    .option("--cwd <path>", "Run from a Basou root other than process.cwd()")
    .option("-v, --verbose", "Show error causes");

  runCommand
    .command("claude-code [args...]")
    .description("Run Claude Code CLI as a Basou-tracked session")
    // Same options redeclared on the subsubcommand so they are recognized
    // when placed AFTER `claude-code` as well; see the function comment.
    .option("--no-snapshot", "Skip git_snapshot before/after the session")
    .option("--cwd <path>", "Run from a Basou root other than process.cwd()")
    .option("-v, --verbose", "Show error causes")
    .passThroughOptions()
    .action(async (args: string[], options: RunOptions, command: Command) => {
      const parentOptions = (command.parent?.opts() ?? {}) as RunOptions;
      // Both layers default `snapshot` to `true` when --no-snapshot is
      // omitted, so a naive spread would let the subsubcommand's default
      // overwrite a `--no-snapshot` set on the parent. Take a logical AND
      // instead: snapshot stays on only when neither layer disables it.
      const snapshotOn = parentOptions.snapshot !== false && options.snapshot !== false;
      const merged: RunOptions = {
        ...parentOptions,
        ...options,
        snapshot: snapshotOn,
      };
      try {
        const exitCode = await runClaudeCode(args, merged, ctx);
        process.exit(exitCode);
      } catch (error: unknown) {
        renderCliError(error, { verbose: isVerbose(merged) });
        process.exit(1);
      }
    });
}

export async function runClaudeCode(
  args: string[],
  options: RunOptions,
  ctx: RunContext = {},
): Promise<number> {
  const runner = ctx.runner ?? new ChildProcessRunner();
  const now = ctx.now ?? (() => new Date());
  const appendEvent: AppendEventFn = ctx.appendEvent ?? coreAppendEvent;
  const resolveCommand: ResolveCommandFn = ctx.resolveCommand ?? resolveClaudeCodeCommand;
  const getDiffFn: GetDiffFn = ctx.getDiff ?? getDiff;

  // 1. Resolve the claude-code executable BEFORE any side-effect: a missing
  //    CLI is a user installation issue, not something worth recording as a
  //    Basou session. Failure here leaves no sessions/<id>/ entry behind.
  const { command } = await resolveCommand();

  const cwd = options.cwd ?? process.cwd();

  // 2. Resolve repository root (entry-fail when not in a git repo).
  const repoRoot = await resolveRepositoryRootForRun(cwd);
  const paths = basouPaths(repoRoot);

  // 3. Workspace safety check.
  await assertBasouRootSafe(paths.root);

  // 4. Read manifest to bind session.workspace_id.
  const manifest = await readManifest(paths);

  // 5. Build a fresh session and persist its initial state.
  const sessionId = prefixedUlid("ses");
  const sessionDir = join(paths.sessions, sessionId);
  await mkdir(sessionDir, { recursive: true });

  const startedAt = now().toISOString();
  const sessionYamlPath = join(sessionDir, "session.yaml");
  const session = buildInitialSession({
    id: sessionId,
    command,
    args,
    cwd: repoRoot,
    workspaceId: manifest.workspace.id,
    startedAt,
  });
  await writeYamlFile(sessionYamlPath, session);

  // 6. session_started.
  await appendEvent(sessionDir, {
    schema_version: "0.1.0",
    type: "session_started",
    id: prefixedUlid("evt"),
    session_id: sessionId,
    occurred_at: startedAt,
    source: claudeCodeAdapterMetadata.kind,
  });

  // 7. Optional pre-execute git_snapshot.
  let preSnapshot: GitSnapshot | null = null;
  if (options.snapshot !== false) {
    preSnapshot = await tryAppendGitSnapshot(sessionDir, sessionId, repoRoot, now, appendEvent);
  }

  // 8. status_changed: initialized -> running.
  const runningAt = now().toISOString();
  await appendEvent(sessionDir, {
    schema_version: "0.1.0",
    type: "session_status_changed",
    id: prefixedUlid("evt"),
    session_id: sessionId,
    occurred_at: runningAt,
    source: claudeCodeAdapterMetadata.kind,
    from: "initialized",
    to: "running",
  });
  await mutateSessionYaml(sessionYamlPath, (s) => {
    s.session.status = "running";
  });

  // 9. Transient signal hooks (SIGINT / SIGTERM / exit). The exit hook is a
  //    last-resort SIGKILL if the parent dies abnormally.
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
        // best-effort cleanup
      }
    }
  };
  const onSigInt = () => signalHandler("SIGINT");
  const onSigTerm = () => signalHandler("SIGTERM");
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);
  process.on("exit", exitHandler);
  ctx.onExitHookInstalled?.(exitHandler);

  // 10-11. runner.run() execute (capture: "none" inherits the parent stdio so
  //         claude-code keeps a real TTY). Spawn-time errors finalize the
  //         session as failed and propagate the error.
  let result: RunResult;
  try {
    try {
      result = await runner.run(command, args, {
        cwd: repoRoot,
        capture: "none",
        signal: controller.signal,
        onSpawn: (child) => {
          activeChild = child;
        },
      });
    } catch (spawnError: unknown) {
      await finalizeSessionAsFailed(sessionDir, sessionYamlPath, sessionId, appendEvent, {
        command,
        args,
        cwd: repoRoot,
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

  // 12. command_executed (parent received_signal vs child terminating signal).
  await appendEvent(sessionDir, {
    schema_version: "0.1.0",
    type: "command_executed",
    id: prefixedUlid("evt"),
    session_id: sessionId,
    occurred_at: endedAt,
    source: "terminal-recording",
    command,
    args,
    cwd: repoRoot,
    exit_code: result.exit_code,
    ...(result.signal !== null ? { signal: result.signal } : {}),
    ...(signalReceived !== null ? { received_signal: signalReceived } : {}),
    duration_ms: result.duration_ms,
  });

  // 13. Optional post-execute git_snapshot.
  let postSnapshot: GitSnapshot | null = null;
  if (options.snapshot !== false) {
    postSnapshot = await tryAppendGitSnapshot(sessionDir, sessionId, repoRoot, now, appendEvent);
  }

  // 14-15. file_changed events derived from getDiff(preHead, postHead). Only
  //        committed changes appear here; dirty (staged/unstaged/untracked)
  //        edits are surfaced via session.yaml.related_files instead.
  let diff: DiffResult | null = null;
  if (preSnapshot !== null && postSnapshot !== null) {
    diff = await tryAppendFileChangedEvents(
      sessionDir,
      sessionId,
      repoRoot,
      preSnapshot.head,
      postSnapshot.head,
      now().toISOString(),
      appendEvent,
      getDiffFn,
    );
  }

  // 16. Compute related_files = pre+post snapshot ∪ diff (sorted, deduped).
  const relatedFiles = computeRelatedFiles(preSnapshot, postSnapshot, diff);

  const finalStatus = decideFinalStatus(result, signalReceived);

  // 17-18. status_changed: running -> final.
  await appendEvent(sessionDir, {
    schema_version: "0.1.0",
    type: "session_status_changed",
    id: prefixedUlid("evt"),
    session_id: sessionId,
    occurred_at: endedAt,
    source: claudeCodeAdapterMetadata.kind,
    from: "running",
    to: finalStatus,
  });

  // 19. session_ended.
  await appendEvent(sessionDir, {
    schema_version: "0.1.0",
    type: "session_ended",
    id: prefixedUlid("evt"),
    session_id: sessionId,
    occurred_at: endedAt,
    source: claudeCodeAdapterMetadata.kind,
    ...(result.exit_code !== null ? { exit_code: result.exit_code } : {}),
  });

  // 20. Final session.yaml update (status / ended_at / invocation.exit_code /
  //     related_files).
  await mutateSessionYaml(sessionYamlPath, (s) => {
    s.session.status = finalStatus;
    s.session.ended_at = endedAt;
    s.session.invocation.exit_code = result.exit_code;
    s.session.related_files = relatedFiles;
  });

  if (result.exit_code !== null) return result.exit_code;
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
  appendEvent: AppendEventFn,
): Promise<GitSnapshot | null> {
  // Stage 1: capability acquisition. Capability-level failures (no git
  // repository, git binary missing, no commits) downgrade to a skip warning;
  // events.jsonl simply lacks this git_snapshot entry.
  let snapshot: GitSnapshot;
  try {
    snapshot = await getSnapshot(repoRoot);
  } catch (error: unknown) {
    console.warn(normalizeGitSnapshotSkipMessage(error));
    return null;
  }
  // Stage 2: events.jsonl append. Failures here would corrupt the events.jsonl
  // integrity contract; let them propagate so the run fails loudly rather
  // than producing a session that looks successful but is actually missing
  // events.
  await appendEvent(sessionDir, {
    schema_version: "0.1.0",
    type: "git_snapshot",
    id: prefixedUlid("evt"),
    session_id: sessionId,
    occurred_at: now().toISOString(),
    source: "git-capability",
    ...snapshot,
  });
  return snapshot;
}

async function tryAppendFileChangedEvents(
  sessionDir: string,
  sessionId: string,
  repoRoot: string,
  baseRef: string,
  headRef: string,
  occurredAt: string,
  appendEvent: AppendEventFn,
  getDiffFn: GetDiffFn,
): Promise<DiffResult | null> {
  // Stage 1: capability acquisition (same skip-vs-fail split as
  // tryAppendGitSnapshot).
  let diff: DiffResult;
  try {
    diff = await getDiffFn(repoRoot, baseRef, headRef);
  } catch (error: unknown) {
    console.warn(normalizeFileChangedSkipMessage(error));
    return null;
  }
  // Stage 2: per-path appendEvent. Schema validation / disk failures here
  // are NOT a capability miss; let them propagate.
  for (const change of diff.changed_files) {
    await appendEvent(sessionDir, {
      schema_version: "0.1.0",
      type: "file_changed",
      id: prefixedUlid("evt"),
      session_id: sessionId,
      occurred_at: occurredAt,
      source: "git-capability",
      path: change.path,
      change_type: change.status,
      ...(change.old_path !== undefined ? { old_path: change.old_path } : {}),
    });
  }
  return diff;
}

function computeRelatedFiles(
  preSnapshot: GitSnapshot | null,
  postSnapshot: GitSnapshot | null,
  diff: DiffResult | null,
): string[] {
  const set = new Set<string>();
  for (const snap of [preSnapshot, postSnapshot]) {
    if (snap === null) continue;
    for (const p of snap.staged) set.add(p);
    for (const p of snap.unstaged) set.add(p);
    for (const p of snap.untracked) set.add(p);
  }
  if (diff !== null) {
    for (const change of diff.changed_files) set.add(change.path);
  }
  return [...set].sort();
}

function normalizeGitSnapshotSkipMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return `git_snapshot skipped: ${String(error)}`;
  }
  const msg = error.message;
  if (msg === "Not a git repository") return "git_snapshot skipped: not in a git repository";
  if (msg === "Git executable not found in PATH. Install git first.") {
    return "git_snapshot skipped: git executable not found";
  }
  if (msg === "No commits in repository") return "git_snapshot skipped: no commits in repository";
  return `git_snapshot skipped: ${msg}`;
}

function normalizeFileChangedSkipMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return `file_changed skipped: ${String(error)}`;
  }
  const msg = error.message;
  if (msg === "Not a git repository") return "file_changed skipped: not in a git repository";
  if (msg === "Git executable not found in PATH. Install git first.") {
    return "file_changed skipped: git executable not found";
  }
  if (msg === "Invalid ref") return "file_changed skipped: invalid git ref";
  if (msg === "Failed to compute git diff")
    return "file_changed skipped: failed to compute git diff";
  return `file_changed skipped: ${msg}`;
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
      label: `basou run ${cmdline} (${input.startedAt})`,
      task_id: null,
      workspace_id: input.workspaceId,
      source: { ...claudeCodeAdapterMetadata },
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
  const validated = SessionSchema.parse(parsed);
  await overwriteYamlFile(filePath, validated);
}

async function finalizeSessionAsFailed(
  sessionDir: string,
  sessionYamlPath: string,
  sessionId: string,
  appendEvent: AppendEventFn,
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
    source: claudeCodeAdapterMetadata.kind,
    from: "running",
    to: "failed",
  });
  await appendEvent(sessionDir, {
    schema_version: "0.1.0",
    type: "session_ended",
    id: prefixedUlid("evt"),
    session_id: sessionId,
    occurred_at: ctx.occurredAt,
    source: claudeCodeAdapterMetadata.kind,
  });
  await mutateSessionYaml(sessionYamlPath, (s) => {
    s.session.status = "failed";
    s.session.ended_at = ctx.occurredAt;
    s.session.invocation.exit_code = null;
  });
}

async function resolveRepositoryRootForRun(cwd: string): Promise<string> {
  try {
    return await resolveRepositoryRoot(cwd);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Not a git repository") {
      throw new Error("Not a git repository. Run 'git init' first, then re-run 'basou run'.", {
        cause: error,
      });
    }
    throw error;
  }
}
