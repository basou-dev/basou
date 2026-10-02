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
import { join } from "node:path";
import { promisify } from "node:util";
import {
  basouPaths,
  createManifest,
  createTaskWithEvent,
  ensureBasouDirectory,
  type PrefixedId,
  writeManifest,
  writeYamlFile,
} from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDecisionGaps } from "./decision-gaps.js";
import { runHandoffGenerate } from "./handoff.js";
import { runOrient } from "./orient.js";
import { runRefresh } from "./refresh.js";
import { runReportGenerate } from "./report.js";
import { runSessionImport } from "./session.js";

// The commands outside `basou task` and `basou approval` that read the task or
// approval store, driven through their CLI entry points against a store whose
// directory is a symlink. The core functions underneath are tested directly in
// @basou/core; this pins that each command stops on the refusal and writes
// nothing, as docs/spec/workspace.md lists.

const execFileAsync = promisify(execFile);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const FIXED_DATE = new Date("2026-05-09T03:00:00.000Z");
const TASK_ID = "task_01HXABCDEF1234567890ABCTK1" as PrefixedId<"task">;
const APPROVAL_ID = "appr_01HXABCDEF1234567890ABCAP1";

let tmp: string | undefined;

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), "basou-store-guard-test-")));
});

afterEach(async () => {
  if (tmp !== undefined) {
    await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
  process.exitCode = 0;
  vi.restoreAllMocks();
});

function getTmp(): string {
  if (tmp === undefined) throw new Error("tmp not initialized");
  return tmp;
}

/** A workspace with one task, one pending approval and one Claude transcript to import. */
async function setupRepo(): Promise<string> {
  const repo = join(getTmp(), "repo");
  await mkdir(repo);
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: repo, env: ENV });
  const paths = await ensureBasouDirectory(repo);
  const manifest = createManifest({
    workspaceName: "fixture-ws",
    now: FIXED_DATE,
    workspaceId: FIXED_WS_ID,
  });
  await writeManifest(paths, manifest);
  const created = await createTaskWithEvent({
    mode: "ad-hoc",
    paths,
    manifest,
    occurredAt: "2026-05-09T03:00:00.000Z",
    taskId: TASK_ID,
    title: "fixture task",
    initialStatus: "planned",
    description: "",
    workingDirectory: repo,
  });
  await writeYamlFile(join(paths.approvals.pending, `${APPROVAL_ID}.yaml`), {
    schema_version: "0.2.0",
    id: APPROVAL_ID,
    session_id: created.sessionId,
    created_at: "2026-05-09T03:00:00.000Z",
    status: "pending",
    risk_level: "low",
    action: { kind: "command" },
    reason: "fixture approval",
    expires_at: null,
  });
  const transcripts = join(getTmp(), "claude", repo.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(transcripts, { recursive: true });
  await writeFile(
    join(transcripts, "claude-sess-1.jsonl"),
    [
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
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n"),
  );
  return repo;
}

function ctxFor(repo: string) {
  return {
    cwd: repo,
    nowProvider: () => FIXED_DATE,
    claudeProjectsDir: join(getTmp(), "claude"),
    codexSessionsDir: join(getTmp(), "codex"),
    hostsConfigPath: join(getTmp(), "hosts.yaml"),
    portfolioConfigPath: join(getTmp(), "portfolio.yaml"),
  };
}

/** A session import payload that names the fixture task. */
async function writeImportPayload(): Promise<string> {
  const file = join(getTmp(), "import.json");
  const sessionId = "ses_01HXABCDEF1234567890ABCNW1";
  await writeFile(
    file,
    JSON.stringify({
      schema_version: "0.2.0",
      session: {
        id: sessionId,
        workspace_id: FIXED_WS_ID,
        task_id: TASK_ID,
        source: { kind: "claude-code-adapter", version: "0.1.0" },
        started_at: "2026-05-08T11:00:00+09:00",
        status: "completed",
        working_directory: "/srv/example-project",
        invocation: { command: "claude", args: [], exit_code: 0 },
        related_files: [],
      },
      events: [
        {
          schema_version: "0.2.0",
          type: "session_started",
          id: "evt_01HXABCDEF1234567890ABCEV2",
          session_id: sessionId,
          occurred_at: "2026-05-08T11:00:00+09:00",
          source: "claude-code-adapter",
        },
      ],
    }),
  );
  return file;
}

/** Every file under `dir`, with its bytes, so a test can prove nothing changed. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await readdir(dir, { recursive: true })).sort()) {
    try {
      out[name] = await readFile(join(dir, name), "utf8");
    } catch {
      out[name] = "<dir>";
    }
  }
  return out;
}

type Command = [string, (repo: string) => Promise<void>];

const BOTH_STORES: Command[] = [
  ["orient", (repo) => runOrient({}, ctxFor(repo))],
  ["orient --refresh", (repo) => runOrient({ refresh: true }, ctxFor(repo))],
  ["handoff generate", (repo) => runHandoffGenerate({}, ctxFor(repo))],
  ["report generate", (repo) => runReportGenerate({}, ctxFor(repo))],
  ["refresh", (repo) => runRefresh({}, ctxFor(repo))],
];
const TASK_STORE_ONLY: Command[] = [
  ["decision gaps", (repo) => runDecisionGaps({}, ctxFor(repo))],
  [
    "session import",
    async (repo) =>
      runSessionImport({ format: "json", from: await writeImportPayload() }, ctxFor(repo)),
  ],
];

const STORES: Array<[string, Command[]]> = [
  ["tasks", [...BOTH_STORES, ...TASK_STORE_ONLY]],
  ["tasks/archive", [...BOTH_STORES, ...TASK_STORE_ONLY]],
  ["approvals", BOTH_STORES],
  ["approvals/pending", BOTH_STORES],
  ["approvals/resolved", BOTH_STORES],
];

// POSIX only: creating a symlink needs privileges on Windows.
describe.skipIf(process.platform === "win32")("a store directory that is a symlink", () => {
  it("control: with the store intact every command succeeds, and refresh imports the transcript", async () => {
    for (const [name, run] of [...BOTH_STORES, ...TASK_STORE_ONLY]) {
      await rm(join(getTmp(), "repo"), { recursive: true, force: true });
      await rm(join(getTmp(), "claude"), { recursive: true, force: true });
      const repo = await setupRepo();
      const sessionsBefore = (await readdir(basouPaths(repo).sessions)).length;
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      process.exitCode = 0;
      await run(repo);
      expect(process.exitCode, `${name}: ${err.mock.calls.join(" | ")}`).not.toBe(1);
      if (name === "refresh") {
        expect((await readdir(basouPaths(repo).sessions)).length).toBe(sessionsBefore + 1);
      }
      vi.restoreAllMocks();
    }
  });

  for (const [relative, commands] of STORES) {
    const label = `.basou/${relative}`;

    it(`${label}: each command stops with the refusal and writes nothing`, async () => {
      for (const [name, run] of commands) {
        await rm(join(getTmp(), "repo"), { recursive: true, force: true });
        await rm(join(getTmp(), "outside"), { recursive: true, force: true });
        await rm(join(getTmp(), "claude"), { recursive: true, force: true });
        const repo = await setupRepo();
        const paths = basouPaths(repo);
        const inside = join(paths.root, relative);
        const outside = join(getTmp(), "outside");
        await mkdir(inside, { recursive: true });
        await rename(inside, outside);
        await symlink(outside, inside);
        const outsideBefore = await snapshot(outside);
        const sessionsBefore = await snapshot(paths.sessions);

        vi.spyOn(console, "log").mockImplementation(() => undefined);
        const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
        process.exitCode = 0;
        await run(repo);
        expect(process.exitCode, name).toBe(1);
        expect(err.mock.calls.map((c) => String(c[0])).join("\n"), name).toContain(
          `${label} is a symlink; refusing to operate`,
        );
        expect(await snapshot(outside), name).toEqual(outsideBefore);
        // Nothing imported, no session started: the sessions are as they were.
        expect(await snapshot(paths.sessions), name).toEqual(sessionsBefore);
        vi.restoreAllMocks();
      }
    });
  }
});
