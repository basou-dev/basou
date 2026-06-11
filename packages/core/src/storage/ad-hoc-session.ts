import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendChainedEventLocked } from "../events/chained-append.js";
import { writeEventsBulk } from "../events/event-writer.js";
import { type PrefixedId, prefixedUlid } from "../ids/ulid.js";
import { findErrorCode } from "../lib/error-codes.js";
import { sanitizeWorkingDirectory } from "../lib/path-sanitizer.js";
import type { Event } from "../schemas/event.schema.js";
import type { Manifest } from "../schemas/manifest.schema.js";
import {
  type Session,
  SessionSchema,
  type SessionSourceKind,
  SessionSourceKindSchema,
  type SessionStatus,
} from "../schemas/session.schema.js";
import { SessionIdSchema } from "../schemas/shared.schema.js";
import type { BasouPaths } from "./basou-dir.js";
import { acquireLock } from "./lockfile.js";
import { readSessionYaml } from "./sessions.js";
import { linkYamlFile, overwriteYamlFile } from "./yaml-store.js";

// ============================================================================
// Finalization-failure error
// ============================================================================

/**
 * Thrown when the ad-hoc session was fully written to disk (4 lifecycle
 * events + N target events plus the initial `session.yaml`) but the final
 * `session.yaml` update to status `completed` failed. The caller can read
 * `sessionId` / `targetEventIds` to emit a retry-duplicate-prevention
 * warning, since the target events themselves are already persisted in
 * `events.jsonl`.
 *
 * `targetEventIds` is an array because a single ad-hoc session may carry
 * multiple target events (e.g. `task new --status done` fires both
 * `task_created` and `task_status_changed`). Callers that need a single
 * anchor id should use `targetEventIds[0]`, which by convention is the
 * primary event for the operation.
 */
export class FailedToFinalizeError extends Error {
  readonly sessionId: PrefixedId<"ses">;
  readonly targetEventIds: ReadonlyArray<PrefixedId<"evt">>;

  constructor(
    sessionId: PrefixedId<"ses">,
    targetEventIds: ReadonlyArray<PrefixedId<"evt">>,
    cause: unknown,
  ) {
    super("Failed to finalize ad-hoc session", { cause });
    this.name = "FailedToFinalizeError";
    if (targetEventIds.length === 0) {
      // Defensive guard for direct (non-orchestrator) constructors. The
      // orchestrator already rejects an empty `targetEventBuilders` array
      // before any ID minting, but `FailedToFinalizeError` is a public
      // exported class and `error-render.ts` reads `targetEventIds[0]` as
      // the operator-facing anchor — an empty array there would surface as
      // `"Recorded undefined ..."`.
      throw new Error("FailedToFinalizeError requires at least one target event id");
    }
    this.sessionId = sessionId;
    this.targetEventIds = targetEventIds;
  }
}

// ============================================================================
// Ad-hoc session path
// ============================================================================

export type CreateAdHocSessionInput = {
  paths: BasouPaths;
  manifest: Manifest;
  /** Pre-built session label (caller is responsible for truncation). */
  label: string;
  /** ISO timestamp shared across the 5 lifecycle/target events. */
  occurredAt: string;
  sessionSource: SessionSourceKind;
  workingDirectory: string;
  invocation: { command: string; args: string[] };
  /**
   * Optional task id to link this ad-hoc session to. When provided, both the
   * initial and the final `session.yaml` writes embed `task_id` so the
   * single-session-to-single-task invariant (see
   * `docs/spec/workspace.md#21-confirmed-invariants`) holds for task-flavoured
   * ad-hoc paths (`basou task new` / `task status` without `--session`).
   * Defaults to `null` so existing callers (decision / note) are unchanged.
   */
  taskId?: PrefixedId<"task">;
  /**
   * Builds the variant-specific target events. Each builder receives the
   * freshly minted session id and a freshly minted event id (one per
   * builder) so callers can fill in cross-reference fields (`decision_id`,
   * `body`, ...) without owning ID generation.
   *
   * The most common case is a single-element array (`[builder]`) for the
   * one-target-event flows (`basou decision record`, `basou session note`,
   * `basou task new --status planned`, `basou task status`,
   * `basou task reconcile`). Two-element arrays are used by
   * `basou task new --status done|cancelled` to emit `task_created` plus
   * an immediate `task_status_changed` in the same atomic bulk write.
   *
   * Must be non-empty; an empty array is rejected at the start of
   * {@link createAdHocSessionWithEvent}.
   */
  targetEventBuilders: ReadonlyArray<
    (sessionId: PrefixedId<"ses">, eventId: PrefixedId<"evt">) => Event
  >;
};

export type CreateAdHocSessionResult = {
  sessionId: PrefixedId<"ses">;
  /**
   * Target event IDs in the order their builders were supplied. Length
   * equals `input.targetEventBuilders.length`. Callers that conceptually
   * have a single anchor event should use `targetEventIds[0]`.
   */
  targetEventIds: PrefixedId<"evt">[];
  /**
   * Lifecycle event IDs in chronological order:
   * `[started, status→running, status→completed, ended]`.
   * Target event IDs are reported separately in {@link targetEventIds}.
   */
  lifecycleEventIds: PrefixedId<"evt">[];
};

/**
 * Atomically create a fresh ad-hoc session that produces one or more target
 * events then immediately closes itself. The session lifecycle
 * (`initialized → running → completed`, see
 * `docs/spec/terminal-and-import.md#62-transition-diagram`) is honored:
 * `4 + N` events are
 * written in one bulk atomic pass (where N = number of target builders) and
 * `session.yaml` is written twice (`initialized` → `completed`).
 *
 * The single-target case (N = 1) covers `basou decision record`,
 * `basou session note`, `basou task new --status planned|in_progress`,
 * `basou task status`, and `basou task reconcile`. The two-target case
 * (N = 2) covers `basou task new --status done|cancelled` which fires
 * `task_created` followed immediately by `task_status_changed (planned → terminal)`
 * so the audit trail captures the implicit transition.
 *
 * Failures during `mkdir`, the initial `session.yaml` write, or the bulk
 * `events.jsonl` write trigger a best-effort `rm -rf` of the session
 * directory so partial ad-hoc sessions do not pollute the workspace.
 *
 * A failure on the final `session.yaml` status update is fatal but the
 * session directory is NOT cleaned up — `events.jsonl` is consistent and
 * carries the full lifecycle trail, so callers can reconcile manually. The
 * thrown {@link FailedToFinalizeError} carries the `sessionId` and
 * `targetEventIds` so the CLI layer can warn the user not to re-run the
 * command and duplicate the target events.
 *
 * Direct (non-CLI) callers are self-defended by zod boundary parses on
 * `sessionSource` and the initial session record.
 */
export async function createAdHocSessionWithEvent(
  input: CreateAdHocSessionInput,
): Promise<CreateAdHocSessionResult> {
  // 1. core boundary parse — direct callers may pass arbitrary strings.
  SessionSourceKindSchema.parse(input.sessionSource);
  if (input.targetEventBuilders.length === 0) {
    throw new Error("Ad-hoc session requires at least one target event builder");
  }

  // 2. ID minting. One target event id per builder; lifecycle ids are fixed.
  const sessionId = prefixedUlid("ses");
  const startedEventId = prefixedUlid("evt");
  const statusToRunningEventId = prefixedUlid("evt");
  const targetEventIds = input.targetEventBuilders.map(() => prefixedUlid("evt"));
  const statusToCompletedEventId = prefixedUlid("evt");
  const endedEventId = prefixedUlid("evt");

  // 3. Build the initial session record (status=initialized) and validate it
  //    so a malformed input shape fails fast before any disk write.
  const initialSession: Session = SessionSchema.parse(
    buildInitialSession({
      sessionId,
      workspaceId: input.manifest.workspace.id,
      sourceKind: input.sessionSource,
      startedAt: input.occurredAt,
      label: input.label,
      workingDirectory: input.workingDirectory,
      invocation: input.invocation,
      taskId: input.taskId ?? null,
    }),
  );

  // Hold the session lock across the whole create sequence (initial yaml ->
  // bulk events -> final yaml). The session is briefly `initialized` and thus
  // attachable; without the lock a foreign attach could append a line into
  // that window which the atomic bulk write would then clobber, breaking the
  // chain. The session id is freshly minted, so no caller already holds it.
  const sessionDir = join(input.paths.sessions, sessionId);
  const sessionYamlPath = join(sessionDir, "session.yaml");
  const lock = await acquireLock(input.paths, "session", sessionId);
  let bulkResult: Awaited<ReturnType<typeof writeEventsBulk>> = null;
  try {
    // 4. Create the session directory (recursive=true so a stripped-down
    //    workspace with `.basou/sessions` missing still recovers).
    try {
      await mkdir(sessionDir, { recursive: true });
    } catch (error: unknown) {
      throw new Error("Failed to create session directory", { cause: error });
    }

    // 5. Initial session.yaml write (status=initialized).
    try {
      await linkYamlFile(sessionYamlPath, initialSession);
    } catch (error: unknown) {
      await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
      if (findErrorCode(error, "EEXIST")) {
        throw new Error("Session directory collision (retry the command)", {
          cause: error,
        });
      }
      throw error;
    }

    // 6. events.jsonl bulk write — the full lifecycle batch written atomically
    //    in a single tmp+rename pass, hash-chained (chain:true) so the ad-hoc
    //    log is tamper-evident like an imported one. A failure here removes the
    //    session directory so no partial state survives (status=initialized +
    //    no events is not visible in `basou session list`).
    try {
      const targetEvents: Event[] = input.targetEventBuilders.map((build, index) => {
        const targetEventId = targetEventIds[index] as PrefixedId<"evt">;
        return assertTargetEventIdentity(build(sessionId, targetEventId), sessionId, targetEventId);
      });
      const events: Event[] = [
        {
          schema_version: "0.1.0",
          id: startedEventId,
          session_id: sessionId,
          occurred_at: input.occurredAt,
          source: "local-cli",
          type: "session_started",
        },
        {
          schema_version: "0.1.0",
          id: statusToRunningEventId,
          session_id: sessionId,
          occurred_at: input.occurredAt,
          source: "local-cli",
          type: "session_status_changed",
          from: "initialized",
          to: "running",
        },
        ...targetEvents,
        {
          schema_version: "0.1.0",
          id: statusToCompletedEventId,
          session_id: sessionId,
          occurred_at: input.occurredAt,
          source: "local-cli",
          type: "session_status_changed",
          from: "running",
          to: "completed",
        },
        {
          schema_version: "0.1.0",
          id: endedEventId,
          session_id: sessionId,
          occurred_at: input.occurredAt,
          source: "local-cli",
          type: "session_ended",
          exit_code: 0,
        },
      ];
      bulkResult = await writeEventsBulk(sessionDir, events, { chain: true });
    } catch (error: unknown) {
      await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    // 7. Finalize: overwrite session.yaml with status=completed + ended_at +
    //    invocation.exit_code=0 + the integrity head anchor from the chained
    //    bulk write. Failure is fatal but events.jsonl is already complete, so
    //    the directory is intentionally NOT removed — the caller surfaces the
    //    partial state via FailedToFinalizeError.
    try {
      const finalSession: Session = SessionSchema.parse({
        ...initialSession,
        session: {
          ...initialSession.session,
          status: "completed" satisfies SessionStatus,
          ended_at: input.occurredAt,
          invocation: { ...initialSession.session.invocation, exit_code: 0 },
          ...(bulkResult !== null
            ? { integrity: { head_hash: bulkResult.headHash, event_count: bulkResult.count } }
            : {}),
        },
      });
      await overwriteYamlFile(sessionYamlPath, finalSession);
    } catch (error: unknown) {
      throw new FailedToFinalizeError(sessionId, targetEventIds, error);
    }
  } finally {
    await lock.release();
  }

  return {
    sessionId,
    targetEventIds,
    lifecycleEventIds: [
      startedEventId,
      statusToRunningEventId,
      statusToCompletedEventId,
      endedEventId,
    ],
  };
}

function buildInitialSession(input: {
  sessionId: PrefixedId<"ses">;
  workspaceId: PrefixedId<"ws">;
  sourceKind: SessionSourceKind;
  startedAt: string;
  label: string;
  workingDirectory: string;
  invocation: { command: string; args: string[] };
  taskId: PrefixedId<"task"> | null;
}): Session {
  return {
    schema_version: "0.1.0",
    session: {
      id: input.sessionId,
      label: input.label,
      task_id: input.taskId,
      workspace_id: input.workspaceId,
      source: { kind: input.sourceKind, version: "0.1.0" },
      started_at: input.startedAt,
      status: "initialized",
      working_directory: sanitizeWorkingDirectory(input.workingDirectory, { homedir: homedir() }),
      invocation: { ...input.invocation, exit_code: null },
      related_files: [],
      events_log: "events.jsonl",
    },
  };
}

// ============================================================================
// Attach path
// ============================================================================

export type AttachableStatus = "initialized" | "running" | "waiting_approval";

const DEFAULT_ATTACHABLE_STATUSES: ReadonlySet<AttachableStatus> = new Set<AttachableStatus>([
  "initialized",
  "running",
  "waiting_approval",
]);

export type AppendEventToExistingInput = {
  paths: BasouPaths;
  /** Already resolved via `resolveSessionId`; parsed at boundary again. */
  sessionId: PrefixedId<"ses">;
  attachableStatuses?: ReadonlySet<AttachableStatus>;
  eventBuilder: (eventId: PrefixedId<"evt">) => Event;
};

export type AppendEventToExistingResult = {
  eventId: PrefixedId<"evt">;
  sessionStatus: SessionStatus;
};

/**
 * Read `session.yaml`, verify the session is in an attachable state, and
 * append a single event to its `events.jsonl`. `session.yaml` is NOT modified
 * so the caller can safely append `decision_recorded` / `note_added` without
 * mutating `related_files`, `summary`, or the session status.
 *
 * Race note: the status check and the event append are not atomic.
 * Between them another writer (e.g. `basou run claude-code` ending its
 * session) can flip the YAML to `completed` and append `session_ended`.
 * v0.1 accepts this race; the `events_say_ended_but_yaml_running`-style
 * suspect rule surfaces the inconsistency. Per-session locking is
 * deferred to a v0.3+ follow-up.
 */
export async function appendEventToExistingSession(
  input: AppendEventToExistingInput,
): Promise<AppendEventToExistingResult> {
  // 1. Boundary parse (direct caller self-defense).
  SessionIdSchema.parse(input.sessionId);

  // 2. Read session.yaml.
  const sessionDoc = await readSessionYaml(input.paths, input.sessionId);
  const status = sessionDoc.session.status;

  // 3. Status check.
  if (status === "imported") {
    throw new Error("Cannot attach to imported session");
  }
  const attachable = input.attachableStatuses ?? DEFAULT_ATTACHABLE_STATUSES;
  if (!attachable.has(status as AttachableStatus)) {
    throw new Error(`Session is not active: ${status}`);
  }

  // 4. Mint event ID and build payload.
  const eventId = prefixedUlid("evt");
  const event = assertTargetEventIdentity(input.eventBuilder(eventId), input.sessionId, eventId);

  // 5. Append, chaining onto the on-disk tail. The CALLER owns the session
  //    lock (decision record / session note / task attach each acquire it
  //    around this whole read-check-append window), so the lock-assumed
  //    primitive is used here and must NOT re-acquire the lock.
  await appendChainedEventLocked(input.paths, input.sessionId, event);

  return { eventId, sessionStatus: status };
}

/**
 * Defensive check: a builder closure could in principle hand back
 * an event whose `id` or `session_id` differs from the orchestrator's
 * minted values. EventSchema only validates the shape, so this slip would
 * silently corrupt events.jsonl. Reject with a fixed pathless message so
 * direct-caller misuse never reaches disk.
 */
function assertTargetEventIdentity(
  event: Event,
  expectedSessionId: PrefixedId<"ses">,
  expectedEventId: PrefixedId<"evt">,
): Event {
  if (event.session_id !== expectedSessionId) {
    throw new Error("Target event session_id mismatch");
  }
  if (event.id !== expectedEventId) {
    throw new Error("Target event id mismatch");
  }
  return event;
}
