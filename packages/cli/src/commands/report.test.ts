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
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerReportCommand, runReportGenerate } from "./report.js";

const execFileAsync = promisify(execFile);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const FIXED_DATE = new Date("2026-05-09T03:00:00.000Z");
const INPUT_SES_ID = "ses_01HXABCDEF1234567890ABCSE1" as const;
const LIVE_SES_ID = "ses_01HXABCDEF1234567890ABCV01" as const;

let tmpRepo: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-report-cli-test-"));
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
    createManifest({ workspaceName: "report-ws", now: FIXED_DATE, workspaceId: FIXED_WS_ID }),
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
      related_files: ["src/touched.ts"],
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
    workspaceName: "report-ws",
    now: FIXED_DATE,
    workspaceId: FIXED_WS_ID,
  });
  const result = await importSessionFromJson(paths, manifest, makePayload(), {});
  return result.sessionId;
}

/** An unchained (anchor-less) session — verifies as `unchained`, not tampered. */
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

describe("basou report generate", () => {
  it("register: wiring exposes 'report' and 'report generate' on the program", () => {
    const program = new Command();
    registerReportCommand(program);
    const report = program.commands.find((c) => c.name() === "report");
    expect(report).toBeDefined();
    expect(report?.commands.find((c) => c.name() === "generate")).toBeDefined();
  });

  it("prints the markdown report to stdout by default (exit 0)", async () => {
    const repo = await setupInitedRepo();
    await importChainedSession(repo);
    await writeLiveSession(repo);

    const out = captureStdout();
    await runReportGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });

    const text = joinCalls(out);
    expect(text).toContain("# Report");
    expect(text).toContain("## Integrity");
    expect(text).toContain("1 verified, 1 unchained");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("emits curated, pipe-safe JSON with --json (no 'billable', exit 0)", async () => {
    const repo = await setupInitedRepo();
    await importChainedSession(repo);

    const out = captureStdout();
    await runReportGenerate({ json: true }, { cwd: repo, nowProvider: () => FIXED_DATE });

    const raw = joinCalls(out);
    expect(raw).not.toMatch(/billable/i);
    const data = JSON.parse(raw) as {
      sessions: { total: number };
      time: { activeMs: number };
      integrity: { total: number; verified: number };
    };
    expect(data.sessions.total).toBe(1);
    expect(data.integrity.verified).toBe(1);
    expect(typeof data.time.activeMs).toBe("number");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("writes the markdown to --out, confirms on stderr, keeps stdout empty", async () => {
    const repo = await setupInitedRepo();
    await importChainedSession(repo);

    const out = captureStdout();
    const err = captureStderr();
    await runReportGenerate({ out: "report.md" }, { cwd: repo, nowProvider: () => FIXED_DATE });

    expect(out.mock.calls).toHaveLength(0); // stdout untouched
    expect(joinCalls(err)).toContain("Wrote report to report.md");
    const written = await readFile(join(repo, "report.md"), "utf8");
    expect(written).toContain("# Report");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("keeps stdout pure JSON when --out and --json are combined", async () => {
    const repo = await setupInitedRepo();
    await importChainedSession(repo);

    const out = captureStdout();
    captureStderr();
    await runReportGenerate(
      { out: "report.md", json: true },
      { cwd: repo, nowProvider: () => FIXED_DATE },
    );

    expect(() => JSON.parse(joinCalls(out))).not.toThrow();
    const written = await readFile(join(repo, "report.md"), "utf8");
    expect(written).toContain("# Report");
  });

  it("surfaces a tampered session but still exits 0 (a report is not a gate)", async () => {
    const repo = await setupInitedRepo();
    const importedId = await importChainedSession(repo);
    const eventsPath = join(basouPaths(repo).sessions, importedId, "events.jsonl");
    const tampered = (await readFile(eventsPath, "utf8")).replace('"hello"', '"hacked"');
    await writeFile(eventsPath, tampered);

    const out = captureStdout();
    await runReportGenerate({ json: true }, { cwd: repo, nowProvider: () => FIXED_DATE });

    const data = JSON.parse(joinCalls(out)) as { integrity: { tampered: number } };
    expect(data.integrity.tampered).toBe(1);
    // The decisive contract: rendering succeeded, so exit code is 0 even though
    // an integrity break was surfaced (unlike `basou verify`, which exits 1).
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("shows the --title in the report header", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await runReportGenerate(
      { title: "Client X — May" },
      { cwd: repo, nowProvider: () => FIXED_DATE },
    );
    expect(joinCalls(out)).toContain("# Report — Client X — May");
  });

  it("exits 1 with a pathless message when the workspace is not initialized", async () => {
    const repo = await realpath(tmpRepo as string); // git repo, but no `basou init`
    const err = captureStderr();
    await runReportGenerate({}, { cwd: repo });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err)).toContain("Workspace not initialized");
  });
});
