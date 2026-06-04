import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  basouPaths,
  createManifest,
  ensureBasouDirectory,
  writeManifest,
  writeYamlFile,
} from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doRunStats, runStats } from "./stats.js";

const execFileAsync = promisify(execFile);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const FIXED_DATE = new Date("2026-05-09T03:00:00.000Z");
const NOW = new Date("2026-05-10T12:00:00.000Z");

let tmpRepo: string | undefined;
let evtCounter = 0;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-stats-test-"));
  evtCounter = 0;
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
    createManifest({ workspaceName: "stats-ws", now: FIXED_DATE, workspaceId: FIXED_WS_ID }),
  );
  return repo;
}

function evtId(): string {
  return `evt_01HXABCDEF1234567890ABC${String(evtCounter++).padStart(3, "0")}`;
}

async function placeSession(
  repo: string,
  opts: {
    id: string;
    source: string;
    startedAt?: string;
    endedAt?: string;
    metrics?: Record<string, unknown>;
    commands?: Array<{ at: string; durationMs: number }>;
  },
): Promise<void> {
  const dir = join(basouPaths(repo).sessions, opts.id);
  await mkdir(dir, { recursive: true });
  await writeYamlFile(join(dir, "session.yaml"), {
    schema_version: "0.1.0",
    session: {
      id: opts.id,
      workspace_id: FIXED_WS_ID,
      source: { kind: opts.source, version: "0.1.0" },
      started_at: opts.startedAt ?? "2026-05-10T00:00:00.000Z",
      ...(opts.endedAt !== undefined ? { ended_at: opts.endedAt } : {}),
      status: "imported",
      working_directory: "/tmp/fixture",
      invocation: {
        command: opts.source === "codex-import" ? "codex" : "claude",
        args: [],
        exit_code: null,
      },
      related_files: [],
      events_log: "events.jsonl",
      ...(opts.metrics !== undefined ? { metrics: opts.metrics } : {}),
    },
  });
  const lines = (opts.commands ?? []).map((c) =>
    JSON.stringify({
      schema_version: "0.1.0",
      id: evtId(),
      session_id: opts.id,
      occurred_at: c.at,
      source: opts.source,
      type: "command_executed",
      command: "bash",
      args: ["-c", "ls"],
      cwd: "/tmp/fixture",
      exit_code: 0,
      duration_ms: c.durationMs,
    }),
  );
  await writeFile(join(dir, "events.jsonl"), lines.length > 0 ? `${lines.join("\n")}\n` : "");
}

function captureStdout(): string[] {
  const calls: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    calls.push(args.map((a) => String(a)).join(" "));
  });
  return calls;
}

const ctx = (repo: string) => ({ cwd: repo, nowProvider: () => NOW });

describe("basou stats", () => {
  it("reports zero sessions on an empty workspace", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunStats({}, ctx(repo));
    expect(out.join("\n")).toContain("Sessions: 0");
  });

  it("reports volume and time for a codex session", async () => {
    const repo = await setupInitedRepo();
    await placeSession(repo, {
      id: "ses_01HXABCDEF1234567890ABCDE1",
      source: "codex-import",
      endedAt: "2026-05-10T00:10:00.000Z",
      metrics: { output_tokens: 5000, reasoning_output_tokens: 800 },
      commands: [{ at: "2026-05-10T00:00:30.000Z", durationMs: 1500 }],
    });
    const out = captureStdout();
    await doRunStats({}, ctx(repo));
    const text = out.join("\n");
    expect(text).toContain("Sessions: 1");
    expect(text).toContain("Output tokens:     5,000");
    expect(text).toContain("Reasoning tokens:");
    expect(text).toContain("Billable active:");
    expect(text).toContain("Command:");
    // No machine_active_time_ms on this session, so no model-working line.
    expect(text).not.toContain("Model working:");
  });

  it("prints a model-working line when machine compute was captured", async () => {
    const repo = await setupInitedRepo();
    await placeSession(repo, {
      id: "ses_01HXABCDEF1234567890ABCDE1",
      source: "codex-import",
      endedAt: "2026-05-10T00:30:00.000Z",
      metrics: {
        active_time_ms: 30 * 60 * 1000,
        active_intervals: [{ start: "2026-05-10T00:00:00.000Z", end: "2026-05-10T00:30:00.000Z" }],
        active_time_method: "turn-intervals",
        machine_active_time_ms: 12 * 60 * 1000,
      },
    });
    const out = captureStdout();
    await doRunStats({}, ctx(repo));
    const text = out.join("\n");
    expect(text).toContain("Model working:");
    expect(text).toContain("12m");
    expect(text).toContain("1 of 1 sessions");
  });

  it("caveats command time when a claude-code-import session is present", async () => {
    const repo = await setupInitedRepo();
    await placeSession(repo, {
      id: "ses_01HXABCDEF1234567890ABCDE2",
      source: "claude-code-import",
      endedAt: "2026-05-10T00:05:00.000Z",
      metrics: { output_tokens: 800000 },
      commands: [{ at: "2026-05-10T00:01:00.000Z", durationMs: 0 }],
    });
    const out = captureStdout();
    await doRunStats({}, ctx(repo));
    expect(out.join("\n")).toContain("report 0 shell time");
  });

  it("--json emits a structured result", async () => {
    const repo = await setupInitedRepo();
    await placeSession(repo, {
      id: "ses_01HXABCDEF1234567890ABCDE3",
      source: "codex-import",
      endedAt: "2026-05-10T00:05:00.000Z",
      commands: [{ at: "2026-05-10T00:00:30.000Z", durationMs: 2000 }],
    });
    const out = captureStdout();
    await doRunStats({ json: true }, ctx(repo));
    const parsed = JSON.parse(out.join("\n")) as {
      totals: { sessionCount: number; billableActiveTimeMs: number };
      sessions: unknown[];
      bySource: unknown[];
      byStatus: unknown[];
      byDay: unknown[];
      generatedAt: string;
      timeZone: string;
    };
    expect(parsed.totals.sessionCount).toBe(1);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.bySource).toHaveLength(1);
    expect(Array.isArray(parsed.byDay)).toBe(true);
    expect(typeof parsed.totals.billableActiveTimeMs).toBe("number");
    expect(parsed.generatedAt).toBe(NOW.toISOString());
  });

  it("--by-source prints a per-source breakdown", async () => {
    const repo = await setupInitedRepo();
    await placeSession(repo, {
      id: "ses_01HXABCDEF1234567890ABCDE4",
      source: "codex-import",
      endedAt: "2026-05-10T00:05:00.000Z",
      commands: [{ at: "2026-05-10T00:00:30.000Z", durationMs: 1000 }],
    });
    const out = captureStdout();
    await doRunStats({ bySource: true }, ctx(repo));
    const text = out.join("\n");
    expect(text).toContain("By source:");
    expect(text).toContain("codex-import:");
  });

  it("--by-day prints a per-day billing breakdown", async () => {
    const repo = await setupInitedRepo();
    await placeSession(repo, {
      id: "ses_01HXABCDEF1234567890ABCDE5",
      source: "codex-import",
      endedAt: "2026-05-10T00:30:00.000Z",
      metrics: {
        output_tokens: 1000,
        active_intervals: [{ start: "2026-05-10T00:00:00.000Z", end: "2026-05-10T00:30:00.000Z" }],
        active_gap_cap_ms: 300000,
        active_time_method: "engaged-turns",
      },
      commands: [{ at: "2026-05-10T00:00:30.000Z", durationMs: 1000 }],
    });
    const out = captureStdout();
    await doRunStats({ byDay: true }, ctx(repo));
    const text = out.join("\n");
    expect(text).toContain("By day");
    // tz-agnostic: the interval lands on 2026-05-09 or -10 depending on host tz.
    expect(text).toMatch(/2026-05-\d{2}: /);
  });

  it("--by-day shows model compute on a day with machine time", async () => {
    const repo = await setupInitedRepo();
    await placeSession(repo, {
      id: "ses_01HXABCDEF1234567890ABCDE6",
      source: "codex-import",
      endedAt: "2026-05-10T00:30:00.000Z",
      metrics: {
        active_intervals: [{ start: "2026-05-10T00:00:00.000Z", end: "2026-05-10T00:30:00.000Z" }],
        active_time_method: "turn-intervals",
        machine_active_time_ms: 12 * 60 * 1000,
      },
    });
    const out = captureStdout();
    await doRunStats({ byDay: true }, ctx(repo));
    const text = out.join("\n");
    expect(text).toMatch(/active \(model 12m/);
  });

  it("shows a summed line only when concurrent sessions overlap", async () => {
    const repo = await setupInitedRepo();
    await placeSession(repo, {
      id: "ses_01HXABCDEF1234567890ABCDE6",
      source: "codex-import",
      endedAt: "2026-05-10T00:30:00.000Z",
      metrics: {
        active_intervals: [{ start: "2026-05-10T00:00:00.000Z", end: "2026-05-10T00:30:00.000Z" }],
      },
    });
    await placeSession(repo, {
      id: "ses_01HXABCDEF1234567890ABCDE7",
      source: "codex-import",
      endedAt: "2026-05-10T00:45:00.000Z",
      metrics: {
        active_intervals: [{ start: "2026-05-10T00:15:00.000Z", end: "2026-05-10T00:45:00.000Z" }],
      },
    });
    const out = captureStdout();
    await doRunStats({}, ctx(repo));
    const text = out.join("\n");
    expect(text).toContain("Billable active:");
    expect(text).toContain("Summed:");
  });

  it("exits 1 on an uninitialized workspace", async () => {
    const repo = await realpath(tmpRepo as string);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runStats({}, ctx(repo));
    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.flat().join(" ")).toContain("Workspace not initialized");
  });
});
