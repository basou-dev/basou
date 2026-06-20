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

/**
 * A source root is RELATIVE to the manifest's repository root (it is resolved
 * to an absolute path at import time). manifest.yaml is a commit candidate, so
 * absolute machine paths (`/Users/...`), home-expansion (`~`), and stray
 * backslashes are rejected to keep committed manifests path-clean and
 * machine-portable. A `..`-prefixed sibling (e.g. `../basou-workspace`) is
 * allowed.
 *
 * Encoded as a regex (not a Zod refinement) so the constraint is also emitted
 * into the published JSON Schema's `pattern`, letting cross-language validators
 * enforce the same rule. It rejects: a leading `~` (home), a leading `/` (POSIX
 * absolute), any backslash anywhere (UNC / Windows / stray), a `<drive>:`
 * prefix, and null bytes; `min(1)` rejects the empty string.
 */
const SOURCE_ROOT_PATTERN = /^(?![~/\\])(?![A-Za-z]:)[^\0\\]+$/;

const SourceRootSchema = z.string().min(1).regex(SOURCE_ROOT_PATTERN, {
  message:
    "source_roots entries must be relative paths (no absolute path, '~', '\\', or null byte)",
});

/**
 * Optional import config. `source_roots` lets one `.basou/` aggregate the
 * native logs of several sibling repositories (each a path relative to the
 * repo root, e.g. `["."`, `"../basou"]`). `basou refresh` / `basou import`
 * scan every listed root; the list is the complete set, so include `"."` to
 * keep the host repository itself. Absent => the host repository root only.
 */
const ImportConfigSchema = z.object({
  source_roots: z.array(SourceRootSchema).min(1).optional(),
});

/**
 * A project's declared repo roster (the "saddle" model): the single source of
 * truth for which repos make up this project. The capture config
 * (`import.source_roots`) is reconciled against this list, and
 * `basou project check` reports drift between the two (e.g. a companion repo
 * wired into the workspace but never added to `source_roots`). Each `path` is
 * relative to the manifest repo root, reusing the machine-portable source-root
 * constraint. `visibility` is the repo's git visibility; richer per-repo fields
 * (language, published surfaces) are deferred to later slices and not modeled
 * here yet.
 */
const RepoVisibilitySchema = z.enum(["public", "private", "future-public"]);

const RepoEntrySchema = z.object({
  path: SourceRootSchema,
  visibility: RepoVisibilitySchema.optional(),
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
  import: ImportConfigSchema.optional(),
  repos: z.array(RepoEntrySchema).min(1).optional(),
});

/** Inferred runtime type for {@link ManifestSchema}. */
export type Manifest = z.infer<typeof ManifestSchema>;
