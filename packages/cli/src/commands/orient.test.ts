import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  basouPaths,
  createManifest,
  ensureBasouDirectory,
  GENERATED_START,
  writeManifest,
  writeYamlFile,
} from "@basou/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doRunOrient, registerOrientCommand, runOrient } from "./orient.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
};

const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const FIXED_DATE = new Date("2026-05-09T03:00:00.000Z");

const SES = (suffix: string) => `ses_01HXABCDEF1234567890ABC${suffix}`;
const APPR = (suffix: string) => `appr_01HXABCDEF1234567890ABC${suffix}`;

let tmpRepo: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-orient-cli-test-"));
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: tmpRepo, env: ENV });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: tmpRepo,
    env: ENV,
  });
  await execFileAsync("git", ["config", "user.name", "test"], { cwd: tmpRepo, env: ENV });
});

afterEach(async () => {
  if (tmpRepo !== undefined) {
    await rm(tmpRepo, { recursive: true, force: true });
    tmpRepo = undefined;
  }
  process.exitCode = 0;
  vi.restoreAllMocks();
});

function getTmpRepo(): string {
  if (tmpRepo === undefined) throw new Error("tmpRepo not initialized");
  return tmpRepo;
}

async function setupInitedRepo(): Promise<string> {
  const repo = await realpath(getTmpRepo());
  const paths = await ensureBasouDirectory(repo);
  const manifest = createManifest({
    workspaceName: "fixture-ws",
    now: FIXED_DATE,
    workspaceId: FIXED_WS_ID,
  });
  await writeManifest(paths, manifest);
  return repo;
}

async function placeSession(
  repo: string,
  fixture: { id: string; status?: string; source?: string },
): Promise<void> {
  const paths = basouPaths(repo);
  const sessionDir = join(paths.sessions, fixture.id);
  await mkdir(sessionDir, { recursive: true });
  await writeYamlFile(join(sessionDir, "session.yaml"), {
    schema_version: "0.1.0",
    session: {
      id: fixture.id,
      label: `fixture ${fixture.id.slice(-3)}`,
      task_id: null,
      workspace_id: FIXED_WS_ID,
      source: { kind: fixture.source ?? "terminal", version: "0.1.0" },
      started_at: "2026-05-08T11:00:00+09:00",
      status: fixture.status ?? "completed",
      working_directory: "/tmp/fixture",
      invocation: { command: "echo", args: [], exit_code: 0 },
      related_files: [],
      events_log: "events.jsonl",
    },
  });
}

async function placePendingApproval(
  repo: string,
  approvalId: string,
  sessionId: string,
): Promise<void> {
  const paths = basouPaths(repo);
  await writeYamlFile(join(paths.approvals.pending, `${approvalId}.yaml`), {
    schema_version: "0.1.0",
    id: approvalId,
    session_id: sessionId,
    created_at: "2026-05-08T11:00:00+09:00",
    status: "pending",
    risk_level: "high",
    action: { kind: "command", command: "deploy.sh" },
    reason: "deploy to production",
    expires_at: null,
  });
}

function captureStdout(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, "log").mockImplementation(() => undefined);
}

function captureStderr(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

function joinCalls(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
}

describe("basou orient", () => {
  it("prints the orientation body to stdout and writes .basou/orientation.md by default", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunOrient({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    const stdout = joinCalls(out);
    expect(stdout).toContain("# Orientation");
    expect(stdout).toContain("## 今どこにいる");
    expect(stdout).toContain("## これは最新か");

    const body = await readFile(basouPaths(repo).files.orientation, "utf8");
    expect(body).toContain("# Orientation");
    // Transient snapshot: written WITHOUT BASOU:GENERATED markers (unlike handoff).
    expect(body).not.toContain(GENERATED_START);
  });

  it("--quiet writes the file and prints only a one-line summary", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunOrient({ quiet: true }, { cwd: repo, nowProvider: () => FIXED_DATE });
    const stdout = joinCalls(out);
    expect(stdout).toContain("Generated .basou/orientation.md");
    expect(stdout).not.toContain("## 今どこにいる");
    const body = await readFile(basouPaths(repo).files.orientation, "utf8");
    expect(body).toContain("# Orientation");
  });

  it("renders the pending-approval list (risk / action / reason)", async () => {
    const repo = await setupInitedRepo();
    await placeSession(repo, { id: SES("S01") });
    await placePendingApproval(repo, APPR("A01"), SES("S01"));
    const out = captureStdout();
    await doRunOrient({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    expect(joinCalls(out)).toContain("[high] command: deploy to production");
  });

  it("overwrites the whole file on re-run (no marker preservation)", async () => {
    const repo = await setupInitedRepo();
    const orientationPath = basouPaths(repo).files.orientation;
    // A pre-existing file with arbitrary content + markers is fully replaced.
    await writeFile(orientationPath, `${GENERATED_START}\nstale\nmanual note\n`);
    captureStdout();
    await doRunOrient({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    const body = await readFile(orientationPath, "utf8");
    expect(body).not.toContain("manual note");
    expect(body).not.toContain(GENERATED_START);
    expect(body).toContain("# Orientation");
  });

  it("not-a-workspace exits 1 with the standard helper message", async () => {
    const tmp = getTmpRepo(); // git-init'd but not basou-init'd
    captureStdout();
    const err = captureStderr();
    await runOrient({}, { cwd: tmp, nowProvider: () => FIXED_DATE });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err)).toContain("Workspace not initialized. Run 'basou init' first.");
  });

  it("register: wiring exposes 'orient' on the program", () => {
    const program = new Command();
    registerOrientCommand(program);
    const orient = program.commands.find((c) => c.name() === "orient");
    expect(orient).toBeDefined();
  });
});
