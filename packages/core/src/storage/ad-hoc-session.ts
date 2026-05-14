import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { appendEvent, writeEventsBulk } from "../events/event-writer.js";
import { type PrefixedId, prefixedUlid } from "../ids/ulid.js";
import { findErrorCode } from "../lib/error-codes.js";
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
import { readSessionYaml } from "./sessions.js";
import { linkYamlFile, overwriteYamlFile } from "./yaml-store.js";

// ============================================================================
// Finalization-failure error (Y-3s H4)
// ============================================================================

/**
 * Thrown when the ad-hoc session was fully written to disk (5 events plus the
 * initial `session.yaml`) but the final `session.yaml` update to status
 * `completed` failed. The caller can read `sessionId` / `decisionEventId` to
 * emit a retry-duplicate-prevention warning, since the target event itself is
 * already persisted in `events.jsonl`.
 *
 * The class name is `decisionEventId` rather than `targetEventId` because
 * only the `basou decision record` ad-hoc path throws this — `basou session
 * note` uses the attach path which never finalizes a session.
 */
export class FailedToFinalizeError extends Error {
  readonly sessionId: PrefixedId<"ses">;
  readonly decisionEventId: PrefixedId<"evt">;

  constructor(sessionId: PrefixedId<"ses">, decisionEventId: PrefixedId<"evt">, cause: unknown) {
    super("Failed to finalize ad-hoc session", { cause });
    this.name = "FailedToFinalizeError";
    this.sessionId = sessionId;
    this.decisionEventId = decisionEventId;
  }
}

// ============================================================================
// Ad-hoc session path (Y-3s D / F)
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
   * single-session-to-single-task invariant (Y-2 §2.1) holds for task-flavoured
   * ad-hoc paths (`basou task new` / `task status` without `--session`).
   * Defaults to `null` so existing callers (decision / note) are unchanged.
   */
  taskId?: PrefixedId<"task">;
  /**
   * Builds the variant-specific target event. Receives the freshly minted
   * session/event IDs so the caller can fill in cross-reference fields
   * (`decision_id`, `body`, ...) without owning ID generation.
   */
  targetEventBuilder: (sessionId: PrefixedId<"ses">, eventId: PrefixedId<"evt">) => Event;
};

export type CreateAdHocSessionResult = {
  sessionId: PrefixedId<"ses">;
  targetEventId: PrefixedId<"evt">;
  /**
   * Lifecycle event IDs in chronological order:
   * `[started, status→running, status→completed, ended]`.
   * The target event ID is reported separately in {@link targetEventId}.
   */
  lifecycleEventIds: PrefixedId<"evt">[];
};

/**
 * Atomically create a fresh ad-hoc session that produces a single target
 * event then immediately closes itself. Y-2 §6.2 lifecycle
 * (`initialized → running → completed`) is honored: five events are written
 * in one bulk atomic pass and `session.yaml` is written twice
 * (`initialized` → `completed`).
 *
 * Failures during `mkdir`, the initial `session.yaml` write, or the bulk
 * `events.jsonl` write trigger a best-effort `rm -rf` of the session
 * directory so partial ad-hoc sessions do not pollute the workspace.
 *
 * A failure on the final `session.yaml` status update is fatal but the
 * session directory is NOT cleaned up — `events.jsonl` is consistent and
 * carries the full lifecycle trail, so callers can reconcile manually. The
 * thrown {@link FailedToFinalizeError} carries the `sessionId` and target
 * `decisionEventId` so the CLI layer can warn the user not to re-run the
 * command and duplicate the decision.
 *
 * Direct (non-CLI) callers are self-defended by zod boundary parses on
 * `sessionSource` and the initial session record.
 */
export async function createAdHocSessionWithEvent(
  input: CreateAdHocSessionInput,
): Promise<CreateAdHocSessionResult> {
  // 1. core boundary parse — direct callers may pass arbitrary strings.
  SessionSourceKindSchema.parse(input.sessionSource);

  // 2. ID minting
  const sessionId = prefixedUlid("ses");
  const startedEventId = prefixedUlid("evt");
  const statusToRunningEventId = prefixedUlid("evt");
  const targetEventId = prefixedUlid("evt");
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

  // 4. Create the session directory (recursive=true so a stripped-down
  //    workspace with `.basou/sessions` missing still recovers).
  const sessionDir = join(input.paths.sessions, sessionId);
  try {
    await mkdir(sessionDir, { recursive: true });
  } catch (error: unknown) {
    throw new Error("Failed to create session directory", { cause: error });
  }

  // 5. Initial session.yaml write (status=initialized).
  const sessionYamlPath = join(sessionDir, "session.yaml");
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

  // 6. events.jsonl bulk write — five events written atomically in a single
  //    tmp+rename pass. A failure here removes the session directory so no
  //    partial state survives (status=initialized + no events is not visible
  //    in `basou session list`).
  try {
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
      assertTargetEventIdentity(
        input.targetEventBuilder(sessionId, targetEventId),
        sessionId,
        targetEventId,
      ),
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
    await writeEventsBulk(sessionDir, events);
  } catch (error: unknown) {
    await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  // 7. Finalize: overwrite session.yaml with status=completed + ended_at +
  //    invocation.exit_code=0. Failure is fatal but events.jsonl is already
  //    complete, so the directory is intentionally NOT removed — the caller
  //    surfaces the partial state via FailedToFinalizeError.
  try {
    const finalSession: Session = SessionSchema.parse({
      ...initialSession,
      session: {
        ...initialSession.session,
        status: "completed" satisfies SessionStatus,
        ended_at: input.occurredAt,
        invocation: { ...initialSession.session.invocation, exit_code: 0 },
      },
    });
    await overwriteYamlFile(sessionYamlPath, finalSession);
  } catch (error: unknown) {
    throw new FailedToFinalizeError(sessionId, targetEventId, error);
  }

  return {
    sessionId,
    targetEventId,
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
      working_directory: input.workingDirectory,
      invocation: { ...input.invocation, exit_code: null },
      related_files: [],
      events_log: "events.jsonl",
    },
  };
}

// ============================================================================
// Attach path (Y-3s E / F)
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
 * Race note (Y-3s H3): the status check and the event append are not atomic.
 * Between them another writer (e.g. `basou run claude-code` ending its
 * session) can flip the YAML to `completed` and append `session_ended`.
 * v0.1 accepts this race; the `events_say_ended_but_yaml_running`-style
 * suspect rule (Y-3o-X1) surfaces the inconsistency. Per-session locking is
 * deferred to release prep (Step 17+ carryover #46).
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

  // 5. Append (appendEvent validates with EventSchema; bad payloads are
  //    rejected with the fixed `"Invalid Basou event payload"` message).
  const sessionDir = join(input.paths.sessions, input.sessionId);
  await appendEvent(sessionDir, event);

  return { eventId, sessionStatus: status };
}

/**
 * Defensive check (Y3s-3-M1): a builder closure could in principle hand back
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
