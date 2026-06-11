import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { verifyEventsChain } from "../events/verify.js";
import type { Manifest } from "../schemas/manifest.schema.js";
import type { SessionImportPayload } from "../schemas/session-import.schema.js";
import { type BasouPaths, ensureBasouDirectory } from "./basou-dir.js";
import { importSessionFromJson, reimportPreservingId } from "./session-import.js";
import { overwriteYamlFile } from "./yaml-store.js";

// Wrap overwriteYamlFile in a pass-through vi.fn so a single test can inject
// a yaml-write failure (the B2 rollback path); every other call delegates to
// the real implementation.
vi.mock("./yaml-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./yaml-store.js")>();
  return {
    ...actual,
    overwriteYamlFile: vi.fn(actual.overwriteYamlFile),
  };
});

const LOCAL_WS_ID = "ws_01HXABCDEF1234567890ABCWS1" as const;
const INPUT_SES_ID = "ses_01HXABCDEF1234567890ABCSE1" as const;

let workDir: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "basou-session-reimport-test-"));
});

afterEach(async () => {
  if (workDir !== undefined) {
    await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
  vi.clearAllMocks();
});

async function setupPaths(): Promise<BasouPaths> {
  if (workDir === undefined) throw new Error("workDir not initialized");
  return ensureBasouDirectory(workDir);
}

function makeManifest(): Manifest {
  return {
    schema_version: "0.1.0",
    basou_version: "0.1.0",
    workspace: {
      id: LOCAL_WS_ID,
      name: "test-workspace",
      created_at: "2026-05-01T00:00:00+09:00",
      updated_at: "2026-05-01T00:00:00+09:00",
    },
    project: {},
    capabilities: { enabled: [] },
    approval: { default_risk_level: "low" },
    adapters: { "claude-code": { enabled: false } },
    git: { events_log: "ignore" },
  };
}

type PayloadEvent = SessionImportPayload["events"][number];

function makeEvent(
  suffix: string,
  type: "session_started" | "session_ended" | "note_added",
  occurredAt: string,
  body?: string,
): PayloadEvent {
  return {
    schema_version: "0.1.0",
    id: `evt_01HXABCDEF1234567890ABCE${suffix}`,
    session_id: INPUT_SES_ID,
    occurred_at: occurredAt,
    source: "codex-import",
    type,
    ...(type === "note_added" ? { body: body ?? `note ${suffix}` } : {}),
  } as PayloadEvent;
}

function makePayload(events: PayloadEvent[]): SessionImportPayload {
  return {
    schema_version: "0.1.0",
    session: {
      workspace_id: LOCAL_WS_ID,
      source: { kind: "codex-import", version: "0.1.0", external_id: "rollout-1" },
      started_at: "2026-05-04T09:00:00+09:00",
      status: "completed",
      working_directory: "/srv/example-project",
      invocation: { command: "codex", args: [], exit_code: 0 },
      related_files: [],
    },
    events,
  };
}

const PRIOR_EVENTS: PayloadEvent[] = [
  makeEvent("V1", "session_started", "2026-05-04T09:00:00+09:00"),
  makeEvent("V2", "note_added", "2026-05-04T09:01:00+09:00", "hello"),
  makeEvent("V3", "session_ended", "2026-05-04T09:02:00+09:00"),
];

const GROWN_EVENTS: PayloadEvent[] = [
  makeEvent("V1", "session_started", "2026-05-04T09:00:00+09:00"),
  makeEvent("V2", "note_added", "2026-05-04T09:01:00+09:00", "hello"),
  makeEvent("V4", "note_added", "2026-05-04T09:03:00+09:00", "world"),
  makeEvent("V5", "session_ended", "2026-05-04T09:04:00+09:00"),
];

async function importPrior(paths: BasouPaths): Promise<string> {
  const result = await importSessionFromJson(paths, makeManifest(), makePayload(PRIOR_EVENTS), {});
  return result.sessionId;
}

describe("reimportPreservingId — hash chain", () => {
  it("re-imports a grown source and keeps the chain verified", async () => {
    const paths = await setupPaths();
    const sessionId = await importPrior(paths);
    expect(await verifyEventsChain(paths, sessionId)).toEqual({
      status: "verified",
      eventCount: 3,
    });

    const outcome = await reimportPreservingId(
      paths,
      makeManifest(),
      sessionId,
      makePayload(GROWN_EVENTS),
    );
    expect(outcome.status).toBe("reimported");
    if (outcome.status !== "reimported") throw new Error("unreachable");
    expect(outcome.eventCount).toBe(4);

    expect(await verifyEventsChain(paths, sessionId)).toEqual({
      status: "verified",
      eventCount: 4,
    });
    const yaml = parseYaml(
      await readFile(join(paths.sessions, sessionId, "session.yaml"), "utf8"),
    ) as { session: { integrity?: { event_count: number; head_hash: string } } };
    expect(yaml.session.integrity?.event_count).toBe(4);
    expect(yaml.session.integrity?.head_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("aborts with prior_chain_broken when the prior log was tampered with", async () => {
    const paths = await setupPaths();
    const sessionId = await importPrior(paths);
    const eventsPath = join(paths.sessions, sessionId, "events.jsonl");
    const tamperedBody = (await readFile(eventsPath, "utf8")).replace('"hello"', '"hacked"');
    await writeFile(eventsPath, tamperedBody);

    const outcome = await reimportPreservingId(
      paths,
      makeManifest(),
      sessionId,
      makePayload(GROWN_EVENTS),
    );
    expect(outcome).toEqual({ status: "skipped", reason: "prior_chain_broken" });
    // The tampered evidence is left in place, not rewritten.
    expect(await readFile(eventsPath, "utf8")).toBe(tamperedBody);
  });

  it("re-imports an unchained legacy session and chains it", async () => {
    const paths = await setupPaths();
    const sessionId = await importPrior(paths);
    const sessionDir = join(paths.sessions, sessionId);

    // Rewind the session to its pre-chaining shape: strip prev_hash from
    // every line and drop the yaml anchor (what an import from before this
    // feature left on disk).
    const eventsPath = join(sessionDir, "events.jsonl");
    const unchained = (await readFile(eventsPath, "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => {
        const obj = JSON.parse(l) as Record<string, unknown>;
        delete obj.prev_hash;
        return JSON.stringify(obj);
      });
    await writeFile(eventsPath, `${unchained.join("\n")}\n`);
    const yamlPath = join(sessionDir, "session.yaml");
    const yaml = parseYaml(await readFile(yamlPath, "utf8")) as {
      session: Record<string, unknown>;
    };
    delete yaml.session.integrity;
    await writeFile(yamlPath, stringifyYaml(yaml));
    expect((await verifyEventsChain(paths, sessionId)).status).toBe("unchained");

    const outcome = await reimportPreservingId(
      paths,
      makeManifest(),
      sessionId,
      makePayload(GROWN_EVENTS),
    );
    expect(outcome.status).toBe("reimported");
    expect(await verifyEventsChain(paths, sessionId)).toEqual({
      status: "verified",
      eventCount: 4,
    });
  });

  it("restores the prior events bytes VERBATIM when the yaml write fails", async () => {
    const paths = await setupPaths();
    const sessionId = await importPrior(paths);
    const eventsPath = join(paths.sessions, sessionId, "events.jsonl");
    const priorBytes = await readFile(eventsPath, "utf8");

    vi.mocked(overwriteYamlFile).mockRejectedValueOnce(new Error("Failed to overwrite YAML file"));
    await expect(
      reimportPreservingId(paths, makeManifest(), sessionId, makePayload(GROWN_EVENTS)),
    ).rejects.toThrow("Failed to overwrite YAML file");

    expect(await readFile(eventsPath, "utf8")).toBe(priorBytes);
    expect(await verifyEventsChain(paths, sessionId)).toEqual({
      status: "verified",
      eventCount: 3,
    });
  });

  it("dry-run verifies and previews without writing", async () => {
    const paths = await setupPaths();
    const sessionId = await importPrior(paths);
    const eventsPath = join(paths.sessions, sessionId, "events.jsonl");
    const priorBytes = await readFile(eventsPath, "utf8");

    const outcome = await reimportPreservingId(
      paths,
      makeManifest(),
      sessionId,
      makePayload(GROWN_EVENTS),
      { dryRun: true },
    );
    expect(outcome.status).toBe("reimported");
    expect(await readFile(eventsPath, "utf8")).toBe(priorBytes);
    expect(await verifyEventsChain(paths, sessionId)).toEqual({
      status: "verified",
      eventCount: 3,
    });
  });
});
