import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    // so its exit_code is null and duration is 0.
    await writeRollout("codex-1", [meta, call]);
    await doRunImportCodex({ all: true }, { cwd: repo, codexSessionsDir: getCodexRoot() });
    const sid = (await listSessionDirs(repo))[0] as string;
    type CmdEvent = StoredEvent & { exit_code: number | null; duration_ms: number };
    const cmdBefore = (await readEvents(repo, sid)).find(
      (e) => e.type === "command_executed",
    ) as CmdEvent;
    expect(cmdBefore.exit_code).toBeNull();
    expect(cmdBefore.duration_ms).toBe(0);

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
