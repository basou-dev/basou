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
