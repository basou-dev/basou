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
  type SessionImportPayload,
  writeManifest,
  writeYamlFile,
} from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runVerify, type VerifyRow } from "./verify.js";

const execFileAsync = promisify(execFile);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const FIXED_DATE = new Date("2026-05-09T03:00:00.000Z");
const INPUT_SES_ID = "ses_01HXABCDEF1234567890ABCSE1" as const;
const LIVE_SES_ID = "ses_01HXABCDEF1234567890ABCLV1" as const;

let tmpRepo: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-verify-cli-test-"));
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
    createManifest({ workspaceName: "verify-ws", now: FIXED_DATE, workspaceId: FIXED_WS_ID }),
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

async function importChainedSession(repo: string): Promise<string> {
  const paths = basouPaths(repo);
  const manifest = createManifest({
    workspaceName: "verify-ws",
    now: FIXED_DATE,
    workspaceId: FIXED_WS_ID,
  });
  const result = await importSessionFromJson(paths, manifest, makePayload(), {});
  return result.sessionId;
}

/** A live-style (unchained, anchor-less) session the verifier must not flag. */
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
    id: "evt_01HXABCDEF1234567890ABCLV1",
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

describe("basou verify", () => {
  it("verifies an imported session and reports a live one unchained (exit 0)", async () => {
    const repo = await setupInitedRepo();
    const importedId = await importChainedSession(repo);
    await writeLiveSession(repo);

    const out = captureStdout();
    await runVerify({}, { cwd: repo });

    const text = joinCalls(out);
    expect(text).toContain(`${importedId}  verified (3 events)`);
    expect(text).toContain(`${LIVE_SES_ID}  unchained`);
    expect(text).toContain(
      "Sessions: 2 total — 1 verified, 1 unchained, 0 empty, 0 incomplete, 0 tampered",
    );
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("flags a tampered imported session and exits non-zero", async () => {
    const repo = await setupInitedRepo();
    const importedId = await importChainedSession(repo);
    const eventsPath = join(basouPaths(repo).sessions, importedId, "events.jsonl");
    const tampered = (await readFile(eventsPath, "utf8")).replace('"hello"', '"hacked"');
    await writeFile(eventsPath, tampered);

    const out = captureStdout();
    await runVerify({}, { cwd: repo });

    expect(joinCalls(out)).toContain("TAMPERED (broken_link at line 3)");
    expect(process.exitCode).toBe(1);
  });

  it("emits machine-readable rows with --json", async () => {
    const repo = await setupInitedRepo();
    const importedId = await importChainedSession(repo);
    await writeLiveSession(repo);

    const out = captureStdout();
    await runVerify({ json: true }, { cwd: repo });

    const rows = JSON.parse(joinCalls(out)) as VerifyRow[];
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.session_id, r]));
    expect(byId.get(importedId)).toEqual({
      session_id: importedId,
      status: "verified",
      event_count: 3,
    });
    expect(byId.get(LIVE_SES_ID)?.status).toBe("unchained");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("verifies a single session with --session (prefix resolution)", async () => {
    const repo = await setupInitedRepo();
    const importedId = await importChainedSession(repo);
    await writeLiveSession(repo);

    const out = captureStdout();
    await runVerify({ session: importedId }, { cwd: repo });

    const text = joinCalls(out);
    expect(text).toContain(`${importedId}  verified (3 events)`);
    expect(text).not.toContain(LIVE_SES_ID);
    expect(text).toContain("Sessions: 1 total");
  });

  it("rejects --session combined with --all", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runVerify({ session: "abc", all: true }, { cwd: repo });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err)).toContain("Specify either --session <id> or --all, not both");
  });

  it("requires an initialized workspace", async () => {
    const repo = await realpath(tmpRepo as string);
    const err = captureStderr();
    await runVerify({}, { cwd: repo });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err)).toContain("Workspace not initialized");
  });

  it("reports an empty workspace as zero sessions (exit 0)", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await runVerify({}, { cwd: repo });
    expect(joinCalls(out)).toContain("Sessions: 0 total");
    expect(process.exitCode ?? 0).toBe(0);
  });
});
