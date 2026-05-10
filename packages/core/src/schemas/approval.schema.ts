import { z } from "zod";
import {
  ApprovalIdSchema,
  IsoTimestampSchema,
  RiskLevelSchema,
  SchemaVersionSchema,
  SessionIdSchema,
} from "./shared.schema.js";

/**
 * Lifecycle states of a Basou approval. The status is stored directly on
 * the approval YAML (flat shape) so that pending → resolved transitions
 * are atomic-move + in-place rewrites rather than schema-variant swaps.
 */
export const ApprovalStatusSchema = z.enum(["pending", "approved", "rejected", "expired"]);
/** Inferred runtime type for {@link ApprovalStatusSchema}. */
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

/**
 * Schema for `.basou/approvals/{pending,resolved}/<approval_id>.yaml`.
 *
 * The schema is intentionally flat (one shape regardless of `status`) so
 * that pending and resolved YAMLs share the same parser. Required vs.
 * optional semantics by status (e.g. `rejection_reason` MUST be set when
 * `status === "rejected"`) are enforced at the CLI orchestration layer
 * rather than here, mirroring the approval event variants in
 * `event.schema.ts`.
 *
 * The `action` field is `{ kind: string }` with `passthrough()` so that
 * adapter-defined keys (e.g. `command`, `path`, `target_url`) survive the
 * round-trip without being stripped — matching the approval_requested
 * event variant.
 */
export const ApprovalSchema = z.object({
  schema_version: SchemaVersionSchema,
  id: ApprovalIdSchema,
  session_id: SessionIdSchema,
  created_at: IsoTimestampSchema,
  status: ApprovalStatusSchema,
  risk_level: RiskLevelSchema,
  action: z.object({ kind: z.string() }).passthrough(),
  reason: z.string(),
  expires_at: IsoTimestampSchema.nullable().default(null),
  // The four fields below are null while `status === "pending"` and set
  // once a resolver records a decision. Defaulting to null keeps the
  // pending YAML free of explicit nulls if a producer omits them.
  resolver: z.string().nullable().default(null),
  resolved_at: IsoTimestampSchema.nullable().default(null),
  note: z.string().nullable().default(null),
  rejection_reason: z.string().nullable().default(null),
});

/** Inferred runtime type for {@link ApprovalSchema}. */
export type Approval = z.infer<typeof ApprovalSchema>;
