import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  basouPaths,
  createManifest,
  ensureBasouDirectory,
  readYamlFile,
  writeManifest,
  writeYamlFile,
} from "@basou/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  doRunSessionList,
  doRunSessionNote,
  doRunSessionShow,
  registerSessionCommand,
  runSessionImport,
  runSessionNote,
} from "./session.js";

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "session-import-roundtrip.json",
);

async function readFixture(): Promise<Record<string, unknown>> {
  const body = await readFile(FIXTURE_PATH, "utf8");
  return JSON.parse(body) as Record<string, unknown>;
}

async function writeImportPayload(payload: unknown, workDir: string): Promise<string> {
  const path = join(workDir, `import-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(path, JSON.stringify(payload));
  return path;
}

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

  it("case 19: prefix-only `ses_` input is rejected as not found", async () => {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: SES("Z01") });
    let captured: unknown;
    try {
      await doRunSessionShow("ses_", {}, { cwd: repo });
    } catch (error: unknown) {
      captured = error;
    }
    expect((captured as Error).message).toBe("Session not found: ses_");
  });

  it("case 20: --last value larger than the events count slices gracefully", async () => {
    const repo = await setupInitedRepo();
    const id = SES("Z02");
    // Crockford base32 excludes I, L, O, U — keep suffix chars within
    // the allowed alphabet so EventSchema validates the synthetic IDs.
    const events = `${SESSION_STARTED_LINE(id, "M01", "2026-05-08T11:00:00+09:00")}${SESSION_ENDED_LINE(id, "M02", "2026-05-08T11:00:30+09:00")}`;
    await createSession(repo, { id, endedAt: "2026-05-08T11:00:30+09:00", events });
    const out = captureStdout();
    await doRunSessionShow(id, { last: 1000 }, { cwd: repo });
    const stdout = joinCalls(out);
    expect(stdout).toContain("Last 2 events:");
    expect(stdout).toContain("session_started");
    expect(stdout).toContain("session_ended");
  });

  it("case 21: show with 0 events omits the trailing events section", async () => {
    const repo = await setupInitedRepo();
    const id = SES("Z03");
    await createSession(repo, { id });
    const out = captureStdout();
    await doRunSessionShow(id, {}, { cwd: repo });
    const stdout = joinCalls(out);
    expect(stdout).toContain("Events: 0 total");
    expect(stdout).not.toContain("Last ");
    expect(stdout).not.toContain("All events:");
  });

  it("case 22: --last 0 is rejected by the option converter (commander layer)", async () => {
    const program = new Command();
    program.exitOverride();
    registerSessionCommand(program);
    let captured: unknown;
    try {
      await program.parseAsync(["node", "basou", "session", "show", "ses_anyid", "--last", "0"], {
        from: "node",
      });
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeDefined();
    const message = (captured as Error).message ?? String(captured ?? "");
    expect(message).toContain("Invalid number: 0");
  });

  it("case 23: working_directory outside the repo prints a `../...` relative path in default text", async () => {
    const repo = await setupInitedRepo();
    const id = SES("Z04");
    // sibling directory of the temp repo (still within the same /private/var
    // subtree) so `relative` produces a `..` traversal.
    const outside = await mkdtemp(join(tmpdir(), "basou-outside-"));
    try {
      const outsideReal = await realpath(outside);
      await createSession(repo, { id, workingDirectory: outsideReal });
      const out = captureStdout();
      await doRunSessionShow(id, {}, { cwd: repo });
      const stdout = joinCalls(out);
      expect(stdout).toMatch(/Working dir:\s+\.\.\/.+/);
      // The default-text contract must not leak the absolute path.
      expect(stdout).not.toContain(outsideReal);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("runSessionImport", () => {
  it("import-1: happy path writes Imported session line and creates session dir", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await runSessionImport({ format: "json", from: FIXTURE_PATH }, { cwd: repo });
    const stdout = joinCalls(out);
    expect(stdout).toMatch(
      /^Imported session \w+ \(7 events\) from session-import-roundtrip\.json$/,
    );
    const paths = basouPaths(repo);
    const sessionDirs = await readdir(paths.sessions);
    expect(sessionDirs).toHaveLength(1);
  });

  it("import-2: --json emits a single JSON line with the documented shape", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await runSessionImport({ format: "json", from: FIXTURE_PATH, json: true }, { cwd: repo });
    const parsed = JSON.parse(joinCalls(out)) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      event_count: 7,
      dry_run: false,
      status: "imported",
      source: { kind: "claude-code-adapter", version: "0.1.0" },
    });
    expect(typeof parsed.session_id).toBe("string");
    expect((parsed.session_id as string).startsWith("ses_")).toBe(true);
  });

  it("import-3: --verbose appends Caused by: on schema fail", async () => {
    const repo = await setupInitedRepo();
    const fixture = await readFixture();
    fixture.events = undefined;
    const from = await writeImportPayload(fixture, repo);
    const err = captureStderr();
    await runSessionImport({ format: "json", from, verbose: true }, { cwd: repo });
    const stderr = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("Invalid import payload");
    expect(stderr).toContain("Caused by: ZodError");
    expect(process.exitCode).toBe(1);
  });

  it("import-4: --label override appears in session.yaml", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await runSessionImport(
      { format: "json", from: FIXTURE_PATH, label: "custom-label" },
      { cwd: repo },
    );
    const paths = basouPaths(repo);
    const [sid = ""] = await readdir(paths.sessions);
    const yaml = (await readYamlFile(join(paths.sessions, sid, "session.yaml"))) as {
      session: { label?: string };
    };
    expect(yaml.session.label).toBe("custom-label");
  });

  it("import-5: --task override appears in session.yaml", async () => {
    const repo = await setupInitedRepo();
    const taskId = "task_01HXABCDEF1234567890ABCTK1";
    captureStdout();
    await runSessionImport({ format: "json", from: FIXTURE_PATH, task: taskId }, { cwd: repo });
    const paths = basouPaths(repo);
    const [sid = ""] = await readdir(paths.sessions);
    const yaml = (await readYamlFile(join(paths.sessions, sid, "session.yaml"))) as {
      session: { task_id?: string };
    };
    expect(yaml.session.task_id).toBe(taskId);
  });

  it("import-6: invalid --task is rejected via the commander layer", async () => {
    const program = new Command();
    program.exitOverride();
    registerSessionCommand(program);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      program.parseAsync([
        "node",
        "basou",
        "session",
        "import",
        "--format",
        "json",
        "--from",
        FIXTURE_PATH,
        "--task",
        "not-a-task",
      ]),
    ).rejects.toBeDefined();
    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderr).toContain("Invalid task_id: not-a-task");
  });

  it("import-7: --dry-run produces an illustrative ID message and writes no files", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await runSessionImport({ format: "json", from: FIXTURE_PATH, dryRun: true }, { cwd: repo });
    const stdout = joinCalls(out);
    expect(stdout).toContain("Dry run: would import 7 events into");
    expect(stdout).toContain("illustrative ID; not reserved, no files written");
    const paths = basouPaths(repo);
    const sessionDirs = await readdir(paths.sessions);
    expect(sessionDirs).toEqual([]);
  });

  it("import-8: ENOENT input is mapped to 'Import source not found'", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runSessionImport({ format: "json", from: join(repo, "missing.json") }, { cwd: repo });
    const stderr = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("Import source not found");
    expect(process.exitCode).toBe(1);
  });

  it("import-9: EISDIR input is mapped to 'Import source is not a file'", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runSessionImport({ format: "json", from: repo }, { cwd: repo });
    const stderr = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("Import source is not a file");
    expect(process.exitCode).toBe(1);
  });

  it("import-10: malformed JSON is mapped to 'Failed to parse import JSON'", async () => {
    const repo = await setupInitedRepo();
    const from = join(repo, "broken.json");
    await writeFile(from, "{this is not json");
    const err = captureStderr();
    await runSessionImport({ format: "json", from }, { cwd: repo });
    const stderr = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("Failed to parse import JSON");
    expect(process.exitCode).toBe(1);
  });

  it("import-11: schema failure (missing events) emits 'Invalid import payload'", async () => {
    const repo = await setupInitedRepo();
    const fixture = await readFixture();
    fixture.events = undefined;
    const from = await writeImportPayload(fixture, repo);
    const err = captureStderr();
    await runSessionImport({ format: "json", from }, { cwd: repo });
    const stderr = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("Invalid import payload");
    expect(process.exitCode).toBe(1);
  });

  it("import-12: schema_version '0.2.0' is rejected with the dedicated message", async () => {
    const repo = await setupInitedRepo();
    const fixture = await readFixture();
    fixture.schema_version = "0.2.0";
    const from = await writeImportPayload(fixture, repo);
    const err = captureStderr();
    await runSessionImport({ format: "json", from }, { cwd: repo });
    const stderr = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("Unsupported import schema_version: 0.2.0");
    expect(process.exitCode).toBe(1);
  });

  it("import-13: non-chronological events trigger 'Events are not in chronological order'", async () => {
    const repo = await setupInitedRepo();
    const fixture = (await readFixture()) as {
      events: Array<{ occurred_at: string }>;
    };
    const second = fixture.events[1];
    if (second === undefined) throw new Error("fixture must have >=2 events");
    second.occurred_at = "2026-04-15T08:00:00+09:00"; // before [0]
    const from = await writeImportPayload(fixture, repo);
    const err = captureStderr();
    await runSessionImport({ format: "json", from }, { cwd: repo });
    const stderr = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("Events are not in chronological order");
    expect(process.exitCode).toBe(1);
  });

  it("import-14: uninitialized workspace yields 'Workspace not initialized...'", async () => {
    const repo = await realpath(getTmpRepo()); // git init only, no basou init
    const err = captureStderr();
    await runSessionImport({ format: "json", from: FIXTURE_PATH }, { cwd: repo });
    const stderr = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("Workspace not initialized. Run 'basou init' first.");
    expect(process.exitCode).toBe(1);
  });

  it("import-15: non-git cwd yields the dedicated 'Not a git repository' message", async () => {
    const outside = await mkdtemp(join(tmpdir(), "basou-not-git-"));
    try {
      const err = captureStderr();
      await runSessionImport({ format: "json", from: FIXTURE_PATH }, { cwd: outside });
      const stderr = err.mock.calls.map((c) => String(c[0])).join("\n");
      expect(stderr).toContain(
        "Not a git repository. Run 'git init' first, then re-run 'basou session import'.",
      );
      expect(process.exitCode).toBe(1);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("import-16: pathless contract — stderr leaks no absolute paths on schema fail", async () => {
    const repo = await setupInitedRepo();
    const fixture = await readFixture();
    fixture.events = undefined;
    const from = await writeImportPayload(fixture, repo);
    const err = captureStderr();
    await runSessionImport({ format: "json", from, verbose: true }, { cwd: repo });
    const stderr = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).not.toContain(repo);
    expect(stderr).not.toContain(from);
    expect(stderr).not.toContain(tmpdir());
  });

  it("import-17: round-trip preserves event count, source.kind and rewrites status", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await runSessionImport({ format: "json", from: FIXTURE_PATH }, { cwd: repo });
    const paths = basouPaths(repo);
    const [sid = ""] = await readdir(paths.sessions);
    const yaml = (await readYamlFile(join(paths.sessions, sid, "session.yaml"))) as {
      session: { status: string; source: { kind: string } };
    };
    expect(yaml.session.status).toBe("imported");
    expect(yaml.session.source.kind).toBe("claude-code-adapter");
    const events = (await readFile(join(paths.sessions, sid, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0);
    expect(events).toHaveLength(7);
  });

  it("import-18: missing --format is rejected by commander", async () => {
    const program = new Command();
    program.exitOverride();
    registerSessionCommand(program);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      program.parseAsync(["node", "basou", "session", "import", "--from", FIXTURE_PATH]),
    ).rejects.toBeDefined();
    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderr).toContain("--format");
  });

  it("import-19: --format 'yaml' is rejected with the dedicated message", async () => {
    const program = new Command();
    program.exitOverride();
    registerSessionCommand(program);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      program.parseAsync([
        "node",
        "basou",
        "session",
        "import",
        "--format",
        "yaml",
        "--from",
        FIXTURE_PATH,
      ]),
    ).rejects.toBeDefined();
    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderr).toContain("Unsupported format: yaml. Valid values: json");
  });

  it("import-20: missing --from is rejected by commander", async () => {
    const program = new Command();
    program.exitOverride();
    registerSessionCommand(program);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      program.parseAsync(["node", "basou", "session", "import", "--format", "json"]),
    ).rejects.toBeDefined();
    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderr).toContain("--from");
  });
});

describe("doRunSessionNote", () => {
  it("note-1: --body appends a note_added event and prints the human summary", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("N01");
    await createSession(repo, { id: sid, status: "running" });
    const out = captureStdout();
    await doRunSessionNote(sid, { body: "hello note" }, { cwd: repo });
    const stdout = joinCalls(out);
    expect(stdout).toContain("Added note to session");
    expect(stdout).toContain("(running)");
    expect(stdout).toContain("hello note");

    const events = (await readFile(join(basouPaths(repo).sessions, sid, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "note_added", body: "hello note" });
  });

  it("note-2: --from-file reads the body from the given path", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("N02");
    await createSession(repo, { id: sid, status: "running" });
    const notePath = join(repo, "note.txt");
    await writeFile(notePath, "file body");
    const out = captureStdout();
    await doRunSessionNote(sid, { fromFile: notePath }, { cwd: repo });
    expect(joinCalls(out)).toContain("file body");
  });

  it("note-3: --json emits the result with event_id / session_id / status / body_length", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("N03");
    await createSession(repo, { id: sid, status: "running" });
    const out = captureStdout();
    await doRunSessionNote(sid, { body: "ABCDE", json: true }, { cwd: repo });
    const payload = JSON.parse(joinCalls(out)) as Record<string, unknown>;
    expect(payload.session_id).toBe(sid);
    expect(payload.session_status).toBe("running");
    expect(typeof payload.event_id).toBe("string");
    expect((payload.event_id as string).startsWith("evt_")).toBe(true);
    expect(payload.body_length).toBe(5);
  });

  it("note-4: does not modify session.yaml content", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("N04");
    await createSession(repo, { id: sid, status: "running" });
    const yamlPath = join(basouPaths(repo).sessions, sid, "session.yaml");
    const before = await readFile(yamlPath, "utf8");
    await doRunSessionNote(sid, { body: "x" }, { cwd: repo });
    const after = await readFile(yamlPath, "utf8");
    expect(after).toBe(before);
  });

  it("note-5: truncates note bodies longer than 80 characters in the text preview", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("N05");
    await createSession(repo, { id: sid, status: "running" });
    const longBody = "a".repeat(100);
    const out = captureStdout();
    await doRunSessionNote(sid, { body: longBody }, { cwd: repo });
    const stdout = joinCalls(out);
    expect(stdout).toContain("...");
    expect(stdout).toContain("a".repeat(77));
    expect(stdout).not.toContain("a".repeat(78));
  });

  it("note-6: missing --body and --from-file fails with 'Provide --body or --from-file'", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("N06");
    await createSession(repo, { id: sid, status: "running" });
    const err = captureStderr();
    await runSessionNote(sid, {}, { cwd: repo });
    expect(joinCalls(err)).toContain("Provide --body or --from-file");
    expect(process.exitCode).toBe(1);
  });

  it("note-7: providing both --body and --from-file fails mutually-exclusive", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("N07");
    await createSession(repo, { id: sid, status: "running" });
    const notePath = join(repo, "n.txt");
    await writeFile(notePath, "x");
    const err = captureStderr();
    await runSessionNote(sid, { body: "y", fromFile: notePath }, { cwd: repo });
    expect(joinCalls(err)).toContain("--body and --from-file are mutually exclusive");
    expect(process.exitCode).toBe(1);
  });

  it("note-8: empty --body is rejected by the commander converter", async () => {
    const program = new Command();
    program.exitOverride();
    registerSessionCommand(program);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      program.parseAsync(["node", "basou", "session", "note", SES("N08"), "--body", ""]),
    ).rejects.toBeDefined();
    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderr).toContain("--body must not be empty");
  });

  it("note-9: --from-file with ENOENT path emits 'Note source not found'", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("N09");
    await createSession(repo, { id: sid, status: "running" });
    const err = captureStderr();
    await runSessionNote(sid, { fromFile: join(repo, "does-not-exist.txt") }, { cwd: repo });
    expect(joinCalls(err)).toContain("Note source not found");
    expect(process.exitCode).toBe(1);
  });

  it("note-10: --from-file pointing at a directory emits 'Note source is not a file'", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("N10");
    await createSession(repo, { id: sid, status: "running" });
    const err = captureStderr();
    await runSessionNote(sid, { fromFile: repo }, { cwd: repo });
    expect(joinCalls(err)).toContain("Note source is not a file");
    expect(process.exitCode).toBe(1);
  });

  it("note-11: empty file body produces 'Note body is empty'", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("N11");
    await createSession(repo, { id: sid, status: "running" });
    const notePath = join(repo, "empty.txt");
    await writeFile(notePath, "");
    const err = captureStderr();
    await runSessionNote(sid, { fromFile: notePath }, { cwd: repo });
    expect(joinCalls(err)).toContain("Note body is empty");
    expect(process.exitCode).toBe(1);
  });

  it("note-12: attaching to a completed session is rejected", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("N12");
    await createSession(repo, { id: sid, status: "completed" });
    const err = captureStderr();
    await runSessionNote(sid, { body: "x" }, { cwd: repo });
    expect(joinCalls(err)).toContain("Session is not active: completed");
    expect(process.exitCode).toBe(1);
  });

  it("note-13: attaching to an imported session is rejected with the dedicated message", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("N13");
    await createSession(repo, { id: sid, status: "imported" });
    const err = captureStderr();
    await runSessionNote(sid, { body: "x" }, { cwd: repo });
    expect(joinCalls(err)).toContain("Cannot attach to imported session");
    expect(process.exitCode).toBe(1);
  });

  it("note-14: waiting_approval is an attachable status (Y3s-M5 happy path)", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("N14");
    await createSession(repo, { id: sid, status: "waiting_approval" });
    const out = captureStdout();
    await doRunSessionNote(sid, { body: "approve later" }, { cwd: repo });
    expect(joinCalls(out)).toContain("(waiting_approval)");
  });

  it("note-15: --from-file - (stdin) is rejected before any disk I/O (Y3s-M4)", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("N15");
    await createSession(repo, { id: sid, status: "running" });
    const err = captureStderr();
    await runSessionNote(sid, { fromFile: "-" }, { cwd: repo });
    expect(joinCalls(err)).toContain("--from-file - (stdin) is not supported in v0.1");
    expect(process.exitCode).toBe(1);
  });

  it("note-16: pathless contract: non-verbose stderr does not leak absolute paths", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("N16");
    await createSession(repo, { id: sid, status: "running" });
    const missing = join(repo, "deep", "nested", "secret.txt");
    const err = captureStderr();
    await runSessionNote(sid, { fromFile: missing }, { cwd: repo });
    const stderr = joinCalls(err);
    expect(stderr).toContain("Note source not found");
    expect(stderr).not.toContain(missing);
    expect(stderr).not.toContain(repo);
    expect(process.exitCode).toBe(1);
  });

  it("note-17: pathless contract: verbose emits 'Caused by: <label>' without leaking cause.message", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("N17");
    await createSession(repo, { id: sid, status: "running" });
    const missing = join(repo, "deep", "nested", "secret.txt");
    const err = captureStderr();
    await runSessionNote(sid, { fromFile: missing, verbose: true }, { cwd: repo });
    const stderr = joinCalls(err);
    expect(stderr).toContain("Note source not found");
    expect(stderr).toContain("Caused by: ENOENT");
    expect(stderr).not.toContain(missing);
    expect(stderr).not.toContain(repo);
  });
});
