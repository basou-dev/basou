import { z } from "zod";
import { IsoTimestampSchema, SchemaVersionSchema, WorkspaceIdSchema } from "./shared.schema.js";

// `repository_url` was removed: it was a write-once copy of git's `remote.origin.url`
// that nothing read and that drifted on an org move/rename. The manifest holds only
// declarative intent; the remote is an observed git fact, derived live where needed
// (e.g. the portfolio view). ProjectSchema stays looseObject, so a legacy value
// survives parse as an unknown key; writeManifest strips it so any rewrite self-heals.
const ProjectSchema = z.looseObject({
  name: z.string().optional(),
  description: z.string().optional(),
});

const CapabilitiesSchema = z.looseObject({
  enabled: z.array(z.string()),
});

const ApprovalConfigSchema = z.looseObject({
  required_for: z.array(z.string()).optional(),
  default_risk_level: z.enum(["low", "medium", "high", "critical"]),
});

const ClaudeCodeAdapterConfigSchema = z.looseObject({
  enabled: z.boolean(),
  config_path: z.string().optional(),
});

const AdaptersSchema = z.looseObject({
  "claude-code": ClaudeCodeAdapterConfigSchema,
});

const GitConfigSchema = z.looseObject({
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
 * prefix, and null bytes; `min(1)` rejects the empty string. It also rejects
 * leading/trailing whitespace: without the `(?!\s)` and trailing `[^\0\\\s]`
 * guards a leading space would "shield" a forbidden first char (" ~/x" would
 * pass), and `basou project sync` normalizes (`.trim()`) before persisting, so
 * a padded path that passed at read time would fail re-validation on write —
 * and a padded `source_roots` entry resolves (path.resolve) to a missed repo
 * while sync wrongly reports it covered. Interior whitespace stays allowed
 * (`../my dir` is a legitimate directory name).
 */
const SOURCE_ROOT_PATTERN = /^(?![~/\\])(?![A-Za-z]:)(?!\s)[^\0\\]*[^\0\\\s]$/;

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
const ImportConfigSchema = z.looseObject({
  source_roots: z.array(SourceRootSchema).min(1).optional(),
});

/**
 * A project's declared repo roster (the "saddle" model): the single source of
 * truth for which repos make up this project. The capture config
 * (`import.source_roots`) is reconciled against this list, and
 * `basou project check` reports drift between the two (e.g. a companion repo
 * wired into the workspace but never added to `source_roots`). Each `path` is
 * relative to the manifest repo root, reusing the machine-portable source-root
 * constraint. `visibility` is the repo's git visibility, `language` its source
 * (commit/comment/code) language, and `publishes` the surfaces it deploys, each
 * independent of the others. `visibility`, `language`, and `publishes` are all
 * optional so a roster can be adopted first and enriched incrementally.
 */
const RepoVisibilitySchema = z.enum(["public", "private", "future-public"]);

/**
 * The audience-driven language axis, independent of visibility:
 * `en` / `ja` for a single audience, `en+ja` when both are served.
 */
const RepoLanguageSchema = z.enum(["en", "ja", "en+ja"]);

/** A published surface kind: a deployed website or a package registry. */
const PublishKindSchema = z.enum(["web", "npm"]);

/**
 * Where a repo's agent instruction files live, INDEPENDENT of the other axes.
 * `hub` (the default when absent) is basou's native topology: the canonical
 * AGENTS.md lives in the project anchor (`agents/<repo>/AGENTS.md`) and each repo
 * carries gitignored symlinks to it — basou owns and generates the wiring. `self`
 * is the additive opt-in: the canonical AGENTS.md is a regular, committed file in
 * the repo itself (hand-authored, shared in its own git history), with CLAUDE.md /
 * Copilot as committed spoke symlinks to it; basou never writes the repo's
 * AGENTS.md content (hands-off — no preset block), never gitignores the
 * instruction files, and only generates the spokes. Absent => `hub`, so an
 * existing manifest's behavior is unchanged.
 */
const RepoInstructionsSchema = z.enum(["hub", "self"]);

/**
 * One published surface. Its `visibility` and `language` are independent of the
 * source repo's (a private repo commonly publishes a public site) and both are
 * optional so a surface can be declared before those facts are pinned down.
 * `kind` is required: a surface with no kind is meaningless.
 */
const PublishTargetSchema = z.looseObject({
  kind: PublishKindSchema,
  visibility: RepoVisibilitySchema.optional(),
  language: RepoLanguageSchema.optional(),
});

const RepoEntrySchema = z.looseObject({
  path: SourceRootSchema,
  visibility: RepoVisibilitySchema.optional(),
  language: RepoLanguageSchema.optional(),
  publishes: z.array(PublishTargetSchema).optional(),
  instructions: RepoInstructionsSchema.optional(),
});

const WorkspaceMetaSchema = z.looseObject({
  id: WorkspaceIdSchema,
  name: z.string().min(1),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
  /**
   * The generated workspace view: a throwaway directory that aggregates the
   * roster repos via symlinks (one `<repo-basename>` symlink per repo). A path
   * relative to the manifest root, reusing the machine-portable source-root
   * constraint. Absent for a solo project (no view needed); `basou project
   * workspace` reconciles the view's symlinks to the declared roster.
   */
  view: SourceRootSchema.optional(),
});

/**
 * Schema for `.basou/manifest.yaml`. The minimal manifest carries
 * schema_version, basou_version, workspace metadata, project info, enabled
 * capabilities, approval policy, adapter config, and git policy. The
 * `adapters."claude-code"` key uses a hyphen; downstream code accesses it
 * via bracket notation.
 *
 * Every object here is `looseObject` (NOT the default strip), so unknown keys
 * at every level survive parse. The manifest is the declarative source of truth
 * and is git-tracked and read-modify-written by `basou project` commands; with
 * the default strip, a field this basou does not recognize — a newer version's
 * additive field, a future adapter under `adapters`, a hand-added key — would be
 * silently dropped on the next write. Preserving them keeps basou from destroying
 * config it does not understand (forward-compatible), while known fields are still
 * fully type-checked and validated. {@link unknownManifestKeys} surfaces the
 * unrecognized top-level keys so preservation is not silent.
 */
export const ManifestSchema = z.looseObject({
  schema_version: SchemaVersionSchema,
  // Same forward-compatible format gate as schema_version (accept 0.x.y, gate a
  // higher major with an upgrade error) rather than a hard literal. `basou_version`
  // is a format stamp, not the npm/product version; consolidating it with
  // schema_version is a candidate cleanup for the M4 freeze pass.
  basou_version: SchemaVersionSchema,
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

/** The declared top-level manifest keys, derived from the schema (no hardcoded drift). */
const KNOWN_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(Object.keys(ManifestSchema.shape));

/**
 * The unrecognized TOP-LEVEL keys a parsed manifest carries — fields preserved by
 * the loose schema that this basou does not know. Returned sorted, for surfacing as
 * an advisory by the read-modify-write commands so preservation is not silent (a
 * newer version's section, or a hand-added/typo'd key, is flagged rather than
 * dropped). Nested unknown keys are preserved too but not enumerated here; this is
 * the high-signal top-level case. Read-only — never mutates.
 */
export function unknownManifestKeys(manifest: Manifest): string[] {
  return Object.keys(manifest)
    .filter((k) => !KNOWN_TOP_LEVEL_KEYS.has(k))
    .sort();
}
