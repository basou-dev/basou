import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  basouPaths,
  createManifest,
  ensureBasouDirectory,
  readYamlFile,
  SessionSchema,
  writeManifest,
  writeYamlFile,
} from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doRunImportClaudeCode, doRunImportCodex } from "./import.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
};

const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const FIXED_DATE = new Date("2026-05-09T03:00:00.000Z");

let tmpRepo: string | undefined;
let projectsRoot: string | undefined;
let codexRoot: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-import-cli-test-"));
  projectsRoot = await mkdtemp(join(tmpdir(), "basou-import-projects-"));
  codexRoot = await mkdtemp(join(tmpdir(), "basou-import-codex-"));
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: tmpRepo, env: ENV });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: tmpRepo,
    env: ENV,
  });
  await execFileAsync("git", ["config", "user.name", "test"], { cwd: tmpRepo, env: ENV });
});

afterEach(async () => {
  for (const dir of [tmpRepo, projectsRoot, codexRoot]) {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
  tmpRepo = undefined;
  projectsRoot = undefined;
  codexRoot = undefined;
  process.exitCode = 0;
  vi.restoreAllMocks();
});

function getProjectsRoot(): string {
  if (projectsRoot === undefined) throw new Error("projectsRoot not initialized");
  return projectsRoot;
}

function getCodexRoot(): string {
  if (codexRoot === undefined) throw new Error("codexRoot not initialized");
  return codexRoot;
}

async function setupInitedRepo(): Promise<string> {
  const repo = await realpath(tmpRepo as string);
  const paths = await ensureBasouDirectory(repo);
  const manifest = createManifest({
    workspaceName: "fixture-ws",
    now: FIXED_DATE,
    workspaceId: FIXED_WS_ID,
  });
  await writeManifest(paths, manifest);
  return repo;
}

/** Write a synthetic Claude transcript into the encoded per-project dir. */
async function writeTranscript(
  repo: string,
  sessionId: string,
  records: Array<Record<string, unknown>>,
): Promise<void> {
  const encoded = repo.replaceAll("/", "-");
  const dir = join(getProjectsRoot(), encoded);
  await mkdir(dir, { recursive: true });
  const body = records.map((r) => JSON.stringify(r)).join("\n");
  await writeFile(join(dir, `${sessionId}.jsonl`), body);
}

function actionTranscript(repo: string): Array<Record<string, unknown>> {
  return [
    {
      type: "user",
      timestamp: "2026-05-10T00:00:00.000Z",
      cwd: repo,
      sessionId: "sess-1",
      message: { role: "user", content: [{ type: "text", text: "go" }] },
    },
    {
      type: "assistant",
      timestamp: "2026-05-10T00:00:01.000Z",
      cwd: repo,
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }],
      },
    },
    {
      type: "assistant",
      timestamp: "2026-05-10T00:00:02.000Z",
      cwd: repo,
      message: {
        content: [{ type: "tool_use", name: "Edit", input: { file_path: `${repo}/a.ts` } }],
      },
    },
  ];
}

async function listSessionDirs(repo: string): Promise<string[]> {
  const paths = basouPaths(repo);
  try {
    return await readdir(paths.sessions);
  } catch {
    return [];
  }
}

describe("basou import claude-code", () => {
  it("--all imports a transcript with actions into a new session", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, "sess-1", actionTranscript(repo));

    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });

    const dirs = await listSessionDirs(repo);
    expect(dirs).toHaveLength(1);

    const sessionDir = join(basouPaths(repo).sessions, dirs[0] as string);
    const session = SessionSchema.parse(await readYamlFile(join(sessionDir, "session.yaml")));
    expect(session.session.source.kind).toBe("claude-code-import");
    expect(session.session.status).toBe("imported");

    const eventsBody = await readFile(join(sessionDir, "events.jsonl"), "utf8");
    const types = eventsBody
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toContain("command_executed");
    expect(types).toContain("file_changed");
    expect(types[0]).toBe("session_started");
    expect(types[types.length - 1]).toBe("session_ended");
  });

  it("is idempotent: re-import skips an already-imported session", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, "sess-1", actionTranscript(repo));

    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });
    expect(await listSessionDirs(repo)).toHaveLength(1);

    // A second run over the same transcript must not create a duplicate.
    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });
    expect(await listSessionDirs(repo)).toHaveLength(1);
  });

  it("dedups a pre-external_id import via its label (migration safety)", async () => {
    const repo = await setupInitedRepo();
    // Simulate a session imported before source.external_id existed: it carries
    // only the `claude-code import <id>` label. The dedup must still recognize it.
    const sid = "ses_01HXABCDEF1234567890ABCDEF";
    const dir = join(basouPaths(repo).sessions, sid);
    await mkdir(dir, { recursive: true });
    await writeYamlFile(join(dir, "session.yaml"), {
      schema_version: "0.1.0",
      session: {
        id: sid,
        workspace_id: FIXED_WS_ID,
        source: { kind: "claude-code-import", version: "0.1.0" },
        started_at: "2026-05-10T00:00:00.000Z",
        status: "imported",
        working_directory: ".",
        invocation: { command: "claude", args: [], exit_code: null },
        related_files: [],
        events_log: "events.jsonl",
        label: "claude-code import sess-1",
      },
    });
    await writeTranscript(repo, "sess-1", actionTranscript(repo));

    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });
    // sess-1 is recognized via the label and not imported again.
    expect(await listSessionDirs(repo)).toHaveLength(1);
  });

  it("--session imports a single transcript by id", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, "sess-1", actionTranscript(repo));

    await doRunImportClaudeCode(
      { session: "sess-1" },
      { cwd: repo, claudeProjectsDir: getProjectsRoot() },
    );

    expect(await listSessionDirs(repo)).toHaveLength(1);
  });

  it("--dry-run writes nothing to disk", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, "sess-1", actionTranscript(repo));

    await doRunImportClaudeCode(
      { all: true, dryRun: true },
      { cwd: repo, claudeProjectsDir: getProjectsRoot() },
    );

    expect(await listSessionDirs(repo)).toHaveLength(0);
  });

  it("skips transcripts with no observable action", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, "sess-empty", [
      {
        type: "user",
        timestamp: "2026-05-10T00:00:00.000Z",
        cwd: repo,
        message: { content: [{ type: "text", text: "hi" }] },
      },
    ]);

    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });
    expect(await listSessionDirs(repo)).toHaveLength(0);
  });

  it("requires --session or --all", async () => {
    const repo = await setupInitedRepo();
    await expect(
      doRunImportClaudeCode({}, { cwd: repo, claudeProjectsDir: getProjectsRoot() }),
    ).rejects.toThrow("Specify --session <id> or --all");
  });

  it("errors when the project's transcript directory is absent", async () => {
    const repo = await setupInitedRepo();
    await expect(
      doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() }),
    ).rejects.toThrow("Claude transcript directory not found for project");
  });

  it("--force replaces an already-imported session instead of skipping", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, "sess-1", actionTranscript(repo));

    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });
    const firstDirs = await listSessionDirs(repo);
    expect(firstDirs).toHaveLength(1);
    const firstId = firstDirs[0] as string;

    // --force deletes the prior session and re-imports under a fresh id, so the
    // count stays at one (replaced, not duplicated).
    await doRunImportClaudeCode(
      { all: true, force: true },
      { cwd: repo, claudeProjectsDir: getProjectsRoot() },
    );
    const secondDirs = await listSessionDirs(repo);
    expect(secondDirs).toHaveLength(1);
    expect(secondDirs[0]).not.toBe(firstId);
  });

  it("--force --dry-run leaves the existing session untouched", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, "sess-1", actionTranscript(repo));

    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });
    const firstDirs = await listSessionDirs(repo);
    expect(firstDirs).toHaveLength(1);
    const firstId = firstDirs[0] as string;

    await doRunImportClaudeCode(
      { all: true, force: true, dryRun: true },
      { cwd: repo, claudeProjectsDir: getProjectsRoot() },
    );
    // No delete under dry-run: the original session id is still present.
    expect(await listSessionDirs(repo)).toEqual([firstId]);
  });
});

/** Write a synthetic Codex rollout under a date directory in the sessions root. */
async function writeRollout(
  sessionId: string,
  records: Array<Record<string, unknown>>,
  subdir = join("2026", "05", "10"),
): Promise<void> {
  const dir = join(getCodexRoot(), subdir);
  await mkdir(dir, { recursive: true });
  const body = records.map((r) => JSON.stringify(r)).join("\n");
  await writeFile(join(dir, `rollout-${sessionId}.jsonl`), body);
}

function codexActionRollout(cwd: string, sessionId: string): Array<Record<string, unknown>> {
  return [
    {
      type: "session_meta",
      timestamp: "2026-05-10T00:00:00.000Z",
      payload: { id: sessionId, cwd, timestamp: "2026-05-10T00:00:00.000Z" },
    },
    {
      type: "response_item",
      timestamp: "2026-05-10T00:00:01.000Z",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "npm test", workdir: cwd }),
        call_id: "call_1",
      },
    },
    {
      type: "response_item",
      timestamp: "2026-05-10T00:00:02.000Z",
      payload: {
        type: "function_call_output",
        call_id: "call_1",
        output: "Wall time: 0.5000 seconds\nProcess exited with code 0\nOutput:\nok",
      },
    },
  ];
}

describe("basou import codex", () => {
  it("--all imports a rollout whose session cwd matches the project", async () => {
    const repo = await setupInitedRepo();
    await writeRollout("codex-1", codexActionRollout(repo, "codex-1"));

    await doRunImportCodex({ all: true }, { cwd: repo, codexSessionsDir: getCodexRoot() });

    const dirs = await listSessionDirs(repo);
    expect(dirs).toHaveLength(1);

    const sessionDir = join(basouPaths(repo).sessions, dirs[0] as string);
    const session = SessionSchema.parse(await readYamlFile(join(sessionDir, "session.yaml")));
    expect(session.session.source.kind).toBe("codex-import");
    expect(session.session.source.external_id).toBe("codex-1");
    expect(session.session.status).toBe("imported");

    const eventsBody = await readFile(join(sessionDir, "events.jsonl"), "utf8");
    const types = eventsBody
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toContain("command_executed");
    expect(types[0]).toBe("session_started");
    expect(types[types.length - 1]).toBe("session_ended");
  });

  it("imports only rollouts started in the requested project", async () => {
    const repo = await setupInitedRepo();
    await writeRollout("codex-here", codexActionRollout(repo, "codex-here"));
    // A rollout from a different project must not be imported.
    await writeRollout(
      "codex-other",
      codexActionRollout("/some/other/project", "codex-other"),
      join("2026", "05", "11"),
    );

    await doRunImportCodex({ all: true }, { cwd: repo, codexSessionsDir: getCodexRoot() });

    const dirs = await listSessionDirs(repo);
    expect(dirs).toHaveLength(1);
    const session = SessionSchema.parse(
      await readYamlFile(join(basouPaths(repo).sessions, dirs[0] as string, "session.yaml")),
    );
    expect(session.session.source.external_id).toBe("codex-here");
  });

  it("--session imports a single rollout by its Codex session id", async () => {
    const repo = await setupInitedRepo();
    await writeRollout("codex-1", codexActionRollout(repo, "codex-1"));
    await writeRollout("codex-2", codexActionRollout(repo, "codex-2"), join("2026", "05", "11"));

    await doRunImportCodex({ session: "codex-2" }, { cwd: repo, codexSessionsDir: getCodexRoot() });

    const dirs = await listSessionDirs(repo);
    expect(dirs).toHaveLength(1);
    const session = SessionSchema.parse(
      await readYamlFile(join(basouPaths(repo).sessions, dirs[0] as string, "session.yaml")),
    );
    expect(session.session.source.external_id).toBe("codex-2");
  });

  it("is idempotent: re-import skips an already-imported rollout", async () => {
    const repo = await setupInitedRepo();
    await writeRollout("codex-1", codexActionRollout(repo, "codex-1"));

    await doRunImportCodex({ all: true }, { cwd: repo, codexSessionsDir: getCodexRoot() });
    expect(await listSessionDirs(repo)).toHaveLength(1);

    await doRunImportCodex({ all: true }, { cwd: repo, codexSessionsDir: getCodexRoot() });
    expect(await listSessionDirs(repo)).toHaveLength(1);
  });

  it("--force replaces an already-imported rollout instead of skipping", async () => {
    const repo = await setupInitedRepo();
    await writeRollout("codex-1", codexActionRollout(repo, "codex-1"));

    await doRunImportCodex({ all: true }, { cwd: repo, codexSessionsDir: getCodexRoot() });
    const firstDirs = await listSessionDirs(repo);
    expect(firstDirs).toHaveLength(1);
    const firstId = firstDirs[0] as string;

    await doRunImportCodex(
      { all: true, force: true },
      { cwd: repo, codexSessionsDir: getCodexRoot() },
    );
    const secondDirs = await listSessionDirs(repo);
    expect(secondDirs).toHaveLength(1);
    expect(secondDirs[0]).not.toBe(firstId);
  });

  it("--dry-run writes nothing to disk", async () => {
    const repo = await setupInitedRepo();
    await writeRollout("codex-1", codexActionRollout(repo, "codex-1"));

    await doRunImportCodex(
      { all: true, dryRun: true },
      { cwd: repo, codexSessionsDir: getCodexRoot() },
    );

    expect(await listSessionDirs(repo)).toHaveLength(0);
  });

  it("skips rollouts with no exec_command", async () => {
    const repo = await setupInitedRepo();
    await writeRollout("codex-empty", [
      {
        type: "session_meta",
        timestamp: "2026-05-10T00:00:00.000Z",
        payload: { id: "codex-empty", cwd: repo, timestamp: "2026-05-10T00:00:00.000Z" },
      },
      {
        type: "response_item",
        timestamp: "2026-05-10T00:00:01.000Z",
        payload: { type: "reasoning", summary: [] },
      },
    ]);

    await doRunImportCodex({ all: true }, { cwd: repo, codexSessionsDir: getCodexRoot() });
    expect(await listSessionDirs(repo)).toHaveLength(0);
  });

  it("requires --session or --all", async () => {
    const repo = await setupInitedRepo();
    await expect(
      doRunImportCodex({}, { cwd: repo, codexSessionsDir: getCodexRoot() }),
    ).rejects.toThrow("Specify --session <id> or --all");
  });

  it("errors when the Codex sessions directory is absent", async () => {
    const repo = await setupInitedRepo();
    await expect(
      doRunImportCodex(
        { all: true },
        { cwd: repo, codexSessionsDir: join(getCodexRoot(), "does-not-exist") },
      ),
    ).rejects.toThrow("Codex sessions directory not found");
  });
});
