import { z } from "zod";
import {
  IsoTimestampSchema,
  SchemaVersionSchema,
  SessionIdSchema,
  TaskIdSchema,
  WorkspaceIdSchema,
} from "./shared.schema.js";

/** Y-2 Section 6.1 session lifecycle states. */
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

/** Y-2 Section 5.1 source kind that produced the session. */
export const SessionSourceKindSchema = z.enum([
  "claude-code-adapter",
  "human",
  "import",
  "terminal",
]);

const SessionSourceSchema = z.object({
  kind: SessionSourceKindSchema,
  version: z.literal("0.1.0"),
});

const InvocationSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  exit_code: z.number().int(),
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
 * Schema for `.basou/sessions/<session_id>/session.yaml`. Y-2 Section 5.1
 * defines the minimal session document with the actual fields nested under
 * the outer `session:` key.
 */
export const SessionSchema = z.object({
  schema_version: SchemaVersionSchema,
  session: SessionInnerSchema,
});

/** Inferred runtime type for {@link SessionSchema}. */
export type Session = z.infer<typeof SessionSchema>;
