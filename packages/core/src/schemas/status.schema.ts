import { z } from "zod";
import { IsoTimestampSchema, SchemaVersionSchema, WorkspaceIdSchema } from "./shared.schema.js";

/**
 * Schema for `.basou/status.json` — a forward-incompat cache of the current
 * workspace state.
 *
 * Each level uses `.strict()` so unknown keys are rejected rather than
 * silently stripped. A v0.1 reader that encounters a future-shape
 * `status.json` therefore fails parsing instead of returning a partially
 * empty snapshot; callers regenerate by calling `buildStatusSnapshot` +
 * `writeStatus` rather than trying to migrate.
 */
export const StatusSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    generated_at: IsoTimestampSchema,
    workspace: z
      .object({
        id: WorkspaceIdSchema,
        name: z.string().min(1),
        // Mirrors the manifest's basou_version, so it uses the same
        // forward-compatible format gate (accept 0.x.y) rather than a literal.
        basou_version: SchemaVersionSchema,
      })
      .strict(),
    directories_present: z
      .object({
        sessions: z.boolean(),
        tasks: z.boolean(),
        approvals_pending: z.boolean(),
        approvals_resolved: z.boolean(),
        logs: z.boolean(),
        raw: z.boolean(),
        tmp: z.boolean(),
      })
      .strict(),
  })
  .strict();

/** Inferred runtime type for {@link StatusSchema}. */
export type StatusSnapshot = z.infer<typeof StatusSchema>;
