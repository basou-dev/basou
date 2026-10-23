import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  basouPaths,
  createManifest,
  ensureBasouDirectory,
  readYamlFile,
  SESSION_OBSERVATION_SCHEMA_VERSION,
  SessionSchema,
  verifyEventsChain,
  writeManifest,
  writeSessionObservation,
  writeYamlFile,
} from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doRunImportClaudeCode, doRunImportCodex } from "./import.js";
import { doRunRefresh } from "./refresh.js";

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
  // Mirror Claude Code's real per-project dir encoding (every non-alphanumeric
  // char -> "-", e.g. "_" and "."), independently of the production encoder so
  // this fixture stays an oracle that catches an encoder regression.
  const encoded = repo.replace(/[^a-zA-Z0-9]/g, "-");
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

describe("basou import claude-code + git observations", () => {
  /** A transcript that ran a shell command and named no file anywhere. */
  function shellOnlyTranscript(repo: string): Array<Record<string, unknown>> {
    return [
      {
        type: "user",
        timestamp: "2026-09-22T00:00:00.000Z",
        cwd: repo,
        sessionId: "sess-obs",
        message: { role: "user", content: [{ type: "text", text: "go" }] },
      },
      {
        type: "assistant",
        timestamp: "2026-09-22T00:00:01.000Z",
        cwd: repo,
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "python3 - <<'PY'\nopen('a.ts','w')\nPY" },
            },
          ],
        },
      },
    ];
  }

  it("imports the files the hooks observed for that session", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, "sess-obs", shellOnlyTranscript(repo));
    await writeSessionObservation(basouPaths(repo).observations, {
      schema_version: SESSION_OBSERVATION_SCHEMA_VERSION,
      external_id: "sess-obs",
      started_at: "2026-09-22T00:00:00.000Z",
      updated_at: "2026-09-22T00:00:02.000Z",
      repos: [
        {
          path: repo,
          base_head: "a".repeat(40),
          base_dirty: [],
          files: [{ path: `${repo}/a.ts`, change_type: "added" }],
        },
      ],
    });

    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });

    const dirs = await listSessionDirs(repo);
    expect(dirs).toHaveLength(1);
    const sessionDir = join(basouPaths(repo).sessions, dirs[0] as string);
    const session = SessionSchema.parse(await readYamlFile(join(sessionDir, "session.yaml")));
    // Stored repo-relative, like every other related file: the observation
    // carries absolute paths and the import sanitizes them as it always has.
    expect(session.session.related_files).toEqual(["a.ts"]);
  });

  it("imports the same transcript unchanged when nothing was observed", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, "sess-obs", shellOnlyTranscript(repo));

    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });

    const dirs = await listSessionDirs(repo);
    expect(dirs).toHaveLength(1);
    const sessionDir = join(basouPaths(repo).sessions, dirs[0] as string);
    const session = SessionSchema.parse(await readYamlFile(join(sessionDir, "session.yaml")));
    expect(session.session.related_files).toEqual([]);
  });
});

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

  it("discovers transcripts for a project path containing an underscore", async () => {
    // Claude Code encodes a project dir by replacing every non-alphanumeric
    // char with "-", so a project at .../spectrum_chisel-workspace stores its
    // logs under ...-spectrum-chisel-workspace. The old "/"-only encoder looked
    // for an underscore-preserving dir and silently skipped the whole project.
    const base = await realpath(tmpRepo as string);
    const repo = join(base, "spectrum_chisel-workspace");
    await mkdir(repo, { recursive: true });
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: repo, env: ENV });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: repo,
      env: ENV,
    });
    await execFileAsync("git", ["config", "user.name", "test"], { cwd: repo, env: ENV });
    const paths = await ensureBasouDirectory(repo);
    await writeManifest(
      paths,
      createManifest({ workspaceName: "fixture-ws", now: FIXED_DATE, workspaceId: FIXED_WS_ID }),
    );

    await writeTranscript(repo, "sess-1", actionTranscript(repo));
    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });

    // The underscore in the path must not cause a silent "no source logs" skip.
    expect(await listSessionDirs(repo)).toHaveLength(1);
  });

  it("skips a colliding sibling project's transcript by its recorded cwd", async () => {
    // "foo_x" and "foo-x" are distinct paths that encode to the SAME Claude
    // project dir (lossy "_"->"-"), so Claude colocates their transcripts. The
    // import must attribute each by its recorded cwd and import only this one.
    const base = await realpath(tmpRepo as string);
    const repo = join(base, "foo_x");
    const sibling = join(base, "foo-x");
    await mkdir(repo, { recursive: true });
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: repo, env: ENV });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: repo,
      env: ENV,
    });
    await execFileAsync("git", ["config", "user.name", "test"], { cwd: repo, env: ENV });
    const paths = await ensureBasouDirectory(repo);
    await writeManifest(
      paths,
      createManifest({ workspaceName: "fixture-ws", now: FIXED_DATE, workspaceId: FIXED_WS_ID }),
    );

    // Both land in the one shared encoded dir; only the cwd distinguishes them.
    await writeTranscript(repo, "mine", actionTranscript(repo));
    await writeTranscript(sibling, "theirs", actionTranscript(sibling));

    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });

    const dirs = await listSessionDirs(repo);
    expect(dirs).toHaveLength(1);
    const ext = SessionSchema.parse(
      await readYamlFile(join(basouPaths(repo).sessions, dirs[0] as string, "session.yaml")),
    ).session.source.external_id;
    expect(ext).toBe("mine");
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

  it("rejects --session combined with --all", async () => {
    const repo = await setupInitedRepo();
    await expect(
      doRunImportClaudeCode(
        { session: "any-id", all: true },
        { cwd: repo, claudeProjectsDir: getProjectsRoot() },
      ),
    ).rejects.toThrow("Specify either --session <id> or --all, not both");
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

  it("rejects --session combined with --all", async () => {
    const repo = await setupInitedRepo();
    await expect(
      doRunImportCodex(
        { session: "any-id", all: true },
        { cwd: repo, codexSessionsDir: getCodexRoot() },
      ),
    ).rejects.toThrow("Specify either --session <id> or --all, not both");
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

  it("errors when --session matches no rollout in the project", async () => {
    const repo = await setupInitedRepo();
    await writeRollout("codex-1", codexActionRollout(repo, "codex-1"));
    await expect(
      doRunImportCodex({ session: "nope" }, { cwd: repo, codexSessionsDir: getCodexRoot() }),
    ).rejects.toThrow("Codex rollout not found for session id in project");
  });

  it("dedup is scoped by source kind: never touches a Claude session sharing an id", async () => {
    const repo = await setupInitedRepo();
    // A Claude-derived session whose external_id collides with a Codex id.
    const claudeSid = "ses_01HXABCDEF1234567890ABCDEF";
    const dir = join(basouPaths(repo).sessions, claudeSid);
    await mkdir(dir, { recursive: true });
    await writeYamlFile(join(dir, "session.yaml"), {
      schema_version: "0.1.0",
      session: {
        id: claudeSid,
        workspace_id: FIXED_WS_ID,
        source: { kind: "claude-code-import", version: "0.1.0", external_id: "shared-id" },
        started_at: "2026-05-10T00:00:00.000Z",
        status: "imported",
        working_directory: ".",
        invocation: { command: "claude", args: [], exit_code: null },
        related_files: [],
        events_log: "events.jsonl",
        label: "claude-code 2026-05-10: 1 command",
      },
    });
    await writeRollout("shared-id", codexActionRollout(repo, "shared-id"));

    // --force would delete a same-id session; the Claude one must survive
    // because dedup is scoped to source.kind.
    await doRunImportCodex(
      { all: true, force: true },
      { cwd: repo, codexSessionsDir: getCodexRoot() },
    );

    const dirs = await listSessionDirs(repo);
    expect(dirs).toContain(claudeSid);
    expect(dirs).toHaveLength(2);
    const kinds = await Promise.all(
      dirs.map(
        async (d) =>
          SessionSchema.parse(
            await readYamlFile(join(basouPaths(repo).sessions, d, "session.yaml")),
          ).session.source.kind,
      ),
    );
    expect(kinds.filter((k) => k === "claude-code-import")).toHaveLength(1);
    expect(kinds.filter((k) => k === "codex-import")).toHaveLength(1);
  });
});

// --- Multi-root source roots -------------------------------------------------

/** Like setupInitedRepo, but persists `import.source_roots` in the manifest. */
async function setupInitedRepoWithSourceRoots(roots: string[]): Promise<string> {
  const repo = await realpath(tmpRepo as string);
  const paths = await ensureBasouDirectory(repo);
  const manifest = createManifest({
    workspaceName: "fixture-ws",
    now: FIXED_DATE,
    workspaceId: FIXED_WS_ID,
    sourceRoots: roots,
  });
  await writeManifest(paths, manifest);
  return repo;
}

/** Write a Claude transcript into the encoded per-project dir of `sourcePath`. */
async function writeTranscriptFor(
  sourcePath: string,
  sessionId: string,
  records: Array<Record<string, unknown>>,
): Promise<void> {
  const dir = join(getProjectsRoot(), sourcePath.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${sessionId}.jsonl`),
    records.map((r) => JSON.stringify(r)).join("\n"),
  );
}

/** Sorted source.external_id of every imported session in the workspace. */
async function importedExternalIds(repo: string): Promise<string[]> {
  const dirs = await listSessionDirs(repo);
  const ids = await Promise.all(
    dirs.map(
      async (d) =>
        SessionSchema.parse(await readYamlFile(join(basouPaths(repo).sessions, d, "session.yaml")))
          .session.source.external_id,
    ),
  );
  return ids.filter((x): x is string => typeof x === "string").sort();
}

describe("multi-root source roots", () => {
  it("codex --project (repeatable) unions rollouts across roots", async () => {
    const repo = await setupInitedRepo();
    const sibling = join(dirname(repo), "sibling-codex");
    await writeRollout("c-host", codexActionRollout(repo, "c-host"));
    await writeRollout("c-sib", codexActionRollout(sibling, "c-sib"), join("2026", "05", "11"));

    await doRunImportCodex(
      { all: true, project: [repo, sibling] },
      { cwd: repo, codexSessionsDir: getCodexRoot() },
    );

    expect(await importedExternalIds(repo)).toEqual(["c-host", "c-sib"]);
  });

  it("codex aggregates manifest import.source_roots with no --project", async () => {
    const repo = await setupInitedRepoWithSourceRoots([".", "../sibling-codex2"]);
    const sibling = join(dirname(repo), "sibling-codex2");
    await writeRollout("c-host", codexActionRollout(repo, "c-host"));
    await writeRollout("c-sib", codexActionRollout(sibling, "c-sib"), join("2026", "05", "11"));

    await doRunImportCodex({ all: true }, { cwd: repo, codexSessionsDir: getCodexRoot() });

    expect(await importedExternalIds(repo)).toEqual(["c-host", "c-sib"]);
  });

  it("codex --project overrides manifest source_roots", async () => {
    const repo = await setupInitedRepoWithSourceRoots(["."]);
    const sibling = join(dirname(repo), "sibling-codex3");
    await writeRollout("c-host", codexActionRollout(repo, "c-host"));
    await writeRollout("c-sib", codexActionRollout(sibling, "c-sib"), join("2026", "05", "11"));

    await doRunImportCodex(
      { all: true, project: [sibling] },
      { cwd: repo, codexSessionsDir: getCodexRoot() },
    );

    // Only the flag's root is imported; the manifest's "." (the repo) is ignored.
    expect(await importedExternalIds(repo)).toEqual(["c-sib"]);
  });

  it("codex de-duplicates a root listed twice", async () => {
    const repo = await setupInitedRepo();
    await writeRollout("c-host", codexActionRollout(repo, "c-host"));

    await doRunImportCodex(
      { all: true, project: [repo, repo] },
      { cwd: repo, codexSessionsDir: getCodexRoot() },
    );

    expect(await importedExternalIds(repo)).toEqual(["c-host"]);
  });

  it("imports a sibling-root session without a '..'-escape in working_directory", async () => {
    const repo = await setupInitedRepo();
    const sibling = join(dirname(repo), "sibling-wd");
    await writeRollout("c-sib", codexActionRollout(sibling, "c-sib"));

    await doRunImportCodex(
      { all: true, project: [sibling] },
      { cwd: repo, codexSessionsDir: getCodexRoot() },
    );

    const dirs = await listSessionDirs(repo);
    const session = SessionSchema.parse(
      await readYamlFile(join(basouPaths(repo).sessions, dirs[0] as string, "session.yaml")),
    );
    // Each session is sanitized against its OWN cwd, never relativized against
    // the host repo, so no '..'-escape leaks into the committed session.yaml.
    expect(session.session.working_directory.includes("..")).toBe(false);
  });

  it("claude --project (repeatable) unions transcripts across roots", async () => {
    const repo = await setupInitedRepo();
    const sibling = join(dirname(repo), "sibling-claude");
    await writeTranscriptFor(repo, "cl-host", actionTranscript(repo));
    await writeTranscriptFor(sibling, "cl-sib", actionTranscript(sibling));

    await doRunImportClaudeCode(
      { all: true, project: [repo, sibling] },
      { cwd: repo, claudeProjectsDir: getProjectsRoot() },
    );

    expect(await importedExternalIds(repo)).toEqual(["cl-host", "cl-sib"]);
  });

  it("claude tolerates an absent root dir when another has transcripts", async () => {
    const repo = await setupInitedRepo();
    const absent = join(dirname(repo), "nope-claude");
    await writeTranscriptFor(repo, "cl-host", actionTranscript(repo));

    await doRunImportClaudeCode(
      { all: true, project: [repo, absent] },
      { cwd: repo, claudeProjectsDir: getProjectsRoot() },
    );

    expect(await importedExternalIds(repo)).toEqual(["cl-host"]);
  });

  it("claude errors only when no root has a transcript directory", async () => {
    const repo = await setupInitedRepo();
    const absent1 = join(dirname(repo), "nope-1");
    const absent2 = join(dirname(repo), "nope-2");

    await expect(
      doRunImportClaudeCode(
        { all: true, project: [absent1, absent2] },
        { cwd: repo, claudeProjectsDir: getProjectsRoot() },
      ),
    ).rejects.toThrow(/transcript directory not found/);
  });

  it("claude --session finds the transcript in a sibling root", async () => {
    const repo = await setupInitedRepo();
    const sibling = join(dirname(repo), "sibling-session");
    await writeTranscriptFor(sibling, "only-sib", actionTranscript(sibling));

    await doRunImportClaudeCode(
      { session: "only-sib", project: [repo, sibling] },
      { cwd: repo, claudeProjectsDir: getProjectsRoot() },
    );

    expect(await importedExternalIds(repo)).toEqual(["only-sib"]);
  });

  it("claude --session errors when no root has that transcript", async () => {
    const repo = await setupInitedRepo();
    await writeTranscriptFor(repo, "exists", actionTranscript(repo));

    await expect(
      doRunImportClaudeCode(
        { session: "missing", project: [repo] },
        { cwd: repo, claudeProjectsDir: getProjectsRoot() },
      ),
    ).rejects.toThrow(/not found for session id/);
  });
});

// --- scoped re-import of a changed source -------------------------------

/** The action transcript plus one more Bash command, so the file grows. */
function grownTranscript(repo: string): Array<Record<string, unknown>> {
  return [
    ...actionTranscript(repo),
    {
      type: "assistant",
      timestamp: "2026-05-10T00:00:03.000Z",
      cwd: repo,
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: "npm run build" } }],
      },
    },
  ];
}

/** The codex action rollout plus one more exec_command, so the file grows. */
function grownCodexRollout(cwd: string, sessionId: string): Array<Record<string, unknown>> {
  return [
    ...codexActionRollout(cwd, sessionId),
    {
      type: "response_item",
      timestamp: "2026-05-10T00:00:03.000Z",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "npm run build", workdir: cwd }),
        call_id: "call_2",
      },
    },
    {
      type: "response_item",
      timestamp: "2026-05-10T00:00:04.000Z",
      payload: {
        type: "function_call_output",
        call_id: "call_2",
        output: "Wall time: 0.5000 seconds\nProcess exited with code 0\nOutput:\nok",
      },
    },
  ];
}

type StoredEvent = {
  id: string;
  type: string;
  occurred_at: string;
  source: string;
  args?: unknown;
  body?: unknown;
};

async function readEvents(repo: string, sid: string): Promise<StoredEvent[]> {
  const body = await readFile(join(basouPaths(repo).sessions, sid, "events.jsonl"), "utf8");
  return body
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as StoredEvent);
}

function readSession(
  repo: string,
  sid: string,
): ReturnType<typeof SessionSchema.parse> | Promise<ReturnType<typeof SessionSchema.parse>> {
  return readYamlFile(join(basouPaths(repo).sessions, sid, "session.yaml")).then((y) =>
    SessionSchema.parse(y),
  );
}

function commandLine(event: StoredEvent): string | undefined {
  return Array.isArray(event.args) ? (event.args[1] as string | undefined) : undefined;
}

describe("basou import claude-code — scoped re-import of a grown source", () => {
  it("records the source byte size on a fresh import", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, "sess-1", actionTranscript(repo));
    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });

    const sid = (await listSessionDirs(repo))[0] as string;
    const session = await readSession(repo, sid);
    const encoded = repo.replace(/[^a-zA-Z0-9]/g, "-");
    const size = (await readFile(join(getProjectsRoot(), encoded, "sess-1.jsonl"))).length;
    expect(session.session.source.source_size_bytes).toBe(size);
  });

  it("re-imports a grown source into the SAME id, refreshing events + size + label", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, "sess-1", actionTranscript(repo));
    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });
    const sid = (await listSessionDirs(repo))[0] as string;
    const before = await readSession(repo, sid);
    expect((await readEvents(repo, sid)).filter((e) => e.type === "command_executed")).toHaveLength(
      1,
    );

    await writeTranscript(repo, "sess-1", grownTranscript(repo));
    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });

    expect(await listSessionDirs(repo)).toEqual([sid]);
    const after = await readSession(repo, sid);
    const afterEvents = await readEvents(repo, sid);
    expect(afterEvents.filter((e) => e.type === "command_executed")).toHaveLength(2);
    expect(after.session.source.source_size_bytes as number).toBeGreaterThan(
      before.session.source.source_size_bytes as number,
    );
    expect(after.session.label).not.toBe(before.session.label);
    expect(afterEvents[0]?.type).toBe("session_started");
    expect(afterEvents[afterEvents.length - 1]?.type).toBe("session_ended");
  });

  it("reuses prior derived event ids for unchanged derivations", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, "sess-1", actionTranscript(repo));
    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });
    const sid = (await listSessionDirs(repo))[0] as string;
    const before = await readEvents(repo, sid);
    const npmTestBefore = before.find((e) => commandLine(e) === "npm test");
    const startedBefore = before.find((e) => e.type === "session_started");
    const endedBefore = before.find((e) => e.type === "session_ended");
    expect(npmTestBefore).toBeDefined();

    await writeTranscript(repo, "sess-1", grownTranscript(repo));
    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });

    const after = await readEvents(repo, sid);
    const npmTestAfter = after.find((e) => commandLine(e) === "npm test");
    const startedAfter = after.find((e) => e.type === "session_started");
    const endedAfter = after.find((e) => e.type === "session_ended");
    // Unchanged derivations keep their id (cross-session linked_events survive).
    expect(npmTestAfter?.id).toBe(npmTestBefore?.id);
    expect(startedAfter?.id).toBe(startedBefore?.id);
    // session_ended keeps its id but advances occurred_at to the new end.
    expect(endedAfter?.id).toBe(endedBefore?.id);
    expect(endedAfter?.occurred_at).not.toBe(endedBefore?.occurred_at);
    // The genuinely new command is a fresh event id.
    const buildAfter = after.find((e) => commandLine(e) === "npm run build");
    expect(buildAfter).toBeDefined();
    expect(before.map((e) => e.id)).not.toContain(buildAfter?.id);
  });

  it("preserves a non-derived event and keeps the merged stream chronological", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, "sess-1", actionTranscript(repo));
    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });
    const sid = (await listSessionDirs(repo))[0] as string;

    // Inject a human note (source local-cli) directly: attach to imported
    // sessions is rejected, so direct write is the only way one lands. Its
    // timestamp sits between the original end and the upcoming new end.
    const evPath = join(basouPaths(repo).sessions, sid, "events.jsonl");
    const note = {
      schema_version: "0.1.0",
      id: "evt_01HXABCDEF1234567890ABCDEF",
      session_id: sid,
      occurred_at: "2026-05-10T00:00:02.500Z",
      source: "local-cli",
      type: "note_added",
      body: "human note",
    };
    await writeFile(evPath, `${await readFile(evPath, "utf8")}${JSON.stringify(note)}\n`);

    await writeTranscript(repo, "sess-1", grownTranscript(repo));
    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });

    const after = await readEvents(repo, sid);
    const preserved = after.find((e) => e.type === "note_added");
    expect(preserved?.id).toBe("evt_01HXABCDEF1234567890ABCDEF");
    expect(preserved?.body).toBe("human note");
    const times = after.map((e) => Date.parse(e.occurred_at));
    for (let i = 1; i < times.length; i++) {
      expect(times[i] ?? 0).toBeGreaterThanOrEqual(times[i - 1] ?? 0);
    }
  });

  it("skips an unchanged source (size matches)", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, "sess-1", actionTranscript(repo));
    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });
    const sid = (await listSessionDirs(repo))[0] as string;
    const before = await readEvents(repo, sid);

    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });
    expect((await readEvents(repo, sid)).map((e) => e.id)).toEqual(before.map((e) => e.id));
  });

  it("does not auto-replace a shrunken source (truncate/rotate)", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, "sess-1", grownTranscript(repo));
    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });
    const sid = (await listSessionDirs(repo))[0] as string;
    const before = await readEvents(repo, sid);
    expect(before.filter((e) => e.type === "command_executed")).toHaveLength(2);

    await writeTranscript(repo, "sess-1", actionTranscript(repo)); // shrink
    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });
    const after = await readEvents(repo, sid);
    expect(after.filter((e) => e.type === "command_executed")).toHaveLength(2);
    expect(after.map((e) => e.id)).toEqual(before.map((e) => e.id));
  });

  it("does not re-import a legacy session that has no recorded size", async () => {
    const repo = await setupInitedRepo();
    const sid = "ses_01HXABCDEF1234567890ABCDEF";
    const dir = join(basouPaths(repo).sessions, sid);
    await mkdir(dir, { recursive: true });
    await writeYamlFile(join(dir, "session.yaml"), {
      schema_version: "0.1.0",
      session: {
        id: sid,
        workspace_id: FIXED_WS_ID,
        source: { kind: "claude-code-import", version: "0.1.0", external_id: "sess-1" },
        started_at: "2026-05-10T00:00:00.000Z",
        status: "imported",
        working_directory: ".",
        invocation: { command: "claude", args: [], exit_code: null },
        related_files: [],
        events_log: "events.jsonl",
        label: "claude-code legacy",
      },
    });
    await writeFile(join(dir, "events.jsonl"), "");
    await writeTranscript(repo, "sess-1", grownTranscript(repo));

    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });
    expect(await listSessionDirs(repo)).toEqual([sid]);
    expect(await readEvents(repo, sid)).toHaveLength(0);
  });

  it("dry-run previews a re-import without writing", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, "sess-1", actionTranscript(repo));
    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });
    const sid = (await listSessionDirs(repo))[0] as string;
    const before = await readEvents(repo, sid);

    await writeTranscript(repo, "sess-1", grownTranscript(repo));
    await doRunImportClaudeCode(
      { all: true, dryRun: true },
      { cwd: repo, claudeProjectsDir: getProjectsRoot() },
    );
    const after = await readEvents(repo, sid);
    expect(after.map((e) => e.id)).toEqual(before.map((e) => e.id));
    expect(after.filter((e) => e.type === "command_executed")).toHaveLength(1);
  });

  it("aborts the re-import when the prior events.jsonl has an unreadable line", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, "sess-1", actionTranscript(repo));
    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });
    const sid = (await listSessionDirs(repo))[0] as string;
    const evPath = join(basouPaths(repo).sessions, sid, "events.jsonl");
    await writeFile(evPath, `${await readFile(evPath, "utf8")}{ this is not json\n`);

    await writeTranscript(repo, "sess-1", grownTranscript(repo));
    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });

    // Aborted: the corrupt line + original single derivation remain; the new
    // command was NOT added.
    const body = await readFile(evPath, "utf8");
    expect(body).toContain("{ this is not json");
    expect(body.split("\n").filter((l) => l.includes('"command_executed"'))).toHaveLength(1);
  });

  it("counts a blocked re-import as skipped_unverifiable (not skipped_no_action) so freshness can flag it", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, "sess-1", actionTranscript(repo));
    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });
    const sid = (await listSessionDirs(repo))[0] as string;
    const evPath = join(basouPaths(repo).sessions, sid, "events.jsonl");
    // Corrupt the prior log so a safe in-place re-import is refused, and grow the
    // source so a re-import is attempted (and then blocked) rather than skipped
    // as unchanged.
    await writeFile(evPath, `${await readFile(evPath, "utf8")}{ this is not json\n`);
    await writeTranscript(repo, "sess-1", grownTranscript(repo));

    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });
    try {
      await doRunImportClaudeCode(
        { all: true, json: true },
        { cwd: repo, claudeProjectsDir: getProjectsRoot() },
      );
    } finally {
      spy.mockRestore();
    }
    const result = lines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((r) => r !== null && "imported_count" in r);
    expect(result).toBeDefined();
    // The grown-but-blocked session is the unverifiable bucket, NOT a benign no-op.
    expect(result?.skipped_unverifiable).toBe(1);
    expect(result?.skipped_no_action).toBe(0);
  });

  it("skips an anomalous >1-prior duplicate instead of replacing it", async () => {
    const repo = await setupInitedRepo();
    const sids = ["ses_01HXABCDEF1234567890ABCDEF", "ses_01HXABCDEF1234567890ABCDEG"];
    for (const sid of sids) {
      const dir = join(basouPaths(repo).sessions, sid);
      await mkdir(dir, { recursive: true });
      await writeYamlFile(join(dir, "session.yaml"), {
        schema_version: "0.1.0",
        session: {
          id: sid,
          workspace_id: FIXED_WS_ID,
          source: {
            kind: "claude-code-import",
            version: "0.1.0",
            external_id: "sess-1",
            source_size_bytes: 1,
          },
          started_at: "2026-05-10T00:00:00.000Z",
          status: "imported",
          working_directory: ".",
          invocation: { command: "claude", args: [], exit_code: null },
          related_files: [],
          events_log: "events.jsonl",
        },
      });
      await writeFile(join(dir, "events.jsonl"), "");
    }
    await writeTranscript(repo, "sess-1", grownTranscript(repo));

    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });
    expect((await listSessionDirs(repo)).sort()).toEqual([...sids].sort());
  });

  it("aborts (skips) when a non-append change would drop a prior derived event", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, "sess-1", actionTranscript(repo));
    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });
    const sid = (await listSessionDirs(repo))[0] as string;
    const before = await readEvents(repo, sid);
    expect(before.find((e) => commandLine(e) === "npm test")).toBeDefined();

    // A LARGER transcript that REPLACES the original command (drops "npm test")
    // — a non-append edit. Re-deriving would drop the prior command event's id,
    // so the re-import must abort and leave the session untouched.
    await writeTranscript(repo, "sess-1", [
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
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "this-replaces-the-original-command-and-grows-the-byte-size" },
            },
          ],
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
    ]);
    await doRunImportClaudeCode({ all: true }, { cwd: repo, claudeProjectsDir: getProjectsRoot() });

    // Untouched: the original derivation (with the original command id) remains.
    const after = await readEvents(repo, sid);
    expect(after.map((e) => e.id)).toEqual(before.map((e) => e.id));
    expect(after.find((e) => commandLine(e) === "npm test")).toBeDefined();
  });
});

// --- forked transcripts -------------------------------------------------

// A transcript forked from another opens with copies of its records under the
// same uuids. The fork's file name sorts BEFORE the original's, so only the
// creation time can tell which copied which.
const ORIGINAL_ID = "zzzzzzzz-original";
const FORK_ID = "aaaaaaaa-fork";
const CREATED_AT_MS: Record<string, number> = { [ORIGINAL_ID]: 1_000, [FORK_ID]: 2_000 };
/** The same two files after a restore that gave the fork the earlier birth time. */
const FLIPPED_CREATED_AT_MS: Record<string, number> = { [ORIGINAL_ID]: 2_000, [FORK_ID]: 1_000 };
const FORK_OF_FORK_ID = "bbbbbbbb-fork-of-fork";

function uuid(n: number): string {
  return `4a1f0c2e-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** What the conversation holds before the fork: a prompt, a command, a confirmed question. */
function conversationStart(repo: string, sessionId: string): Array<Record<string, unknown>> {
  return [
    {
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-05-10T00:00:00.050Z",
      sessionId,
    },
    {
      type: "user",
      uuid: uuid(1),
      timestamp: "2026-05-10T00:00:00.000Z",
      cwd: repo,
      sessionId,
      message: { role: "user", content: [{ type: "text", text: "go" }] },
    },
    {
      type: "assistant",
      uuid: uuid(2),
      timestamp: "2026-05-10T00:00:01.000Z",
      cwd: repo,
      sessionId,
      message: {
        id: "msg_1",
        usage: { output_tokens: 100 },
        content: [{ type: "tool_use", name: "Bash", input: { command: "git status" } }],
      },
    },
    {
      type: "assistant",
      uuid: uuid(3),
      timestamp: "2026-05-10T00:00:02.000Z",
      cwd: repo,
      sessionId,
      message: {
        id: "msg_2",
        usage: { output_tokens: 50 },
        content: [
          {
            type: "tool_use",
            id: "toolu_ask1",
            name: "AskUserQuestion",
            input: {
              questions: [
                { question: "Which DB?", header: "DB", options: [{ label: "Postgres" }] },
              ],
            },
          },
        ],
      },
    },
    {
      type: "user",
      uuid: uuid(4),
      timestamp: "2026-05-10T00:00:03.000Z",
      cwd: repo,
      sessionId,
      toolUseResult: { questions: [], answers: { "Which DB?": "Postgres" } },
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_ask1", content: "ok" }] },
    },
  ];
}

/** An assistant record that runs one Bash command. */
function commandRecord(
  repo: string,
  n: number,
  timestamp: string,
  sessionId: string,
  command: string,
): Record<string, unknown> {
  return {
    type: "assistant",
    uuid: uuid(n),
    timestamp,
    cwd: repo,
    sessionId,
    message: {
      id: `msg_${n}`,
      usage: { output_tokens: 10 },
      content: [{ type: "tool_use", name: "Bash", input: { command } }],
    },
  };
}

function originalTranscript(repo: string): Array<Record<string, unknown>> {
  return [
    ...conversationStart(repo, ORIGINAL_ID),
    {
      type: "assistant",
      uuid: uuid(5),
      timestamp: "2026-05-10T02:00:00.000Z",
      cwd: repo,
      sessionId: ORIGINAL_ID,
      message: {
        id: "msg_5",
        usage: { output_tokens: 70 },
        content: [{ type: "tool_use", name: "Bash", input: { command: "git log" } }],
      },
    },
  ];
}

/** The fork: metadata, the copies (sessionId rewritten), then what it added. */
function forkTranscript(repo: string, extra: Array<Record<string, unknown>> = []) {
  return [
    { type: "custom-title", customTitle: "fixture", sessionId: FORK_ID },
    ...conversationStart(repo, FORK_ID),
    {
      type: "user",
      uuid: uuid(11),
      timestamp: "2026-05-10T01:00:00.000Z",
      cwd: repo,
      sessionId: FORK_ID,
      message: { role: "user", content: [{ type: "text", text: "forked task" }] },
    },
    {
      type: "assistant",
      uuid: uuid(12),
      timestamp: "2026-05-10T01:00:01.000Z",
      cwd: repo,
      sessionId: FORK_ID,
      message: {
        id: "msg_12",
        usage: { output_tokens: 300 },
        content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm build" } }],
      },
    },
    ...extra,
  ];
}

/** A fork of the fork, taken after the fork's 01:00 command: it holds a copy of that too. */
function forkOfForkTranscript(repo: string): Array<Record<string, unknown>> {
  return [
    ...forkTranscript(repo)
      .slice(1)
      .map((record) => ({ ...record, sessionId: FORK_OF_FORK_ID })),
    commandRecord(repo, 21, "2026-05-10T03:00:00.000Z", FORK_OF_FORK_ID, "pnpm lint"),
  ];
}

function forkCtx(repo: string, createdAtMs: Record<string, number> = CREATED_AT_MS) {
  return {
    cwd: repo,
    claudeProjectsDir: getProjectsRoot(),
    transcriptCreatedAtMs: async (file: string) => createdAtMs[basename(file, ".jsonl")] ?? 0,
  };
}

async function transcriptPath(repo: string, sessionId: string): Promise<string> {
  return join(getProjectsRoot(), repo.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
}

async function sessionIdOf(repo: string, externalId: string): Promise<string> {
  for (const sid of await listSessionDirs(repo)) {
    const session = await readSession(repo, sid);
    if (session.session.source.external_id === externalId) return sid;
  }
  throw new Error(`no session for ${externalId}`);
}

async function commandsOf(repo: string, sid: string): Promise<string[]> {
  return (await readEvents(repo, sid))
    .filter((e) => e.type === "command_executed")
    .map((e) => commandLine(e) ?? "");
}

async function importJson(
  repo: string,
  options: Parameters<typeof doRunImportClaudeCode>[0],
  ctx: Parameters<typeof doRunImportClaudeCode>[1] = forkCtx(repo),
): Promise<Record<string, unknown> | undefined> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  });
  try {
    await doRunImportClaudeCode({ ...options, json: true }, ctx);
  } finally {
    spy.mockRestore();
  }
  return lines
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .find((r): r is Record<string, unknown> => r !== null && "imported_count" in r);
}

/** Import the fork while the original is not there, so it takes the copies (as before the fix). */
async function importForkWithCopies(repo: string): Promise<string> {
  await writeTranscript(repo, FORK_ID, forkTranscript(repo));
  await doRunImportClaudeCode({ all: true }, forkCtx(repo));
  const sid = await sessionIdOf(repo, FORK_ID);
  expect(await commandsOf(repo, sid)).toEqual(["git status", "pnpm build"]);
  return sid;
}

describe("basou import claude-code: forked transcripts", () => {
  it("imports a fork beside its original with only what the fork added", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    await writeTranscript(repo, FORK_ID, forkTranscript(repo));
    await doRunImportClaudeCode({ all: true }, forkCtx(repo));

    const original = await sessionIdOf(repo, ORIGINAL_ID);
    const fork = await sessionIdOf(repo, FORK_ID);
    expect(await commandsOf(repo, original)).toEqual(["git status", "git log"]);
    expect(await commandsOf(repo, fork)).toEqual(["pnpm build"]);
    const forkEvents = await readEvents(repo, fork);
    expect(forkEvents.filter((e) => e.type === "decision_recorded")).toHaveLength(0);
    const forkSession = await readSession(repo, fork);
    expect(forkSession.session.started_at).toBe("2026-05-10T01:00:00.000Z");
    expect(forkSession.session.metrics?.output_tokens).toBe(300);
    const originalSession = await readSession(repo, original);
    expect(originalSession.session.started_at).toBe("2026-05-10T00:00:00.000Z");
    expect(originalSession.session.metrics?.output_tokens).toBe(220);
    expect(
      (await readEvents(repo, original)).filter((e) => e.type === "decision_recorded"),
    ).toHaveLength(1);
  });

  it("decides which transcript is older by when its file was created, not by its name", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    await writeTranscript(repo, FORK_ID, forkTranscript(repo));
    // Reversed: the transcript holding the fork's records is now the older one,
    // so the other keeps only what it holds beyond the shared start.
    await doRunImportClaudeCode(
      { all: true },
      forkCtx(repo, { [ORIGINAL_ID]: 2_000, [FORK_ID]: 1_000 }),
    );
    expect(await commandsOf(repo, await sessionIdOf(repo, FORK_ID))).toEqual([
      "git status",
      "pnpm build",
    ]);
    expect(await commandsOf(repo, await sessionIdOf(repo, ORIGINAL_ID))).toEqual(["git log"]);
  });

  it("lets the session id decide when no birth time is recorded", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    await writeTranscript(repo, FORK_ID, forkTranscript(repo));
    await doRunImportClaudeCode({ all: true }, forkCtx(repo, {}));
    // "aaaaaaaa-fork" sorts first, so it is taken as the older one.
    expect(await commandsOf(repo, await sessionIdOf(repo, FORK_ID))).toEqual([
      "git status",
      "pnpm build",
    ]);
    expect(await commandsOf(repo, await sessionIdOf(repo, ORIGINAL_ID))).toEqual(["git log"]);
  });

  it("takes a transcript with a recorded birth time as older than one without", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    await writeTranscript(repo, FORK_ID, forkTranscript(repo));
    // The fork has no birth time (0), though its id sorts first.
    await doRunImportClaudeCode({ all: true }, forkCtx(repo, { [ORIGINAL_ID]: 1_000 }));
    expect(await commandsOf(repo, await sessionIdOf(repo, FORK_ID))).toEqual(["pnpm build"]);
    expect(await commandsOf(repo, await sessionIdOf(repo, ORIGINAL_ID))).toEqual([
      "git status",
      "git log",
    ]);
  });

  it("leaves a session alone when the older transcript is gone before it is read", async () => {
    const repo = await setupInitedRepo();
    const fork = await importForkWithCopies(repo);
    const eventsPath = join(basouPaths(repo).sessions, fork, "events.jsonl");
    const bytes = await readFile(eventsPath, "utf8");
    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    const originalPath = await transcriptPath(repo, ORIGINAL_ID);
    // Listed and grouped, then deleted before its records are read.
    const ctx = {
      ...forkCtx(repo),
      transcriptCreatedAtMs: async (file: string) => {
        if (file === originalPath) await rm(originalPath);
        return CREATED_AT_MS[basename(file, ".jsonl")] ?? 0;
      },
    };
    const result = await importJson(repo, { session: FORK_ID }, ctx);
    expect(result?.reimported_count).toBe(0);
    expect(result?.skipped_already_imported).toBe(1);
    expect(await readFile(eventsPath, "utf8")).toBe(bytes);
  });

  it("--session imports a fork without the copies, reading its original beside it", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    await writeTranscript(repo, FORK_ID, forkTranscript(repo));
    await doRunImportClaudeCode({ session: FORK_ID }, forkCtx(repo));
    expect(await listSessionDirs(repo)).toHaveLength(1);
    expect(await commandsOf(repo, await sessionIdOf(repo, FORK_ID))).toEqual(["pnpm build"]);
  });

  it("does not import a fork that added nothing of its own", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    await writeTranscript(repo, FORK_ID, [
      { type: "custom-title", customTitle: "fixture", sessionId: FORK_ID },
      ...conversationStart(repo, FORK_ID),
    ]);
    const result = await importJson(repo, { all: true });
    expect(result?.imported_count).toBe(1);
    expect(result?.skipped_no_action).toBe(1);
    expect(await commandsOf(repo, await sessionIdOf(repo, ORIGINAL_ID))).toEqual([
      "git status",
      "git log",
    ]);
  });

  it("re-derives a session imported with the copies, in place, though its transcript did not change", async () => {
    const repo = await setupInitedRepo();
    const fork = await importForkWithCopies(repo);
    const before = await readEvents(repo, fork);
    const buildBefore = before.find((e) => commandLine(e) === "pnpm build");
    const startedBefore = before.find((e) => e.type === "session_started");
    const forkSize = (await readFile(await transcriptPath(repo, FORK_ID))).length;

    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    const changes: Array<{ decisions: number; outputTokens: number }> = [];
    const result = await importJson(
      repo,
      { all: true },
      { ...forkCtx(repo), onReimportChange: (change) => changes.push(change) },
    );
    expect(result?.imported_count).toBe(1);
    expect(result?.reimported_count).toBe(1);
    expect(result?.dropped_copies_count).toBe(1);
    // The copied decision and the copied replies' tokens are what it took out;
    // the --json result does not carry them.
    expect(changes).toEqual([{ decisions: -1, outputTokens: -150 }]);
    expect(result).not.toHaveProperty("reimport_change");

    expect(await sessionIdOf(repo, FORK_ID)).toBe(fork);
    const after = await readEvents(repo, fork);
    expect(after.filter((e) => e.type === "command_executed").map(commandLine)).toEqual([
      "pnpm build",
    ]);
    expect(after.filter((e) => e.type === "decision_recorded")).toHaveLength(0);
    expect(after.find((e) => commandLine(e) === "pnpm build")?.id).toBe(buildBefore?.id);
    expect(after.find((e) => e.type === "session_started")?.id).toBe(startedBefore?.id);
    const session = await readSession(repo, fork);
    expect(session.session.started_at).toBe("2026-05-10T01:00:00.000Z");
    expect(session.session.metrics?.output_tokens).toBe(300);
    expect(session.session.source.source_size_bytes).toBe(forkSize);
    expect(session.session.label).toContain("1 command,");
    expect((await verifyEventsChain(basouPaths(repo), fork)).status).toBe("verified");

    // Done once: the next import leaves both alone.
    const again = await importJson(repo, { all: true });
    expect(again?.reimported_count).toBe(0);
    expect(again?.dropped_copies_count).toBe(0);
    expect(again?.skipped_already_imported).toBe(2);
  });

  it("counts a re-derived session as dropping copies even when the copies derived no event", async () => {
    const repo = await setupInitedRepo();
    // The copied stretch is talk only: a prompt and a reply with tokens.
    const talk = (sessionId: string): Array<Record<string, unknown>> => [
      {
        type: "user",
        uuid: uuid(1),
        timestamp: "2026-05-10T00:00:00.000Z",
        cwd: repo,
        sessionId,
        message: { role: "user", content: [{ type: "text", text: "go" }] },
      },
      {
        type: "assistant",
        uuid: uuid(2),
        timestamp: "2026-05-10T00:00:01.000Z",
        cwd: repo,
        sessionId,
        message: {
          id: "msg_1",
          usage: { output_tokens: 999 },
          content: [{ type: "text", text: "ok" }],
        },
      },
    ];
    const forkOwn = forkTranscript(repo).slice(-2);
    await writeTranscript(repo, FORK_ID, [...talk(FORK_ID), ...forkOwn]);
    await doRunImportClaudeCode({ all: true }, forkCtx(repo));
    const fork = await sessionIdOf(repo, FORK_ID);
    expect((await readSession(repo, fork)).session.metrics?.output_tokens).toBe(1299);

    await writeTranscript(repo, ORIGINAL_ID, talk(ORIGINAL_ID));
    const result = await importJson(repo, { all: true });
    expect(result?.reimported_count).toBe(1);
    expect(result?.dropped_copies_count).toBe(1);
    const session = await readSession(repo, fork);
    expect(session.session.started_at).toBe("2026-05-10T01:00:00.000Z");
    expect(session.session.metrics?.output_tokens).toBe(300);
  });

  it("leaves a fork imported with its copies as it is when it added no action of its own", async () => {
    const repo = await setupInitedRepo();
    const talkOnly = {
      type: "user",
      uuid: uuid(11),
      timestamp: "2026-05-10T01:00:00.000Z",
      cwd: repo,
      sessionId: FORK_ID,
      message: { role: "user", content: [{ type: "text", text: "just a question" }] },
    };
    await writeTranscript(repo, FORK_ID, [...conversationStart(repo, FORK_ID), talkOnly]);
    await doRunImportClaudeCode({ all: true }, forkCtx(repo));
    const fork = await sessionIdOf(repo, FORK_ID);
    const eventsPath = join(basouPaths(repo).sessions, fork, "events.jsonl");
    const bytes = await readFile(eventsPath, "utf8");

    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    const errors: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(" "));
    });
    let result: Record<string, unknown> | undefined;
    try {
      result = await importJson(repo, { all: true });
    } finally {
      errSpy.mockRestore();
    }
    expect(result?.reimported_count).toBe(0);
    expect(result?.skipped_no_action).toBe(1);
    expect(await readFile(eventsPath, "utf8")).toBe(bytes);
    expect(errors.join("\n")).toContain(
      `Import: ${FORK_ID} added no action of its own after the records it copied from an older transcript`,
    );
  });

  it("says so in the summary line", async () => {
    const repo = await setupInitedRepo();
    await importForkWithCopies(repo);
    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });
    try {
      await doRunImportClaudeCode({ all: true }, forkCtx(repo));
    } finally {
      spy.mockRestore();
    }
    expect(lines.join("\n")).toContain(
      "re-imported 1 changed session(s) (1 without the records its transcript copied from an older one; 1 fewer decision, 150 fewer output tokens)",
    );
  });

  it("sums what it took out over every session it re-imports", async () => {
    const repo = await setupInitedRepo();
    const SOLO = "bbbbbbbb-solo";
    const solo = (commands: string[]) =>
      commands.map((command, i) =>
        commandRecord(repo, 60 + i, `2026-05-11T00:0${i}:00.000Z`, SOLO, command),
      );
    await writeTranscript(repo, SOLO, solo(["ls"]));
    await importForkWithCopies(repo);
    // The fork leaves its copies out, and an unrelated session grows by a
    // command of 10 tokens: one run re-imports both.
    await writeTranscript(repo, SOLO, solo(["ls", "pwd"]));
    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    const changes: Array<{ decisions: number; outputTokens: number }> = [];
    const result = await importJson(
      repo,
      { all: true },
      { ...forkCtx(repo), onReimportChange: (change) => changes.push(change) },
    );
    expect(result?.reimported_count).toBe(2);
    expect(changes).toEqual([{ decisions: -1, outputTokens: -140 }]);
  });

  it("says in a dry run what the re-import would take out", async () => {
    const repo = await setupInitedRepo();
    await importForkWithCopies(repo);
    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });
    try {
      await doRunImportClaudeCode({ all: true, dryRun: true }, forkCtx(repo));
    } finally {
      spy.mockRestore();
    }
    expect(lines.join("\n")).toContain(
      "re-import 1 changed session(s) (1 without the records its transcript copied from an older one; 1 fewer decision, 150 fewer output tokens)",
    );
  });

  // Refresh a workspace whose fork is re-imported without its copies.
  async function refreshAfterFork(json: boolean): Promise<string> {
    const repo = await setupInitedRepo();
    await importForkWithCopies(repo);
    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });
    try {
      await doRunRefresh(json ? { json: true } : {}, {
        ...forkCtx(repo),
        codexSessionsDir: join(repo, "no-codex-sessions"),
        portfolioConfigPath: join(repo, "no-portfolio.yaml"),
      });
    } finally {
      spy.mockRestore();
    }
    return lines.join("\n");
  }

  it("refresh says what its re-import took out", async () => {
    expect(await refreshAfterFork(false)).toContain(
      "claude-code: imported 1 session(s), 5 events, 1 re-imported (1 without records copied from an older transcript; 1 fewer decision, 150 fewer output tokens)",
    );
  });

  it("refresh --json holds no more than before: what a re-import took out is not on its result", async () => {
    const out = await refreshAfterFork(true);
    const json = JSON.parse(out.slice(out.indexOf("{"))) as Record<string, Record<string, unknown>>;
    expect(json.claudeCode?.reimportedCount).toBe(1);
    expect(Object.keys(json.claudeCode ?? {}).sort()).toEqual(
      [
        "adapter",
        "status",
        "importedCount",
        "replacedCount",
        "reimportedCount",
        "droppedCopiesCount",
        "skippedNoAction",
        "skippedAlreadyImported",
        "skippedLegacyUntracked",
        "skippedDecreased",
        "skippedDuplicate",
        "skippedUnverifiable",
        "eventTotal",
        "dryRun",
      ].sort(),
    );
  });

  it("--dry-run previews the re-derivation and writes nothing", async () => {
    const repo = await setupInitedRepo();
    const fork = await importForkWithCopies(repo);
    const eventsPath = join(basouPaths(repo).sessions, fork, "events.jsonl");
    const bytes = await readFile(eventsPath, "utf8");
    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    const result = await importJson(repo, { all: true, dryRun: true });
    expect(result?.reimported_count).toBe(1);
    expect(result?.dropped_copies_count).toBe(1);
    expect(await readFile(eventsPath, "utf8")).toBe(bytes);
    expect(await listSessionDirs(repo)).toEqual([fork]);
  });

  it("keeps the copies out once the original is gone and the fork grows", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    await writeTranscript(repo, FORK_ID, forkTranscript(repo));
    await doRunImportClaudeCode({ all: true }, forkCtx(repo));
    const fork = await sessionIdOf(repo, FORK_ID);

    await rm(await transcriptPath(repo, ORIGINAL_ID));
    await writeTranscript(
      repo,
      FORK_ID,
      forkTranscript(repo, [
        {
          type: "assistant",
          uuid: uuid(13),
          timestamp: "2026-05-10T01:30:00.000Z",
          cwd: repo,
          sessionId: FORK_ID,
          message: {
            id: "msg_13",
            usage: { output_tokens: 40 },
            content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm test" } }],
          },
        },
      ]),
    );
    const result = await importJson(repo, { all: true });
    expect(result?.reimported_count).toBe(1);
    // A growth that drops nothing is not counted as dropping copies.
    expect(result?.dropped_copies_count).toBe(0);
    expect(await commandsOf(repo, fork)).toEqual(["pnpm build", "pnpm test"]);
    expect((await readSession(repo, fork)).session.started_at).toBe("2026-05-10T01:00:00.000Z");
  });

  it("--force re-creates a fork without the copies once the original is gone", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    await writeTranscript(repo, FORK_ID, forkTranscript(repo));
    await doRunImportClaudeCode({ all: true }, forkCtx(repo));
    const fork = await sessionIdOf(repo, FORK_ID);

    await rm(await transcriptPath(repo, ORIGINAL_ID));
    await doRunImportClaudeCode({ all: true, force: true }, forkCtx(repo));
    const recreated = await sessionIdOf(repo, FORK_ID);
    expect(recreated).not.toBe(fork);
    expect(await commandsOf(repo, recreated)).toEqual(["pnpm build"]);
  });

  it("still refuses a re-import that would drop an event from the fork's own time", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    await writeTranscript(
      repo,
      FORK_ID,
      forkTranscript(repo, [
        {
          type: "assistant",
          uuid: uuid(13),
          timestamp: "2026-05-10T01:30:00.000Z",
          cwd: repo,
          sessionId: FORK_ID,
          message: {
            id: "msg_13",
            content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm test" } }],
          },
        },
      ]),
    );
    await doRunImportClaudeCode({ all: true }, forkCtx(repo));
    const fork = await sessionIdOf(repo, FORK_ID);

    // A non-append rewrite that loses the fork's own 01:30 command but grows.
    await writeTranscript(
      repo,
      FORK_ID,
      forkTranscript(repo, [
        {
          type: "user",
          uuid: uuid(14),
          timestamp: "2026-05-10T01:40:00.000Z",
          cwd: repo,
          sessionId: FORK_ID,
          message: {
            role: "user",
            content: [{ type: "text", text: "a longer prompt ".repeat(40) }],
          },
        },
      ]),
    );
    const result = await importJson(repo, { all: true });
    expect(result?.skipped_unverifiable).toBe(1);
    expect(await commandsOf(repo, fork)).toEqual(["pnpm build", "pnpm test"]);
  });

  it("keeps the shared records where they are when the birth times flip after an import", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    await writeTranscript(repo, FORK_ID, forkTranscript(repo));
    await doRunImportClaudeCode({ all: true }, forkCtx(repo));
    const original = await sessionIdOf(repo, ORIGINAL_ID);
    const fork = await sessionIdOf(repo, FORK_ID);
    const eventsOf = (sid: string) =>
      readFile(join(basouPaths(repo).sessions, sid, "events.jsonl"), "utf8");
    const originalBytes = await eventsOf(original);
    const forkBytes = await eventsOf(fork);

    // Restored from a backup: the fork's file is now the older one.
    const result = await importJson(repo, { all: true }, forkCtx(repo, FLIPPED_CREATED_AT_MS));
    expect(result?.reimported_count).toBe(0);
    expect(result?.dropped_copies_count).toBe(0);
    expect(result?.skipped_already_imported).toBe(2);
    expect(await eventsOf(original)).toBe(originalBytes);
    expect(await eventsOf(fork)).toBe(forkBytes);
  });

  it("re-imports a grown original without dropping the shared records after the birth times flip", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    await writeTranscript(repo, FORK_ID, forkTranscript(repo));
    await doRunImportClaudeCode({ all: true }, forkCtx(repo));
    const original = await sessionIdOf(repo, ORIGINAL_ID);

    await writeTranscript(repo, ORIGINAL_ID, [
      ...originalTranscript(repo),
      commandRecord(repo, 6, "2026-05-10T03:00:00.000Z", ORIGINAL_ID, "git diff"),
    ]);
    const result = await importJson(repo, { all: true }, forkCtx(repo, FLIPPED_CREATED_AT_MS));
    expect(result?.reimported_count).toBe(1);
    expect(result?.dropped_copies_count).toBe(0);
    expect(await commandsOf(repo, original)).toEqual(["git status", "git log", "git diff"]);
    expect(
      (await readEvents(repo, original)).filter((e) => e.type === "decision_recorded"),
    ).toHaveLength(1);
    expect((await readSession(repo, original)).session.started_at).toBe("2026-05-10T00:00:00.000Z");
    expect(await commandsOf(repo, await sessionIdOf(repo, FORK_ID))).toEqual(["pnpm build"]);
  });

  it("keeps what a later fork copied from a fork in that fork when their birth times flip", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    await writeTranscript(repo, FORK_ID, forkTranscript(repo));
    // Forked from the fork after its 01:00 command, so it holds a copy of that too.
    await writeTranscript(repo, FORK_OF_FORK_ID, forkOfForkTranscript(repo));
    await doRunImportClaudeCode(
      { all: true },
      forkCtx(repo, { [ORIGINAL_ID]: 1_000, [FORK_ID]: 2_000, [FORK_OF_FORK_ID]: 3_000 }),
    );
    const fork = await sessionIdOf(repo, FORK_ID);
    const forkOfFork = await sessionIdOf(repo, FORK_OF_FORK_ID);
    expect(await commandsOf(repo, forkOfFork)).toEqual(["pnpm lint"]);

    // The two forks' files flip, and the first fork goes on.
    await writeTranscript(
      repo,
      FORK_ID,
      forkTranscript(repo, [
        commandRecord(repo, 13, "2026-05-10T04:00:00.000Z", FORK_ID, "pnpm test"),
      ]),
    );
    const result = await importJson(
      repo,
      { all: true },
      forkCtx(repo, { [ORIGINAL_ID]: 1_000, [FORK_ID]: 3_000, [FORK_OF_FORK_ID]: 2_000 }),
    );
    expect(result?.reimported_count).toBe(1);
    expect(await commandsOf(repo, fork)).toEqual(["pnpm build", "pnpm test"]);
    expect((await readSession(repo, fork)).session.started_at).toBe("2026-05-10T01:00:00.000Z");
    expect(await commandsOf(repo, forkOfFork)).toEqual(["pnpm lint"]);
    expect(await commandsOf(repo, await sessionIdOf(repo, ORIGINAL_ID))).toEqual([
      "git status",
      "git log",
    ]);
  });

  it("--force re-creates the sessions in the order they began after the birth times flip", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    await writeTranscript(repo, FORK_ID, forkTranscript(repo));
    await doRunImportClaudeCode({ all: true }, forkCtx(repo));

    await doRunImportClaudeCode({ all: true, force: true }, forkCtx(repo, FLIPPED_CREATED_AT_MS));
    expect(await listSessionDirs(repo)).toHaveLength(2);
    expect(await commandsOf(repo, await sessionIdOf(repo, ORIGINAL_ID))).toEqual([
      "git status",
      "git log",
    ]);
    expect(await commandsOf(repo, await sessionIdOf(repo, FORK_ID))).toEqual(["pnpm build"]);
  });

  it("re-derives a fork imported with its copies beside an original imported with them too", async () => {
    const repo = await setupInitedRepo();
    const fork = await importForkWithCopies(repo);
    // The original is imported on its own, so both sessions begin at the
    // conversation's first record, as an earlier basou left them.
    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    await doRunImportClaudeCode({ session: ORIGINAL_ID }, forkCtx(repo));
    const original = await sessionIdOf(repo, ORIGINAL_ID);
    expect(await commandsOf(repo, original)).toEqual(["git status", "git log"]);
    expect(await commandsOf(repo, fork)).toEqual(["git status", "pnpm build"]);

    // They begin together, so their files' birth times decide.
    const result = await importJson(repo, { all: true });
    expect(result?.reimported_count).toBe(1);
    expect(result?.dropped_copies_count).toBe(1);
    expect(await commandsOf(repo, original)).toEqual(["git status", "git log"]);
    expect(await commandsOf(repo, fork)).toEqual(["pnpm build"]);
  });

  it("imports a new fork of an imported original with only what the fork added", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    await doRunImportClaudeCode({ all: true }, forkCtx(repo));
    const original = await sessionIdOf(repo, ORIGINAL_ID);
    const originalBytes = await readFile(
      join(basouPaths(repo).sessions, original, "events.jsonl"),
      "utf8",
    );

    await writeTranscript(repo, FORK_ID, forkTranscript(repo));
    const result = await importJson(repo, { all: true });
    expect(result?.imported_count).toBe(1);
    expect(result?.reimported_count).toBe(0);
    expect(await commandsOf(repo, await sessionIdOf(repo, FORK_ID))).toEqual(["pnpm build"]);
    expect(await readFile(join(basouPaths(repo).sessions, original, "events.jsonl"), "utf8")).toBe(
      originalBytes,
    );
  });

  it("places a transcript not imported yet by its birth time", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    await writeTranscript(repo, FORK_ID, forkTranscript(repo));
    await doRunImportClaudeCode({ all: true }, forkCtx(repo));

    // A new fork of the fork, after its 01:00 command.
    await writeTranscript(repo, FORK_OF_FORK_ID, forkOfForkTranscript(repo));
    const result = await importJson(
      repo,
      { all: true },
      forkCtx(repo, { [ORIGINAL_ID]: 1_000, [FORK_ID]: 2_000, [FORK_OF_FORK_ID]: 3_000 }),
    );
    expect(result?.imported_count).toBe(1);
    expect(result?.skipped_already_imported).toBe(2);
    expect(await commandsOf(repo, await sessionIdOf(repo, FORK_OF_FORK_ID))).toEqual(["pnpm lint"]);
  });

  it("places a transcript not imported yet after an imported fork it copied from, whatever its birth time", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    await writeTranscript(repo, FORK_ID, forkTranscript(repo));
    await doRunImportClaudeCode({ all: true }, forkCtx(repo));
    const fork = await sessionIdOf(repo, FORK_ID);
    await writeTranscript(repo, FORK_OF_FORK_ID, forkOfForkTranscript(repo));

    // Restored in name order: the new transcript's birth time falls between
    // the two imported ones, which keep the order their sessions began in.
    const restored = { [FORK_ID]: 1_000, [FORK_OF_FORK_ID]: 2_000, [ORIGINAL_ID]: 3_000 };
    const result = await importJson(repo, { all: true }, forkCtx(repo, restored));
    expect(result?.imported_count).toBe(1);
    expect(result?.reimported_count).toBe(0);
    const forkOfFork = await sessionIdOf(repo, FORK_OF_FORK_ID);
    expect(await commandsOf(repo, forkOfFork)).toEqual(["pnpm lint"]);
    expect((await readSession(repo, forkOfFork)).session.started_at).toBe(
      "2026-05-10T03:00:00.000Z",
    );
    expect(await commandsOf(repo, fork)).toEqual(["pnpm build"]);
    expect(await commandsOf(repo, await sessionIdOf(repo, ORIGINAL_ID))).toEqual([
      "git status",
      "git log",
    ]);
  });

  it("keeps the shared records with the original when a new fork of a fork is restored first", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, ORIGINAL_ID, originalTranscript(repo));
    await writeTranscript(repo, FORK_ID, forkTranscript(repo));
    await doRunImportClaudeCode({ all: true }, forkCtx(repo));
    await writeTranscript(repo, FORK_OF_FORK_ID, forkOfForkTranscript(repo));

    const restored = { [FORK_OF_FORK_ID]: 1_000, [FORK_ID]: 2_000, [ORIGINAL_ID]: 3_000 };
    const result = await importJson(repo, { all: true }, forkCtx(repo, restored));
    expect(result?.imported_count).toBe(1);
    expect(result?.reimported_count).toBe(0);
    expect(await commandsOf(repo, await sessionIdOf(repo, ORIGINAL_ID))).toEqual([
      "git status",
      "git log",
    ]);
    expect(await commandsOf(repo, await sessionIdOf(repo, FORK_ID))).toEqual(["pnpm build"]);
    expect(await commandsOf(repo, await sessionIdOf(repo, FORK_OF_FORK_ID))).toEqual(["pnpm lint"]);
  });

  it("keeps an original not imported yet before an imported fork that it holds nothing of", async () => {
    const repo = await setupInitedRepo();
    // The conversation is talk only until it forks, so the original is not
    // imported, and the fork is imported with what it added.
    const talk = (sessionId: string): Array<Record<string, unknown>> => [
      {
        type: "user",
        uuid: uuid(1),
        timestamp: "2026-05-10T00:00:00.000Z",
        cwd: repo,
        sessionId,
        message: { role: "user", content: [{ type: "text", text: "go" }] },
      },
      {
        type: "assistant",
        uuid: uuid(2),
        timestamp: "2026-05-10T00:00:01.000Z",
        cwd: repo,
        sessionId,
        message: {
          id: "msg_1",
          usage: { output_tokens: 999 },
          content: [{ type: "text", text: "ok" }],
        },
      },
    ];
    await writeTranscript(repo, ORIGINAL_ID, talk(ORIGINAL_ID));
    await writeTranscript(repo, FORK_ID, [...talk(FORK_ID), ...forkTranscript(repo).slice(-2)]);
    await doRunImportClaudeCode({ all: true }, forkCtx(repo));
    expect(await listSessionDirs(repo)).toHaveLength(1);
    const fork = await sessionIdOf(repo, FORK_ID);
    expect((await readSession(repo, fork)).session.started_at).toBe("2026-05-10T01:00:00.000Z");

    // The original goes on and runs a command of its own.
    await writeTranscript(repo, ORIGINAL_ID, [
      ...talk(ORIGINAL_ID),
      commandRecord(repo, 6, "2026-05-10T02:00:00.000Z", ORIGINAL_ID, "git log"),
    ]);
    const result = await importJson(repo, { all: true });
    expect(result?.imported_count).toBe(1);
    const original = await sessionIdOf(repo, ORIGINAL_ID);
    expect(await commandsOf(repo, original)).toEqual(["git log"]);
    const originalSession = await readSession(repo, original);
    expect(originalSession.session.started_at).toBe("2026-05-10T00:00:00.000Z");
    expect(originalSession.session.metrics?.output_tokens).toBe(1009);
    expect(await commandsOf(repo, fork)).toEqual(["pnpm build"]);
  });
});

describe("basou import codex — scoped re-import of a grown source", () => {
  it("re-imports a grown rollout into the same session id", async () => {
    const repo = await setupInitedRepo();
    await writeRollout("codex-1", codexActionRollout(repo, "codex-1"));
    await doRunImportCodex({ all: true }, { cwd: repo, codexSessionsDir: getCodexRoot() });
    const sid = (await listSessionDirs(repo))[0] as string;
    expect((await readEvents(repo, sid)).filter((e) => e.type === "command_executed")).toHaveLength(
      1,
    );

    await writeRollout("codex-1", grownCodexRollout(repo, "codex-1"));
    await doRunImportCodex({ all: true }, { cwd: repo, codexSessionsDir: getCodexRoot() });

    expect(await listSessionDirs(repo)).toEqual([sid]);
    expect((await readEvents(repo, sid)).filter((e) => e.type === "command_executed")).toHaveLength(
      2,
    );
  });

  it("refreshes a command's outcome on re-import while keeping its event id", async () => {
    const repo = await setupInitedRepo();
    const meta = {
      type: "session_meta",
      timestamp: "2026-05-10T00:00:00.000Z",
      payload: { id: "codex-1", cwd: repo, timestamp: "2026-05-10T00:00:00.000Z" },
    };
    const call = {
      type: "response_item",
      timestamp: "2026-05-10T00:00:01.000Z",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "ls", workdir: repo }),
        call_id: "c1",
      },
    };
    // First import: the command is still running (no function_call_output yet),
    // so both its exit_code and its duration are unobserved (null).
    await writeRollout("codex-1", [meta, call]);
    await doRunImportCodex({ all: true }, { cwd: repo, codexSessionsDir: getCodexRoot() });
    const sid = (await listSessionDirs(repo))[0] as string;
    type CmdEvent = StoredEvent & { exit_code: number | null; duration_ms: number | null };
    const cmdBefore = (await readEvents(repo, sid)).find(
      (e) => e.type === "command_executed",
    ) as CmdEvent;
    expect(cmdBefore.exit_code).toBeNull();
    expect(cmdBefore.duration_ms).toBeNull();

    // The command completes: its output is appended (file grows). Re-import must
    // refresh the outcome while keeping the same event id.
    await writeRollout("codex-1", [
      meta,
      call,
      {
        type: "response_item",
        timestamp: "2026-05-10T00:00:02.000Z",
        payload: {
          type: "function_call_output",
          call_id: "c1",
          output: "Wall time: 0.5000 seconds\nProcess exited with code 0\n",
        },
      },
    ]);
    await doRunImportCodex({ all: true }, { cwd: repo, codexSessionsDir: getCodexRoot() });

    const cmdAfter = (await readEvents(repo, sid)).find(
      (e) => e.type === "command_executed",
    ) as CmdEvent;
    expect(cmdAfter.id).toBe(cmdBefore.id); // id reused (linked_events stable)
    expect(cmdAfter.exit_code).toBe(0); // outcome refreshed
    expect(cmdAfter.duration_ms).toBe(500);
  });
});

describe("basou import claude-code (cross-project boundary warning)", () => {
  it("warns when a session edited files outside the declared source_roots", async () => {
    const repo = await realpath(tmpRepo as string);
    const paths = await ensureBasouDirectory(repo);
    // Declare source_roots = the repo itself; a sibling repo is out-of-bounds.
    await writeManifest(
      paths,
      createManifest({
        workspaceName: "fixture-ws",
        now: FIXED_DATE,
        workspaceId: FIXED_WS_ID,
        sourceRoots: ["."],
      }),
    );
    const outside = await mkdtemp(join(tmpdir(), "basou-import-outside-"));
    try {
      await writeTranscript(repo, "sess-x", [
        {
          type: "assistant",
          timestamp: "2026-05-10T00:00:01.000Z",
          cwd: repo,
          message: {
            content: [{ type: "tool_use", name: "Edit", input: { file_path: `${repo}/in.ts` } }],
          },
        },
        {
          type: "assistant",
          timestamp: "2026-05-10T00:00:02.000Z",
          cwd: repo,
          message: {
            content: [
              { type: "tool_use", name: "Edit", input: { file_path: `${outside}/blog.ts` } },
            ],
          },
        },
      ]);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await doRunImportClaudeCode(
        { all: true },
        { cwd: repo, claudeProjectsDir: getProjectsRoot() },
      );
      const warnings = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warnings).toContain("outside this project's source_roots");
      expect(warnings).toContain(`${outside}/blog.ts`);
      expect(warnings).not.toContain(`${repo}/in.ts`);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("prints a file outside source_roots escaped, so the terminal never gets its raw bytes", async () => {
    const repo = await realpath(tmpRepo as string);
    const paths = await ensureBasouDirectory(repo);
    await writeManifest(
      paths,
      createManifest({
        workspaceName: "fixture-ws",
        now: FIXED_DATE,
        workspaceId: FIXED_WS_ID,
        sourceRoots: ["."],
      }),
    );
    const forged = "/etc/new\n\n## Forged section\ntext\u001b[2J.txt";
    await writeTranscript(repo, "sess-forged", [
      {
        type: "assistant",
        timestamp: "2026-05-10T00:00:01.000Z",
        cwd: repo,
        message: {
          content: [{ type: "tool_use", name: "Edit", input: { file_path: forged } }],
        },
      },
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await doRunImportClaudeCode(
        { all: true },
        { cwd: repo, claudeProjectsDir: getProjectsRoot() },
      );
      const warnings = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warnings).toContain("outside this project's source_roots");
      expect(warnings).toContain("/etc/new\\n\\n## Forged section\\ntext\\x1b[2J.txt");
      expect(warnings).not.toContain("\u001b");
      expect(warnings).not.toMatch(/^## Forged section/m);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("does not warn for a solo project (no declared source_roots)", async () => {
    const repo = await setupInitedRepo();
    const outside = await mkdtemp(join(tmpdir(), "basou-import-outside-"));
    try {
      await writeTranscript(repo, "sess-y", [
        {
          type: "assistant",
          timestamp: "2026-05-10T00:00:02.000Z",
          cwd: repo,
          message: {
            content: [
              { type: "tool_use", name: "Edit", input: { file_path: `${outside}/blog.ts` } },
            ],
          },
        },
      ]);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await doRunImportClaudeCode(
        { all: true },
        { cwd: repo, claudeProjectsDir: getProjectsRoot() },
      );
      const warnings = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warnings).not.toContain("outside this project's source_roots");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("warns when an explicit --project flag declares the boundary (no manifest source_roots)", async () => {
    // The boundary can be declared by --project even with no manifest
    // source_roots; the warning must still fire in that case.
    const repo = await setupInitedRepo();
    const outside = await mkdtemp(join(tmpdir(), "basou-import-outside-"));
    try {
      await writeTranscript(repo, "sess-z", [
        {
          type: "assistant",
          timestamp: "2026-05-10T00:00:02.000Z",
          cwd: repo,
          message: {
            content: [
              { type: "tool_use", name: "Edit", input: { file_path: `${outside}/blog.ts` } },
            ],
          },
        },
      ]);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await doRunImportClaudeCode(
        { all: true, project: ["."] },
        { cwd: repo, claudeProjectsDir: getProjectsRoot() },
      );
      const warnings = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warnings).toContain("outside this project's source_roots");
      expect(warnings).toContain(`${outside}/blog.ts`);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

// POSIX only: creating a symlink needs privileges on Windows.
describe.skipIf(process.platform === "win32")(
  "basou import with an entry named as a session that is not a directory",
  () => {
    const WARNING = "not checked for an earlier import";

    it("warns once, with the full id, when a session is imported as new", async () => {
      const repo = await setupInitedRepo();
      await writeTranscript(repo, "sess-1", actionTranscript(repo));
      await writeTranscript(repo, "sess-2", actionTranscript(repo));
      const ctx = { cwd: repo, claudeProjectsDir: getProjectsRoot() };
      await doRunImportClaudeCode({ session: "sess-1" }, ctx);
      const [linked] = await listSessionDirs(repo);
      if (linked === undefined) throw new Error("fixture import failed");
      // The earlier import moved out of the store and linked back in.
      const paths = basouPaths(repo);
      await rename(join(paths.sessions, linked), join(repo, "moved-session"));
      await symlink(join(repo, "moved-session"), join(paths.sessions, linked));
      const fileId = "ses_01HXABCDEF1234567890ABCFX1";
      await writeFile(join(paths.sessions, fileId), "");

      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await doRunImportClaudeCode({ all: true }, ctx);
      const warnings = err.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(WARNING));
      expect(warnings).toEqual([
        `Import: ${[linked, fileId].sort().join(", ")} are not directories (a symlink or a file is not followed), so they were not checked for an earlier import; a session imported there may be imported again`,
      ]);
      // The link is not followed, so sess-1 is imported again beside it.
      expect(
        (await listSessionDirs(repo)).filter((d) => d !== linked && d !== fileId),
      ).toHaveLength(2);

      // Nothing left to import as new: no warning, and none when --force
      // replaces sessions whose earlier import was found.
      for (const options of [{ all: true }, { all: true, force: true }]) {
        err.mockClear();
        await doRunImportClaudeCode(options, ctx);
        expect(err.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(WARNING))).toEqual(
          [],
        );
      }
    });

    it("warns once, with the full id, about a session whose session.yaml is not a regular file", async () => {
      const repo = await setupInitedRepo();
      await writeTranscript(repo, "sess-1", actionTranscript(repo));
      await writeTranscript(repo, "sess-2", actionTranscript(repo));
      const ctx = { cwd: repo, claudeProjectsDir: getProjectsRoot() };
      await doRunImportClaudeCode({ session: "sess-1" }, ctx);
      const [linked] = await listSessionDirs(repo);
      if (linked === undefined) throw new Error("fixture import failed");
      // The earlier import's session.yaml moved out and linked back in.
      const yaml = join(basouPaths(repo).sessions, linked, "session.yaml");
      await rename(yaml, join(repo, "moved-session.yaml"));
      await symlink(join(repo, "moved-session.yaml"), yaml);

      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await doRunImportClaudeCode({ all: true }, ctx);
      const warnings = err.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(WARNING));
      expect(warnings).toEqual([
        `Import: the session.yaml of ${linked} is not a regular file (a symlink or anything else is not followed), so it was not checked for an earlier import; a session imported there may be imported again`,
      ]);
      // The link is not followed, so sess-1 is imported again beside it.
      expect((await listSessionDirs(repo)).filter((d) => d !== linked)).toHaveLength(2);
    });

    it("a .basou/sessions that is a symlink stops the import, --dry-run included", async () => {
      const repo = await setupInitedRepo();
      await writeTranscript(repo, "sess-1", actionTranscript(repo));
      const paths = basouPaths(repo);
      const outside = join(repo, "outside-store");
      await mkdir(outside);
      await rm(paths.sessions, { recursive: true });
      await symlink(outside, paths.sessions);
      const ctx = { cwd: repo, claudeProjectsDir: getProjectsRoot() };
      await expect(doRunImportClaudeCode({ all: true, dryRun: true }, ctx)).rejects.toThrow(
        ".basou/sessions is a symlink; refusing to operate",
      );
      await expect(doRunImportClaudeCode({ all: true }, ctx)).rejects.toThrow(
        ".basou/sessions is a symlink; refusing to operate",
      );
      expect(await readdir(outside)).toEqual([]);
    });
  },
);

// The hooks that write observations have no reader for stderr, and an import
// reads a refused directory as no observation at all, so this line is the one
// place the refusal shows.
describe.skipIf(process.platform === "win32")(
  "basou import with an observations directory that is refused",
  () => {
    const NOTICE = "not observed there";

    function noticesOf(err: { mock: { calls: unknown[][] } }): string[] {
      return err.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(NOTICE));
    }

    async function relatedFilesOf(repo: string): Promise<string[][]> {
      const out: string[][] = [];
      for (const dir of (await listSessionDirs(repo)).sort()) {
        const yaml = join(basouPaths(repo).sessions, dir, "session.yaml");
        out.push(SessionSchema.parse(await readYamlFile(yaml)).session.related_files);
      }
      return out;
    }

    it("says once per run, naming the directory and the workspace, that a symlinked .basou/tmp is not read", async () => {
      const repo = await setupInitedRepo();
      await writeTranscript(repo, "sess-1", actionTranscript(repo));
      await writeTranscript(repo, "sess-2", actionTranscript(repo));
      const paths = basouPaths(repo);
      const outside = join(repo, "outside-tmp");
      // An observation the import would read if it followed the link.
      await writeSessionObservation(join(outside, "observations"), {
        schema_version: SESSION_OBSERVATION_SCHEMA_VERSION,
        external_id: "sess-1",
        started_at: "2026-05-10T00:00:00.000Z",
        updated_at: "2026-05-10T00:00:02.000Z",
        repos: [
          {
            path: repo,
            base_head: null,
            base_dirty: [],
            files: [{ path: `${repo}/observed.ts`, change_type: "added" }],
          },
        ],
      });
      await rm(paths.tmp, { recursive: true });
      await symlink(outside, paths.tmp);

      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await doRunImportClaudeCode(
        { all: true },
        { cwd: repo, claudeProjectsDir: getProjectsRoot() },
      );

      expect(noticesOf(err)).toEqual([
        `basou: .basou/tmp is a symlink; refusing to operate (in ${repo}). The files a session changes through the shell are not observed there, so a session imported now records only the files its transcript names.`,
      ]);
      // What the line says: both sessions hold only what their transcripts name.
      expect(await relatedFilesOf(repo)).toEqual([["a.ts"], ["a.ts"]]);
    });

    it("names .basou/tmp/observations when it is a file, --dry-run included", async () => {
      const repo = await setupInitedRepo();
      await writeTranscript(repo, "sess-1", actionTranscript(repo));
      await writeFile(basouPaths(repo).observations, "");
      const ctx = { cwd: repo, claudeProjectsDir: getProjectsRoot() };

      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      await doRunImportClaudeCode({ all: true, dryRun: true }, ctx);
      await doRunImportClaudeCode({ all: true }, ctx);

      const expected = `basou: .basou/tmp/observations exists but is not a directory (in ${repo}). The files a session changes through the shell are not observed there, so a session imported now records only the files its transcript names.`;
      expect(noticesOf(err)).toEqual([expected, expected]);
    });

    it("says it before the transcripts are looked for, so a run that finds none says it too", async () => {
      const repo = await setupInitedRepo();
      const paths = basouPaths(repo);
      await rm(paths.tmp, { recursive: true });
      await symlink(join(repo, "outside-tmp"), paths.tmp);
      const ctx = { cwd: repo, claudeProjectsDir: getProjectsRoot() };

      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await expect(doRunImportClaudeCode({ all: true }, ctx)).rejects.toThrow(
        "Claude transcript directory not found for project",
      );

      expect(noticesOf(err)).toEqual([
        `basou: .basou/tmp is a symlink; refusing to operate (in ${repo}). The files a session changes through the shell are not observed there, so a session imported now records only the files its transcript names.`,
      ]);
    });

    it("says nothing when observations can be read, or when there is no directory", async () => {
      const repo = await setupInitedRepo();
      await writeTranscript(repo, "sess-1", actionTranscript(repo));
      const paths = basouPaths(repo);
      await writeSessionObservation(paths.observations, {
        schema_version: SESSION_OBSERVATION_SCHEMA_VERSION,
        external_id: "sess-1",
        started_at: "2026-05-10T00:00:00.000Z",
        updated_at: "2026-05-10T00:00:02.000Z",
        repos: [{ path: repo, base_head: null, base_dirty: [], files: [] }],
      });
      const ctx = { cwd: repo, claudeProjectsDir: getProjectsRoot() };

      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await doRunImportClaudeCode({ all: true }, ctx);
      await rm(paths.tmp, { recursive: true });
      await doRunImportClaudeCode({ all: true, force: true }, ctx);

      expect(noticesOf(err)).toEqual([]);
    });

    it("the codex import, which reads no observation, says nothing", async () => {
      const repo = await setupInitedRepo();
      await writeRollout("codex-1", codexActionRollout(repo, "codex-1"));
      const paths = basouPaths(repo);
      await rm(paths.tmp, { recursive: true });
      await symlink(join(repo, "outside-tmp"), paths.tmp);

      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await doRunImportCodex({ all: true }, { cwd: repo, codexSessionsDir: getCodexRoot() });

      expect(noticesOf(err)).toEqual([]);
      expect(await listSessionDirs(repo)).toHaveLength(1);
    });
  },
);

describe("basou import claude-code from a workspace view", () => {
  it("resolves a git-untracked view to the repo it links and imports there", async () => {
    const repo = await setupInitedRepo();
    await writeTranscript(repo, "sess-view", actionTranscript(repo));
    const view = await mkdtemp(join(tmpdir(), "basou-import-view-"));
    try {
      await symlink(repo, join(view, "fixture-planning"));
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      await doRunImportClaudeCode(
        { all: true },
        { cwd: view, claudeProjectsDir: getProjectsRoot() },
      );
      expect(await listSessionDirs(repo)).toHaveLength(1);
      expect(err.mock.calls.flat().join(" ")).toContain("Resolved workspace view to");
      expect(await readdir(view)).toEqual(["fixture-planning"]);
    } finally {
      await rm(view, { recursive: true, force: true });
    }
  });
});
