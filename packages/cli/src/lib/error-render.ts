import {
  FailedToFinalizeError,
  type ReplayWarning,
  type SessionSkipReason,
  type TaskSkipReason,
} from "@basou/core";

// ============================================================================
// Short-id helpers
// ============================================================================

const SES_PREFIX = "ses_";
const TASK_PREFIX = "task_";
const SHORT_ID_LEN = 6;

/**
 * Strip the `ses_` prefix and slice the first {@link SHORT_ID_LEN} chars of
 * the ULID body for human-readable session identification in CLI output.
 * IDs without the prefix are sliced from offset 0.
 */
export function shortSessionId(id: string): string {
  if (id.startsWith(SES_PREFIX))
    return id.slice(SES_PREFIX.length, SES_PREFIX.length + SHORT_ID_LEN);
  return id.slice(0, SHORT_ID_LEN);
}

/**
 * Same as {@link shortSessionId} but for `task_<ULID>` ids.
 */
export function shortTaskId(id: string): string {
  if (id.startsWith(TASK_PREFIX))
    return id.slice(TASK_PREFIX.length, TASK_PREFIX.length + SHORT_ID_LEN);
  return id.slice(0, SHORT_ID_LEN);
}

// ============================================================================
// Verbose mode detection
// ============================================================================

/**
 * Unified verbose-mode predicate: `options.verbose === true` OR the
 * `BASOU_DEBUG=1` environment variable. CLI surfaces use this everywhere
 * the verbose error / cause label rendering needs a yes/no answer.
 */
export function isVerbose(options: { verbose?: boolean } | undefined): boolean {
  return options?.verbose === true || process.env.BASOU_DEBUG === "1";
}

// ============================================================================
// Cause-chain walk (pathless)
// ============================================================================

const CAUSE_CHAIN_MAX_DEPTH = 4;

/**
 * Walk the cause chain (up to {@link CAUSE_CHAIN_MAX_DEPTH} hops) and return
 * the first errno-style `code` found, falling back to the deepest
 * constructor name. The value goes into `Caused by: <label>` so verbose
 * output stays pathless even when capability layers wrap native errors.
 *
 * Returns `undefined` when `error.cause` is not itself an Error (= no chain
 * to walk).
 */
export function extractCauseLabel(error: Error): string | undefined {
  let current: unknown = error.cause;
  let constructorName: string | undefined;
  for (let depth = 0; depth < CAUSE_CHAIN_MAX_DEPTH; depth += 1) {
    if (!(current instanceof Error)) break;
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    constructorName = current.constructor.name;
    current = current.cause;
  }
  return constructorName;
}

// ============================================================================
// Pluggable classifier interface
// ============================================================================

/**
 * Plug-in for command-specific error rendering. {@link renderCliError}
 * invokes every classifier whose {@link match} returns true and emits each
 * line returned by {@link additionalLines} after the main `error.message`
 * line. Classifiers MUST keep their lines pathless — no absolute paths, no
 * `cause.message` echo.
 */
export interface ErrorClassifier {
  match(error: Error): boolean;
  additionalLines(error: Error): readonly string[];
}

/**
 * Shared classifier for {@link FailedToFinalizeError}. Both `task.ts` and
 * `decision.ts` need exactly the same two warning lines — the session.yaml
 * status update failed AFTER the target event was already written, so the
 * operator must NOT retry the command.
 */
export const failedToFinalizeClassifier: ErrorClassifier = {
  match: (error) => error instanceof FailedToFinalizeError,
  additionalLines: (error) => {
    const e = error as FailedToFinalizeError;
    const sid = shortSessionId(e.sessionId);
    // `targetEventIds[0]` is the operator-facing anchor event (= the
    // `decision_recorded` / `task_created` / `task_reconciled` event the
    // command was meant to produce). Multi-target ad-hoc sessions (e.g.
    // `task new --status done` which adds `task_status_changed`) carry the
    // additional ids in `targetEventIds[1..]`; one anchor is enough for the
    // do-not-rerun warning.
    const anchor = e.targetEventIds[0];
    return [
      `Recorded ${anchor} in session ${sid}; do not rerun`,
      "Warning: session.yaml status update failed; events.jsonl is consistent",
    ];
  },
};

// ============================================================================
// Generic CLI error renderer
// ============================================================================

/**
 * Render an unknown thrown value to stderr without leaking absolute paths.
 *
 * Always prints `error.message` first, then any classifier-emitted lines,
 * and finally — in verbose mode — a single `Caused by: <label>` line where
 * `<label>` is the first errno code found while walking `error.cause` (or
 * the deepest constructor name as a fallback). The error's `cause.message`
 * is intentionally never printed because Node's native fs errors embed
 * absolute paths there.
 *
 * Non-Error values are coerced via `String(error)` so the catch-all fallback
 * in `program.parseAsync().catch(...)` still produces something readable.
 */
export function renderCliError(
  error: unknown,
  options: { verbose: boolean; classifiers?: readonly ErrorClassifier[] },
): void {
  if (!(error instanceof Error)) {
    console.error(String(error));
    return;
  }
  console.error(error.message);
  for (const classifier of options.classifiers ?? []) {
    if (classifier.match(error)) {
      for (const line of classifier.additionalLines(error)) console.error(line);
    }
  }
  if (options.verbose) {
    const label = extractCauseLabel(error);
    if (label !== undefined) console.error(`Caused by: ${label}`);
  }
}

// ============================================================================
// Warning surface helpers
// ============================================================================

/**
 * Print a `ReplayWarning` on stderr in the canonical short form used by
 * every command that consumes the event-replay stream (= task / handoff /
 * decisions / etc.). The session id is shortened via {@link shortSessionId}
 * for readability.
 */
export function printReplayWarning(warning: ReplayWarning, sessionId: string): void {
  const short = shortSessionId(sessionId);
  switch (warning.kind) {
    case "partial_trailing_line":
      console.error(`Warning: ignored partial trailing line in ${short}/events.jsonl`);
      break;
    case "malformed_json":
      console.error(
        `Warning: skipped malformed JSON at line ${warning.line} in ${short}/events.jsonl`,
      );
      break;
    case "schema_violation":
      console.error(
        `Warning: skipped invalid event at line ${warning.line} in ${short}/events.jsonl`,
      );
      break;
  }
}

/**
 * Print a session-skip warning in the "scan" form used by handoff / decisions
 * generators: `events_jsonl_unreadable` is mapped to the standardised
 * suspect-check warning used elsewhere in the CLI, every other reason falls
 * through to a generic `Skipped <sid>: <reason>` form preserving the raw
 * enum value.
 */
export function printSessionSkip(sid: string, reason: SessionSkipReason): void {
  const short = shortSessionId(sid);
  if (reason === "events_jsonl_unreadable") {
    console.error(`Warning: skipped suspect check for ${short}: events.jsonl unreadable`);
  } else {
    console.error(`Skipped ${short}: ${reason}`);
  }
}

/**
 * Print a session-skip warning in the "list" form used by `session list`.
 * Each reason is mapped to a user-friendly English phrase rather than the
 * raw enum value. `events_jsonl_unreadable` shares the wording produced by
 * {@link printSessionSkip} so the CLI surface stays consistent across
 * subcommands.
 */
export function printSessionListSkip(sid: string, reason: SessionSkipReason): void {
  const short = shortSessionId(sid);
  switch (reason) {
    case "session_yaml_missing":
      console.error(`Skipped ${short}: session.yaml not found`);
      break;
    case "session_yaml_invalid":
      console.error(`Skipped ${short}: invalid session schema`);
      break;
    case "events_jsonl_unreadable":
      console.error(`Warning: skipped suspect check for ${short}: events.jsonl unreadable`);
      break;
  }
}

/**
 * Print a task-skip warning shared between `task list` (which sees a
 * narrowed {@link TaskSkipReason} enum) and handoff / decisions generators
 * (which may forward an arbitrary reason string). Accepts a plain `string`
 * so both shapes route through the same renderer.
 */
export function printTaskSkip(taskId: string, reason: TaskSkipReason | string): void {
  console.error(`Skipped ${shortTaskId(taskId)}: ${reason}`);
}
