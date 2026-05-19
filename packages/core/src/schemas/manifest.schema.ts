import { z } from "zod";
import { IsoTimestampSchema, SchemaVersionSchema, WorkspaceIdSchema } from "./shared.schema.js";

const ProjectSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  repository_url: z.string().nullable().optional(),
});

const CapabilitiesSchema = z.object({
  enabled: z.array(z.string()),
});

const ApprovalConfigSchema = z.object({
  required_for: z.array(z.string()).optional(),
  default_risk_level: z.enum(["low", "medium", "high", "critical"]),
});

const ClaudeCodeAdapterConfigSchema = z.object({
  enabled: z.boolean(),
  config_path: z.string().optional(),
});

const AdaptersSchema = z.object({
  "claude-code": ClaudeCodeAdapterConfigSchema,
});

const GitConfigSchema = z.object({
  events_log: z.enum(["ignore", "commit"]).default("ignore"),
});

const WorkspaceMetaSchema = z.object({
  id: WorkspaceIdSchema,
  name: z.string().min(1),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});

/**
 * Schema for `.basou/manifest.yaml`. The minimal manifest carries
 * schema_version, basou_version, workspace metadata, project info, enabled
 * capabilities, approval policy, adapter config, and git policy. The
 * `adapters."claude-code"` key uses a hyphen; downstream code accesses it
 * via bracket notation.
 */
export const ManifestSchema = z.object({
  schema_version: SchemaVersionSchema,
  basou_version: z.literal("0.1.0"),
  workspace: WorkspaceMetaSchema,
  project: ProjectSchema,
  capabilities: CapabilitiesSchema,
  approval: ApprovalConfigSchema,
  adapters: AdaptersSchema,
  git: GitConfigSchema,
});

/** Inferred runtime type for {@link ManifestSchema}. */
export type Manifest = z.infer<typeof ManifestSchema>;
