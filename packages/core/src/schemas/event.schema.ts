import { z } from "zod";
import {
  ApprovalIdSchema,
  DecisionIdSchema,
  EventIdSchema,
  EventSourceSchema,
  IsoTimestampSchema,
  RiskLevelSchema,
  SchemaVersionSchema,
  SessionIdSchema,
  TaskIdSchema,
} from "./shared.schema.js";

// Common base every event variant extends. Each variant declares its own
// `type: z.literal(...)` and adds variant-specific fields.
const BaseEventSchema = z.object({
  schema_version: SchemaVersionSchema,
  id: EventIdSchema,
  session_id: SessionIdSchema,
  occurred_at: IsoTimestampSchema,
  source: EventSourceSchema,
});

// --- Session lifecycle events ---

const SessionStartedEventSchema = BaseEventSchema.extend({
  type: z.literal("session_started"),
});

const SessionEndedEventSchema = BaseEventSchema.extend({
  type: z.literal("session_ended"),
  exit_code: z.number().int().optional(),
});

// `from`/`to` use `string` to keep this module independent of session.schema
// and avoid a circular import. Step 5 (event-replay) may narrow these to
// SessionStatusSchema by relocating the enum into shared.schema.
const SessionStatusChangedEventSchema = BaseEventSchema.extend({
  type: z.literal("session_status_changed"),
  from: z.string(),
  to: z.string(),
});

// --- Approval events (Y-2 Section 9) ---

const ApprovalRequestedEventSchema = BaseEventSchema.extend({
  type: z.literal("approval_requested"),
  approval_id: ApprovalIdSchema,
  expires_at: IsoTimestampSchema.nullable().default(null),
  risk_level: RiskLevelSchema,
  // `action.kind` is required; additional fields are allowed to support
  // future action shapes (shell_command, external_send, ...).
  action: z.object({ kind: z.string() }).passthrough(),
  reason: z.string(),
  status: z.literal("pending"),
});

const ApprovalApprovedEventSchema = BaseEventSchema.extend({
  type: z.literal("approval_approved"),
  approval_id: ApprovalIdSchema,
  resolver: z.string().optional(),
  note: z.string().nullable().optional(),
});

const ApprovalRejectedEventSchema = BaseEventSchema.extend({
  type: z.literal("approval_rejected"),
  approval_id: ApprovalIdSchema,
  resolver: z.string().optional(),
  reason: z.string(),
});

const ApprovalExpiredEventSchema = BaseEventSchema.extend({
  type: z.literal("approval_expired"),
  approval_id: ApprovalIdSchema,
});

// --- Command / Git / File events ---

// `command` is the spawned executable name only (e.g. "npm"); arguments are
// kept in `args` to preserve quoting and avoid shell-injection round-trips.
// `exit_code` is null when the child terminated by signal. `signal` records
// the child's terminating signal; `received_signal` records what the parent
// process received (SIGINT/SIGTERM) and forwarded as cancellation, so a
// timeout (signal set, received_signal absent) can be distinguished from a
// user interrupt (both set).
const CommandExecutedEventSchema = BaseEventSchema.extend({
  type: z.literal("command_executed"),
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  exit_code: z.number().int().nullable(),
  signal: z.string().nullable().optional(),
  received_signal: z.string().nullable().optional(),
  duration_ms: z.number().int().nonnegative(),
});

const GitSnapshotEventSchema = BaseEventSchema.extend({
  type: z.literal("git_snapshot"),
  head: z.string(),
  branch: z.string(),
  dirty: z.boolean(),
  staged: z.array(z.string()),
  unstaged: z.array(z.string()),
  untracked: z.array(z.string()),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
});

const FileChangedEventSchema = BaseEventSchema.extend({
  type: z.literal("file_changed"),
  path: z.string(),
  change_type: z.enum(["added", "modified", "deleted", "renamed"]),
  // Renamed entries record the previous path here. Optional + nullable to
  // keep the wire format stable for added / modified / deleted events.
  old_path: z.string().nullable().optional(),
});

// --- Decision / Task / Note events ---

const DecisionRecordedEventSchema = BaseEventSchema.extend({
  type: z.literal("decision_recorded"),
  decision_id: DecisionIdSchema,
  title: z.string(),
});

const TaskCreatedEventSchema = BaseEventSchema.extend({
  type: z.literal("task_created"),
  task_id: TaskIdSchema,
  title: z.string(),
});

const TaskStatusChangedEventSchema = BaseEventSchema.extend({
  type: z.literal("task_status_changed"),
  task_id: TaskIdSchema,
  from: z.string(),
  to: z.string(),
});

// Step 19: emitted by `basou task reconcile --write` after broken session
// references in a task.md are cleaned up. `.strict()` so that any extra field
// (likely a core-side miscoding of an audit value) is rejected at parse time
// rather than silently stripped — the event is the audit trail.
const TaskReconciledEventSchema = BaseEventSchema.extend({
  type: z.literal("task_reconciled"),
  task_id: TaskIdSchema,
  removed_created_in_session: SessionIdSchema.nullable().default(null),
  created_in_session_replacement: SessionIdSchema.nullable().default(null),
  removed_linked_sessions: z.array(SessionIdSchema).default([]),
}).strict();

const NoteAddedEventSchema = BaseEventSchema.extend({
  type: z.literal("note_added"),
  body: z.string(),
});

// --- Adapter output (`.strict()` rejects raw bodies) ---
//
// Y-2 Section 7 forbids embedding raw adapter output (`content`, `body`,
// `raw`, ...) directly in events.jsonl. The strict variant rejects any
// schema-unknown key so that contract is enforced at parse time.
const AdapterOutputEventSchema = BaseEventSchema.extend({
  type: z.literal("adapter_output"),
  stream: z.enum(["stdout", "stderr"]),
  summary: z.string(),
  raw_ref: z.string(),
  redacted: z.boolean().optional(),
}).strict();

/**
 * Discriminated union of every Basou v0.1 event type. The `type` literal
 * narrows TypeScript to the appropriate variant. The `adapter_output`
 * variant is uniquely strict to bar raw adapter bodies.
 */
export const EventSchema = z.discriminatedUnion("type", [
  SessionStartedEventSchema,
  SessionEndedEventSchema,
  SessionStatusChangedEventSchema,
  ApprovalRequestedEventSchema,
  ApprovalApprovedEventSchema,
  ApprovalRejectedEventSchema,
  ApprovalExpiredEventSchema,
  CommandExecutedEventSchema,
  GitSnapshotEventSchema,
  FileChangedEventSchema,
  DecisionRecordedEventSchema,
  TaskCreatedEventSchema,
  TaskStatusChangedEventSchema,
  TaskReconciledEventSchema,
  NoteAddedEventSchema,
  AdapterOutputEventSchema,
]);

/** Inferred runtime type for any Basou event. */
export type Event = z.infer<typeof EventSchema>;

/** Narrowed runtime type for the `session_started` event variant. */
export type SessionStartedEvent = z.infer<typeof SessionStartedEventSchema>;
/** Narrowed runtime type for the `session_ended` event variant. */
export type SessionEndedEvent = z.infer<typeof SessionEndedEventSchema>;
/** Narrowed runtime type for the `session_status_changed` event variant. */
export type SessionStatusChangedEvent = z.infer<typeof SessionStatusChangedEventSchema>;
/** Narrowed runtime type for the `approval_requested` event variant. */
export type ApprovalRequestedEvent = z.infer<typeof ApprovalRequestedEventSchema>;
/** Narrowed runtime type for the `approval_approved` event variant. */
export type ApprovalApprovedEvent = z.infer<typeof ApprovalApprovedEventSchema>;
/** Narrowed runtime type for the `approval_rejected` event variant. */
export type ApprovalRejectedEvent = z.infer<typeof ApprovalRejectedEventSchema>;
/** Narrowed runtime type for the `approval_expired` event variant. */
export type ApprovalExpiredEvent = z.infer<typeof ApprovalExpiredEventSchema>;
/** Narrowed runtime type for the `command_executed` event variant. */
export type CommandExecutedEvent = z.infer<typeof CommandExecutedEventSchema>;
/** Narrowed runtime type for the `git_snapshot` event variant. */
export type GitSnapshotEvent = z.infer<typeof GitSnapshotEventSchema>;
/** Narrowed runtime type for the `file_changed` event variant. */
export type FileChangedEvent = z.infer<typeof FileChangedEventSchema>;
/** Narrowed runtime type for the `decision_recorded` event variant. */
export type DecisionRecordedEvent = z.infer<typeof DecisionRecordedEventSchema>;
/** Narrowed runtime type for the `task_created` event variant. */
export type TaskCreatedEvent = z.infer<typeof TaskCreatedEventSchema>;
/** Narrowed runtime type for the `task_status_changed` event variant. */
export type TaskStatusChangedEvent = z.infer<typeof TaskStatusChangedEventSchema>;
/** Narrowed runtime type for the `task_reconciled` event variant (.strict()). */
export type TaskReconciledEvent = z.infer<typeof TaskReconciledEventSchema>;
/** Narrowed runtime type for the `note_added` event variant. */
export type NoteAddedEvent = z.infer<typeof NoteAddedEventSchema>;
/** Narrowed runtime type for the `adapter_output` event variant (.strict()). */
export type AdapterOutputEvent = z.infer<typeof AdapterOutputEventSchema>;
