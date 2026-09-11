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
import { EVENT_SCHEMA_VERSION } from "./event.schema.js";
import { buildJsonSchemas, JSON_SCHEMA_VERSIONS, serializeJsonSchema } from "./json-schema.js";

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
      const version = JSON_SCHEMA_VERSIONS[name as keyof typeof JSON_SCHEMA_VERSIONS];
      expect(version).toBeTypeOf("string");
      expect(schema.$id).toBe(`https://basou.dev/schemas/${version}/${name}.schema.json`);
      expect(typeof schema.title).toBe("string");
      expect(typeof schema.description).toBe("string");
    }
  });

  it("versions each $id independently: only the event format moved to 0.2.0", () => {
    const byName = new Map(artifacts.map((a) => [a.name, a.schema.$id]));
    expect(byName.get("event")).toBe("https://basou.dev/schemas/0.2.0/event.schema.json");
    for (const name of [
      "approval",
      "manifest",
      "session",
      "session-import",
      "status",
      "task",
      "task-index",
    ]) {
      expect(byName.get(name)).toBe(`https://basou.dev/schemas/0.1.0/${name}.schema.json`);
    }
  });

  it("keeps each $id version equal to the schema_version the document declares", () => {
    // The concrete regression: `status` shipped an $id of 0.2.0 next to a
    // `schema_version` const of 0.1.0, so the artifact contradicted its own URL.
    const checked: string[] = [];
    for (const { name, schema } of artifacts) {
      const declared = (schema as { properties?: { schema_version?: { const?: unknown } } })
        .properties?.schema_version?.const;
      if (typeof declared !== "string") continue;
      checked.push(name);
      expect(JSON_SCHEMA_VERSIONS[name as keyof typeof JSON_SCHEMA_VERSIONS]).toBe(declared);
    }
    // Pin WHICH documents this can check, so the guard cannot quietly shrink to
    // covering nothing. Only these three pin `schema_version` to a literal; the
    // rest publish it as a `0.x.y` pattern (or, for `event`, as a root `oneOf`
    // with no top-level properties), so there is no declared value to compare.
    // `session-import` joined them when the published envelope started pinning
    // the one version its importer accepts.
    expect(checked.sort()).toEqual(["session-import", "status", "task-index"]);
  });

  it("versions every document it emits, with no unused entries either way", () => {
    // The map and DOCUMENTS are hand-maintained in step; a name in one and not
    // the other is either silently dead or a missing version waiting to happen.
    expect(artifacts.map((a) => a.name).sort()).toEqual(Object.keys(JSON_SCHEMA_VERSIONS).sort());
    for (const version of Object.values(JSON_SCHEMA_VERSIONS)) {
      expect(version).toMatch(/^0\.\d+\.\d+$/);
    }
  });

  it("ties the event document's version to the constant its writers stamp", () => {
    // `event` is the only document whose version is wired to a named constant
    // rather than a repeated literal, so this is the one case where the
    // invariant holds by construction rather than by assertion.
    expect(JSON_SCHEMA_VERSIONS.event).toBe(EVENT_SCHEMA_VERSION);
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

describe("retired JSON Schema artifacts", () => {
  // A document whose `$id` version moves leaves bytes behind that the NEW
  // artifact does not describe, and the old `$id` URL is one basou published
  // and told people to point a validator at. So the superseded artifact is kept
  // verbatim under `schemas/retired/<version>/` rather than deleted: the
  // 0.1.0 event schema still describes every 0.1.0 event on disk, and nothing
  // regenerates it (its Zod source is gone). These assertions are about
  // identity and non-collision, never about content -- the bytes are frozen.
  const retired = [{ name: "event", version: "0.1.0" }] as const;

  for (const { name, version } of retired) {
    it(`schemas/retired/${version}/${name}.schema.json declares the $id its path serves`, () => {
      const raw = readFileSync(join(schemasDir, "retired", version, `${name}.schema.json`), "utf8");
      const doc = JSON.parse(raw) as { $id?: string };
      expect(doc.$id).toBe(`https://basou.dev/schemas/${version}/${name}.schema.json`);
    });

    it(`schemas/retired/${version}/${name}.schema.json does not collide with the live artifact`, () => {
      // If a retired version equals the live one, two files claim one URL and
      // the site's `$id`-keyed publish would have to pick a winner.
      expect(JSON_SCHEMA_VERSIONS[name]).not.toBe(version);
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

  it("rejects an import envelope whose schema_version the importer would reject", () => {
    // The portable contract used to be weaker than the implementation: the
    // published artifact said `schema_version: {type: string}` while the
    // importer accepts exactly one value, so a third party could validate a
    // payload against the published schema, pass, and be rejected at run time.
    // Both now read SESSION_IMPORT_SCHEMA_VERSION.
    const envelope = structuredClone(samples["session-import"]) as { schema_version: string };
    expect(validate("session-import", envelope)).toBe(true);
    envelope.schema_version = "0.2.0";
    expect(validate("session-import", envelope)).toBe(false);
  });

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
