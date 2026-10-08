import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
  basouPaths,
  chainEvents,
  createManifest,
  type Event,
  ensureBasouDirectory,
  type RepoEntry,
  writeManifest,
} from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeStaleness } from "../lib/provenance-actions.js";
import {
  doRunBoardMeasure,
  doRunBoardRecord,
  measureLiveBoard,
  runBoardMeasure,
  runBoardRecord,
} from "./board.js";
import { doRunPortfolioList } from "./portfolio.js";
import { doRunReviewGaps } from "./review-gaps.js";
import { doRunStats } from "./stats.js";
import { runVerify } from "./verify.js";

const execFileAsync = promisify(execFile);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
const NOW = new Date("2026-10-05T03:00:00.000Z");
const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;

let tmpRepo: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-board-test-"));
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: tmpRepo, env: ENV });
});

afterEach(async () => {
  if (tmpRepo !== undefined) await rm(tmpRepo, { recursive: true, force: true });
  tmpRepo = undefined;
  process.exitCode = 0;
  vi.restoreAllMocks();
});

async function workspace(repos?: RepoEntry[]): Promise<string> {
  const repo = await realpath(tmpRepo as string);
  const paths = await ensureBasouDirectory(repo);
  const manifest = createManifest({
    workspaceName: "board-ws",
    now: NOW,
    workspaceId: FIXED_WS_ID,
  });
  await writeManifest(paths, repos === undefined ? manifest : { ...manifest, repos });
  await writeFile(join(repo, "README.md"), "# ws\n");
  await writeFile(join(repo, "NOTES.md"), "a\nb\n");
  return repo;
}

const STAGES = Object.fromEntries(
  ["01", "02", "03", "04", "05", "06"].map((id) => [id, { meaning: `stage ${id}` }]),
);

// JSON is YAML 1.2, so the fixture needs no YAML writer.
function boardYaml(measures: Record<string, unknown>[]): string {
  return JSON.stringify(
    {
      board_version: 1,
      title: "Board",
      stages: STAGES,
      lanes: [{ id: "core", name: "Core" }],
      measures,
      axis: { version: 1, review_due_days: 60 },
      effort: { start: "2026-04-28" },
    },
    null,
    2,
  );
}

const MD = { id: "md", kind: "file_count", repo: ".", include: ["*.md"], unit: "files" };

async function placeBoard(repo: string, text: string, at = "board/board.yaml"): Promise<void> {
  await mkdir(join(repo, at, ".."), { recursive: true });
  await writeFile(join(repo, at), text);
}

function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    err.push(args.map(String).join(" "));
  });
  return { out, err };
}

// The portfolio config and the native logs are read from beside the
// workspace, where no test writes them unless it means to, so no test reads
// the host's own.
const ctx = (cwd: string) => ({
  cwd,
  nowProvider: () => NOW,
  portfolioConfigPath: join(cwd, ".portfolio.yaml"),
  claudeProjectsDir: join(cwd, ".claude-projects"),
  codexSessionsDir: join(cwd, ".codex-sessions"),
});
const ESC = String.fromCharCode(27);

describe("basou board measure", () => {
  it("reads board/board.yaml when the manifest declares the workspace's own repo private", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    await placeBoard(repo, boardYaml([MD]));
    const { out } = capture();
    await runBoardMeasure({ json: true }, ctx(repo));
    const result = JSON.parse(out.join("\n"));
    expect(result).toMatchObject({
      board_version: 1,
      title: "Board",
      measured_at: NOW.toISOString(),
      complete: true,
      not_found: [],
      measures: { md: { value: 2, unit: "files" } },
    });
    expect(result.measured_with.basou).toMatch(/^\d+\.\d+\.\d+/);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it.each<[string, RepoEntry[] | undefined]>([
    ["no repos", undefined],
    ["a public repo", [{ path: ".", visibility: "public" }]],
    ["no visibility", [{ path: "." }]],
  ])("needs --board when the manifest declares %s", async (_what, repos) => {
    const repo = await workspace(repos);
    await placeBoard(repo, boardYaml([]));
    const { out, err } = capture();
    await runBoardMeasure({ json: true }, ctx(repo));
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain(
      "No --board given, and the default board/board.yaml is used only when the manifest declares this workspace's own repo (path: .) private. Pass --board <path to board.yaml>.",
    );
    expect(process.exitCode).toBe(1);
  });

  it("reads --board relative to the working directory, and says when it is not there", async () => {
    const repo = await workspace([{ path: "." }]);
    await placeBoard(repo, boardYaml([MD]), "elsewhere/my-board.yaml");
    await mkdir(join(repo, "sub"));
    const { out, err } = capture();
    await runBoardMeasure(
      { json: true, board: "../elsewhere/my-board.yaml" },
      ctx(join(repo, "sub")),
    );
    expect(JSON.parse(out.join("\n")).measures.md.value).toBe(2);
    await runBoardMeasure({ json: true, board: "nope.yaml" }, ctx(repo));
    expect(err.join("\n")).toContain("No board declaration at nope.yaml.");
    expect(process.exitCode).toBe(1);
  });

  it("prints no repos when the manifest declares none", async () => {
    const repo = await workspace();
    await placeBoard(repo, boardYaml([]));
    const { out } = capture();
    const result = await doRunBoardMeasure({ board: "board/board.yaml" }, ctx(repo));
    expect(result.repos).toEqual([]);
    expect(out.join("\n")).not.toContain("Repos:");
  });

  it("prints nothing on stdout and every problem on stderr for a declaration it cannot read", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    await placeBoard(
      repo,
      boardYaml([
        { ...MD, repo: "../elsewhere" },
        { id: "x", kind: "file_count", repo: ".", unit: "files" },
      ]),
    );
    const { out, err } = capture();
    await runBoardMeasure({ json: true }, ctx(repo));
    expect(out).toEqual([]);
    expect(err.join("\n")).toBe(
      [
        "board/board.yaml is not a valid board declaration:",
        "  - measures[1].include: Invalid input: expected array, received undefined",
        "  - measures[0].repo: '../elsewhere' is not a repo path in the manifest (the manifest declares '.')",
      ].join("\n"),
    );
    expect(process.exitCode).toBe(1);
  });

  it("prints what it measured and exits 1 when something could not be measured", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    await placeBoard(
      repo,
      boardYaml([
        MD,
        { id: "gone", kind: "line_count", repo: ".", include: ["GONE.md"], unit: "lines" },
      ]),
    );
    const { out } = capture();
    const result = await doRunBoardMeasure({ json: true }, ctx(repo));
    expect(result.complete).toBe(false);
    expect(JSON.parse(out.join("\n")).not_found).toEqual([
      { at: "measures.gone", reason: "'GONE.md' matches no file in the working tree" },
    ]);
    expect(process.exitCode).toBe(1);
  });

  it("prints a summary without --json", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    await placeBoard(
      repo,
      boardYaml([
        { ...MD, lane: "core" },
        { id: "gone", kind: "line_count", repo: ".", include: ["GONE.md"], unit: "lines" },
      ]),
    );
    const { out } = capture();
    await runBoardMeasure({}, ctx(repo));
    const text = out.join("\n");
    expect(text).toContain("md    2 files  [core]");
    expect(text).toContain(`\nRepos:\n  . (${basename(repo)})  `);
    expect(text).toContain("gone  not measured");
    expect(text).toContain(
      "Not measured (1):\n  measures.gone: 'GONE.md' matches no file in the working tree",
    );
    expect(text).toContain("\nTrail:\n  decisions 0 (live 0)\n  open tracks 0\n");
    expect(text).toContain(
      "\nIntegrity:\n  sessions 0: 0 verified, 0 unchained, 0 empty, 0 incomplete, 0 in_progress, 0 unsupported, 0 tampered\n  not verified 0\n",
    );
    expect(text).toContain(
      "\nReview gaps:\n  units 0: 0 omission, 0 near_unbound, 0 candidate, 0 unknown\n  gaps 0\n",
    );
    expect(text).toContain("\nPortfolio:\n  no ~/.basou/portfolio.yaml\n");
    expect(text).toContain(
      "\nFreshness:\n  newest session none\n  not imported 0 new, 0 updated, 0 unverifiable\n",
    );
    expect(text).toContain("Complete: no");
    expect(text).toMatch(/Digest: sha256:[0-9a-f]{64}/);
  });

  it("prints each repo in the summary, saying what a null means", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }, { path: "../gone" }]);
    await placeBoard(repo, boardYaml([]));
    const { out } = capture();
    await runBoardMeasure({}, ctx(repo));
    const name = basename(repo);
    const unborn = out.join("\n");
    expect(unborn).toMatch(
      new RegExp(
        `Repos:\\n  \\. \\(${name}\\)  main at no commit yet, last commit none, commits 0, files \\d+, uncommitted \\d+, behind origin/main \\(no origin/main\\)\\n  \\.\\./gone  not measured\\n`,
      ),
    );
    expect(unborn).toContain("repos[../gone]: the repo '../gone' is not on disk");
    expect(process.exitCode).toBe(1);

    await execFileAsync("git", ["add", "README.md"], { cwd: repo, env: ENV });
    await execFileAsync(
      "git",
      ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "one"],
      {
        cwd: repo,
        env: { ...ENV, GIT_COMMITTER_DATE: "2026-10-04T23:30:00+09:00" },
      },
    );
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo, env: ENV });
    await execFileAsync("git", ["checkout", "-q", "--detach"], { cwd: repo, env: ENV });
    out.length = 0;
    await runBoardMeasure({}, ctx(repo));
    expect(out.join("\n")).toContain(
      `  . (${name})  detached HEAD at ${stdout.slice(0, 7)}, last commit 2026-10-04T23:30:00+09:00, commits 1, files `,
    );
  });

  it("prints the open tracks in the summary, or that the trail was not measured", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    await placeBoard(repo, boardYaml([]));
    const sessionId = "ses_01HXABCDEF1234567890ABCS01";
    const dir = join(repo, ".basou", "sessions", sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "session.yaml"),
      [
        'schema_version: "0.1.0"',
        "session:",
        `  id: ${sessionId}`,
        "  label: fixture",
        "  task_id: null",
        `  workspace_id: ${FIXED_WS_ID}`,
        "  source: { kind: terminal, version: 0.1.0 }",
        "  started_at: 2026-10-01T00:00:00Z",
        "  status: completed",
        "  working_directory: /tmp/fixture",
        "  invocation: { command: echo, args: [], exit_code: 0 }",
        "  related_files: []",
        "  events_log: events.jsonl",
        "",
      ].join("\n"),
    );
    const event = (n: string, fields: Record<string, unknown>) =>
      JSON.stringify({
        schema_version: "0.1.0",
        id: `evt_01HXABCDEF1234567890ABCE0${n}`,
        session_id: sessionId,
        occurred_at: `2026-10-0${n}T00:00:00Z`,
        source: "local-cli",
        ...fields,
      });
    const decision = (n: string) => `decision_01HXABCDEF1234567890ABCD0${n}`;
    const events = [
      event("1", {
        type: "decision_recorded",
        decision_id: decision("1"),
        title: `open ${ESC}[31m question`,
        kind: "track",
      }),
      event("2", {
        type: "decision_recorded",
        decision_id: decision("2"),
        title: "newer",
        kind: "track",
      }),
      event("3", { type: "decision_recorded", decision_id: decision("3"), title: "voided" }),
      event("4", { type: "decision_voided", decision_id: decision("3") }),
      event("5", { type: "decision_recorded", decision_id: decision("5"), title: "settled" }),
    ];
    await writeFile(join(dir, "events.jsonl"), `${events.join("\n")}\n`);
    const { out } = capture();
    await runBoardMeasure({}, ctx(repo));
    const text = out.join("\n");
    expect(text).toContain(
      `\nTrail:\n  decisions 4 (live 3)\n  open tracks 2\n    ${decision("2")}  newer\n    ${decision("1")}  open `,
    );
    expect(text).not.toContain(ESC);

    await writeFile(join(dir, "events.jsonl"), `{"broken\n${events[0]}\n`);
    out.length = 0;
    process.exitCode = 0;
    await runBoardMeasure({ json: true }, ctx(repo));
    expect(JSON.parse(out.join("\n")).complete).toBe(false);
    expect(process.exitCode).toBe(1);
    out.length = 0;
    await runBoardMeasure({}, ctx(repo));
    expect(out.join("\n")).toContain("\nTrail:\n  not measured\n");
  });

  it.skipIf(
    process.platform === "win32" ||
      (typeof process.getuid === "function" && process.getuid() === 0),
  )("counts what basou verify reports, and prints it or that it was not measured", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    await placeBoard(repo, boardYaml([]));
    const sessions = join(repo, ".basou", "sessions");
    const sessionId = "ses_01HXABCDEF1234567890ABCS01";
    await mkdir(join(sessions, sessionId), { recursive: true });
    await writeFile(
      join(sessions, sessionId, "events.jsonl"),
      `${JSON.stringify({
        schema_version: "0.1.0",
        id: "evt_01HXABCDEF1234567890ABCE01",
        session_id: sessionId,
        occurred_at: "2026-10-01T00:00:00Z",
        source: "local-cli",
        type: "note_added",
        body: "x",
      })}\n`,
    );
    await symlink(join(sessions, sessionId), join(sessions, "ses_01HXABCDEF1234567890ABCS02"));
    await writeFile(join(sessions, "ses_01HXABCDEF1234567890ABCS03"), "not a session\n");
    // A verified one: chained events and the head anchor in session.yaml.
    const chainedId = "ses_01HXABCDEF1234567890ABCS04";
    await mkdir(join(sessions, chainedId));
    const { lines, headHash, count } = chainEvents(
      [
        {
          schema_version: "0.1.0",
          id: "evt_01HXABCDEF1234567890ABCE02",
          session_id: chainedId,
          occurred_at: "2026-10-01T00:00:00Z",
          source: "local-cli",
          type: "note_added",
          body: "y",
        } as Event,
      ],
      chainedId,
    );
    await writeFile(join(sessions, chainedId, "events.jsonl"), `${lines.join("\n")}\n`);
    await writeFile(
      join(sessions, chainedId, "session.yaml"),
      [
        'schema_version: "0.1.0"',
        "session:",
        `  id: ${chainedId}`,
        "  task_id: null",
        `  workspace_id: ${FIXED_WS_ID}`,
        "  source: { kind: terminal, version: 0.1.0 }",
        "  started_at: 2026-10-01T00:00:00Z",
        "  status: completed",
        "  working_directory: /tmp/fixture",
        "  invocation: { command: echo, args: [], exit_code: 0 }",
        "  related_files: []",
        "  events_log: events.jsonl",
        `  integrity: { head_hash: ${headHash}, event_count: ${count} }`,
        "",
      ].join("\n"),
    );
    const { out } = capture();
    await runVerify({ json: true }, { cwd: repo });
    const rows = JSON.parse(out.join("\n")) as { status: string }[];
    const tally: Record<string, number> = {};
    for (const row of rows) tally[row.status] = (tally[row.status] ?? 0) + 1;
    out.length = 0;
    process.exitCode = 0;
    const result = await doRunBoardMeasure({ json: true }, ctx(repo));
    expect(rows).toHaveLength(4);
    expect(
      Object.fromEntries(Object.entries(result.integrity.by_status ?? {}).filter(([, n]) => n > 0)),
    ).toEqual(tally);
    out.length = 0;
    await runBoardMeasure({}, ctx(repo));
    expect(out.join("\n")).toContain(
      "\nIntegrity:\n  sessions 4: 1 verified, 1 unchained, 0 empty, 0 incomplete, 0 in_progress, 0 unsupported, 2 tampered\n  not verified 3\n",
    );

    const events = join(sessions, sessionId, "events.jsonl");
    await chmod(events, 0o000);
    try {
      out.length = 0;
      process.exitCode = 0;
      await runBoardMeasure({}, ctx(repo));
      expect(out.join("\n")).toContain("\nIntegrity:\n  not measured\n");
      expect(process.exitCode).toBe(1);
    } finally {
      await chmod(events, 0o644);
    }
  });

  it("counts what basou review-gaps reports, and prints it or that it was not measured", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    await placeBoard(repo, boardYaml([]));
    const sessions = join(repo, ".basou", "sessions");
    const place = async (id: string, source: string, args: string[], cwd: string | null) => {
      await mkdir(join(sessions, id), { recursive: true });
      await writeFile(
        join(sessions, id, "session.yaml"),
        [
          'schema_version: "0.1.0"',
          "session:",
          `  id: ${id}`,
          "  task_id: null",
          `  workspace_id: ${FIXED_WS_ID}`,
          `  source: { kind: ${source}, version: 0.1.0 }`,
          "  started_at: 2026-10-01T00:00:00Z",
          "  status: imported",
          "  working_directory: /tmp/fixture",
          `  invocation: { command: ${source}, args: [], exit_code: null }`,
          "  related_files: []",
          "  events_log: events.jsonl",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(sessions, id, "events.jsonl"),
        `${JSON.stringify({
          schema_version: "0.1.0",
          id: `evt_${id.slice(4)}`,
          session_id: id,
          occurred_at: args.includes("git diff") ? "2026-10-01T09:30:00Z" : "2026-10-01T10:05:00Z",
          source: "local-cli",
          type: "command_executed",
          command: null,
          args,
          cwd,
          exit_code: 0,
          duration_ms: 0,
        })}\n`,
      );
    };
    await place("ses_01HXABCDEF1234567890ABCR01", "codex-import", ["-c", "git diff"], repo);
    await place(
      "ses_01HXABCDEF1234567890ABCC01",
      "claude-code-import",
      ["-c", "git commit -m a"],
      repo,
    );
    await place(
      "ses_01HXABCDEF1234567890ABCC02",
      "claude-code-import",
      ["-c", "git commit -m b"],
      "/nonexistent/projects/beta",
    );
    await place(
      "ses_01HXABCDEF1234567890ABCC03",
      "claude-code-import",
      ["-c", "git commit -m c"],
      null,
    );
    const { out } = capture();
    const summary = await doRunReviewGaps({ json: true }, { cwd: repo });
    const tally: Record<string, number> = {};
    for (const u of [...summary.gaps, ...summary.candidates, ...summary.unknowns]) {
      tally[u.verdict] = (tally[u.verdict] ?? 0) + 1;
    }
    out.length = 0;
    const result = await doRunBoardMeasure({ json: true }, ctx(repo));
    expect(tally).toEqual({ candidate: 1, omission: 1, unknown: 1 });
    expect(
      Object.fromEntries(
        Object.entries(result.review_gaps.by_verdict ?? {}).filter(([, n]) => n > 0),
      ),
    ).toEqual(tally);
    expect(result.review_gaps.gaps).toBe(summary.gaps.length);
    out.length = 0;
    await runBoardMeasure({}, ctx(repo));
    expect(out.join("\n")).toContain(
      "\nReview gaps:\n  units 3: 1 omission, 0 near_unbound, 1 candidate, 1 unknown\n  gaps 1\n",
    );

    await writeFile(join(sessions, "ses_01HXABCDEF1234567890ABCC02", "session.yaml"), "[]\n");
    out.length = 0;
    process.exitCode = 0;
    await runBoardMeasure({}, ctx(repo));
    expect(out.join("\n")).toContain("\nReview gaps:\n  not measured\n");
    expect(process.exitCode).toBe(1);
  });

  it("counts what basou portfolio lists, and prints it, that there is none, or that it was not measured", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    await placeBoard(repo, boardYaml([]));
    const config = join(repo, ".portfolio.yaml");
    const absent = join(repo, "gone");
    // There, but with no `.basou` directory of its own.
    const bare = join(repo, "bare");
    await mkdir(bare);
    await writeFile(
      config,
      `workspaces:\n  - { path: ${repo} }\n  - { path: ${bare} }\n  - { path: ${absent} }\n`,
    );
    const { out } = capture();
    const listed = await doRunPortfolioList({ json: true }, { configPath: config });
    out.length = 0;
    const result = await doRunBoardMeasure({ json: true }, ctx(repo));
    expect(result.portfolio).toEqual({
      workspaces: listed.workspaces.length,
      initialized: listed.workspaces.filter((w) => w.initialized).length,
    });
    expect(result.portfolio).toEqual({ workspaces: 3, initialized: 1 });
    out.length = 0;
    await runBoardMeasure({}, ctx(repo));
    expect(out.join("\n")).toContain("\nPortfolio:\n  workspaces 3 (initialized 1)\n");

    await writeFile(config, "workspaces: []\n");
    out.length = 0;
    process.exitCode = 0;
    await runBoardMeasure({}, ctx(repo));
    expect(out.join("\n")).toContain("\nPortfolio:\n  not measured\n");
    expect(out.join("\n")).toContain("portfolio: ~/.basou/portfolio.yaml has no workspaces.");
    expect(process.exitCode).toBe(1);
  });

  it("counts the sessions not yet imported as basou orient does, and prints them", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    await placeBoard(repo, boardYaml([]));
    const context = ctx(repo);
    // A Claude Code transcript of this workspace that was never imported.
    const projectDir = join(context.claudeProjectsDir, repo.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "sess-1.jsonl"),
      [
        {
          type: "user",
          timestamp: "2026-10-01T00:00:00.000Z",
          cwd: repo,
          sessionId: "sess-1",
          message: { role: "user", content: [{ type: "text", text: "go" }] },
        },
        {
          type: "assistant",
          timestamp: "2026-10-01T00:00:01.000Z",
          cwd: repo,
          message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );
    const { out } = capture();
    const probe = await probeStaleness({
      ctx: {
        cwd: repo,
        claudeProjectsDir: context.claudeProjectsDir,
        codexSessionsDir: context.codexSessionsDir,
      },
      paths: basouPaths(repo),
      nowIso: NOW.toISOString(),
    });
    out.length = 0;
    const result = await doRunBoardMeasure({ json: true }, context);
    expect(probe).toEqual({ newSessions: 1, updatedSessions: 0, unverifiableSessions: 0 });
    expect(result.freshness.unimported).toEqual({ new: 1, updated: 0, unverifiable: 0 });
    // A dry run: nothing was imported.
    expect(result.freshness.newest_session_at).toBeNull();
    out.length = 0;
    await runBoardMeasure({}, context);
    expect(out.join("\n")).toContain(
      "\nFreshness:\n  newest session none\n  not imported 1 new, 0 updated, 0 unverifiable\n",
    );

    // A session that cannot be read could be the newest.
    const broken = join(repo, ".basou", "sessions", "ses_01HXABCDEF1234567890ABCS01");
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "session.yaml"), "session: [broken]\n");
    out.length = 0;
    process.exitCode = 0;
    await runBoardMeasure({}, context);
    expect(out.join("\n")).toContain("\nFreshness:\n  newest session not measured\n");
    expect(process.exitCode).toBe(1);
  });

  it("counts the active time and tokens basou stats counts, and prints them", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    await placeBoard(repo, boardYaml([]));
    const id = "ses_01HXABCDEF1234567890ABCS01";
    const dir = join(repo, ".basou", "sessions", id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "session.yaml"),
      [
        'schema_version: "0.1.0"',
        "session:",
        `  id: ${id}`,
        "  task_id: null",
        `  workspace_id: ${FIXED_WS_ID}`,
        "  source: { kind: claude-code-import, version: 0.1.0 }",
        "  started_at: 2026-10-01T00:00:00Z",
        "  status: imported",
        "  working_directory: /tmp/fixture",
        "  invocation: { command: claude, args: [], exit_code: null }",
        "  related_files: []",
        "  events_log: events.jsonl",
        "  metrics:",
        "    output_tokens: 1234",
        "    active_intervals:",
        "      - { start: 2026-10-01T00:00:00Z, end: 2026-10-01T01:30:00Z }",
        "",
      ].join("\n"),
    );
    await writeFile(join(dir, "events.jsonl"), "");
    const { out } = capture();
    await doRunStats({ json: true }, { cwd: repo, nowProvider: () => NOW });
    const stats = JSON.parse(out.join("\n")) as {
      totals: { billableActiveTimeMs: number; tokens: { output: number } };
    };
    out.length = 0;
    const result = await doRunBoardMeasure({ json: true }, ctx(repo));
    expect(result.effort.active_ms.union).toBe(stats.totals.billableActiveTimeMs);
    expect(result.effort.active_ms).toEqual({ union: 5_400_000, claude: 5_400_000, codex: null });
    expect(result.effort.output_tokens).toBe(stats.totals.tokens.output);
    out.length = 0;
    await runBoardMeasure({}, ctx(repo));
    const text = out.join("\n");
    expect(text).toContain("\nEffort:\n  from 2026-04-28 (");
    expect(text).toContain(
      "\n  active 1.5 h: Claude 1.5 h, Codex no Codex session\n  output tokens 1234, 0 sessions recorded none\n  commits: . ",
    );
  });

  it("says one day as one day", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    const declared = JSON.parse(boardYaml([])) as Record<string, unknown>;
    await placeBoard(
      repo,
      JSON.stringify({ ...declared, effort: { start: "2026-10-04", time_zone: "UTC" } }),
    );
    const { out } = capture();
    await runBoardMeasure({}, ctx(repo));
    expect(out.join("\n")).toContain("\nEffort:\n  from 2026-10-04 (UTC), 1 day\n");
  });

  it("prints the components found, each flagged when it is not registered, and those gone", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    await writeFile(join(repo, "package.json"), "{}\n");
    await mkdir(join(repo, "svc"));
    await writeFile(join(repo, "svc", "Dockerfile"), "FROM x\n");
    const name = basename(repo);
    const declared = JSON.parse(boardYaml([])) as Record<string, unknown>;
    await placeBoard(
      repo,
      JSON.stringify({
        ...declared,
        components: {
          [name]: { lane: ["core"] },
          [`${name}/gone`]: { lane: "-", note: "removed" },
        },
      }),
    );
    const { out } = capture();
    await runBoardMeasure({}, ctx(repo));
    expect(out.join("\n")).toContain(
      `\nComponents:\n  2 found, 1 unacknowledged, 1 gone\n    ${name}  manifest\n    ${name}/svc  container  (unacknowledged)\n    ${name}/gone  (gone)\n`,
    );
  });

  it("lists the components by code point, whatever order JSON gives their keys", async () => {
    const repo = await workspace([
      { path: ".", visibility: "private" },
      { path: "10" },
      { path: "9" },
    ]);
    for (const name of ["10", "9"]) {
      const dir = join(repo, name);
      await mkdir(dir);
      await execFileAsync("git", ["-c", "init.defaultBranch=main", "init", "-q"], {
        cwd: dir,
        env: ENV,
      });
      await writeFile(join(dir, "package.json"), "{}\n");
    }
    await placeBoard(repo, boardYaml([]));
    const { out } = capture();
    const result = await doRunBoardMeasure({ json: true }, ctx(repo));
    // An object puts the keys that read as array indexes first.
    expect(Object.keys(result.components.found ?? {})).toEqual(["9", "10"]);
    out.length = 0;
    await runBoardMeasure({}, ctx(repo));
    expect(out.join("\n")).toContain(
      "\n    10  manifest  (unacknowledged)\n    9  manifest  (unacknowledged)\n",
    );
  });

  it("judges trigger (c) of the axis only with --model, and prints the axis", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    const declared = JSON.parse(boardYaml([])) as Record<string, unknown>;
    await placeBoard(
      repo,
      JSON.stringify({
        ...declared,
        axis: {
          version: 1,
          review_due_days: 60,
          seed_review: { date: "2026-09-28", model: "Claude Opus 5.5" },
        },
      }),
    );
    const { out } = capture();
    const quiet = await doRunBoardMeasure({ json: true }, ctx(repo));
    expect(quiet.axis.review_needed).toBe(false);
    expect(quiet.axis.unjudged.map((u) => u.trigger)).toEqual(["c", "e"]);
    out.length = 0;
    await runBoardMeasure({ model: "Claude Fable 5.1" }, ctx(repo));
    expect(out.join("\n")).toContain(
      "\nAxis:\n  version 1, last reviewed 2026-09-28 by Claude Opus 5.5 (seed)\n  review needed: yes\n    (c) Claude Fable 5.1 judges; Claude Opus 5.5 reviewed last\n    (e) not judged: there is no previous record to compare the methods with\n",
    );
  });

  it("refuses an empty --model before measuring", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    await placeBoard(repo, boardYaml([]));
    const { out, err } = capture();
    await runBoardMeasure({ model: "  " }, ctx(repo));
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("--model must name a model.");
    expect(process.exitCode).toBe(1);
  });

  it("says when it does not know whether the axis is due a review", async () => {
    // A repository that is not there leaves the components, and so (a), unknown.
    const repo = await workspace([{ path: ".", visibility: "private" }, { path: "gone" }]);
    const declared = JSON.parse(boardYaml([])) as Record<string, unknown>;
    await placeBoard(
      repo,
      JSON.stringify({
        ...declared,
        axis: {
          version: 1,
          review_due_days: 60,
          seed_review: { date: "2026-09-28", model: "Claude Opus 5.5" },
        },
      }),
    );
    const { out } = capture();
    await runBoardMeasure({}, ctx(repo));
    expect(out.join("\n")).toContain(
      "\n  review needed: not known\n    (a) not judged: the components were not measured\n",
    );
  });

  it("refuses a workspace that is not initialized", async () => {
    const repo = await realpath(tmpRepo as string);
    const { out, err } = capture();
    await runBoardMeasure({ board: "board.yaml" }, ctx(repo));
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("Workspace not initialized. Run 'basou init' first.");
    expect(process.exitCode).toBe(1);
  });

  it("looks for a member repo's master in the portfolio config it is given", async () => {
    const repo = await realpath(tmpRepo as string);
    // A config the host's own could not be: the line below can only come from it.
    await writeFile(join(repo, ".portfolio.yaml"), "workspaces: [\n");
    const { err } = capture();
    await runBoardMeasure({ board: "board.yaml" }, ctx(repo));
    expect(err.join("\n")).toContain(
      "Ignoring ~/.basou/portfolio.yaml: ~/.basou/portfolio.yaml is not valid YAML.",
    );
    expect(process.exitCode).toBe(1);
  });
});

describe("basou board measure: what the review found", () => {
  it("looks for the workspace's own repo by its path, not at the first entry", async () => {
    const repo = await workspace([
      { path: "../other", visibility: "private" },
      { path: ".", visibility: "public" },
    ]);
    await placeBoard(repo, boardYaml([]));
    const { out, err } = capture();
    await runBoardMeasure({ json: true }, ctx(repo));
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("No --board given");
  });

  it.skipIf(process.platform === "win32")(
    "escapes a control character in a reason and in the board path",
    async () => {
      const repo = await workspace([{ path: ".", visibility: "private" }]);
      await symlink("/", join(repo, `e${ESC}.md`));
      await placeBoard(repo, boardYaml([MD]));
      const { out, err } = capture();
      await runBoardMeasure({}, ctx(repo));
      expect(out.join("\n")).toContain("measures.md: 'e");
      expect(out.join("\n")).toContain("is a symlink to outside the repository");
      expect(out.join("\n")).not.toContain(ESC);
      await runBoardMeasure({ board: `missing${ESC}.yaml` }, ctx(repo));
      expect(err.join("\n")).toContain("No board declaration at missing");
      expect(err.join("\n")).not.toContain(ESC);
    },
  );

  it("says when --board names a directory", async () => {
    const repo = await workspace([{ path: "." }]);
    await mkdir(join(repo, "boards"));
    const { err } = capture();
    await runBoardMeasure({ board: "boards" }, ctx(repo));
    expect(err.join("\n")).toContain("boards is a directory, not a board declaration.");
    expect(process.exitCode).toBe(1);
  });

  it("rounds a ratio in the summary", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    await writeFile(join(repo, "ONE.md"), "1\n");
    await writeFile(join(repo, "THREE.md"), "1\n2\n3\n");
    const text = JSON.parse(
      boardYaml([
        { id: "one", kind: "line_count", repo: ".", include: ["ONE.md"], unit: "lines" },
        { id: "three", kind: "line_count", repo: ".", include: ["THREE.md"], unit: "lines" },
      ]),
    );
    text.ratios = [{ id: "third", label: "r", numerator: "one", denominator: "three" }];
    await placeBoard(repo, JSON.stringify(text, null, 2));
    const { out } = capture();
    await runBoardMeasure({}, ctx(repo));
    expect(out.join("\n")).toContain("third  0.3333  (one / three)");
  });
});

describe("basou board record", () => {
  // A workspace whose own repo is private, with a board of one lane, and the
  // input of a record judged against the board as measured now.
  async function judged(
    states: string[] = ["done", "part", "none", "none", "none", "none"],
    board: string = boardYaml([MD]),
  ): Promise<{ repo: string; input: Record<string, unknown> }> {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    await placeBoard(repo, board);
    const { out } = capture();
    const measured = await doRunBoardMeasure({ json: true }, ctx(repo));
    out.length = 0;
    vi.restoreAllMocks();
    return {
      repo,
      input: {
        measure_digest: measured.digest,
        cells: states.map((state, i) => ({
          lane: "core",
          stage: `0${i + 1}`,
          state,
          ...(state === "blocked" ? { reason: "waiting" } : {}),
        })),
        prose: { summary: "fine" },
        judged_by: { model: "Claude Opus 5.5", self_reported: true },
      },
    };
  }

  const fed = (repo: string, input: unknown) => ({
    ...ctx(repo),
    readInput: async () => (typeof input === "string" ? input : JSON.stringify(input)),
  });

  it("writes the record beside board.yaml, all of it, and says where", async () => {
    const { repo, input } = await judged();
    const { out } = capture();
    const result = await doRunBoardRecord({}, fed(repo, input));
    expect(result.record).toMatch(/^board\/records\/[0-7][0-9A-HJKMNP-TV-Z]{25}\.json$/);
    expect(out.join("\n")).toBe(`Recorded ${result.record}\nNot compared with a previous record.`);
    const name = (result.record ?? "").split("/").at(-1) ?? "";
    expect(await readdir(join(repo, "board", "records"))).toEqual([name]);
    const written = JSON.parse(await readFile(join(repo, result.record ?? ""), "utf8"));
    expect(written).toMatchObject({
      record_version: 1,
      measure: { digest: input.measure_digest },
      judged_by: { model: "Claude Opus 5.5", self_reported: true },
      order_anomalies: [],
    });
    // Measured again as the judge's model: with no review on record, (c) fires.
    expect(written.measure.axis.reasons.map((r: { trigger: string }) => r.trigger)).toEqual([
      "b",
      "c",
    ]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("checks and measures but writes nothing with --dry-run, and reports as JSON", async () => {
    const { repo, input } = await judged();
    const { out } = capture();
    const result = await doRunBoardRecord({ dryRun: true, json: true }, fed(repo, input));
    expect(result).toEqual({
      record: null,
      dry_run: true,
      complete: true,
      not_found: [],
      order_anomalies: [],
      diff: null,
    });
    expect(JSON.parse(out.join("\n"))).toEqual(result);
    out.length = 0;
    await doRunBoardRecord({ dryRun: true }, fed(repo, input));
    expect(out.join("\n")).toBe(
      "Dry run: the record checked out (nothing was written).\nNot compared with a previous record.",
    );
    await expect(readdir(join(repo, "board"))).resolves.toEqual(["board.yaml"]);
  });

  it("measures again as the judge's model, against the review the axis has on record", async () => {
    const board = JSON.parse(boardYaml([MD]));
    board.axis.seed_review = { date: "2026-10-01", model: "Other Model" };
    const { repo, input } = await judged(undefined, JSON.stringify(board));
    capture();
    const result = await doRunBoardRecord({}, fed(repo, input));
    const written = JSON.parse(await readFile(join(repo, result.record ?? ""), "utf8"));
    expect(written.measure.axis.reasons).toContainEqual({
      trigger: "c",
      detail: "Claude Opus 5.5 judges; Other Model reviewed last",
    });
  });

  it("says where the record is from the current directory, or beside a --board as given", async () => {
    const { repo, input } = await judged();
    const deeper = join(repo, "sub", "deeper");
    await mkdir(deeper, { recursive: true });
    const { out } = capture();
    const result = await doRunBoardRecord({}, { ...fed(repo, input), cwd: deeper });
    expect(result.record).toMatch(
      /^\.\.\/\.\.\/board\/records\/[0-7][0-9A-HJKMNP-TV-Z]{25}\.json$/,
    );
    expect(out.join("\n")).toBe(`Recorded ${result.record}\nNot compared with a previous record.`);
    await expect(readFile(join(deeper, result.record ?? ""), "utf8")).resolves.toContain(
      '"record_version": 1',
    );
  });

  it("refuses records outside a repo the manifest declares private, unless --not-private", async () => {
    const { repo, input } = await judged();
    // Beside the repo, under a name that starts with the repo's.
    const outside = `${repo}-elsewhere`;
    await mkdir(outside);
    try {
      await placeBoard(outside, boardYaml([MD]));
      const board = join(outside, "board", "board.yaml");
      const { out, err } = capture();
      await runBoardRecord({ board }, fed(repo, input));
      expect(err.join("\n")).toContain(
        "is not in a repo the manifest declares private, and a record holds what the trail holds (open tracks, time worked, model names). Pass --not-private to record there anyway; nothing was written.",
      );
      expect(out).toEqual([]);
      expect(process.exitCode).toBe(1);
      await expect(readdir(join(outside, "board"))).resolves.toEqual(["board.yaml"]);
      process.exitCode = 0;
      const result = await doRunBoardRecord({ board, notPrivate: true }, fed(repo, input));
      expect(result.record).toMatch(
        new RegExp(`^${join(outside, "board", "records")}/[0-7][0-9A-HJKMNP-TV-Z]{25}\\.json$`),
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses records in a repo inside the private one that the manifest does not declare private", async () => {
    const repo = await workspace([
      { path: ".", visibility: "private" },
      { path: "pub", visibility: "public" },
    ]);
    await placeBoard(repo, boardYaml([MD]), "pub/board/board.yaml");
    const { err } = capture();
    await runBoardRecord({ board: "pub/board/board.yaml", dryRun: true }, fed(repo, "{}"));
    expect(err.join("\n")).toContain(
      "pub/board/records is not in a repo the manifest declares private",
    );
    expect(process.exitCode).toBe(1);
  });

  it("refuses, with --dry-run too, a board.yaml of another name, records under .basou/, or a records/ that is not a directory", async () => {
    const { repo, input } = await judged();
    const { out, err } = capture();
    await placeBoard(repo, boardYaml([MD]), "board/other.yaml");
    await runBoardRecord({ board: "board/other.yaml", dryRun: true }, fed(repo, input));
    expect(err.join("\n")).toContain(
      "board/other.yaml is not named board.yaml: basou board record reads only a file of that name, so that the records/ beside it holds one board's records; nothing was written.",
    );
    err.length = 0;
    await placeBoard(repo, boardYaml([MD]), ".basou/board/board.yaml");
    await runBoardRecord({ board: ".basou/board/board.yaml" }, fed(repo, input));
    expect(err.join("\n")).toContain(
      ".basou/board/records would be under a .basou/ directory, where basou board record writes nothing; nothing was written.",
    );
    err.length = 0;
    await symlink(join(repo, ".basou", "board"), join(repo, "linked"));
    await runBoardRecord({ board: "linked/board.yaml", dryRun: true }, fed(repo, input));
    expect(err.join("\n")).toContain("linked/records would be under a .basou/ directory");
    await expect(readdir(join(repo, ".basou", "board"))).resolves.toEqual(["board.yaml"]);
    err.length = 0;
    await writeFile(join(repo, "board", "records"), "not a directory\n");
    await runBoardRecord({ dryRun: true }, fed(repo, input));
    expect(err.join("\n")).toContain(
      "board/records is not a directory (a symlink or a file); nothing was written.",
    );
    expect(out).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it("says why a record could not be written, and leaves nothing behind", async () => {
    const { repo, input } = await judged();
    const records = join(repo, "board", "records");
    await mkdir(records);
    await chmod(records, 0o555);
    try {
      const { out, err } = capture();
      await runBoardRecord({}, fed(repo, input));
      expect(err.join("\n")).toContain(
        "The record could not be written (EACCES); nothing was written.",
      );
      expect(out).toEqual([]);
      expect(process.exitCode).toBe(1);
      expect(await readdir(records)).toEqual([]);
    } finally {
      await chmod(records, 0o755);
    }
  });

  it("lists the stages left behind", async () => {
    const { repo, input } = await judged(["done", "none", "part", "blocked", "done", "none"]);
    const { out } = capture();
    await doRunBoardRecord({}, fed(repo, input));
    expect(out.join("\n")).toContain(
      "Order anomalies (2):\n  core 02 is none before 03, which is done or begun\n  core 04 is blocked before 05, which is done or begun",
    );
  });

  it("refuses, and writes nothing, when the board moved since the judgement", async () => {
    const { repo, input } = await judged();
    await writeFile(join(repo, "LATER.md"), "# later\n");
    const { out, err } = capture();
    await runBoardRecord({}, fed(repo, input));
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain(
      `measure_digest is ${input.measure_digest}, but the board measures sha256:`,
    );
    expect(err.join("\n")).toContain(
      "something it measures moved since the judgement, or basou was rebuilt or upgraded since that measurement. Measure again and judge that; nothing was written.",
    );
    expect(process.exitCode).toBe(1);
    await expect(readdir(join(repo, "board"))).resolves.toEqual(["board.yaml"]);
  });

  it("refuses an input it cannot read, saying everything wrong with it at once", async () => {
    const { repo, input } = await judged();
    const { out, err } = capture();
    await runBoardRecord({}, fed(repo, "{not json"));
    expect(err.join("\n")).toContain("The record's input is not valid JSON; nothing was written.");
    err.length = 0;
    await runBoardRecord({}, fed(repo, "  \n"));
    expect(err.join("\n")).toBe(
      "No input: pipe the record's JSON to stdin or pass --file <path>.\nNothing was written.",
    );
    err.length = 0;
    const cells = (input.cells as Record<string, unknown>[]).slice(1);
    await runBoardRecord({}, fed(repo, { ...input, cells, extra: true }));
    expect(err.join("\n")).toBe(
      "The record's input was refused; nothing was written:\n  - (top level): unknown key 'extra'\n  - cells: lane 'core' has no cell at stage '01'",
    );
    err.length = 0;
    await writeFile(join(repo, "board", "board.yaml"), "board_version: 1\n");
    await runBoardRecord({}, fed(repo, input));
    expect(err.join("\n")).toMatch(
      /^board\/board\.yaml is not a valid board declaration:\n[\s\S]*\nNothing was written\.$/,
    );
    expect(out).toEqual([]);
    expect(process.exitCode).toBe(1);
    await expect(readdir(join(repo, "board"))).resolves.toEqual(["board.yaml"]);
  });

  it("reads the input from --file, or from stdin given -", async () => {
    const { repo, input } = await judged();
    // Outside the repository, whose files the board counts.
    const outside = await mkdtemp(join(tmpdir(), "basou-board-input-"));
    const file = join(outside, "input.json");
    await writeFile(file, JSON.stringify(input));
    capture();
    try {
      const fromFile = await doRunBoardRecord({ file, dryRun: true }, ctx(repo));
      expect(fromFile.dry_run).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    const fromStdin = await doRunBoardRecord({ file: "-", dryRun: true }, fed(repo, input));
    expect(fromStdin.dry_run).toBe(true);
    await expect(doRunBoardRecord({ file: join(repo, "missing.json") }, ctx(repo))).rejects.toThrow(
      /Input file not found/,
    );
  });
});

describe("basou board measure and record against the previous record", () => {
  async function recorded(): Promise<{ repo: string; first: string }> {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    await placeBoard(repo, boardYaml([MD]));
    capture();
    const measured = await doRunBoardMeasure({ json: true }, ctx(repo));
    const result = await doRunBoardRecord(
      {},
      {
        ...ctx(repo),
        readInput: async () =>
          JSON.stringify(
            judgement(measured.digest, ["done", "part"], {
              npm: { value: "0.64.0", observed_at: "2026-10-05", source: "registry" },
              site: { value: "0.64.0", observed_at: "2026-10-05", source: "site" },
            }),
          ),
      },
    );
    vi.restoreAllMocks();
    const first =
      (result.record ?? "")
        .split("/")
        .at(-1)
        ?.replace(/\.json$/, "") ?? "";
    return { repo, first };
  }

  function judgement(digest: string, states: string[], observed: Record<string, unknown>) {
    return {
      measure_digest: digest,
      observed,
      cells: ["01", "02", "03", "04", "05", "06"].map((stage, i) => ({
        lane: "core",
        stage,
        state: states[i] ?? "none",
      })),
      prose: { summary: "fine" },
      judged_by: { model: "Claude Opus 5.5", self_reported: true },
    };
  }

  it("measures against the last record, and says first what moved", async () => {
    const { repo, first } = await recorded();
    await writeFile(join(repo, "LATER.md"), "# later\n");
    const { out } = capture();
    const m = await doRunBoardMeasure({ json: true }, ctx(repo));
    expect(m.diff?.against).toBe(first);
    expect(m.diff?.values).toContainEqual({
      at: "measures.md.value",
      before: 2,
      after: 3,
      delta: 1,
    });
    out.length = 0;
    await doRunBoardMeasure({}, ctx(repo));
    const lines = out.join("\n").split("\n");
    expect(lines.slice(2, 5)).toEqual(["", `Since the previous record ${first}:`, lines[4]]);
    expect(out.join("\n")).toContain("  measures.md.value: 2 -> 3 (+1)\n");
  });

  it("reads no records for a declaration not named board.yaml", async () => {
    const { repo } = await recorded();
    await placeBoard(repo, boardYaml([MD]), "board/other.yaml");
    const { out } = capture();
    const m = await doRunBoardMeasure({ board: "board/other.yaml", json: true }, ctx(repo));
    expect(m.diff).toBeNull();
    expect(m.components.kind_changed).toBeNull();
    out.length = 0;
    await doRunBoardMeasure({ board: "board/other.yaml" }, ctx(repo));
    expect(out.join("\n")).toContain(
      "\n\nNo records are read for a declaration not named board.yaml.\n",
    );
  });

  it("records again, saying what moved in the cells, the observations and the measurement", async () => {
    const { repo, first } = await recorded();
    capture();
    const measured = await doRunBoardMeasure({ json: true }, ctx(repo));
    vi.restoreAllMocks();
    const { out } = capture();
    const result = await doRunBoardRecord(
      {},
      {
        ...ctx(repo),
        readInput: async () =>
          JSON.stringify(
            judgement(measured.digest, ["done", "done", "part"], {
              npm: { value: "0.65.0", observed_at: "2026-10-06", source: "registry" },
              site: { value: null, observed_at: "2026-10-06", source: "site", error: "timeout" },
            }),
          ),
      },
    );
    expect(result.diff).toMatchObject({
      against: first,
      cells: [
        { lane: "core", stage: "02", before: "part", after: "done" },
        { lane: "core", stage: "03", before: "none", after: "part" },
      ],
      observed: [
        { name: "npm", before: { value: "0.64.0" }, after: { value: "0.65.0" } },
        { name: "site", before: { value: "0.64.0" }, after: { value: null, error: "timeout" } },
      ],
    });
    expect(result.diff?.measure.values).toEqual(measured.diff?.values);
    const text = out.join("\n");
    expect(text).toContain(
      `Since the previous record ${first}:\n  core 02: part -> done\n  core 03: none -> part\n  observed npm: "0.64.0" -> "0.65.0"\n  observed site: "0.64.0" -> null (timeout)\n`,
    );
  });

  it("shows what a previous record holds with its control characters escaped", async () => {
    const { repo, first } = await recorded();
    const file = join(repo, "board", "records", `${first}.json`);
    const written = JSON.parse(await readFile(file, "utf8"));
    written.cells[1].state = `part${ESC}[31m`;
    written.measure.methods[`evil${ESC}[2J`] = 1;
    await writeFile(file, JSON.stringify(written));
    const { out } = capture();
    const m = await doRunBoardMeasure({ json: true }, ctx(repo));
    out.length = 0;
    await doRunBoardMeasure({}, ctx(repo));
    await doRunBoardRecord(
      { dryRun: true },
      {
        ...ctx(repo),
        readInput: async () => JSON.stringify(judgement(m.digest, ["done", "done"], {})),
      },
    );
    const text = out.join("\n");
    expect(text).not.toContain(ESC);
    expect(text).toContain("  core 02: part\\x1b[31m -> done\n");
    expect(text).toContain("methods changed: evil\\x1b[2J 1 -> none");
  });

  it("takes a record it cannot read as a gap, not as no record", async () => {
    const { repo, first } = await recorded();
    await writeFile(join(repo, "board", "records", `${first}.json`), "{ not json");
    // The record says why, in its text and as JSON, before anything else.
    capture();
    const measuredNow = await doRunBoardMeasure({ json: true }, ctx(repo));
    vi.restoreAllMocks();
    const said = capture();
    const result = await doRunBoardRecord(
      { dryRun: true },
      {
        ...ctx(repo),
        readInput: async () => JSON.stringify(judgement(measuredNow.digest, ["done"], {})),
      },
    );
    expect(result.diff).toBeNull();
    expect(result.not_found).toContainEqual({
      at: "diff",
      reason: `the record ${first} could not be read as JSON`,
    });
    const recordText = said.out.join("\n").split("\n");
    expect(recordText[1]).toBe(
      "The previous record could not be read, so nothing is compared with it.",
    );
    expect(recordText[2]).toMatch(/^The measurement recorded is not complete \(\d+\):$/);
    expect(recordText).toContain(`  diff: the record ${first} could not be read as JSON`);
    expect(said.out.join("\n")).not.toContain("not measured");
    vi.restoreAllMocks();
    const { out } = capture();
    const m = await doRunBoardMeasure({ json: true }, ctx(repo));
    expect(m.diff).toBeNull();
    expect(m.complete).toBe(false);
    expect(m.not_found).toContainEqual({
      at: "diff",
      reason: `the record ${first} could not be read as JSON`,
    });
    expect(process.exitCode).toBe(1);
    out.length = 0;
    await doRunBoardMeasure({}, ctx(repo));
    expect(out.join("\n")).toContain(
      "\n\nThe previous record could not be read (see Not measured).\n",
    );
    expect(out.join("\n")).toContain("Components:\n  0 found, 0 unacknowledged, gone not known\n");
  });
});

describe("measureLiveBoard: the board page's measurement with no board", () => {
  // A Claude Code transcript of the workspace that was never imported, beside
  // it where ctx() points the dry run of an import.
  async function neverImported(repo: string): Promise<void> {
    const projectDir = join(ctx(repo).claudeProjectsDir, repo.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "sess-1.jsonl"),
      [
        {
          type: "user",
          timestamp: "2026-10-01T00:00:00.000Z",
          cwd: repo,
          sessionId: "sess-1",
          message: { role: "user", content: [{ type: "text", text: "go" }] },
        },
        {
          type: "assistant",
          timestamp: "2026-10-01T00:00:01.000Z",
          cwd: repo,
          message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );
  }

  // Every path under a directory with, for a file, its size, modification
  // time and content.
  async function snapshot(dir: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        out[path] = "dir";
        Object.assign(out, await snapshot(path));
      } else {
        const s = await stat(path, { bigint: true });
        const sha = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
        out[path] = `${s.size}:${s.mtimeNs}:${sha}`;
      }
    }
    return out;
  }

  it("writes nothing, the dry run of an import included", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    await neverImported(repo);
    const before = await snapshot(repo);
    const m = await measureLiveBoard(repo, ctx(repo));
    expect(m.freshness.unimported).toEqual({ new: 1, updated: 0, unverifiable: 0 });
    expect(m.freshness.newest_session_at).toBeNull();
    expect(await snapshot(repo)).toEqual(before);
  });

  it("counts the same when dry runs of an import are started at once", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    await neverImported(repo);
    const context = ctx(repo);
    const args = {
      ctx: {
        cwd: repo,
        claudeProjectsDir: context.claudeProjectsDir,
        codexSessionsDir: context.codexSessionsDir,
      },
      paths: basouPaths(repo),
      nowIso: NOW.toISOString(),
    };
    const log = console.log;
    const error = console.error;
    const [live, ...probes] = await Promise.all([
      measureLiveBoard(repo, context),
      ...[1, 2, 3].map(() => probeStaleness(args)),
    ]);
    expect(live?.freshness.unimported).toEqual({ new: 1, updated: 0, unverifiable: 0 });
    for (const probe of probes) {
      expect(probe).toEqual({ newSessions: 1, updatedSessions: 0, unverifiableSessions: 0 });
    }
    // Each capture put the console back as it found it.
    expect(console.log).toBe(log);
    expect(console.error).toBe(error);
  });

  it("measures the repos the manifest declares, with no declaration and no board.yaml", async () => {
    const repo = await workspace([
      { path: ".", visibility: "public" },
      { path: "../elsewhere", visibility: "private" },
    ]);
    const m = await measureLiveBoard(repo, ctx(repo));
    expect(m.repos.map((r) => r.path)).toEqual([".", "../elsewhere"]);
    expect(m.not_found.map((n) => n.at)).toContain("repos[../elsewhere]");
    expect(m.measured_at).toBe(NOW.toISOString());
    // The dry run of an import ran, over the logs beside the workspace.
    expect(m.freshness.unimported).toEqual({ new: 0, updated: 0, unverifiable: 0 });
  });

  it("measures the workspace's own repo when the manifest declares none", async () => {
    const repo = await workspace();
    const m = await measureLiveBoard(repo, ctx(repo));
    expect(m.repos.map((r) => r.path)).toEqual(["."]);
    expect(m.not_found.map((n) => n.at)).not.toContain("repos");
  });

  it("measures the workspace's own repo, and says why, when the manifest cannot be read", async () => {
    const repo = await workspace([{ path: ".", visibility: "private" }]);
    await writeFile(join(repo, ".basou", "manifest.yaml"), "repos: [: broken\n");
    const m = await measureLiveBoard(repo, ctx(repo));
    expect(m.repos.map((r) => r.path)).toEqual(["."]);
    expect(m.complete).toBe(false);
    expect(m.not_found[0]).toEqual({
      at: "repos",
      reason: "the manifest could not be read, so only the workspace's own repo was measured",
    });
  });
});
