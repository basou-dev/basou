import { z } from "zod";
import { ApprovalSchema } from "./approval.schema.js";
import { EVENT_SCHEMA_VERSION, EventSchema } from "./event.schema.js";
import { ManifestSchema } from "./manifest.schema.js";
import { SessionSchema } from "./session.schema.js";
import {
  SESSION_IMPORT_SCHEMA_VERSION,
  SessionImportPayloadSchema,
} from "./session-import.schema.js";
import { StatusSchema } from "./status.schema.js";
import { TaskSchema } from "./task.schema.js";
import { TaskIndexSchema } from "./task-index.schema.js";

/**
 * `schema_version` of each on-disk format, keyed by artifact basename.
 *
 * Per document, not workspace-wide: the formats version independently, so one
 * of them changing must not move the `$id` of the others. It tracks
 * {@link SchemaVersionSchema} (the `schema_version` field a writer stamps on
 * that document), NOT the npm package version, so a document's `$id` stays
 * stable while the package moves.
 *
 * The version a document is listed under is the version its WRITERS stamp, so
 * the published `$id` and the `schema_version` inside the same artifact always
 * agree. `session-import` is the case worth naming: its envelope still stamps
 * (and its importer still requires) `0.1.0`, while the events it carries are
 * individually versioned and now include `0.2.0` ones — so the envelope's bytes
 * changed without the envelope's own format changing.
 */
export const JSON_SCHEMA_VERSIONS = {
  manifest: "0.1.0",
  session: "0.1.0",
  event: EVENT_SCHEMA_VERSION,
  task: "0.1.0",
  approval: "0.1.0",
  status: "0.1.0",
  "task-index": "0.1.0",
  "session-import": SESSION_IMPORT_SCHEMA_VERSION,
} as const satisfies Record<string, string>;

/** Base of every emitted schema's `$id`, before the per-document version. The
 * URL is a stable identifier; it need not resolve (serving the schemas on
 * basou.dev is a separate concern). */
const ID_BASE = "https://basou.dev/schemas";

/** JSON Schema draft the artifacts target (what `z.toJSONSchema` emits). */
const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/**
 * The on-disk Basou documents that get a published JSON Schema, keyed by the
 * artifact basename (`<name>.schema.json`). Each entry maps a `.basou/` file
 * format to the Zod schema that is its single source of truth.
 */
const DOCUMENTS: ReadonlyArray<{
  name: keyof typeof JSON_SCHEMA_VERSIONS;
  schema: z.ZodType;
  title: string;
  description: string;
}> = [
  {
    name: "manifest",
    schema: ManifestSchema,
    title: "Basou Manifest",
    description: "The `.basou/manifest.yaml` workspace manifest.",
  },
  {
    name: "session",
    schema: SessionSchema,
    title: "Basou Session",
    description: "A `.basou/sessions/<id>/session.yaml` session record.",
  },
  {
    name: "event",
    schema: EventSchema,
    title: "Basou Event",
    description:
      "One line of a `.basou/sessions/<id>/events.jsonl` stream (a discriminated union over the event `type`).",
  },
  {
    name: "task",
    schema: TaskSchema,
    title: "Basou Task",
    description: "The YAML front matter of a `.basou/tasks/<id>.md` task document.",
  },
  {
    name: "approval",
    schema: ApprovalSchema,
    title: "Basou Approval",
    description: "A `.basou/approvals/{pending,resolved}/<id>.yaml` approval record.",
  },
  {
    name: "status",
    schema: StatusSchema,
    title: "Basou Status",
    description: "The `.basou/status.json` workspace status snapshot.",
  },
  {
    name: "task-index",
    schema: TaskIndexSchema,
    title: "Basou Task Index",
    description: "The `.basou/tasks/index.json` task lookup index.",
  },
  {
    name: "session-import",
    schema: SessionImportPayloadSchema,
    title: "Basou Session Import Payload",
    description: "The portable session payload consumed by `basou session import`.",
  },
];

/** One emitted JSON Schema artifact. */
export type JsonSchemaArtifact = {
  /** Artifact basename without extension (e.g. `session`). */
  name: string;
  /** The JSON Schema document (draft 2020-12). */
  schema: Record<string, unknown>;
};

/**
 * Build the published JSON Schema artifacts from the canonical Zod schemas.
 *
 * Pure: no disk or environment access. Each artifact is `z.toJSONSchema` of the
 * document schema, re-headed with an `$id` carrying that document's own
 * {@link JSON_SCHEMA_VERSIONS} entry, plus `title` / `description` (the draft
 * `$schema` from zod is preserved). This is the single generator used by
 * both the `gen:schemas` script (which writes the committed files) and the
 * drift-guard test (which asserts the committed files still match), so the two
 * can never disagree.
 *
 * Generated in `io: "input"` mode so the artifacts describe what a consumer
 * AUTHORS on disk, not zod's parsed output: a field with a `.default()` (e.g.
 * `events_log`) stays optional rather than `required`, and a non-strict object
 * omits `additionalProperties: false` so additive fields are allowed. Only the
 * `.strict()` event variants (e.g. `adapter_output`) keep
 * `additionalProperties: false`, preserving their reject-unknown contract.
 *
 * Note: prefixed-id fields carry a representable `pattern` (see
 * `createPrefixedIdSchema`); other refinement-only constraints are not
 * expressible in JSON Schema and are intentionally omitted.
 */
export function buildJsonSchemas(): JsonSchemaArtifact[] {
  return DOCUMENTS.map((doc) => {
    const generated = z.toJSONSchema(doc.schema, { io: "input" }) as Record<string, unknown>;
    const { $schema, ...rest } = generated;
    const schema: Record<string, unknown> = {
      $schema: typeof $schema === "string" ? $schema : JSON_SCHEMA_DIALECT,
      $id: `${ID_BASE}/${JSON_SCHEMA_VERSIONS[doc.name]}/${doc.name}.schema.json`,
      title: doc.title,
      description: doc.description,
      ...rest,
    };
    return { name: doc.name, schema };
  });
}

/** Serialize an artifact's schema exactly as the committed file stores it
 * (2-space indent, trailing newline) so the generator and the drift-guard test
 * compare byte-for-byte. */
export function serializeJsonSchema(schema: Record<string, unknown>): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}
