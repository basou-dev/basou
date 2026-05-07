import type { ChildProcess } from "node:child_process";

/**
 * Internal abstraction over child-process execution.
 *
 * The v0.1 implementation is intentionally minimal:
 * - Optional UTF-8 stdout/stderr capture (`capture: "buffer"`, default) or
 *   pass-through to the parent's stdio (`capture: "none"`).
 * - No stream callbacks for partial chunks.
 * - No event emission. Callers wire any event flow separately.
 *
 * The boundary is internal: ProcessRunner is not part of the public
 * adapter surface. Adapters do not import or instantiate it directly;
 * CLI / Core orchestration owns construction and invocation.
 */

/**
 * Output capture mode.
 *
 * - `"buffer"` (default): pipe stdout/stderr to the runner and accumulate
 *   the full UTF-8 string into {@link RunResult}.
 * - `"none"`: inherit the parent's stdio. The child writes directly to the
 *   parent terminal in real time and {@link RunResult.stdout} /
 *   {@link RunResult.stderr} are empty strings. `stdin` cannot be combined
 *   with `"none"` because the child has no writable stdin pipe.
 */
export type CaptureMode = "buffer" | "none";

export type RunOptions = {
  /**
   * Working directory for the child process. Required: callers resolve
   * the workspace root themselves; the runner does not validate cwd
   * existence and surfaces native spawn errors via classification.
   */
  readonly cwd: string;
  /**
   * Environment variables for the child. When omitted, the parent's
   * `process.env` is inherited verbatim. Callers wanting a sanitized
   * environment must build it explicitly.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * External cancellation. Aborting the signal triggers a two-stage
   * kill (SIGTERM, then SIGKILL after a short grace period).
   */
  readonly signal?: AbortSignal;
  /**
   * Internal timeout in milliseconds. Must be a positive finite number.
   * Triggers the same two-stage kill as `signal`.
   */
  readonly timeout_ms?: number;
  /**
   * Optional input written to the child's stdin. The pipe is closed
   * after the value is written. Incompatible with `capture: "none"`.
   */
  readonly stdin?: string | Buffer;
  /**
   * Output capture mode. Defaults to `"buffer"`. See {@link CaptureMode}.
   */
  readonly capture?: CaptureMode;
  /**
   * Invoked synchronously immediately after the child has been spawned,
   * before the runner waits for completion. Callers use this to retain a
   * reference for parent-side cleanup (e.g. an `exit` hook that SIGKILLs
   * the child if the parent is forcibly terminated). The runner takes no
   * action if the callback throws.
   */
  readonly onSpawn?: (child: ChildProcess) => void;
};

export type RunResult = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** `null` when the process was killed by a signal. */
  readonly exit_code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** ISO 8601 timestamp captured before spawn. */
  readonly started_at: string;
  /** ISO 8601 timestamp captured on the `close` event. */
  readonly ended_at: string;
  readonly duration_ms: number;
  readonly pid: number | null;
};

export type ProcessRunner = {
  run(command: string, args: readonly string[], options: RunOptions): Promise<RunResult>;
};
