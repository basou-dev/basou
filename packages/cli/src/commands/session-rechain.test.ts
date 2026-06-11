import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  basouPaths,
  createManifest,
  ensureBasouDirectory,
  importSessionFromJson,
  readYamlFile,
  type SessionImportPayload,
  verifyEventsChain,
  writeManifest,
  writeYamlFile,
} from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RechainRow, runSessionRechain } from "./session.js";

const execFileAsync = promisify(execFile);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const FIXED_DATE = new Date("2026-05-09T03:00:00.000Z");
const INPUT_SES_ID = "ses_01HXABCDEF1234567890ABCSE1" as const;
const LIVE_SES_ID = "ses_01HXABCDEF1234567890ABCV01" as const;

let tmpRepo: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-rechain-cli-test-"));
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: tmpRepo, env: ENV });
  await execFileAsync("git", ["config", "user.email", "t@e.com"], { cwd: tmpRepo, env: ENV });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: tmpRepo, env: ENV });
});

afterEach(async () => {
  if (tmpRepo !== undefined) await rm(tmpRepo, { recursive: true, force: true });
  tmpRepo = undefined;
  process.exitCode = 0;
  vi.restoreAllMocks();
});

async function setupInitedRepo(): Promise<string> {
  const repo = await realpath(tmpRepo as string);
  const paths = await ensureBasouDirectory(repo);
  await writeManifest(
    paths,
    createManifest({ workspaceName: "rechain-ws", now: FIXED_DATE, workspaceId: FIXED_WS_ID }),
  );
  return repo;
}

function makePayload(): SessionImportPayload {
  const evt = (suffix: string, type: string, occurredAt: string, body?: string) =>
    ({
      schema_version: "0.1.0",
      id: `evt_01HXABCDEF1234567890ABCE${suffix}`,
      session_id: INPUT_SES_ID,
      occurred_at: occurredAt,
      source: "codex-import",
      type,
      ...(body !== undefined ? { body } : {}),
    }) as SessionImportPayload["events"][number];
  return {
    schema_version: "0.1.0",
    session: {
      workspace_id: FIXED_WS_ID,
      source: { kind: "codex-import", version: "0.1.0", external_id: "rollout-1" },
      started_at: "2026-05-04T09:00:00+09:00",
      status: "completed",
      working_directory: "/srv/example-project",
      invocation: { command: "codex", args: [], exit_code: 0 },
      related_files: [],
    },
    events: [
      evt("V1", "session_started", "2026-05-04T09:00:00+09:00"),
      evt("V2", "note_added", "2026-05-04T09:01:00+09:00", "hello"),
      evt("V3", "session_ended", "2026-05-04T09:02:00+09:00"),
    ],
  };
}

/** Import a session, then strip it back to its pre-chaining (legacy) shape. */
async function importLegacySession(repo: string): Promise<string> {
  const paths = basouPaths(repo);
  const manifest = createManifest({
    workspaceName: "rechain-ws",
    now: FIXED_DATE,
    workspaceId: FIXED_WS_ID,
  });
  const { sessionId } = await importSessionFromJson(paths, manifest, makePayload(), {});
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
  const yaml = (await readYamlFile(yamlPath)) as { session: Record<string, unknown> };
  delete yaml.session.integrity;
  await writeYamlFile(yamlPath, yaml);
  return sessionId;
}

/** A live (non-imported) session the sweep must skip, not rechain. */
async function writeLiveSession(repo: string): Promise<void> {
  const paths = basouPaths(repo);
  const dir = join(paths.sessions, LIVE_SES_ID);
  await mkdir(dir, { recursive: true });
  await writeYamlFile(join(dir, "session.yaml"), {
    schema_version: "0.1.0",
    session: {
      id: LIVE_SES_ID,
      task_id: null,
      workspace_id: FIXED_WS_ID,
      source: { kind: "terminal", version: "0.1.0" },
      started_at: "2026-05-04T09:00:00+09:00",
      status: "completed",
      working_directory: "~/projects/example",
      invocation: { command: "bash", args: [], exit_code: 0 },
      related_files: [],
      events_log: "events.jsonl",
      summary: null,
    },
  });
  const line = JSON.stringify({
    schema_version: "0.1.0",
    id: "evt_01HXABCDEF1234567890ABCV01",
    session_id: LIVE_SES_ID,
    occurred_at: "2026-05-04T09:00:00+09:00",
    source: "terminal-recording",
    type: "session_started",
  });
  await writeFile(join(dir, "events.jsonl"), `${line}\n`);
}

function captureStdout() {
  return vi.spyOn(console, "log").mockImplementation(() => undefined);
}

function captureStderr() {
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

function joinCalls(spy: ReturnType<typeof captureStdout>): string {
  return spy.mock.calls.flat().map(String).join("\n");
}

describe("basou session rechain", () => {
  it("rechains a legacy session and skips a live one (exit 0)", async () => {
    const repo = await setupInitedRepo();
    const legacyId = await importLegacySession(repo);
    await writeLiveSession(repo);

    const out = captureStdout();
    await runSessionRechain({ all: true }, { cwd: repo });

    const text = joinCalls(out);
    expect(text).toContain(`${legacyId}  rechained (3 events)`);
    expect(text).toContain(`${LIVE_SES_ID}  skipped (not_imported)`);
    expect(text).toContain("Sessions: 2 total — 1 rechained, 1 skipped, 0 errors");
    expect(process.exitCode ?? 0).toBe(0);

    expect(await verifyEventsChain(basouPaths(repo), legacyId)).toEqual({
      status: "verified",
      eventCount: 3,
    });
  });

  it("requires an explicit selector and rejects both together", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runSessionRechain({}, { cwd: repo });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err)).toContain("Specify --session <id> or --all");

    process.exitCode = 0;
    const err2 = captureStderr();
    await runSessionRechain({ session: "abc", all: true }, { cwd: repo });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err2)).toContain("Specify either --session <id> or --all, not both");
  });

  it("targets a single session with --session and leaves the rest alone", async () => {
    const repo = await setupInitedRepo();
    const legacyId = await importLegacySession(repo);
    await writeLiveSession(repo);

    const out = captureStdout();
    await runSessionRechain({ session: legacyId }, { cwd: repo });

    const text = joinCalls(out);
    expect(text).toContain(`${legacyId}  rechained (3 events)`);
    expect(text).not.toContain(LIVE_SES_ID);
    expect(text).toContain("Sessions: 1 total");
  });

  it("dry-run previews without writing", async () => {
    const repo = await setupInitedRepo();
    const legacyId = await importLegacySession(repo);

    const out = captureStdout();
    await runSessionRechain({ all: true, dryRun: true }, { cwd: repo });

    expect(joinCalls(out)).toContain(`${legacyId}  would rechain (3 events)`);
    expect((await verifyEventsChain(basouPaths(repo), legacyId)).status).toBe("unchained");
  });

  it("emits machine-readable rows with --json", async () => {
    const repo = await setupInitedRepo();
    const legacyId = await importLegacySession(repo);
    await writeLiveSession(repo);

    const out = captureStdout();
    await runSessionRechain({ all: true, json: true }, { cwd: repo });

    const rows = JSON.parse(joinCalls(out)) as RechainRow[];
    const byId = new Map(rows.map((r) => [r.session_id, r]));
    expect(byId.get(legacyId)).toEqual({
      session_id: legacyId,
      status: "rechained",
      event_count: 3,
    });
    expect(byId.get(LIVE_SES_ID)).toEqual({
      session_id: LIVE_SES_ID,
      status: "skipped",
      reason: "not_imported",
    });
  });

  it("flags a tampered session in the exit code and keeps sweeping", async () => {
    const repo = await setupInitedRepo();
    const paths = basouPaths(repo);
    const manifest = createManifest({
      workspaceName: "rechain-ws",
      now: FIXED_DATE,
      workspaceId: FIXED_WS_ID,
    });
    const { sessionId } = await importSessionFromJson(paths, manifest, makePayload(), {});
    const eventsPath = join(paths.sessions, sessionId, "events.jsonl");
    await writeFile(
      eventsPath,
      (await readFile(eventsPath, "utf8")).replace('"hello"', '"hacked"'),
    );
    await writeLiveSession(repo);

    const out = captureStdout();
    await runSessionRechain({ all: true }, { cwd: repo });

    const text = joinCalls(out);
    expect(text).toContain("skipped (TAMPERED — inspect with 'basou verify')");
    expect(text).toContain(`${LIVE_SES_ID}  skipped (not_imported)`);
    expect(process.exitCode).toBe(1);
  });

  it("turns a per-session I/O failure into an error row and keeps sweeping", async () => {
    const repo = await setupInitedRepo();
    const legacyId = await importLegacySession(repo);
    // A session whose events.jsonl is a DIRECTORY: reads fail with a
    // non-ENOENT error, which must become an error row, not abort the sweep.
    const paths = basouPaths(repo);
    const brokenId = "ses_01HXABCDEF1234567890ABCBRK";
    const brokenDir = join(paths.sessions, brokenId);
    await mkdir(join(brokenDir, "events.jsonl"), { recursive: true });
    await writeYamlFile(join(brokenDir, "session.yaml"), {
      schema_version: "0.1.0",
      session: {
        id: brokenId,
        task_id: null,
        workspace_id: FIXED_WS_ID,
        source: { kind: "codex-import", version: "0.1.0" },
        started_at: "2026-05-04T09:00:00+09:00",
        status: "imported",
        working_directory: "~/projects/example",
        invocation: { command: "codex", args: [], exit_code: 0 },
        related_files: [],
        events_log: "events.jsonl",
        summary: null,
      },
    });

    const out = captureStdout();
    await runSessionRechain({ all: true }, { cwd: repo });

    const text = joinCalls(out);
    expect(text).toContain(`${brokenId}  error (Failed to read events.jsonl)`);
    expect(text).toContain(`${legacyId}  rechained (3 events)`);
    expect(text).toContain("1 errors");
    expect(process.exitCode).toBe(1);
  });

  it("requires an initialized workspace", async () => {
    const repo = await realpath(tmpRepo as string);
    const err = captureStderr();
    await runSessionRechain({ all: true }, { cwd: repo });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err)).toContain("Workspace not initialized");
  });
});
