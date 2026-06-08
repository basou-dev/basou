import { z } from "zod";
import { ApprovalSchema } from "./approval.schema.js";
import { EventSchema } from "./event.schema.js";
import { ManifestSchema } from "./manifest.schema.js";
import { SessionSchema } from "./session.schema.js";
import { SessionImportPayloadSchema } from "./session-import.schema.js";
import { StatusSchema } from "./status.schema.js";
import { TaskSchema } from "./task.schema.js";
import { TaskIndexSchema } from "./task-index.schema.js";

/**
 * Schema version of the on-disk Basou v0.1 formats these JSON Schemas describe.
 * It tracks {@link SchemaVersionSchema} (the `schema_version` field), NOT the
 * npm package version, so the `$id` URLs stay stable while the package moves.
 */
export const JSON_SCHEMA_VERSION = "0.1.0";

/** Base of every emitted schema's `$id`. The URL is a stable identifier; it
 * need not resolve (serving the schemas on basou.dev is a separate concern). */
const ID_BASE = `https://basou.dev/schemas/${JSON_SCHEMA_VERSION}`;

/** JSON Schema draft the artifacts target (what `z.toJSONSchema` emits). */
const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/**
 * The on-disk Basou documents that get a published JSON Schema, keyed by the
 * artifact basename (`<name>.schema.json`). Each entry maps a `.basou/` file
 * format to the Zod schema that is its single source of truth.
 */
const DOCUMENTS: ReadonlyArray<{
  name: string;
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
 * document schema, re-headed with a stable `$id` / `title` / `description` (the
 * draft `$schema` from zod is preserved). This is the single generator used by
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
      $id: `${ID_BASE}/${doc.name}.schema.json`,
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
