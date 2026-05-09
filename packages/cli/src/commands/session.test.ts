import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  basouPaths,
  createManifest,
  ensureBasouDirectory,
  writeManifest,
  writeYamlFile,
} from "@basou/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doRunSessionList, doRunSessionShow, registerSessionCommand } from "./session.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
};

const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const FIXED_DATE = new Date("2026-05-09T03:00:00.000Z");

let tmpRepo: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-session-cli-test-"));
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
  // Canonicalize so the repo path matches what `git rev-parse
  // --show-toplevel` will report. macOS resolves `/var/folders/...` to
  // `/private/var/folders/...`, and a non-canonical fixture path would make
  // the working_directory display logic compare against the wrong root.
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

type SessionFixture = {
  id: string;
  status?:
    | "initialized"
    | "running"
    | "waiting_approval"
    | "completed"
    | "failed"
    | "interrupted"
    | "imported";
  startedAt?: string;
  endedAt?: string;
  workingDirectory?: string;
  source?: { kind: "claude-code-adapter" | "human" | "import" | "terminal"; version: "0.1.0" };
  label?: string;
  exitCode?: number | null;
  args?: string[];
  command?: string;
  relatedFiles?: string[];
  events?: string; // raw events.jsonl body (concatenated lines, each with \n)
};

async function createSession(repo: string, fixture: SessionFixture): Promise<string> {
  const paths = basouPaths(repo);
  const sessionDir = join(paths.sessions, fixture.id);
  await mkdir(sessionDir, { recursive: true });
  const status = fixture.status ?? "completed";
  const session = {
    schema_version: "0.1.0" as const,
    session: {
      id: fixture.id,
      label: fixture.label ?? `fixture ${fixture.id}`,
      task_id: null,
      workspace_id: FIXED_WS_ID,
      source: fixture.source ?? { kind: "terminal" as const, version: "0.1.0" as const },
      started_at: fixture.startedAt ?? "2026-05-08T11:00:00+09:00",
      ...(fixture.endedAt !== undefined ? { ended_at: fixture.endedAt } : {}),
      status,
      working_directory: fixture.workingDirectory ?? repo,
      invocation: {
        command: fixture.command ?? "echo",
        args: fixture.args ?? [],
        exit_code: fixture.exitCode === undefined ? 0 : fixture.exitCode,
      },
      related_files: fixture.relatedFiles ?? [],
      events_log: "events.jsonl",
    },
  };
  await writeYamlFile(join(sessionDir, "session.yaml"), session);
  if (fixture.events !== undefined) {
    await writeFile(join(sessionDir, "events.jsonl"), fixture.events);
  }
  return fixture.id;
}

function captureStdout() {
  return vi.spyOn(console, "log").mockImplementation(() => undefined);
}

function captureStderr() {
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

function joinCalls(spy: ReturnType<typeof captureStdout>): string {
  return spy.mock.calls.map((c) => String(c[0])).join("\n");
}

const SES = (suffix: string) => `ses_01HXABCDEF1234567890ABC${suffix}`;
const EVT = (suffix: string) => `evt_01HXABCDEF1234567890ABC${suffix}`;

const SESSION_STARTED_LINE = (sessionId: string, suffix: string, occurredAt: string) =>
  `${JSON.stringify({
    schema_version: "0.1.0",
    type: "session_started",
    id: EVT(suffix),
    session_id: sessionId,
    occurred_at: occurredAt,
    source: "terminal-recording",
  })}\n`;

const SESSION_ENDED_LINE = (sessionId: string, suffix: string, occurredAt: string) =>
  `${JSON.stringify({
    schema_version: "0.1.0",
    type: "session_ended",
    id: EVT(suffix),
    session_id: sessionId,
    occurred_at: occurredAt,
    source: "terminal-recording",
    exit_code: 0,
  })}\n`;

describe("doRunSessionList", () => {
  it("case 1: empty workspace (sessions dir absent) prints No sessions found.", async () => {
    const repo = await setupInitedRepo();
    // remove .basou/sessions to mimic an even older basou not creating it
    await rm(join(repo, ".basou", "sessions"), { recursive: true, force: true });
    const out = captureStdout();
    await doRunSessionList({}, { cwd: repo });
    expect(joinCalls(out)).toBe("No sessions found.");
  });

  it("case 2: empty sessions directory prints No sessions found.", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunSessionList({}, { cwd: repo });
    expect(joinCalls(out)).toBe("No sessions found.");
  });

  it("case 3: lists multiple sessions in started_at desc order", async () => {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: SES("X01"), startedAt: "2026-05-08T11:00:00+09:00" });
    await createSession(repo, { id: SES("X02"), startedAt: "2026-05-09T11:00:00+09:00" });
    await createSession(repo, { id: SES("X03"), startedAt: "2026-05-07T11:00:00+09:00" });
    const out = captureStdout();
    await doRunSessionList({}, { cwd: repo });
    const lines = joinCalls(out).split("\n");
    expect(lines[0]).toContain("SHORT_ID");
    expect(lines[1]).toContain("01HXAB"); // SHORT_ID prefix common to all
    // Newest first (X02), then X01, then X03.
    expect(lines[1]).toContain("2026-05-09");
    expect(lines[2]).toContain("2026-05-08");
    expect(lines[3]).toContain("2026-05-07");
  });

  it("case 4: --json emits an array carrying suspect/suspect_reason fields", async () => {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: SES("X01") });
    const out = captureStdout();
    await doRunSessionList({ json: true }, { cwd: repo });
    const stdout = joinCalls(out);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toHaveProperty("suspect", false);
    expect(parsed[0]).toHaveProperty("suspect_reason", null);
    expect(parsed[0]).toHaveProperty("status", "completed");
  });

  it("case 5: skips a session with broken session.yaml and warns to stderr", async () => {
    const repo = await setupInitedRepo();
    const paths = basouPaths(repo);
    const broken = SES("X05");
    await mkdir(join(paths.sessions, broken), { recursive: true });
    await writeFile(join(paths.sessions, broken, "session.yaml"), "{this is not yaml: ::");
    await createSession(repo, { id: SES("X06") });
    const out = captureStdout();
    const err = captureStderr();
    await doRunSessionList({}, { cwd: repo });
    const stdout = joinCalls(out);
    const stderr = joinCalls(err);
    expect(stderr).toContain("Skipped");
    expect(stdout).toContain("X06"); // valid one rendered, broken one skipped
    expect(stdout).not.toContain("X05");
  });

  it("case 6: --status filter restricts the list", async () => {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: SES("X01"), status: "running" });
    await createSession(repo, { id: SES("X02"), status: "completed" });
    const out = captureStdout();
    await doRunSessionList({ status: "running" }, { cwd: repo });
    const stdout = joinCalls(out);
    expect(stdout).toContain("X01");
    expect(stdout).not.toContain("X02");
  });

  it("case 6b: --status typo throws via the option converter before any list logic runs", async () => {
    // Run the converter through a fresh commander program with exitOverride
    // so the throw propagates instead of terminating vitest.
    const program = new Command();
    program.exitOverride();
    registerSessionCommand(program);
    let captured: unknown;
    try {
      await program.parseAsync(["node", "basou", "session", "list", "--status", "runnning"], {
        from: "node",
      });
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeDefined();
    // commander wraps the converter's Error in a CommanderError carrying the
    // original message; check both surfaces so the assertion does not couple
    // to commander internals.
    const message = (captured as Error).message ?? String(captured ?? "");
    expect(message).toContain("Invalid session status: runnning");
  });

  it("case 7a: suspect Rule A — running yaml + session_ended event in jsonl", async () => {
    const repo = await setupInitedRepo();
    const id = SES("X10");
    const events =
      SESSION_STARTED_LINE(id, "E01", "2026-05-08T11:00:00+09:00") +
      SESSION_ENDED_LINE(id, "E02", "2026-05-08T11:00:30+09:00");
    await createSession(repo, { id, status: "running", events });
    const out = captureStdout();
    await doRunSessionList({}, { cwd: repo });
    expect(joinCalls(out)).toContain("⚠ ended (yaml stale)");
  });

  it("case 7b: suspect Rule B — running yaml, no session_ended, last event > 24h old", async () => {
    const repo = await setupInitedRepo();
    const id = SES("X11");
    const oldAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString().replace("Z", "+00:00");
    const events = SESSION_STARTED_LINE(id, "E03", oldAgo);
    await createSession(repo, { id, status: "running", events });
    const out = captureStdout();
    await doRunSessionList({}, { cwd: repo });
    expect(joinCalls(out)).toContain("⚠ no end event");
  });

  it("case 7c: suspect false-positive guard — running session with recent activity", async () => {
    const repo = await setupInitedRepo();
    const id = SES("X12");
    const justNow = new Date().toISOString().replace("Z", "+00:00");
    const events = SESSION_STARTED_LINE(id, "E04", justNow);
    await createSession(repo, { id, status: "running", events });
    const out = captureStdout();
    await doRunSessionList({}, { cwd: repo });
    const stdout = joinCalls(out);
    expect(stdout).not.toContain("⚠");
  });

  it("case 8: workspace not initialized returns guidance + exit 1", async () => {
    const repo = getTmpRepo();
    const err = captureStderr();
    let captured: unknown;
    try {
      await doRunSessionList({}, { cwd: repo });
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("Workspace not initialized. Run 'basou init' first.");
    expect(joinCalls(err)).toBe("");
  });

  it("case 9: non-git directory yields the wrapped guidance message", async () => {
    const nonGit = await mkdtemp(join(tmpdir(), "basou-no-git-"));
    try {
      let captured: unknown;
      try {
        await doRunSessionList({}, { cwd: nonGit });
      } catch (error: unknown) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(Error);
      expect((captured as Error).message).toBe(
        "Not a git repository. Run 'git init' first, then re-run 'basou session list'.",
      );
    } finally {
      await rm(nonGit, { recursive: true, force: true });
    }
  });

  it("case 10: partial trailing line in events.jsonl yields a stderr warning but list succeeds", async () => {
    const repo = await setupInitedRepo();
    const id = SES("X13");
    // valid started line + valid ended line WITHOUT trailing newline.
    const lastLine = JSON.stringify({
      schema_version: "0.1.0",
      type: "session_ended",
      id: EVT("E05"),
      session_id: id,
      occurred_at: "2026-05-08T11:01:00+09:00",
      source: "terminal-recording",
    });
    const events = SESSION_STARTED_LINE(id, "E04", "2026-05-08T11:00:00+09:00") + lastLine;
    await createSession(repo, { id, status: "running", events });
    const out = captureStdout();
    const err = captureStderr();
    await doRunSessionList({}, { cwd: repo });
    expect(joinCalls(out)).toContain("01HXAB");
    expect(joinCalls(err)).toContain("partial trailing line");
  });

  it("case 10b: timezone-offset-aware sort uses Date.parse, not lexicographic compare", async () => {
    const repo = await setupInitedRepo();
    // Two sessions at the same instant expressed in different offsets.
    // 2026-05-09T01:00:00+00:00 == 2026-05-09T10:00:00+09:00
    // The first has a later started_at field if compared lexicographically
    // (`+09:00` > `+00:00`), but Date.parse renders them equal.
    await createSession(repo, {
      id: SES("X14"),
      startedAt: "2026-05-09T01:00:00+00:00",
      label: "older-by-clock-equal-to-newer",
    });
    await createSession(repo, {
      id: SES("X15"),
      startedAt: "2026-05-09T11:00:00+09:00", // an hour later in real time
      label: "newest",
    });
    const out = captureStdout();
    await doRunSessionList({}, { cwd: repo });
    const lines = joinCalls(out).split("\n");
    expect(lines[1]).toContain("X15");
    expect(lines[2]).toContain("X14");
  });

  it("case 10c: SHORT_ID grows when the base 6-char prefix collides", async () => {
    // Two IDs that share the first 6 ULID chars ("01HXAB") and diverge at
    // position 7. With base length 6 they would collide; growing to 8 keeps
    // them distinct. The header column width itself is anchored to the
    // "SHORT_ID" label width, so the assertion targets the data rows where
    // the actual rendered short id length reflects the chosen prefix.
    const repo = await setupInitedRepo();
    await createSession(repo, { id: "ses_01HXABA0000000000000000000" });
    await createSession(repo, { id: "ses_01HXABB0000000000000000000" });
    const out = captureStdout();
    await doRunSessionList({}, { cwd: repo });
    const lines = joinCalls(out).split("\n");
    const sid1 = lines[1]?.split(/\s\s+/)[0] ?? "";
    const sid2 = lines[2]?.split(/\s\s+/)[0] ?? "";
    expect(sid1.length).toBeGreaterThanOrEqual(8);
    expect(sid2.length).toBeGreaterThanOrEqual(8);
    expect(sid1).not.toBe(sid2);
  });
});

describe("doRunSessionShow", () => {
  it("case 11: full ID hit prints metadata + event count + last events", async () => {
    const repo = await setupInitedRepo();
    const id = SES("Y01");
    const events =
      SESSION_STARTED_LINE(id, "F01", "2026-05-08T11:00:00+09:00") +
      SESSION_ENDED_LINE(id, "F02", "2026-05-08T11:00:30+09:00");
    await createSession(repo, { id, endedAt: "2026-05-08T11:00:30+09:00", events });
    const out = captureStdout();
    await doRunSessionShow(id, {}, { cwd: repo });
    const stdout = joinCalls(out);
    expect(stdout).toContain(`Session: ${id}`);
    expect(stdout).toContain("Events: 2 total");
    expect(stdout).toContain("session_started:");
    expect(stdout).toContain("session_ended:");
  });

  it("case 12: unique prefix hit resolves to the full ID", async () => {
    const repo = await setupInitedRepo();
    const id = SES("Y02");
    await createSession(repo, { id });
    const out = captureStdout();
    // Pass a truncated ULID body without the `ses_` prefix.
    await doRunSessionShow("01HXABCDEF1234567890ABCY02", {}, { cwd: repo });
    expect(joinCalls(out)).toContain(id);
  });

  it("case 13: unknown ID throws Session not found", async () => {
    const repo = await setupInitedRepo();
    let captured: unknown;
    try {
      await doRunSessionShow("01HXFFFFFFFFFFFFFFFFFFFFFF", {}, { cwd: repo });
    } catch (error: unknown) {
      captured = error;
    }
    expect((captured as Error).message).toBe("Session not found: 01HXFFFFFFFFFFFFFFFFFFFFFF");
  });

  it("case 14: ambiguous prefix throws Ambiguous session id", async () => {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: "ses_01HXAB2222222222222222Z01" });
    await createSession(repo, { id: "ses_01HXAB2222222222222222Z02" });
    let captured: unknown;
    try {
      await doRunSessionShow("01HXAB2222222222222222Z", {}, { cwd: repo });
    } catch (error: unknown) {
      captured = error;
    }
    expect((captured as Error).message).toContain("Ambiguous session id");
    expect((captured as Error).message).toContain("matched 2 sessions");
  });

  it("case 15: --events lists every event without truncation", async () => {
    const repo = await setupInitedRepo();
    const id = SES("Y03");
    const events =
      SESSION_STARTED_LINE(id, "G01", "2026-05-08T11:00:00+09:00") +
      SESSION_ENDED_LINE(id, "G02", "2026-05-08T11:00:30+09:00");
    await createSession(repo, { id, endedAt: "2026-05-08T11:00:30+09:00", events });
    const out = captureStdout();
    await doRunSessionShow(id, { events: true }, { cwd: repo });
    const stdout = joinCalls(out);
    expect(stdout).toContain("All events:");
    expect(stdout).toMatch(/session_started\s+\(start\)/);
    expect(stdout).toMatch(/session_ended\s+exit_code=/);
  });

  it("case 16: --events --last 1 displays only the trailing event", async () => {
    const repo = await setupInitedRepo();
    const id = SES("Y04");
    const events =
      SESSION_STARTED_LINE(id, "H01", "2026-05-08T11:00:00+09:00") +
      SESSION_ENDED_LINE(id, "H02", "2026-05-08T11:00:30+09:00");
    await createSession(repo, { id, endedAt: "2026-05-08T11:00:30+09:00", events });
    const out = captureStdout();
    await doRunSessionShow(id, { events: true, last: 1 }, { cwd: repo });
    const stdout = joinCalls(out);
    expect(stdout).toContain("Last 1 events:");
    expect(stdout).toContain("session_ended");
    expect(stdout.split("\n").filter((l) => l.includes("session_started ")).length).toBe(0);
  });

  it("case 16b: --last alone (no --events) limits the default trailing slice", async () => {
    const repo = await setupInitedRepo();
    const id = SES("Y05");
    const events =
      SESSION_STARTED_LINE(id, "J01", "2026-05-08T11:00:00+09:00") +
      SESSION_ENDED_LINE(id, "J02", "2026-05-08T11:00:30+09:00");
    await createSession(repo, { id, endedAt: "2026-05-08T11:00:30+09:00", events });
    const out = captureStdout();
    await doRunSessionShow(id, { last: 1 }, { cwd: repo });
    const stdout = joinCalls(out);
    expect(stdout).toContain("Last 1 events:");
    expect(stdout).toContain("session_ended");
  });

  it("case 17: --json keeps working_directory as the recorded absolute path", async () => {
    const repo = await setupInitedRepo();
    const id = SES("Y06");
    const subdir = join(repo, "packages", "cli");
    await createSession(repo, { id, workingDirectory: subdir });
    const out = captureStdout();
    await doRunSessionShow(id, { json: true }, { cwd: repo });
    const stdout = joinCalls(out);
    const parsed = JSON.parse(stdout);
    expect(parsed.session.working_directory).toBe(subdir);
    expect(Array.isArray(parsed.events)).toBe(true);
  });

  it("case 17b: default text labels working_directory == repository_root as <repository_root>", async () => {
    const repo = await setupInitedRepo();
    const id = SES("Y07");
    await createSession(repo, { id, workingDirectory: repo });
    const out = captureStdout();
    await doRunSessionShow(id, {}, { cwd: repo });
    expect(joinCalls(out)).toContain("Working dir:   <repository_root>");
  });

  it("case 17c: default text relativizes a working_directory under the repo root", async () => {
    const repo = await setupInitedRepo();
    const id = SES("Y08");
    const subdir = join(repo, "packages", "cli");
    await createSession(repo, { id, workingDirectory: subdir });
    const out = captureStdout();
    await doRunSessionShow(id, {}, { cwd: repo });
    expect(joinCalls(out)).toContain("Working dir:   ./packages/cli");
  });

  it("case 17d: --full-path forces the absolute working_directory in default text", async () => {
    const repo = await setupInitedRepo();
    const id = SES("Y09");
    await createSession(repo, { id, workingDirectory: repo });
    const out = captureStdout();
    await doRunSessionShow(id, { fullPath: true }, { cwd: repo });
    expect(joinCalls(out)).toContain(`Working dir:   ${repo}`);
  });

  it("case 18: malformed JSON in events.jsonl produces a stderr warning but show still renders", async () => {
    const repo = await setupInitedRepo();
    const id = SES("Y10");
    const events = `${SESSION_STARTED_LINE(id, "K01", "2026-05-08T11:00:00+09:00")}{not valid\n${SESSION_ENDED_LINE(id, "K02", "2026-05-08T11:00:30+09:00")}`;
    await createSession(repo, { id, endedAt: "2026-05-08T11:00:30+09:00", events });
    const out = captureStdout();
    const err = captureStderr();
    await doRunSessionShow(id, {}, { cwd: repo });
    expect(joinCalls(out)).toContain("Events: 2 total");
    expect(joinCalls(err)).toContain("malformed JSON");
  });
});
