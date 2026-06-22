import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
let claudeRoot: string | undefined;
let codexRoot: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-orient-cli-test-"));
  // Empty native-log roots keep the freshness probe hermetic (no real ~/.claude).
  claudeRoot = await mkdtemp(join(tmpdir(), "basou-orient-claude-"));
  codexRoot = await mkdtemp(join(tmpdir(), "basou-orient-codex-"));
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: tmpRepo, env: ENV });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: tmpRepo,
    env: ENV,
  });
  await execFileAsync("git", ["config", "user.name", "test"], { cwd: tmpRepo, env: ENV });
});

afterEach(async () => {
  for (const dir of [tmpRepo, claudeRoot, codexRoot]) {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
  tmpRepo = undefined;
  claudeRoot = undefined;
  codexRoot = undefined;
  process.exitCode = 0;
  vi.restoreAllMocks();
});

function getTmpRepo(): string {
  if (tmpRepo === undefined) throw new Error("tmpRepo not initialized");
  return tmpRepo;
}

function getClaudeRoot(): string {
  if (claudeRoot === undefined) throw new Error("claudeRoot not initialized");
  return claudeRoot;
}
function getCodexRoot(): string {
  if (codexRoot === undefined) throw new Error("codexRoot not initialized");
  return codexRoot;
}

/** Orient context with the native-log roots wired to empty fixtures. */
function ctxFor(repo: string) {
  return {
    cwd: repo,
    claudeProjectsDir: getClaudeRoot(),
    codexSessionsDir: getCodexRoot(),
    nowProvider: () => FIXED_DATE,
  };
}

/** A Codex rollout whose session cwd is `cwd` — an uncaptured session the probe should see. */
async function writeCodexRolloutAt(cwd: string, id: string): Promise<void> {
  const dir = join(getCodexRoot(), "2026", "05", "10");
  await mkdir(dir, { recursive: true });
  const records = [
    {
      type: "session_meta",
      timestamp: "2026-05-10T00:00:00.000Z",
      payload: { id, cwd, timestamp: "2026-05-10T00:00:00.000Z" },
    },
    {
      type: "response_item",
      timestamp: "2026-05-10T00:00:01.000Z",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "ls", workdir: cwd }),
        call_id: "c1",
      },
    },
    {
      type: "response_item",
      timestamp: "2026-05-10T00:00:02.000Z",
      payload: {
        type: "function_call_output",
        call_id: "c1",
        output: "Wall time: 0.1000 seconds\nProcess exited with code 0\n",
      },
    },
  ];
  await writeFile(
    join(dir, `rollout-${id}.jsonl`),
    records.map((r) => JSON.stringify(r)).join("\n"),
  );
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
    await doRunOrient({}, ctxFor(repo));
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
    await doRunOrient({ quiet: true }, ctxFor(repo));
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
    await doRunOrient({}, ctxFor(repo));
    expect(joinCalls(out)).toContain("[high] command: deploy to production");
  });

  it("overwrites the whole file on re-run (no marker preservation)", async () => {
    const repo = await setupInitedRepo();
    const orientationPath = basouPaths(repo).files.orientation;
    // A pre-existing file with arbitrary content + markers is fully replaced.
    await writeFile(orientationPath, `${GENERATED_START}\nstale\nmanual note\n`);
    captureStdout();
    await doRunOrient({}, ctxFor(repo));
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

  it("これは最新か: a clean capture (no uncaptured native logs) prints the ✅ current verdict", async () => {
    const repo = await setupInitedRepo();
    await placeSession(repo, { id: SES("S01"), source: "claude-code-import" });
    const out = captureStdout();
    await doRunOrient({}, ctxFor(repo));
    expect(joinCalls(out)).toContain("✅ 取り込みは最新です。");
  });

  it("これは最新か: an uncaptured native session flips the verdict to ⚠️ stale → run refresh", async () => {
    const repo = await setupInitedRepo();
    // A Codex rollout for this repo exists in the native logs but was never imported.
    await writeCodexRolloutAt(repo, "codex-uncaptured");
    const out = captureStdout();
    await doRunOrient({}, ctxFor(repo));
    const stdout = joinCalls(out);
    expect(stdout).toContain("⚠️ 古いかもしれません。");
    expect(stdout).toContain("`basou refresh`");
  });

  it("--verbose appends raw freshness telemetry; the default view omits it", async () => {
    const repo = await setupInitedRepo();
    await placeSession(repo, { id: SES("S01"), source: "claude-code-import" });

    const plainOut = captureStdout();
    await doRunOrient({}, ctxFor(repo));
    expect(joinCalls(plainOut)).not.toContain("staleness probe:");
    plainOut.mockRestore();

    const verboseOut = captureStdout();
    await doRunOrient({ verbose: true }, ctxFor(repo));
    expect(joinCalls(verboseOut)).toContain("staleness probe:");
  });

  it("workspace view: resolves to the linked planning repo and notes the redirect", async () => {
    const repo = await setupInitedRepo();
    await placeSession(repo, { id: SES("S01"), source: "claude-code-import" });
    // A git-untracked "view" dir that holds the repo only via a symlink.
    const view = await realpath(await mkdtemp(join(tmpdir(), "basou-orient-view-")));
    await symlink(repo, join(view, "fixture-planning"));
    try {
      const out = captureStdout();
      const err = captureStderr();
      await doRunOrient({}, { ...ctxFor(repo), cwd: view });
      expect(joinCalls(out)).toContain("# Orientation");
      expect(joinCalls(err)).toContain("Resolved workspace view to");
      expect(joinCalls(err)).toContain("via fixture-planning");
      // The orientation was written into the linked repo's .basou, not the view.
      const body = await readFile(basouPaths(repo).files.orientation, "utf8");
      expect(body).toContain("# Orientation");
    } finally {
      await rm(view, { recursive: true, force: true });
    }
  });

  it("register: wiring exposes 'orient' on the program", () => {
    const program = new Command();
    registerOrientCommand(program);
    const orient = program.commands.find((c) => c.name() === "orient");
    expect(orient).toBeDefined();
  });
});
