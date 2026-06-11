import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { verifyEventsChain } from "../events/verify.js";
import type { Manifest } from "../schemas/manifest.schema.js";
import type { Session } from "../schemas/session.schema.js";
import type { SessionImportPayload } from "../schemas/session-import.schema.js";
import { type BasouPaths, ensureBasouDirectory } from "./basou-dir.js";
import {
  importSessionFromJson,
  rechainSessionInPlace,
  reimportPreservingId,
} from "./session-import.js";
import { overwriteYamlFile } from "./yaml-store.js";

// Pass-through vi.fn wrapper so one test can inject a yaml-write failure
// (the rechain rollback path); every other call delegates to the real
// implementation.
vi.mock("./yaml-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./yaml-store.js")>();
  return {
    ...actual,
    overwriteYamlFile: vi.fn(actual.overwriteYamlFile),
  };
});

const LOCAL_WS_ID = "ws_01HXABCDEF1234567890ABCWS1" as const;
const INPUT_SES_ID = "ses_01HXABCDEF1234567890ABCSE1" as const;
const HAND_SES_ID = "ses_01HXABCDEF1234567890ABCHN1" as const;
const OTHER_SES_ID = "ses_01HXABCDEF1234567890ABCHN2" as const;

let workDir: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "basou-session-rechain-test-"));
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
      label: "fixture label",
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

/**
 * Import a session, then strip it back to its pre-chaining shape (no
 * prev_hash on any line, no yaml integrity anchor) — exactly what a
 * pre-feature import left on disk.
 */
async function importLegacy(paths: BasouPaths): Promise<string> {
  const result = await importSessionFromJson(paths, makeManifest(), makePayload(PRIOR_EVENTS), {});
  const sessionId = result.sessionId;
  await stripToLegacy(paths, sessionId);
  return sessionId;
}

async function stripToLegacy(paths: BasouPaths, sessionId: string): Promise<void> {
  const sessionDir = join(paths.sessions, sessionId);
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
  const yaml = parseYaml(await readFile(yamlPath, "utf8")) as { session: Record<string, unknown> };
  delete yaml.session.integrity;
  await writeFile(yamlPath, stringifyYaml(yaml));
}

/** Hand-build a minimal imported-session dir from raw line strings. */
async function writeHandSession(
  paths: BasouPaths,
  sessionId: string,
  rawBody: string,
  options: { status?: Session["session"]["status"]; yaml?: boolean } = {},
): Promise<{ eventsPath: string; yamlPath: string }> {
  const sessionDir = join(paths.sessions, sessionId);
  await mkdir(sessionDir, { recursive: true });
  const eventsPath = join(sessionDir, "events.jsonl");
  await writeFile(eventsPath, rawBody);
  const yamlPath = join(sessionDir, "session.yaml");
  if (options.yaml !== false) {
    await writeFile(
      yamlPath,
      stringifyYaml({
        schema_version: "0.1.0",
        session: {
          id: sessionId,
          task_id: null,
          workspace_id: LOCAL_WS_ID,
          source: { kind: "codex-import", version: "0.1.0" },
          started_at: "2026-05-04T09:00:00+09:00",
          status: options.status ?? "imported",
          working_directory: "~/projects/example",
          invocation: { command: "codex", args: [], exit_code: 0 },
          related_files: [],
          events_log: "events.jsonl",
          summary: null,
        },
      }),
    );
  }
  return { eventsPath, yamlPath };
}

function handLine(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: "0.1.0",
    id: "evt_01HXABCDEF1234567890ABCEH1",
    session_id: HAND_SES_ID,
    occurred_at: "2026-05-04T09:00:00+09:00",
    source: "codex-import",
    type: "note_added",
    body: "hand",
    ...extra,
  });
}

describe("rechainSessionInPlace — success paths", () => {
  it("rechains a legacy session: verified, lines preserved except prev_hash", async () => {
    const paths = await setupPaths();
    const sessionId = await importLegacy(paths);
    const eventsPath = join(paths.sessions, sessionId, "events.jsonl");
    const originalLines = (await readFile(eventsPath, "utf8")).split("\n").filter((l) => l.length);
    expect((await verifyEventsChain(paths, sessionId)).status).toBe("unchained");

    const outcome = await rechainSessionInPlace(paths, sessionId);
    expect(outcome).toEqual({ status: "rechained", eventCount: 3 });
    expect(await verifyEventsChain(paths, sessionId)).toEqual({
      status: "verified",
      eventCount: 3,
    });

    // Each rechained line is the original line with ONLY prev_hash added.
    const rechainedLines = (await readFile(eventsPath, "utf8")).split("\n").filter((l) => l.length);
    expect(rechainedLines).toHaveLength(originalLines.length);
    for (let i = 0; i < originalLines.length; i++) {
      const rechained = JSON.parse(rechainedLines[i] as string) as Record<string, unknown>;
      expect(typeof rechained.prev_hash).toBe("string");
      delete rechained.prev_hash;
      expect(rechained).toEqual(JSON.parse(originalLines[i] as string));
    }
  });

  it("preserves every session.yaml field, adding only integrity", async () => {
    const paths = await setupPaths();
    const sessionId = await importLegacy(paths);
    const yamlPath = join(paths.sessions, sessionId, "session.yaml");
    const before = parseYaml(await readFile(yamlPath, "utf8")) as {
      session: Record<string, unknown>;
    };

    await rechainSessionInPlace(paths, sessionId);

    const after = parseYaml(await readFile(yamlPath, "utf8")) as {
      session: Record<string, unknown>;
    };
    const integrity = after.session.integrity as { head_hash: string; event_count: number };
    expect(integrity.event_count).toBe(3);
    expect(integrity.head_hash).toMatch(/^[0-9a-f]{64}$/);
    delete after.session.integrity;
    expect(after.session).toEqual(before.session);
    expect(after.session.label).toBe("fixture label");
  });

  it("preserves an unknown top-level event field byte-for-byte", async () => {
    const paths = await setupPaths();
    const line = handLine({ custom_field: "kept" });
    const { eventsPath } = await writeHandSession(paths, HAND_SES_ID, `${line}\n`);

    const outcome = await rechainSessionInPlace(paths, HAND_SES_ID);
    expect(outcome).toEqual({ status: "rechained", eventCount: 1 });

    const rechained = (await readFile(eventsPath, "utf8")).trim();
    const parsed = JSON.parse(rechained) as Record<string, unknown>;
    expect(parsed.custom_field).toBe("kept");
    delete parsed.prev_hash;
    expect(JSON.stringify(parsed)).toBe(line);
    expect((await verifyEventsChain(paths, HAND_SES_ID)).status).toBe("verified");
  });

  it("is idempotent: a second run skips with already_chained, bytes untouched", async () => {
    const paths = await setupPaths();
    const sessionId = await importLegacy(paths);
    await rechainSessionInPlace(paths, sessionId);
    const eventsPath = join(paths.sessions, sessionId, "events.jsonl");
    const bytes = await readFile(eventsPath);

    const second = await rechainSessionInPlace(paths, sessionId);
    expect(second).toEqual({ status: "skipped", reason: "already_chained" });
    expect((await readFile(eventsPath)).equals(bytes)).toBe(true);
  });

  it("dry-run reports the outcome without writing", async () => {
    const paths = await setupPaths();
    const sessionId = await importLegacy(paths);
    const eventsPath = join(paths.sessions, sessionId, "events.jsonl");
    const bytes = await readFile(eventsPath);

    const outcome = await rechainSessionInPlace(paths, sessionId, { dryRun: true });
    expect(outcome).toEqual({ status: "rechained", eventCount: 3 });
    expect((await readFile(eventsPath)).equals(bytes)).toBe(true);
    expect((await verifyEventsChain(paths, sessionId)).status).toBe("unchained");
  });

  it("a rechained session still re-imports in place with id reuse (B2)", async () => {
    const paths = await setupPaths();
    const sessionId = await importLegacy(paths);
    await rechainSessionInPlace(paths, sessionId);
    const eventsPath = join(paths.sessions, sessionId, "events.jsonl");
    const idsBefore = (await readFile(eventsPath, "utf8"))
      .split("\n")
      .filter((l) => l.length)
      .map((l) => (JSON.parse(l) as { id: string }).id);

    const outcome = await reimportPreservingId(
      paths,
      makeManifest(),
      sessionId,
      makePayload(GROWN_EVENTS),
    );
    expect(outcome.status).toBe("reimported");
    if (outcome.status !== "reimported") throw new Error("unreachable");
    expect(outcome.reusedIdCount).toBeGreaterThan(0);

    const idsAfter = (await readFile(eventsPath, "utf8"))
      .split("\n")
      .filter((l) => l.length)
      .map((l) => (JSON.parse(l) as { id: string }).id);
    // Every prior derived id recurs in the re-imported log.
    for (const id of idsBefore) expect(idsAfter).toContain(id);
    expect(await verifyEventsChain(paths, sessionId)).toEqual({
      status: "verified",
      eventCount: 4,
    });
  });
});

describe("rechainSessionInPlace — refusals", () => {
  it("skips a non-imported session (not_imported)", async () => {
    const paths = await setupPaths();
    await writeHandSession(paths, HAND_SES_ID, `${handLine()}\n`, { status: "completed" });
    expect(await rechainSessionInPlace(paths, HAND_SES_ID)).toEqual({
      status: "skipped",
      reason: "not_imported",
    });
  });

  it("skips a tampered chained session and leaves the bytes alone", async () => {
    const paths = await setupPaths();
    const result = await importSessionFromJson(
      paths,
      makeManifest(),
      makePayload(PRIOR_EVENTS),
      {},
    );
    const eventsPath = join(paths.sessions, result.sessionId, "events.jsonl");
    const tampered = (await readFile(eventsPath, "utf8")).replace('"hello"', '"hacked"');
    await writeFile(eventsPath, tampered);

    expect(await rechainSessionInPlace(paths, result.sessionId)).toEqual({
      status: "skipped",
      reason: "tampered",
    });
    expect(await readFile(eventsPath, "utf8")).toBe(tampered);
  });

  it("skips a chain stripped out from under an anchor (tampered)", async () => {
    const paths = await setupPaths();
    const result = await importSessionFromJson(
      paths,
      makeManifest(),
      makePayload(PRIOR_EVENTS),
      {},
    );
    const eventsPath = join(paths.sessions, result.sessionId, "events.jsonl");
    // Strip the chain but keep the yaml anchor: verify says tampered
    // (anchor_without_chain); rechain must not "repair" it.
    const unchained = (await readFile(eventsPath, "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => {
        const obj = JSON.parse(l) as Record<string, unknown>;
        delete obj.prev_hash;
        return JSON.stringify(obj);
      });
    await writeFile(eventsPath, `${unchained.join("\n")}\n`);

    expect(await rechainSessionInPlace(paths, result.sessionId)).toEqual({
      status: "skipped",
      reason: "tampered",
    });
  });

  it("skips a partially-chained log (tampered)", async () => {
    const paths = await setupPaths();
    const lineA = handLine({ id: "evt_01HXABCDEF1234567890ABCEH1" });
    const lineB = handLine({ id: "evt_01HXABCDEF1234567890ABCEH2", prev_hash: "f".repeat(64) });
    await writeHandSession(paths, HAND_SES_ID, `${lineA}\n${lineB}\n`);
    expect(await rechainSessionInPlace(paths, HAND_SES_ID)).toEqual({
      status: "skipped",
      reason: "tampered",
    });
  });

  it("skips a blank line inside the log (events_unreadable)", async () => {
    const paths = await setupPaths();
    const { eventsPath } = await writeHandSession(
      paths,
      HAND_SES_ID,
      `${handLine()}\n\n${handLine()}\n`,
    );
    const before = await readFile(eventsPath);
    expect(await rechainSessionInPlace(paths, HAND_SES_ID)).toEqual({
      status: "skipped",
      reason: "events_unreadable",
    });
    expect((await readFile(eventsPath)).equals(before)).toBe(true);
  });

  it("skips an unterminated tail (events_unreadable)", async () => {
    const paths = await setupPaths();
    await writeHandSession(paths, HAND_SES_ID, handLine()); // no trailing \n
    expect(await rechainSessionInPlace(paths, HAND_SES_ID)).toEqual({
      status: "skipped",
      reason: "events_unreadable",
    });
  });

  it("skips a malformed JSON line (events_unreadable)", async () => {
    const paths = await setupPaths();
    await writeHandSession(paths, HAND_SES_ID, `{not json\n`);
    expect(await rechainSessionInPlace(paths, HAND_SES_ID)).toEqual({
      status: "skipped",
      reason: "events_unreadable",
    });
  });

  it("skips a schema-invalid line (events_unreadable)", async () => {
    const paths = await setupPaths();
    await writeHandSession(paths, HAND_SES_ID, `${handLine({ type: "no_such_type" })}\n`);
    expect(await rechainSessionInPlace(paths, HAND_SES_ID)).toEqual({
      status: "skipped",
      reason: "events_unreadable",
    });
  });

  it("skips a line that does not round-trip byte-identically (events_unreadable)", async () => {
    const paths = await setupPaths();
    // Valid JSON, valid schema, but padded — JSON.stringify(JSON.parse(line))
    // differs, so rechaining would silently rewrite it.
    const padded = handLine().replace('{"schema_version"', '{ "schema_version"');
    await writeHandSession(paths, HAND_SES_ID, `${padded}\n`);
    expect(await rechainSessionInPlace(paths, HAND_SES_ID)).toEqual({
      status: "skipped",
      reason: "events_unreadable",
    });
  });

  it("skips a foreign session_id line (session_id_mismatch)", async () => {
    const paths = await setupPaths();
    await writeHandSession(paths, HAND_SES_ID, `${handLine({ session_id: OTHER_SES_ID })}\n`);
    expect(await rechainSessionInPlace(paths, HAND_SES_ID)).toEqual({
      status: "skipped",
      reason: "session_id_mismatch",
    });
  });

  it("skips an empty log without writing an anchor (empty)", async () => {
    const paths = await setupPaths();
    const { yamlPath } = await writeHandSession(paths, HAND_SES_ID, "");
    expect(await rechainSessionInPlace(paths, HAND_SES_ID)).toEqual({
      status: "skipped",
      reason: "empty",
    });
    const yaml = parseYaml(await readFile(yamlPath, "utf8")) as {
      session: Record<string, unknown>;
    };
    expect(yaml.session.integrity).toBeUndefined();
  });

  it("skips when session.yaml is absent (yaml_missing)", async () => {
    const paths = await setupPaths();
    await writeHandSession(paths, HAND_SES_ID, `${handLine()}\n`, { yaml: false });
    expect(await rechainSessionInPlace(paths, HAND_SES_ID)).toEqual({
      status: "skipped",
      reason: "yaml_missing",
    });
  });

  it("skips when session.yaml is unparseable (yaml_unreadable)", async () => {
    const paths = await setupPaths();
    const { yamlPath } = await writeHandSession(paths, HAND_SES_ID, `${handLine()}\n`);
    await writeFile(yamlPath, "schema_version: [unclosed\n");
    expect(await rechainSessionInPlace(paths, HAND_SES_ID)).toEqual({
      status: "skipped",
      reason: "yaml_unreadable",
    });
  });
});

describe("rechainSessionInPlace — rollback", () => {
  it("restores the prior events bytes VERBATIM when the yaml write fails", async () => {
    const paths = await setupPaths();
    const sessionId = await importLegacy(paths);
    const eventsPath = join(paths.sessions, sessionId, "events.jsonl");
    const priorBytes = await readFile(eventsPath);

    vi.mocked(overwriteYamlFile).mockRejectedValueOnce(new Error("Failed to overwrite YAML file"));
    await expect(rechainSessionInPlace(paths, sessionId)).rejects.toThrow(
      "Failed to overwrite YAML file",
    );

    expect((await readFile(eventsPath)).equals(priorBytes)).toBe(true);
    expect((await verifyEventsChain(paths, sessionId)).status).toBe("unchained");
  });
});
