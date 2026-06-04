import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
// ajv-formats is CJS (`module.exports = fn`); under NodeNext the callable lives
// on `.default`. Its `FormatsPlugin` type is mis-resolved as non-callable here,
// so cast to the (verified-at-runtime) call signature rather than loosen tsc.
import * as ajvFormats from "ajv-formats";

const addFormats = ajvFormats.default as unknown as (ajv: Ajv2020) => void;

import { describe, expect, it } from "vitest";
import { buildJsonSchemas, JSON_SCHEMA_VERSION, serializeJsonSchema } from "./json-schema.js";

const schemasDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas");
const artifacts = buildJsonSchemas();

/** Find an event `oneOf` variant by its `type` const. */
function eventVariant(type: string): Record<string, unknown> {
  const event = artifacts.find((a) => a.name === "event")?.schema as {
    oneOf: Array<{ properties?: { type?: { const?: string } } } & Record<string, unknown>>;
  };
  const found = event.oneOf.find((v) => v.properties?.type?.const === type);
  if (found === undefined) throw new Error(`no event variant ${type}`);
  return found;
}

describe("buildJsonSchemas", () => {
  it("emits one artifact per on-disk document", () => {
    expect(artifacts.map((a) => a.name).sort()).toEqual([
      "approval",
      "event",
      "manifest",
      "session",
      "session-import",
      "status",
      "task",
      "task-index",
    ]);
  });

  it("heads every artifact with the draft dialect, a versioned $id, title, and description", () => {
    for (const { name, schema } of artifacts) {
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(schema.$id).toBe(
        `https://basou.dev/schemas/${JSON_SCHEMA_VERSION}/${name}.schema.json`,
      );
      expect(typeof schema.title).toBe("string");
      expect(typeof schema.description).toBe("string");
    }
  });

  it("carries the ULID pattern on prefixed-id fields (metadata fidelity)", () => {
    const session = artifacts.find((a) => a.name === "session")?.schema as {
      properties: { session: { properties: { id: { pattern?: string } } } };
    };
    expect(session.properties.session.properties.id.pattern).toBe(
      "^ses_[0-7][0-9A-HJKMNP-TV-Z]{25}$",
    );
  });

  it("emits the event document as a discriminated union (oneOf)", () => {
    const event = artifacts.find((a) => a.name === "event")?.schema as { oneOf?: unknown[] };
    expect(Array.isArray(event.oneOf)).toBe(true);
    expect(event.oneOf?.length ?? 0).toBeGreaterThan(1);
  });

  it("locks unknown keys only on strict event variants (input-mode semantics)", () => {
    // adapter_output is `.strict()` (bars raw bodies); session_started is not,
    // so it must allow additive fields rather than rejecting them.
    expect(eventVariant("adapter_output").additionalProperties).toBe(false);
    expect(eventVariant("session_started").additionalProperties).toBeUndefined();
  });
});

describe("committed JSON Schema artifacts", () => {
  // Drift guard: the committed schemas/*.json must match what the canonical Zod
  // schemas generate today. If this fails, a schema changed without
  // regenerating — run `pnpm --filter @basou/core gen:schemas`.
  for (const { name, schema } of artifacts) {
    it(`schemas/${name}.schema.json is in sync with the Zod source`, () => {
      const committed = readFileSync(join(schemasDir, `${name}.schema.json`), "utf8");
      expect(committed).toBe(serializeJsonSchema(schema));
    });
  }
});

describe("emitted schemas validate real documents (ajv draft 2020-12)", () => {
  const WS = "ws_01HXABCDEF1234567890ABCDEF";
  const SES = "ses_01HXABCDEF1234567890ABCDEF";
  const EVT = "evt_01HXABCDEF1234567890ABCDEF";
  const TASK = "task_01HXABCDEF1234567890ABCDEF";
  const APPR = "appr_01HXABCDEF1234567890ABCDEF";
  const ISO = "2026-05-10T00:00:00.000Z";

  // One representative VALID document per emitted schema.
  const samples: Record<string, unknown> = {
    manifest: {
      schema_version: "0.1.0",
      basou_version: "0.1.0",
      workspace: { id: WS, name: "w", created_at: ISO, updated_at: ISO },
      project: {},
      capabilities: { enabled: [] },
      approval: { default_risk_level: "low" },
      adapters: { "claude-code": { enabled: false } },
      git: { events_log: "ignore" },
    },
    session: {
      schema_version: "0.1.0",
      session: {
        id: SES,
        workspace_id: WS,
        source: { kind: "codex-import", version: "0.1.0" },
        started_at: ISO,
        ended_at: ISO,
        status: "completed",
        working_directory: "/tmp",
        invocation: { command: "codex", args: [], exit_code: null },
        related_files: [],
        events_log: "events.jsonl",
      },
    },
    event: {
      schema_version: "0.1.0",
      id: EVT,
      session_id: SES,
      occurred_at: ISO,
      source: "codex-import",
      type: "session_started",
    },
    task: {
      schema_version: "0.1.0",
      task: {
        id: TASK,
        title: "t",
        status: "planned",
        created_at: ISO,
        updated_at: ISO,
        workspace_id: WS,
        created_in_session: SES,
        linked_sessions: [SES],
      },
    },
    approval: {
      schema_version: "0.1.0",
      id: APPR,
      session_id: SES,
      created_at: ISO,
      status: "pending",
      risk_level: "low",
      action: { kind: "command" },
      reason: "r",
    },
    status: {
      schema_version: "0.1.0",
      generated_at: ISO,
      workspace: { id: WS, name: "w", basou_version: "0.1.0" },
      directories_present: {
        sessions: true,
        tasks: true,
        approvals_pending: true,
        approvals_resolved: true,
        logs: true,
        raw: true,
        tmp: true,
      },
    },
    "task-index": {
      schema_version: "0.1.0",
      tasks: [{ id: TASK, status: "planned", updated_at: ISO }],
      last_rebuilt_at: ISO,
    },
    "session-import": {
      schema_version: "0.1.0",
      session: {
        id: SES,
        workspace_id: WS,
        source: { kind: "claude-code-adapter", version: "0.1.0" },
        started_at: ISO,
        status: "completed",
        working_directory: "/tmp",
        invocation: { command: "claude", args: [], exit_code: 0 },
        related_files: [],
      },
      events: [
        {
          schema_version: "0.1.0",
          type: "session_started",
          id: EVT,
          session_id: SES,
          occurred_at: ISO,
          source: "claude-code-adapter",
        },
      ],
    },
  };

  // One ajv instance; each schema registers under its unique $id.
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  const validators = new Map(artifacts.map((a) => [a.name, ajv.compile(a.schema)]));
  const validate = (name: string, doc: unknown): boolean => {
    const fn = validators.get(name);
    if (fn === undefined) throw new Error(`no validator for ${name}`);
    const ok = fn(doc);
    if (!ok) console.error(`${name} validation errors:`, fn.errors);
    return ok;
  };

  for (const { name } of artifacts) {
    it(`${name}.schema.json compiles and accepts a representative document`, () => {
      expect(validate(name, samples[name])).toBe(true);
    });
  }

  it("accepts a manifest that omits the defaulted events_log (input-mode optional)", () => {
    const m = structuredClone(samples.manifest) as { git: { events_log?: string } };
    delete m.git.events_log;
    expect(validate("manifest", m)).toBe(true);
  });

  it("accepts a session that omits defaulted events_log / related_files", () => {
    const s = structuredClone(samples.session) as {
      session: { events_log?: string; related_files?: unknown };
    };
    delete s.session.events_log;
    delete s.session.related_files;
    expect(validate("session", s)).toBe(true);
  });

  it("accepts an additive field on a non-strict event variant", () => {
    expect(validate("event", { ...(samples.event as object), extra_field: true })).toBe(true);
  });

  it("rejects a malformed session id (the ULID pattern has teeth)", () => {
    const s = structuredClone(samples.session) as { session: { id: string } };
    s.session.id = "ses_not-a-valid-ulid";
    expect(validate("session", s)).toBe(false);
  });
});
