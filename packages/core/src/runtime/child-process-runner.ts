import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import { findErrorCode } from "../storage/status.js";

import type { ProcessRunner, RunOptions, RunResult } from "./process-runner.js";

const DEFAULT_KILL_GRACE_MS = 5_000;

/**
 * Spawn-based ProcessRunner implementation.
 *
 * Behavior:
 * - `shell: false` and `detached: false`. The process group is not
 *   detached, but the OS does not guarantee the child is reaped when
 *   the parent terminates abruptly; callers handle SIGINT/SIGTERM/exit
 *   hooks themselves.
 * - `stdio: ['pipe', 'pipe', 'pipe']`. stdout / stderr are decoded as
 *   UTF-8 and accumulated as full strings (no streaming callbacks).
 * - `timeout_ms` and `AbortSignal` both trigger a two-stage kill:
 *   `SIGTERM`, then `SIGKILL` after `DEFAULT_KILL_GRACE_MS` (5_000 ms).
 * - A non-zero `exit_code` does not throw; it is returned via
 *   `RunResult`. Spawn-time errors throw with a pathless message and
 *   the original error attached as `cause`.
 *
 * Error message contract: messages never include `cwd` or absolute
 * command paths. The original errno (and any nested wrapping) is
 * preserved on `Error.cause`, allowing callers to classify with
 * `findErrorCode` when needed.
 */
export class ChildProcessRunner implements ProcessRunner {
  async run(command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
    validateOptions(options);

    if (options.signal?.aborted) {
      throw new Error("Process aborted before spawn", {
        cause: options.signal.reason,
      });
    }

    const started_at = new Date();

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        detached: false,
      });
    } catch (error: unknown) {
      throw classifySpawnError(error);
    }

    let timeoutTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let killed = false;
    let settled = false;

    const triggerKill = (): void => {
      if (killed || child.exitCode !== null) return;
      killed = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, DEFAULT_KILL_GRACE_MS);
    };

    // Attach the abort listener immediately, then re-check `aborted` to
    // close the window between spawn() returning and addEventListener.
    const onAbort = (): void => {
      triggerKill();
    };
    options.signal?.addEventListener("abort", onAbort);
    if (options.signal?.aborted) {
      triggerKill();
    }

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }

    if (options.timeout_ms !== undefined) {
      timeoutTimer = setTimeout(triggerKill, options.timeout_ms);
    }

    const cleanup = (): void => {
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    return new Promise<RunResult>((resolve, reject) => {
      child.once("error", (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(classifySpawnError(error));
      });
      child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        const ended_at = new Date();
        resolve({
          command,
          args: [...args],
          cwd: options.cwd,
          exit_code: code,
          signal,
          stdout,
          stderr,
          started_at: started_at.toISOString(),
          ended_at: ended_at.toISOString(),
          duration_ms: ended_at.getTime() - started_at.getTime(),
          pid: child.pid ?? null,
        });
      });
    });
  }
}

function validateOptions(options: RunOptions): void {
  if (
    options.timeout_ms !== undefined &&
    (!Number.isFinite(options.timeout_ms) || options.timeout_ms <= 0)
  ) {
    throw new Error("Invalid timeout_ms");
  }
}

function classifySpawnError(error: unknown): Error {
  if (findErrorCode(error, "ENOENT")) {
    return new Error("Command not found", { cause: error });
  }
  return new Error("Failed to spawn child process", { cause: error });
}
