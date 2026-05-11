import { z } from "zod";
import { EventSchema } from "./event.schema.js";
import { SessionSourceKindSchema, SessionStatusSchema } from "./session.schema.js";
import {
  IsoTimestampSchema,
  SessionIdSchema,
  TaskIdSchema,
  WorkspaceIdSchema,
} from "./shared.schema.js";

// Independent copy of SessionInnerSchema for import payloads. The differences
// from session.schema.ts are deliberate:
//   - `id` is `SessionIdSchema.optional()` so format is validated when present
//     but the orchestrator discards it and assigns a fresh ULID.
//   - `status` / `source.kind` are validated against the canonical enums but
//     overwritten by the orchestrator (status -> "imported", source.kind
//     retained from input per K1).
//   - `events_log` is plain `z.string().optional()`; the orchestrator forces
//     "events.jsonl" to block path traversal.
//   - `.strict()` rejects unknown session-level keys at parse time.
//
// Events strictness follows EventSchema as authored: `adapter_output` is
// `.strict()`, the other 14 variants are permissive, and
// `approval_requested.action` is `.passthrough()`. This keeps Y-2 Section 7.3
// (additive event fields are allowed) and round-trip imports of post-v0.1
// events compatible. A blanket strict wrap for every variant is deferred to
// v0.2 (carry-over #35).
//
// `schema_version` at the top level is `z.string()` rather than the
// `SchemaVersionSchema = z.literal("0.1.0")` literal. The strict reject for
// unsupported versions emits a dedicated `Unsupported import schema_version`
// message from the orchestrator; a literal here would short-circuit the
// branch and turn every mismatched version into the generic
// `Invalid import payload`.
export const SessionInnerImportSchema = z
  .object({
    id: SessionIdSchema.optional(),
    label: z.string().optional(),
    task_id: TaskIdSchema.nullable().optional(),
    workspace_id: WorkspaceIdSchema,
    source: z.object({
      kind: SessionSourceKindSchema,
      version: z.literal("0.1.0"),
    }),
    started_at: IsoTimestampSchema,
    ended_at: IsoTimestampSchema.optional(),
    status: SessionStatusSchema,
    working_directory: z.string().min(1),
    invocation: z.object({
      command: z.string().min(1),
      args: z.array(z.string()),
      exit_code: z.number().int().nullable(),
    }),
    related_files: z.array(z.string()).default([]),
    events_log: z.string().optional(),
    summary: z.string().nullable().optional(),
  })
  .strict();

/**
 * Schema for the round-trip JSON payload accepted by `basou session import
 * --format json`. The top level is `.strict()`; unknown keys at the outer
 * envelope are rejected.
 */
export const SessionImportPayloadSchema = z
  .object({
    schema_version: z.string(),
    session: SessionInnerImportSchema,
    events: z.array(EventSchema),
  })
  .strict();

/** Inferred runtime type for {@link SessionImportPayloadSchema}. */
export type SessionImportPayload = z.infer<typeof SessionImportPayloadSchema>;
/** Inferred runtime type for {@link SessionInnerImportSchema}. */
export type SessionInnerImportInput = z.infer<typeof SessionInnerImportSchema>;
