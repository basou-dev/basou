import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { basouPaths, createManifest, ensureBasouDirectory, writeManifest } from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doRunRefresh, runRefresh } from "./refresh.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
};

const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const FIXED_DATE = new Date("2026-05-09T03:00:00.000Z");

let tmpRepo: string | undefined;
let claudeRoot: string | undefined;
let codexRoot: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-refresh-test-"));
  claudeRoot = await mkdtemp(join(tmpdir(), "basou-refresh-claude-"));
  codexRoot = await mkdtemp(join(tmpdir(), "basou-refresh-codex-"));
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

function getClaudeRoot(): string {
  if (claudeRoot === undefined) throw new Error("claudeRoot not initialized");
  return claudeRoot;
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

async function writeClaudeTranscript(repo: string): Promise<void> {
  const encoded = repo.replaceAll("/", "-");
  const dir = join(getClaudeRoot(), encoded);
  await mkdir(dir, { recursive: true });
  const records = [
    {
      type: "user",
      timestamp: "2026-05-10T00:00:00.000Z",
      cwd: repo,
      sessionId: "claude-sess-1",
      message: { role: "user", content: [{ type: "text", text: "go" }] },
    },
    {
      type: "assistant",
      timestamp: "2026-05-10T00:00:01.000Z",
      cwd: repo,
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] },
    },
  ];
  await writeFile(
    join(dir, "claude-sess-1.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n"),
  );
}

async function writeCodexRollout(repo: string): Promise<void> {
  const dir = join(getCodexRoot(), "2026", "05", "10");
  await mkdir(dir, { recursive: true });
  const records = [
    {
      type: "session_meta",
      timestamp: "2026-05-10T00:00:00.000Z",
      payload: { id: "codex-1", cwd: repo, timestamp: "2026-05-10T00:00:00.000Z" },
    },
    {
      type: "response_item",
      timestamp: "2026-05-10T00:00:01.000Z",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "ls", workdir: repo }),
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
    join(dir, "rollout-codex-1.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n"),
  );
}

function ctxFor(repo: string) {
  return { cwd: repo, claudeProjectsDir: getClaudeRoot(), codexSessionsDir: getCodexRoot() };
}

describe("basou refresh", () => {
  it("imports both adapters and regenerates handoff + decisions in one run", async () => {
    const repo = await setupInitedRepo();
    await writeClaudeTranscript(repo);
    await writeCodexRollout(repo);

    const result = await doRunRefresh({}, ctxFor(repo));

    expect(result.claudeCode.status).toBe("ran");
    expect(result.codex.status).toBe("ran");
    if (result.claudeCode.status === "ran") expect(result.claudeCode.importedCount).toBe(1);
    if (result.codex.status === "ran") expect(result.codex.importedCount).toBe(1);
    expect(result.handoff.status).toBe("generated");
    expect(result.decisions.status).toBe("generated");

    const paths = basouPaths(repo);
    await expect(access(paths.files.handoff)).resolves.toBeUndefined();
    const handoffBody = await readFile(paths.files.handoff, "utf8");
    expect(handoffBody).toContain("BASOU:GENERATED");
    await expect(access(paths.files.decisions)).resolves.toBeUndefined();
  });

  it("is best-effort: a missing adapter source dir is skipped, the other still imports", async () => {
    const repo = await setupInitedRepo();
    // Only Codex has logs; the Claude per-project transcript dir never exists.
    await writeCodexRollout(repo);

    const result = await doRunRefresh({}, ctxFor(repo));

    expect(result.claudeCode.status).toBe("skipped");
    expect(result.codex.status).toBe("ran");
    expect(result.handoff.status).toBe("generated");
  });

  it("--dry-run previews imports and leaves handoff / decisions unwritten", async () => {
    const repo = await setupInitedRepo();
    await writeCodexRollout(repo);

    const result = await doRunRefresh({ dryRun: true }, ctxFor(repo));

    expect(result.dryRun).toBe(true);
    if (result.codex.status === "ran") {
      expect(result.codex.dryRun).toBe(true);
      expect(result.codex.importedCount).toBe(1);
    }
    expect(result.handoff.status).toBe("skipped");
    expect(result.decisions.status).toBe("skipped");

    const paths = basouPaths(repo);
    await expect(access(paths.files.handoff)).rejects.toThrow();
  });

  it("errors with exit code 1 on an uninitialized workspace", async () => {
    const repo = await realpath(tmpRepo as string);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runRefresh({}, ctxFor(repo));
    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.flat().join(" ")).toContain("Workspace not initialized");
  });
});
