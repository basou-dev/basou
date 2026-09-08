import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { basouPaths, createManifest, ensureBasouDirectory, writeManifest } from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefreshResult } from "../lib/provenance-actions.js";
import {
  doRunRefresh,
  doRunRefreshPortfolio,
  doRunRefreshWatch,
  parseInterval,
  printRefreshSummary,
  runRefresh,
} from "./refresh.js";

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
// A temp stand-in for ~/.codex/AGENTS.md so the channel sync never writes to the
// real home-global file when the suite runs `doRunRefresh`.
let codexChannelDir: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-refresh-test-"));
  claudeRoot = await mkdtemp(join(tmpdir(), "basou-refresh-claude-"));
  codexRoot = await mkdtemp(join(tmpdir(), "basou-refresh-codex-"));
  codexChannelDir = await mkdtemp(join(tmpdir(), "basou-refresh-channel-"));
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: tmpRepo, env: ENV });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: tmpRepo,
    env: ENV,
  });
  await execFileAsync("git", ["config", "user.name", "test"], { cwd: tmpRepo, env: ENV });
});

afterEach(async () => {
  for (const dir of [tmpRepo, claudeRoot, codexRoot, codexChannelDir]) {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
  tmpRepo = undefined;
  claudeRoot = undefined;
  codexRoot = undefined;
  codexChannelDir = undefined;
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
function getCodexChannelPath(): string {
  if (codexChannelDir === undefined) throw new Error("codexChannelDir not initialized");
  return join(codexChannelDir, "AGENTS.md");
}

/**
 * Initialize the fixture workspace. `channels.codex` and `policies.confidential`
 * are still parsed (the keys were shipped), so the fixture can declare them to
 * prove that neither makes a refresh write the user-global Codex face.
 */
async function setupInitedRepo(
  declare: { codexChannel?: boolean; confidential?: boolean } = {},
): Promise<string> {
  const repo = await realpath(tmpRepo as string);
  const paths = await ensureBasouDirectory(repo);
  const manifest = createManifest({
    workspaceName: "fixture-ws",
    now: FIXED_DATE,
    workspaceId: FIXED_WS_ID,
  });
  if (declare.codexChannel !== undefined) manifest.channels = { codex: declare.codexChannel };
  if (declare.confidential === true) manifest.policies = { confidential: true };
  await writeManifest(paths, manifest);
  return repo;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Capture console.log lines for the duration of `fn`. */
async function captureLog<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
  try {
    return { value: await fn(), lines };
  } finally {
    spy.mockRestore();
  }
}

async function writeClaudeTranscript(repo: string, editedFile?: string): Promise<void> {
  const encoded = repo.replace(/[^a-zA-Z0-9]/g, "-");
  const dir = join(getClaudeRoot(), encoded);
  await mkdir(dir, { recursive: true });
  const records: Record<string, unknown>[] = [
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
  if (editedFile !== undefined) {
    records.push({
      type: "assistant",
      timestamp: "2026-05-10T00:00:02.000Z",
      cwd: repo,
      message: {
        content: [{ type: "tool_use", name: "Edit", input: { file_path: editedFile } }],
      },
    });
  }
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

/** Write a Codex rollout whose session cwd is `cwd`, under a unique filename. */
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

function ctxFor(repo: string) {
  return {
    cwd: repo,
    claudeProjectsDir: getClaudeRoot(),
    codexSessionsDir: getCodexRoot(),
  };
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

  // The face used to be written on opt-in; it is retired. Whatever a manifest
  // still says — nothing, the old opt-in, or the confidential veto — the file's
  // content hash is unchanged after a refresh. One fixture per case: the helper
  // initializes the single temp repo once.
  for (const [label, declare] of [
    ["no declaration", {}],
    ["the old channels.codex opt-in", { codexChannel: true }],
    ["the opt-in plus policies.confidential", { codexChannel: true, confidential: true }],
  ] as const) {
    it(`writes nothing to the user-global Codex face with ${label}`, async () => {
      const repo = await setupInitedRepo(declare);
      await writeCodexRollout(repo);
      const prior =
        "<!-- BASOU:ORIENTATION:START -->\nanother workspace\n<!-- BASOU:ORIENTATION:END -->\n";
      await writeFile(getCodexChannelPath(), prior);
      const before = sha256(await readFile(getCodexChannelPath(), "utf8"));

      const { value: result } = await captureLog(() => doRunRefresh({}, ctxFor(repo)));

      expect(sha256(await readFile(getCodexChannelPath(), "utf8"))).toBe(before);
      expect(result.codexChannel).toEqual({ status: "retired" });
    });
  }

  it("says the opt-in is retired when the manifest still declares it, without telling the reader to flip a key", async () => {
    const repo = await setupInitedRepo({ codexChannel: true });
    await writeCodexRollout(repo);
    const { lines } = await captureLog(() => doRunRefresh({}, ctxFor(repo)));
    expect(lines.join("\n")).toContain("codex channel: retired");
    expect(lines.join("\n")).toContain("SessionStart hook");
    expect(lines.join("\n")).not.toMatch(/set channels\.codex/);
  });

  it("says nothing about the channel for channels.codex: false, which never did anything", async () => {
    const repo = await setupInitedRepo({ codexChannel: false });
    await writeCodexRollout(repo);
    const { lines } = await captureLog(() => doRunRefresh({}, ctxFor(repo)));
    expect(lines.join("\n")).not.toContain("codex channel");
  });

  it("says nothing about the channel when the manifest never declared it", async () => {
    const repo = await setupInitedRepo();
    await writeCodexRollout(repo);
    const { lines } = await captureLog(() => doRunRefresh({}, ctxFor(repo)));
    expect(lines.join("\n")).not.toContain("codex channel");
  });

  it("--json carries the retired channel as a field and stays the sole stdout line", async () => {
    const repo = await setupInitedRepo({ codexChannel: true });
    await writeCodexRollout(repo);

    const { lines } = await captureLog(() => doRunRefresh({ json: true }, ctxFor(repo)));

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}") as { codexChannel?: unknown };
    expect(parsed.codexChannel).toEqual({ status: "retired" });
    await expect(access(getCodexChannelPath())).rejects.toThrow();
  });

  it("aggregates manifest import.source_roots across sibling repos in one run", async () => {
    const repo = await realpath(tmpRepo as string);
    const sibling = join(dirname(repo), "sibling-refresh");
    const paths = await ensureBasouDirectory(repo);
    await writeManifest(
      paths,
      createManifest({
        workspaceName: "fixture-ws",
        now: FIXED_DATE,
        workspaceId: FIXED_WS_ID,
        sourceRoots: [".", "../sibling-refresh"],
      }),
    );
    await writeCodexRolloutAt(repo, "codex-host");
    await writeCodexRolloutAt(sibling, "codex-sib");

    // No --project: refresh reads the manifest's source roots and unions them.
    const result = await doRunRefresh({}, ctxFor(repo));

    expect(result.codex.status).toBe("ran");
    if (result.codex.status === "ran") expect(result.codex.importedCount).toBe(2);
  });

  it("errors with exit code 1 on an uninitialized workspace", async () => {
    const repo = await realpath(tmpRepo as string);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runRefresh({}, ctxFor(repo));
    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.flat().join(" ")).toContain("Workspace not initialized");
  });
});

// A refresh regenerates the position; the position is then handed to the agent
// session running in this workspace. The content check rides on the regenerate,
// reads the file back, and reports on stderr so `--json` stays parseable.
describe("basou refresh (foreign-workspace advisory)", () => {
  async function setupWithForeignPath(): Promise<{ repo: string; portfolio: string }> {
    const repo = await setupInitedRepo();
    const other = join(dirname(repo), "beta-planning");
    const portfolio = join(repo, "portfolio.yaml");
    await writeFile(portfolio, `workspaces:\n  - path: ${repo}\n  - path: ${other}\n`);
    await writeClaudeTranscript(repo, join(other, "notes.md"));
    return { repo, portfolio };
  }

  it("warns when the regenerated position names another registered workspace", async () => {
    const { repo, portfolio } = await setupWithForeignPath();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await captureLog(() => doRunRefresh({}, { ...ctxFor(repo), portfolioConfigPath: portfolio }));

    const stderr = err.mock.calls.flat().join(" ");
    expect(stderr).toContain("names another registered workspace");
    expect(stderr).toContain("nothing was withheld");
    // The advisory never lands in the file it is reporting on.
    const body = await readFile(basouPaths(repo).files.orientation, "utf8");
    expect(body).not.toContain("registered workspace");
  });

  it("stays silent under --dry-run, which regenerates no position", async () => {
    const { repo, portfolio } = await setupWithForeignPath();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await captureLog(() =>
      doRunRefresh({ dryRun: true }, { ...ctxFor(repo), portfolioConfigPath: portfolio }),
    );

    expect(err.mock.calls.flat().join(" ")).not.toContain("registered workspace");
  });

  it("stays silent when there is no portfolio registry", async () => {
    const { repo } = await setupWithForeignPath();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await captureLog(() =>
      doRunRefresh({}, { ...ctxFor(repo), portfolioConfigPath: join(repo, "absent.yaml") }),
    );

    expect(err.mock.calls.flat().join(" ")).not.toContain("registered workspace");
  });
});

describe("basou refresh --watch (validation)", () => {
  it("rejects --watch combined with --dry-run / --json / --force", async () => {
    const repo = await setupInitedRepo();
    await expect(doRunRefreshWatch({ watch: true, dryRun: true }, ctxFor(repo))).rejects.toThrow(
      /--watch cannot be combined with --dry-run/,
    );
    await expect(doRunRefreshWatch({ watch: true, json: true }, ctxFor(repo))).rejects.toThrow(
      /--watch cannot be combined with --json/,
    );
    await expect(doRunRefreshWatch({ watch: true, force: true }, ctxFor(repo))).rejects.toThrow(
      /--watch cannot be combined with --force/,
    );
  });

  it("parseInterval accepts in-range integers and rejects out-of-range / non-integers", () => {
    expect(parseInterval("30")).toBe(30);
    expect(parseInterval("5")).toBe(5);
    expect(parseInterval("86400")).toBe(86400);
    for (const bad of ["4", "0", "-1", "2.5", "abc", "", "999999999"]) {
      expect(() => parseInterval(bad)).toThrow();
    }
  });
});

describe("basou refresh --portfolio", () => {
  /** A fresh git repo with an initialized `.basou/` and a distinct workspace id. */
  async function makeInitedRepo(id: `ws_${string}`): Promise<string> {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "basou-pf-ws-")));
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: dir, env: ENV });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: dir,
      env: ENV,
    });
    await execFileAsync("git", ["config", "user.name", "test"], { cwd: dir, env: ENV });
    const paths = await ensureBasouDirectory(dir);
    await writeManifest(
      paths,
      createManifest({ workspaceName: `pf-${id}`, now: FIXED_DATE, workspaceId: id }),
    );
    return dir;
  }

  it("rejects --project (each workspace uses its own source roots)", async () => {
    await expect(
      doRunRefreshPortfolio({ portfolio: true, project: ["/some/path"] }, {}),
    ).rejects.toThrow(/remove --project/);
  });

  it("rejects --watch", async () => {
    await expect(doRunRefreshPortfolio({ portfolio: true, watch: true }, {})).rejects.toThrow(
      /cannot be combined with --watch/,
    );
  });

  it("refreshes every workspace listed in the portfolio config", async () => {
    const wsA = await makeInitedRepo("ws_01HXABCDEF1234567890PFAAA1");
    const wsB = await makeInitedRepo("ws_01HXABCDEF1234567890PFBBB2");
    const cfgDir = await realpath(await mkdtemp(join(tmpdir(), "basou-pf-cfg-")));
    try {
      await writeCodexRolloutAt(wsA, "codex-a");
      await writeCodexRolloutAt(wsB, "codex-b");
      const configPath = join(cfgDir, "portfolio.yaml");
      await writeFile(
        configPath,
        `workspaces:\n  - path: ${wsA}\n    label: A\n  - path: ${wsB}\n    label: B\n`,
      );
      vi.spyOn(console, "log").mockImplementation(() => {});

      await doRunRefreshPortfolio(
        { portfolio: true },
        {
          claudeProjectsDir: getClaudeRoot(),
          codexSessionsDir: getCodexRoot(),
          portfolioConfigPath: configPath,
          nowProvider: () => FIXED_DATE,
        },
      );

      // Each workspace got its own regenerated handoff (the refresh ran there).
      await expect(access(basouPaths(wsA).files.handoff)).resolves.toBeUndefined();
      await expect(access(basouPaths(wsB).files.handoff)).resolves.toBeUndefined();
      expect(process.exitCode).not.toBe(1);
    } finally {
      for (const dir of [wsA, wsB, cfgDir]) await rm(dir, { recursive: true, force: true });
    }
  });

  it("continues past a failing workspace and exits non-zero", async () => {
    const wsA = await makeInitedRepo("ws_01HXABCDEF1234567890PFCCC3");
    const missing = join(tmpdir(), "basou-pf-does-not-exist-zzz");
    const cfgDir = await realpath(await mkdtemp(join(tmpdir(), "basou-pf-cfg-")));
    try {
      await writeCodexRolloutAt(wsA, "codex-c");
      const configPath = join(cfgDir, "portfolio.yaml");
      // The missing path comes first; the loop must still reach wsA.
      await writeFile(configPath, `workspaces:\n  - path: ${missing}\n  - path: ${wsA}\n`);
      vi.spyOn(console, "log").mockImplementation(() => {});

      await doRunRefreshPortfolio(
        { portfolio: true },
        {
          claudeProjectsDir: getClaudeRoot(),
          codexSessionsDir: getCodexRoot(),
          portfolioConfigPath: configPath,
          nowProvider: () => FIXED_DATE,
        },
      );

      await expect(access(basouPaths(wsA).files.handoff)).resolves.toBeUndefined();
      expect(process.exitCode).toBe(1);
    } finally {
      for (const dir of [wsA, cfgDir]) await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("basou refresh (workspace view)", () => {
  it("redirects a non-git view to its linked repo and imports there", async () => {
    const inited = await setupInitedRepo();
    await writeCodexRollout(inited); // a Codex rollout whose cwd is the linked repo
    const view = await realpath(await mkdtemp(join(tmpdir(), "basou-refresh-view-")));
    try {
      await symlink(inited, join(view, "fixture-planning"));
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await doRunRefresh(
        {},
        {
          cwd: view,
          claudeProjectsDir: getClaudeRoot(),
          codexSessionsDir: getCodexRoot(),
          nowProvider: () => FIXED_DATE,
        },
      );

      expect(result.codex.status).toBe("ran");
      if (result.codex.status === "ran") expect(result.codex.importedCount).toBe(1);
      expect(errSpy.mock.calls.flat().join(" ")).toContain("Resolved workspace view to");
      // Imported into the LINKED repo's .basou, not the view.
      await expect(access(basouPaths(inited).files.handoff)).resolves.toBeUndefined();
    } finally {
      await rm(view, { recursive: true, force: true });
    }
  });
});

describe("printRefreshSummary", () => {
  const baseResult = (over: Partial<RefreshResult>): RefreshResult => ({
    claudeCode: { adapter: "claude-code", status: "skipped", reason: "no source logs" },
    codex: { adapter: "codex", status: "skipped", reason: "no source logs" },
    handoff: {
      status: "generated",
      sessionCount: 5,
      taskCount: 0,
      decisionCount: 0,
      pendingApprovalsCount: 0,
    },
    decisions: { status: "generated", decisionCount: 0 },
    orientation: {
      status: "generated",
      sessionCount: 5,
      inFlightTaskCount: 0,
      pendingApprovalsCount: 0,
      suspectCount: 0,
    },
    dryRun: false,
    ...over,
  });

  function capture(result: RefreshResult): string {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      lines.push(String(m));
    });
    try {
      printRefreshSummary(result);
    } finally {
      spy.mockRestore();
    }
    return lines.join("\n");
  }

  it("names every discovered-but-dropped source, so a silent skip cannot read as up to date", () => {
    const out = capture(
      baseResult({
        codex: {
          adapter: "codex",
          status: "ran",
          importedCount: 0,
          replacedCount: 0,
          reimportedCount: 0,
          skippedNoAction: 2,
          skippedAlreadyImported: 4,
          skippedLegacyUntracked: 0,
          skippedDecreased: 0,
          skippedDuplicate: 0,
          skippedUnverifiable: 1,
          eventTotal: 0,
          dryRun: false,
        },
      }),
    );
    // Without the drop counts this line read "imported 0 session(s), 0 events, 4
    // already imported" — indistinguishable from "nothing new happened".
    expect(out).toContain("2 with no actions");
    expect(out).toContain("1 unverifiable (run 'basou verify')");
    expect(out).toContain("4 already imported");
  });

  it("0 decisions WITH captured sessions: states the count and nudges the runnable command (not 'regenerated (0)')", () => {
    const out = capture(baseResult({ decisions: { status: "generated", decisionCount: 0 } }));
    expect(out).toContain("decisions: 0");
    expect(out).toContain("basou decision capture"); // the batch capture command, not the bare group
    expect(out).not.toContain("regenerated (0)"); // the misleading success-looking wording is gone
  });

  it("0 decisions with NO captured sessions (empty workspace): states the count without nagging", () => {
    const out = capture(
      baseResult({
        handoff: {
          status: "generated",
          sessionCount: 0,
          taskCount: 0,
          decisionCount: 0,
          pendingApprovalsCount: 0,
        },
        decisions: { status: "generated", decisionCount: 0 },
      }),
    );
    expect(out).toContain("decisions: 0");
    expect(out).not.toContain("basou decision");
  });

  it("non-zero decisions: reports the regenerated count as before", () => {
    const out = capture(baseResult({ decisions: { status: "generated", decisionCount: 3 } }));
    expect(out).toContain("decisions: regenerated (3)");
    expect(out).not.toContain("basou decision");
  });
});
