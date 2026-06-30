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
 * - `codex-adapter` — a live `basou run codex` process wrap.
 * - `codex-import` — derived after the fact from an OpenAI Codex native
 *   rollout log (date-partitioned `~/.codex/sessions`) by `basou import codex`.
 * - `import` — a round-trip of a Basou-format export (`basou session import`).
 * - `human` / `terminal` — manually-authored / terminal-recorded sessions.
 */
export const SessionSourceKindSchema = z.enum([
  "claude-code-adapter",
  "claude-code-import",
  "codex-adapter",
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
  // Byte size of the source native log at import time, recorded so a later
  // import can detect that an append-only transcript GREW and re-import it
  // (scoped, preserving the session id) instead of skipping it as already
  // imported. Additive optional => no schema_version bump (precedent:
  // external_id, metrics). Absent on sessions imported before this field
  // existed (treated as legacy: never auto-re-imported, populated on the next
  // fresh import or `--force`).
  source_size_bytes: z.number().int().nonnegative().optional(),
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
 *   stored numbers stay interpretable if the method changes later. When a
 *   source records explicit per-turn intervals (Codex), `active_time_method` is
 *   `turn-intervals` and the in-turn time is the log's real wall-clock span
 *   rather than a gap-capped approximation; the active semantics are unchanged.
 * - `machine_active_time_ms`: model compute time — the summed duration of the
 *   source's per-turn spans (Codex `task_complete.duration_ms`), a SUBSET of a
 *   single session's engaged active time. Unlike `active_intervals` it is a
 *   plain sum, NOT wall-clock-deduplicated, so two concurrent sessions can sum
 *   past their billable (union) active wall-clock — that is intended (two models
 *   working at once did two machine-hours in one wall-clock hour). Captured only
 *   for sources that record per-turn duration (Codex); absent otherwise.
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
  machine_active_time_ms: z.number().int().nonnegative().optional(),
});
/** Inferred runtime type for {@link SessionMetricsSchema}. */
export type SessionMetrics = z.infer<typeof SessionMetricsSchema>;

/**
 * Tamper-evidence head anchor for a session whose `events.jsonl` is hash
 * chained: `head_hash` is the hex sha-256 of the last written event line
 * (excluding the trailing newline), `event_count` the number of chained lines.
 * Written by the import / in-place re-import writers and, for a live session
 * (`exec` / `run` / ad-hoc), by the finalize once it reaches a terminal status.
 * Absent on a still-live session (the anchor is stamped at finalize) and on a
 * pre-feature unchained session. Additive optional => no schema_version bump.
 * `.strict()` because the writers fully own the shape.
 */
export const SessionIntegritySchema = z
  .object({
    head_hash: z.string(),
    event_count: z.number().int().nonnegative(),
  })
  .strict();
/** Inferred runtime type for {@link SessionIntegritySchema}. */
export type SessionIntegrity = z.infer<typeof SessionIntegritySchema>;

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
  integrity: SessionIntegritySchema.optional(),
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
