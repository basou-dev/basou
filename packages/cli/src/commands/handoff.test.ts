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
import { doRunHandoffGenerate, registerHandoffCommand, runHandoffGenerate } from "./handoff.js";

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
const APPR = (suffix: string) => `appr_01HXABCDEF1234567890ABC${suffix}`;

let tmpRepo: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-handoff-cli-test-"));
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
  relatedFiles?: string[];
  source?: "claude-code-adapter" | "human" | "import" | "terminal";
};

async function placeSession(repo: string, fixture: SessionFixture, events?: string): Promise<void> {
  const paths = basouPaths(repo);
  const sessionDir = join(paths.sessions, fixture.id);
  await mkdir(sessionDir, { recursive: true });
  await writeYamlFile(join(sessionDir, "session.yaml"), {
    schema_version: "0.1.0",
    session: {
      id: fixture.id,
      label: `fixture ${fixture.id.slice(-3)}`,
      task_id: null,
      workspace_id: FIXED_WS_ID,
      source: { kind: fixture.source ?? "terminal", version: "0.1.0" },
      started_at: fixture.startedAt ?? "2026-05-08T11:00:00+09:00",
      ...(fixture.endedAt !== undefined ? { ended_at: fixture.endedAt } : {}),
      status: fixture.status ?? "completed",
      working_directory: "/tmp/fixture",
      invocation: { command: "echo", args: [], exit_code: 0 },
      related_files: fixture.relatedFiles ?? [],
      events_log: "events.jsonl",
    },
  });
  if (events !== undefined) await writeFile(join(sessionDir, "events.jsonl"), events);
}

function sessionStartedLine(id: string, evt: string, occurredAt: string): string {
  return `${JSON.stringify({
    schema_version: "0.1.0",
    type: "session_started",
    id: EVT(evt),
    session_id: id,
    occurred_at: occurredAt,
    source: "human",
  })}\n`;
}

function sessionEndedLine(id: string, evt: string, occurredAt: string): string {
  return `${JSON.stringify({
    schema_version: "0.1.0",
    type: "session_ended",
    id: EVT(evt),
    session_id: id,
    occurred_at: occurredAt,
    source: "human",
    final_status: "completed",
  })}\n`;
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

async function placePendingApproval(repo: string, approvalId: string): Promise<void> {
  const paths = basouPaths(repo);
  await writeYamlFile(join(paths.approvals.pending, `${approvalId}.yaml`), {
    approval_id: approvalId,
  });
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

describe("basou handoff generate", () => {
  it("case 1: empty workspace produces a fresh handoff.md with no-sessions placeholder", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunHandoffGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    const stdout = joinCalls(out);
    expect(stdout).toContain("Generated .basou/handoff.md");
    expect(stdout).toContain("sessions: 0");
    const body = await readFile(basouPaths(repo).files.handoff, "utf8");
    expect(body).toContain(GENERATED_START);
    expect(body).toContain(GENERATED_END);
    expect(body).toContain("(no sessions yet)");
  });

  it("case 2: single session is summarized in stdout", async () => {
    const repo = await setupInitedRepo();
    await placeSession(repo, { id: SES("X01") });
    const out = captureStdout();
    await doRunHandoffGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    expect(joinCalls(out)).toContain("sessions: 1");
  });

  it("case 3: aggregates multiple sessions and unions related_files", async () => {
    const repo = await setupInitedRepo();
    await placeSession(repo, { id: SES("X02"), relatedFiles: ["src/a.ts"] });
    await placeSession(repo, { id: SES("X03"), relatedFiles: ["src/b.ts"] });
    const out = captureStdout();
    await doRunHandoffGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    expect(joinCalls(out)).toContain("sessions: 2");
    const body = await readFile(basouPaths(repo).files.handoff, "utf8");
    expect(body).toContain("- src/a.ts");
    expect(body).toContain("- src/b.ts");
  });

  it("case 4: partial / malformed trailing content in events.jsonl produces a stderr warning", async () => {
    const repo = await setupInitedRepo();
    const id = SES("X04");
    // First a valid event, then a JSON-valid event WITHOUT a trailing newline
    // → replayEvents reports `partial_trailing_line`. (A truncated/unclosed
    // JSON instead surfaces as `malformed_json`; either kind satisfies this
    // test, since the intent is only that onWarning fires.)
    const trailingEvent = sessionStartedLine(id, "E02", "2026-05-08T11:01:00+09:00").trimEnd();
    const events =
      decisionLine(id, "E01", DEC("D01"), "ok", "2026-05-08T11:00:00+09:00") + trailingEvent;
    await placeSession(repo, { id }, events);
    captureStdout();
    const err = captureStderr();
    await doRunHandoffGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    expect(joinCalls(err)).toMatch(
      /Warning: (ignored partial trailing line|skipped malformed JSON)/,
    );
  });

  it("case 4b (Codex#2 Y3q-M4): events.jsonl unreadable surfaces the existing suspect-check wording", async () => {
    const repo = await setupInitedRepo();
    const id = SES("X05");
    await placeSession(repo, { id, status: "running" });
    // Replace events.jsonl with a directory so the read fails with EISDIR.
    await mkdir(join(basouPaths(repo).sessions, id, "events.jsonl"), { recursive: true });
    captureStdout();
    const err = captureStderr();
    await doRunHandoffGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    expect(joinCalls(err)).toContain(
      `Warning: skipped suspect check for ${id.slice(4, 10)}: events.jsonl unreadable`,
    );
  });

  it("case 4b2 (Codex#3 Y3q-M1): completed session with unreadable events.jsonl still surfaces a warning", async () => {
    const repo = await setupInitedRepo();
    const id = SES("X14");
    // Status = completed: classifySuspect short-circuits and never touches
    // events.jsonl. The unreadable file is therefore only seen on the
    // decision-aggregation pass; without M1 the catch would swallow it.
    await placeSession(repo, { id, status: "completed" });
    await mkdir(join(basouPaths(repo).sessions, id, "events.jsonl"), { recursive: true });
    captureStdout();
    const err = captureStderr();
    await doRunHandoffGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    expect(joinCalls(err)).toContain(
      `Warning: skipped suspect check for ${id.slice(4, 10)}: events.jsonl unreadable`,
    );
  });

  it("case 4c (Codex#2 Y3q-M4): session.yaml missing emits Skipped <sid>: session_yaml_missing", async () => {
    const repo = await setupInitedRepo();
    const id = SES("X06");
    await mkdir(join(basouPaths(repo).sessions, id), { recursive: true });
    captureStdout();
    const err = captureStderr();
    await doRunHandoffGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    expect(joinCalls(err)).toContain(`Skipped ${id.slice(4, 10)}: session_yaml_missing`);
  });

  it("case 4d (Codex#2 Y3q-M4): session.yaml invalid schema emits Skipped <sid>: session_yaml_invalid", async () => {
    const repo = await setupInitedRepo();
    const id = SES("X07");
    const sessionDir = join(basouPaths(repo).sessions, id);
    await mkdir(sessionDir, { recursive: true });
    // Schema violation: missing required fields under `session`.
    await writeYamlFile(join(sessionDir, "session.yaml"), {
      schema_version: "0.1.0",
      session: { id },
    });
    captureStdout();
    const err = captureStderr();
    await doRunHandoffGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    expect(joinCalls(err)).toContain(`Skipped ${id.slice(4, 10)}: session_yaml_invalid`);
  });

  it("case 5: re-generation replaces the marker region and preserves text outside", async () => {
    const repo = await setupInitedRepo();
    await placeSession(repo, { id: SES("X08") });
    captureStdout();
    await doRunHandoffGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    const handoffPath = basouPaths(repo).files.handoff;
    const first = await readFile(handoffPath, "utf8");
    // Append manual notes after the END marker.
    await writeFile(handoffPath, `${first}\n## Manual notes\nremember XYZ\n`);
    await doRunHandoffGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    const second = await readFile(handoffPath, "utf8");
    expect(second).toContain("## Manual notes");
    expect(second).toContain("remember XYZ");
  });

  it("case 6: marker missing_start aborts with exit 1 and does not touch handoff.md", async () => {
    const repo = await setupInitedRepo();
    await placeSession(repo, { id: SES("X09") });
    const handoffPath = basouPaths(repo).files.handoff;
    await writeFile(handoffPath, `prose\n${GENERATED_END}\nmore\n`);
    captureStdout();
    const err = captureStderr();
    await runHandoffGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err)).toContain("Markers mismatched in handoff.md");
    const body = await readFile(handoffPath, "utf8");
    expect(body).toContain(GENERATED_END);
    expect(body).not.toContain(GENERATED_START);
  });

  it("case 7: marker missing_end aborts with exit 1", async () => {
    const repo = await setupInitedRepo();
    const handoffPath = basouPaths(repo).files.handoff;
    await writeFile(handoffPath, `${GENERATED_START}\nbody\n`);
    captureStdout();
    const err = captureStderr();
    await runHandoffGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err)).toContain("Markers mismatched in handoff.md");
  });

  it("case 8: legacy file with no markers aborts with exit 1 (Markers missing)", async () => {
    const repo = await setupInitedRepo();
    const handoffPath = basouPaths(repo).files.handoff;
    await writeFile(handoffPath, "legacy content\nno markers here\n");
    captureStdout();
    const err = captureStderr();
    await runHandoffGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err)).toContain("Markers missing in handoff.md");
  });

  it("case 9: multiple marker pairs abort with exit 1 (Markers mismatched)", async () => {
    const repo = await setupInitedRepo();
    const handoffPath = basouPaths(repo).files.handoff;
    await writeFile(
      handoffPath,
      `${GENERATED_START}\na\n${GENERATED_END}\n${GENERATED_START}\nb\n${GENERATED_END}\n`,
    );
    captureStdout();
    const err = captureStderr();
    await runHandoffGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err)).toContain("Markers mismatched in handoff.md");
  });

  it("case 11: pending approvals surface as a count in the 未決事項 section", async () => {
    const repo = await setupInitedRepo();
    await placeSession(repo, { id: SES("X0A") });
    await placePendingApproval(repo, APPR("A01"));
    await placePendingApproval(repo, APPR("A02"));
    captureStdout();
    await doRunHandoffGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    const body = await readFile(basouPaths(repo).files.handoff, "utf8");
    expect(body).toContain("- 2 pending approvals");
  });

  it("case 12: suspect sessions appear inline in the table", async () => {
    const repo = await setupInitedRepo();
    const id = SES("X0B");
    const events =
      sessionStartedLine(id, "E0A", "2026-05-08T11:00:00+09:00") +
      sessionEndedLine(id, "E0B", "2026-05-08T11:00:30+09:00");
    await placeSession(repo, { id, status: "running" }, events);
    captureStdout();
    await doRunHandoffGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    const body = await readFile(basouPaths(repo).files.handoff, "utf8");
    expect(body).toContain("⚠ ended (yaml stale)");
  });

  it("case 13: I/O error on sessions enumeration exits 1 with 'Failed to enumerate sessions'", async () => {
    const repo = await setupInitedRepo();
    const paths = basouPaths(repo);
    // Make .basou/sessions unreadable so readdir fails non-ENOENT.
    await chmod(paths.sessions, 0o000);
    captureStdout();
    const err = captureStderr();
    try {
      await runHandoffGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
      expect(process.exitCode).toBe(1);
      expect(joinCalls(err)).toContain("Failed to enumerate sessions");
    } finally {
      await chmod(paths.sessions, 0o755);
    }
  });

  it("case 14 (Codex#3 Y3q-L1): markdown write failure exits 1 with the fixed message", async () => {
    const repo = await setupInitedRepo();
    const paths = basouPaths(repo);
    // Make .basou itself read-only so the tmp file inside cannot be created.
    // (Pre-creating handoff.md as a directory wouldn't work because
    // readMarkdownFile reads it first and fails on EISDIR before write runs.)
    await chmod(paths.root, 0o555);
    captureStdout();
    const err = captureStderr();
    try {
      await runHandoffGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
      expect(process.exitCode).toBe(1);
      expect(joinCalls(err)).toContain("Failed to write markdown file");
    } finally {
      await chmod(paths.root, 0o755);
    }
  });

  it("case 14b (Codex#3 Y3q-L1): verbose mode surfaces 'Caused by: <code>' on a write failure", async () => {
    const repo = await setupInitedRepo();
    const paths = basouPaths(repo);
    await chmod(paths.root, 0o555);
    captureStdout();
    const err = captureStderr();
    try {
      await runHandoffGenerate({ verbose: true }, { cwd: repo, nowProvider: () => FIXED_DATE });
      expect(process.exitCode).toBe(1);
      expect(joinCalls(err)).toMatch(/Caused by:/);
    } finally {
      await chmod(paths.root, 0o755);
    }
  });

  it("case 15: verbose mode surfaces 'Caused by: <code>' when a wrapped error has a code", async () => {
    const repo = await setupInitedRepo();
    const paths = basouPaths(repo);
    await chmod(paths.sessions, 0o000);
    captureStdout();
    const err = captureStderr();
    try {
      await runHandoffGenerate({ verbose: true }, { cwd: repo, nowProvider: () => FIXED_DATE });
      expect(process.exitCode).toBe(1);
      expect(joinCalls(err)).toMatch(/Caused by:/);
    } finally {
      await chmod(paths.sessions, 0o755);
    }
  });

  it("case 16: not-a-workspace exits 1 with the standard helper message", async () => {
    const tmp = getTmpRepo(); // git-init'd but not basou-init'd
    captureStdout();
    const err = captureStderr();
    await runHandoffGenerate({}, { cwd: tmp, nowProvider: () => FIXED_DATE });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err)).toContain("Workspace not initialized. Run 'basou init' first.");
  });

  it("register: wiring exposes 'handoff' and 'handoff generate' on the program", () => {
    const program = new Command();
    registerHandoffCommand(program);
    const handoff = program.commands.find((c) => c.name() === "handoff");
    expect(handoff).toBeDefined();
    const generate = handoff?.commands.find((c) => c.name() === "generate");
    expect(generate).toBeDefined();
  });

  it("case 17: stdout summary includes a tasks: count (Step 17)", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunHandoffGenerate({}, { cwd: repo, nowProvider: () => FIXED_DATE });
    expect(joinCalls(out)).toContain("tasks: 0");
  });
});
