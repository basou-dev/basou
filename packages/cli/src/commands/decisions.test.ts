import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  GENERATED_END,
  GENERATED_START,
  basouPaths,
  createManifest,
  ensureBasouDirectory,
  writeManifest,
  writeYamlFile,
} from "@basou/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  doRunDecisionsGenerate,
  registerDecisionsCommand,
  runDecisionsGenerate,
} from "./decisions.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
};

const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const FIXED_DATE = new Date("2026-05-09T03:00:00.000Z");

const SES = (suffix: string) => `ses_01HXABCDEF1234567890ABC${suffix}`;
const EVT = (suffix: string) => `evt_01HXABCDEF1234567890ABC${suffix}`;
const DEC = (suffix: string) => `decision_01HXABCDEF1234567890ABC${suffix}`;

let tmpRepo: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-decisions-cli-test-"));
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], {
    cwd: tmpRepo,
    env: ENV,
  });
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
  id: string,
  startedAt: string,
  events?: string,
): Promise<void> {
  const paths = basouPaths(repo);
  const sessionDir = join(paths.sessions, id);
  await mkdir(sessionDir, { recursive: true });
  await writeYamlFile(join(sessionDir, "session.yaml"), {
    schema_version: "0.1.0",
    session: {
      id,
      label: `fixture ${id.slice(-3)}`,
      task_id: null,
      workspace_id: FIXED_WS_ID,
      source: { kind: "terminal", version: "0.1.0" },
      started_at: startedAt,
      status: "completed",
      working_directory: "/tmp/fixture",
      invocation: { command: "echo", args: [], exit_code: 0 },
      related_files: [],
      events_log: "events.jsonl",
    },
  });
  if (events !== undefined) await writeFile(join(sessionDir, "events.jsonl"), events);
}

function decisionLine(
  sessionId: string,
  evt: string,
  decisionId: string,
  title: string,
  occurredAt: string,
): string {
  return `${JSON.stringify({
    schema_version: "0.1.0",
    type: "decision_recorded",
    id: EVT(evt),
    session_id: sessionId,
    occurred_at: occurredAt,
    source: "human",
    decision_id: decisionId,
    title,
  })}\n`;
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

describe("basou decisions generate", () => {
  it("case 1: empty workspace produces decisions.md with no-decisions placeholder", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunDecisionsGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    expect(joinCalls(out)).toContain("decisions: 0");
    const body = await readFile(basouPaths(repo).files.decisions, "utf8");
    expect(body).toContain(GENERATED_START);
    expect(body).toContain(GENERATED_END);
    expect(body).toContain("(no decisions recorded yet)");
  });

  it("case 2: re-generation preserves manual text outside the markers", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunDecisionsGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    const decisionsPath = basouPaths(repo).files.decisions;
    const first = await readFile(decisionsPath, "utf8");
    await writeFile(decisionsPath, `${first}\n## Manual\nhand-written content\n`);
    await doRunDecisionsGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    const second = await readFile(decisionsPath, "utf8");
    expect(second).toContain("## Manual");
    expect(second).toContain("hand-written content");
  });

  it("case 3: missing_start aborts with exit 1 and Markers mismatched in decisions.md", async () => {
    const repo = await setupInitedRepo();
    const decisionsPath = basouPaths(repo).files.decisions;
    await writeFile(decisionsPath, `prose\n${GENERATED_END}\n`);
    captureStdout();
    const err = captureStderr();
    await runDecisionsGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err)).toContain("Markers mismatched in decisions.md");
  });

  it("case 4: missing_end aborts with exit 1", async () => {
    const repo = await setupInitedRepo();
    const decisionsPath = basouPaths(repo).files.decisions;
    await writeFile(decisionsPath, `${GENERATED_START}\nbody\n`);
    captureStdout();
    const err = captureStderr();
    await runDecisionsGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err)).toContain("Markers mismatched in decisions.md");
  });

  it("case 5: legacy file with no markers aborts with 'Markers missing in decisions.md'", async () => {
    const repo = await setupInitedRepo();
    const decisionsPath = basouPaths(repo).files.decisions;
    await writeFile(decisionsPath, "old content\n");
    captureStdout();
    const err = captureStderr();
    await runDecisionsGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err)).toContain("Markers missing in decisions.md");
  });

  it("case 6: multiple marker pairs abort", async () => {
    const repo = await setupInitedRepo();
    const decisionsPath = basouPaths(repo).files.decisions;
    await writeFile(
      decisionsPath,
      `${GENERATED_START}\na\n${GENERATED_END}\n${GENERATED_START}\nb\n${GENERATED_END}\n`,
    );
    captureStdout();
    const err = captureStderr();
    await runDecisionsGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err)).toContain("Markers mismatched in decisions.md");
  });

  it("case 7: partial trailing line in events.jsonl produces a stderr warning", async () => {
    const repo = await setupInitedRepo();
    const id = SES("X01");
    // JSON-valid line missing a trailing newline → partial_trailing_line.
    const trailing = `${JSON.stringify({
      schema_version: "0.1.0",
      type: "session_started",
      id: EVT("E10"),
      session_id: id,
      occurred_at: "2026-05-08T11:01:00+09:00",
      source: "human",
    })}`;
    const events =
      decisionLine(id, "E11", DEC("D10"), "ok", "2026-05-08T11:00:00+09:00") + trailing;
    await placeSession(repo, id, "2026-05-08T11:00:00+09:00", events);
    captureStdout();
    const err = captureStderr();
    await doRunDecisionsGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    expect(joinCalls(err)).toMatch(
      /Warning: (ignored partial trailing line|skipped malformed JSON)/,
    );
  });

  it("case 8: not-a-workspace exits 1", async () => {
    const tmp = getTmpRepo();
    captureStdout();
    const err = captureStderr();
    await runDecisionsGenerate({}, { cwd: tmp, nowProvider: () => FIXED_DATE });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err)).toContain("Workspace not initialized. Run 'basou init' first.");
  });

  it("case 9: I/O error on sessions enumeration exits 1", async () => {
    const repo = await setupInitedRepo();
    const paths = basouPaths(repo);
    await chmod(paths.sessions, 0o000);
    captureStdout();
    const err = captureStderr();
    try {
      await runDecisionsGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
      expect(process.exitCode).toBe(1);
      expect(joinCalls(err)).toContain("Failed to enumerate sessions");
    } finally {
      await chmod(paths.sessions, 0o755);
    }
  });

  it("case 10: zero decisions emits the no-decisions placeholder body", async () => {
    const repo = await setupInitedRepo();
    await placeSession(repo, SES("X02"), "2026-05-08T11:00:00+09:00");
    captureStdout();
    await doRunDecisionsGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    const body = await readFile(basouPaths(repo).files.decisions, "utf8");
    expect(body).toContain("(no decisions recorded yet)");
  });

  it("case 11: a single decision renders the 4-field section", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("X03");
    const did = DEC("D20");
    await placeSession(
      repo,
      sid,
      "2026-05-08T11:00:00+09:00",
      decisionLine(sid, "E20", did, "use zod", "2026-05-08T11:30:00+09:00"),
    );
    captureStdout();
    await doRunDecisionsGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    const body = await readFile(basouPaths(repo).files.decisions, "utf8");
    expect(body).toContain(`## ${did}: use zod`);
    expect(body).toContain("- 決定日: 2026-05-08");
    expect(body).toContain("- 判断: use zod");
  });

  it("case 12: multiple decisions across sessions render chronologically", async () => {
    const repo = await setupInitedRepo();
    const sidA = SES("X04");
    const sidB = SES("X05");
    await placeSession(
      repo,
      sidA,
      "2026-05-08T11:00:00+09:00",
      decisionLine(sidA, "E30", DEC("D30"), "first", "2026-05-08T11:00:00+09:00") +
        decisionLine(sidA, "E31", DEC("D32"), "third", "2026-05-08T13:00:00+09:00"),
    );
    await placeSession(
      repo,
      sidB,
      "2026-05-08T12:00:00+09:00",
      decisionLine(sidB, "E32", DEC("D31"), "second", "2026-05-08T12:00:00+09:00"),
    );
    const out = captureStdout();
    await doRunDecisionsGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    expect(joinCalls(out)).toContain("decisions: 3");
    const body = await readFile(basouPaths(repo).files.decisions, "utf8");
    const idx1 = body.indexOf("first");
    const idx2 = body.indexOf("second");
    const idx3 = body.indexOf("third");
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
  });

  it("case 13: same-timestamp decisions tie-break by decisionId ascending", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("X06");
    const sameTime = "2026-05-08T11:00:00+09:00";
    await placeSession(
      repo,
      sid,
      sameTime,
      decisionLine(sid, "E40", DEC("DB0"), "B", sameTime) +
        decisionLine(sid, "E41", DEC("DA0"), "A", sameTime),
    );
    captureStdout();
    await doRunDecisionsGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    const body = await readFile(basouPaths(repo).files.decisions, "utf8");
    const idxA = body.indexOf(`## ${DEC("DA0")}`);
    const idxB = body.indexOf(`## ${DEC("DB0")}`);
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(idxA);
  });

  it("case 14: stdout summary reports the decision count", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("X07");
    await placeSession(
      repo,
      sid,
      "2026-05-08T11:00:00+09:00",
      decisionLine(sid, "E50", DEC("D50"), "k", "2026-05-08T11:00:00+09:00"),
    );
    const out = captureStdout();
    await doRunDecisionsGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    expect(joinCalls(out)).toContain("decisions: 1");
  });

  it("register: wiring exposes 'decisions' and 'decisions generate' on the program", () => {
    const program = new Command();
    registerDecisionsCommand(program);
    const decisions = program.commands.find((c) => c.name() === "decisions");
    expect(decisions).toBeDefined();
    const generate = decisions?.commands.find((c) => c.name() === "generate");
    expect(generate).toBeDefined();
  });
});
