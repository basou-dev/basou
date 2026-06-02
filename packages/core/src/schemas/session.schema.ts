import { z } from "zod";
import {
  IsoTimestampSchema,
  SchemaVersionSchema,
  SessionIdSchema,
  TaskIdSchema,
  WorkspaceIdSchema,
} from "./shared.schema.js";

/** Session lifecycle states. */
export const SessionStatusSchema = z.enum([
  "initialized",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "interrupted",
  "imported",
  "archived",
]);
/** Inferred runtime type for {@link SessionStatusSchema}. */
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/**
 * Source kind that produced the session.
 *
 * - `claude-code-adapter` — a live `basou run claude-code` process wrap.
 * - `claude-code-import` — derived after the fact from a Claude Code native
 *   transcript (`~/.claude/projects/*.jsonl`) by `basou import claude-code`.
 * - `codex-import` — derived after the fact from an OpenAI Codex native
 *   rollout log (date-partitioned `~/.codex/sessions`) by `basou import codex`.
 * - `import` — a round-trip of a Basou-format export (`basou session import`).
 * - `human` / `terminal` — manually-authored / terminal-recorded sessions.
 */
export const SessionSourceKindSchema = z.enum([
  "claude-code-adapter",
  "claude-code-import",
  "codex-import",
  "human",
  "import",
  "terminal",
]);
/** Inferred runtime type for {@link SessionSourceKindSchema}. */
export type SessionSourceKind = z.infer<typeof SessionSourceKindSchema>;

const SessionSourceSchema = z.object({
  kind: SessionSourceKindSchema,
  version: z.literal("0.1.0"),
  // Optional id of the originating session in the SOURCE tool's own
  // namespace (e.g. the Claude Code session UUID for a `claude-code-import`).
  // Lets re-imports of the same source be deduplicated; absent for live runs.
  external_id: z.string().optional(),
});

const InvocationSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  // Nullable to record signal-terminated runs where the child has no exit
  // code; the same nullability is mirrored in CommandExecutedEventSchema.
  exit_code: z.number().int().nullable(),
});

/**
 * Optional per-session metrics, computed at import time from the source tool's
 * native log. Two groups, both optional because not every source records them:
 *
 * - Model-usage rollup (`*_tokens`): the transcript carries per-message token
 *   usage; these are the session totals. `reasoning_output_tokens` is
 *   Codex-only, and live `run`/`exec` sessions carry no token usage at all.
 * - Engaged-time metrics (`active_*`): the billing-oriented active time derived
 *   from the session's genuine engagement timestamps (conversation turns plus
 *   action events), with idle gaps capped. `active_intervals` are the merged
 *   wall-clock ranges (so cross-session totals can de-duplicate overlapping
 *   work by interval union); `active_time_ms` is their summed duration;
 *   `active_gap_cap_ms` and `active_time_method` lock the methodology so the
 *   stored numbers stay interpretable if the method changes later.
 *
 * Absent on sessions imported before a given field existed (re-import to
 * backfill). Live sessions carry no engaged-time metrics and fall back to
 * event-derived active time at stats time.
 */
export const SessionMetricsSchema = z.object({
  output_tokens: z.number().int().nonnegative().optional(),
  input_tokens: z.number().int().nonnegative().optional(),
  cached_input_tokens: z.number().int().nonnegative().optional(),
  reasoning_output_tokens: z.number().int().nonnegative().optional(),
  active_time_ms: z.number().int().nonnegative().optional(),
  active_intervals: z
    .array(z.object({ start: IsoTimestampSchema, end: IsoTimestampSchema }))
    .optional(),
  active_gap_cap_ms: z.number().int().nonnegative().optional(),
  active_time_method: z.string().optional(),
});
/** Inferred runtime type for {@link SessionMetricsSchema}. */
export type SessionMetrics = z.infer<typeof SessionMetricsSchema>;

const SessionInnerSchema = z.object({
  id: SessionIdSchema,
  label: z.string().optional(),
  task_id: TaskIdSchema.nullable().optional(),
  workspace_id: WorkspaceIdSchema,
  source: SessionSourceSchema,
  started_at: IsoTimestampSchema,
  // ended_at is optional because initialized / running sessions have no end time yet.
  ended_at: IsoTimestampSchema.optional(),
  status: SessionStatusSchema,
  working_directory: z.string().min(1),
  invocation: InvocationSchema,
  related_files: z.array(z.string()).default([]),
  events_log: z.string().default("events.jsonl"),
  summary: z.string().nullable().optional(),
  metrics: SessionMetricsSchema.optional(),
});

/**
 * Schema for `.basou/sessions/<session_id>/session.yaml`. The minimal
 * session document carries the actual fields nested under the outer
 * `session:` key.
 */
export const SessionSchema = z.object({
  schema_version: SchemaVersionSchema,
  session: SessionInnerSchema,
});

/** Inferred runtime type for {@link SessionSchema}. */
export type Session = z.infer<typeof SessionSchema>;
