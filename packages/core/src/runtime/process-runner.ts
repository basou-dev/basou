/**
 * Internal abstraction over child-process execution.
 *
 * The v0.1 implementation is intentionally minimal:
 * - No stream callbacks (callers receive stdout/stderr as full strings).
 * - No event emission. Callers wire any event flow separately.
 * - UTF-8 capture only.
 *
 * The boundary is internal: ProcessRunner is not part of the public
 * adapter surface. Adapters do not import or instantiate it directly;
 * CLI / Core orchestration owns construction and invocation.
 */

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
   * after the value is written.
   */
  readonly stdin?: string | Buffer;
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
