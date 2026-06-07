import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  basouPaths,
  createManifest,
  ensureBasouDirectory,
  readSessionYaml,
  writeManifest,
} from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRefreshWatch, scanSourceLogs, scansEqual, type WatchDeps } from "./refresh-watch.js";

const execFileAsync = promisify(execFile);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const FIXED_DATE = new Date("2026-05-09T03:00:00.000Z");

let tmpRepo: string | undefined;
let claudeRoot: string | undefined;
let codexRoot: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-watch-test-"));
  claudeRoot = await mkdtemp(join(tmpdir(), "basou-watch-claude-"));
  codexRoot = await mkdtemp(join(tmpdir(), "basou-watch-codex-"));
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: tmpRepo, env: ENV });
});

afterEach(async () => {
  for (const dir of [tmpRepo, claudeRoot, codexRoot]) {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
  tmpRepo = undefined;
  claudeRoot = undefined;
  codexRoot = undefined;
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

async function setupRepo(sourceRoots?: string[]): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  const repo = await realpath(tmpRepo as string);
  const paths = await ensureBasouDirectory(repo);
  await writeManifest(
    paths,
    createManifest({
      workspaceName: "fixture-ws",
      now: FIXED_DATE,
      workspaceId: FIXED_WS_ID,
      ...(sourceRoots ? { sourceRoots } : {}),
    }),
  );
  return repo;
}

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

async function codexSessionIds(repo: string): Promise<string[]> {
  const paths = basouPaths(repo);
  let dirs: string[];
  try {
    dirs = await readdir(paths.sessions);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const dir of dirs) {
    const session = await readSessionYaml(paths, dir);
    if (session.session.source.kind === "codex-import") {
      const ext = session.session.source.external_id;
      if (typeof ext === "string") ids.push(ext);
    }
  }
  return ids.sort();
}

/**
 * A fake `sleep` that runs one scripted step per cycle, then aborts when the
 * steps run out (so the watcher loop terminates deterministically).
 */
function scriptedSleep(
  controller: AbortController,
  steps: Array<() => Promise<void> | void>,
): WatchDeps["sleep"] {
  let i = 0;
  return async () => {
    const step = steps[i];
    i += 1;
    if (step) {
      await step();
    } else {
      controller.abort();
    }
  };
}

function watchDeps(
  repo: string,
  controller: AbortController,
  sleep: WatchDeps["sleep"],
): WatchDeps {
  const logs: string[] = [];
  const deps: WatchDeps = {
    ctx: { cwd: repo, claudeProjectsDir: getClaudeRoot(), codexSessionsDir: getCodexRoot() },
    paths: basouPaths(repo),
    intervalMs: 1000,
    importOptions: {},
    now: () => FIXED_DATE,
    signal: controller.signal,
    sleep,
    log: (line) => logs.push(line),
  };
  (deps as WatchDeps & { logs: string[] }).logs = logs;
  return deps;
}

describe("scanSourceLogs / scansEqual", () => {
  it("collects *.jsonl signatures and tolerates a missing root", async () => {
    await writeCodexRolloutAt("/some/proj", "c1");
    const scan = await scanSourceLogs([getCodexRoot(), join(getCodexRoot(), "does-not-exist")]);
    expect(scan.size).toBe(1);
    expect([...scan.keys()][0]?.endsWith("rollout-c1.jsonl")).toBe(true);
  });

  it("treats a root that is a file (ENOTDIR) as empty, not an error", async () => {
    const file = join(getCodexRoot(), "not-a-dir");
    await writeFile(file, "x");
    const scan = await scanSourceLogs([file]);
    expect(scan.size).toBe(0);
  });

  it("scansEqual is true for identical scans and false after growth", async () => {
    await writeCodexRolloutAt("/some/proj", "c1");
    const a = await scanSourceLogs([getCodexRoot()]);
    const b = await scanSourceLogs([getCodexRoot()]);
    expect(scansEqual(a, b)).toBe(true);
    // Append to the file -> size changes -> not equal.
    const file = join(getCodexRoot(), "2026", "05", "10", "rollout-c1.jsonl");
    await writeFile(file, "x".repeat(10), { flag: "a" });
    const c = await scanSourceLogs([getCodexRoot()]);
    expect(scansEqual(a, c)).toBe(false);
  });
});

describe("runRefreshWatch", () => {
  it("imports a session only once its log has settled (stable for one poll)", async () => {
    const repo = await setupRepo();
    const controller = new AbortController();
    // Cycle 1: a new rollout appears (not yet stable -> skipped).
    // Cycle 2: unchanged (settled) -> imported. Cycle 3: no step -> abort.
    const sleep = scriptedSleep(controller, [
      async () => writeCodexRolloutAt(repo, "c-settle"),
      // Before the settle cycle: the just-appeared rollout must NOT be imported
      // yet (it was not stable for a full poll). This guards against a watcher
      // that imports on first sighting.
      async () => expect(await codexSessionIds(repo)).toEqual([]),
    ]);
    const deps = watchDeps(repo, controller, sleep);

    await runRefreshWatch(deps);

    expect(await codexSessionIds(repo)).toEqual(["c-settle"]);
    const logs = (deps as WatchDeps & { logs: string[] }).logs;
    expect(logs.some((l) => l.includes("refreshed:") && l.includes("codex +1"))).toBe(true);
    expect(logs[logs.length - 1]).toBe("watch stopped");
  });

  it("does not regenerate when a change imports nothing relevant (no churn)", async () => {
    // Manifest scopes to the repo only; an unrelated-cwd rollout must not import.
    const repo = await setupRepo(["."]);
    const controller = new AbortController();
    const sleep = scriptedSleep(controller, [
      async () => writeCodexRolloutAt("/unrelated/project", "c-other"),
      () => {},
    ]);
    const deps = watchDeps(repo, controller, sleep);

    await runRefreshWatch(deps);

    expect(await codexSessionIds(repo)).toEqual([]);
    const logs = (deps as WatchDeps & { logs: string[] }).logs;
    // Only the initial catch-up regenerates (and logs one "refreshed:" line).
    // The steady-state cycle triggered by the unrelated change imported 0, so it
    // regenerated nothing and added NO further "refreshed:" line (no churn).
    const refreshed = logs.filter((l) => l.includes("refreshed:"));
    expect(refreshed).toHaveLength(1);
    expect(logs[logs.length - 1]).toBe("watch stopped");
  });

  it("exits cleanly on the first abort with a 'watch stopped' line", async () => {
    const repo = await setupRepo();
    const controller = new AbortController();
    const sleep = scriptedSleep(controller, []); // abort on the first sleep
    const deps = watchDeps(repo, controller, sleep);

    await runRefreshWatch(deps);

    const logs = (deps as WatchDeps & { logs: string[] }).logs;
    expect(logs[0]).toContain("watching");
    expect(logs[logs.length - 1]).toBe("watch stopped");
  });
});
