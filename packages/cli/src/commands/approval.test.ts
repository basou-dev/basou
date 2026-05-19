import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
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
import {
  doRunApprovalList,
  doRunApprovalShow,
  registerApprovalCommand,
  runApprovalApprove,
  runApprovalReject,
} from "./approval.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
};

const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const FIXED_DATE = new Date("2026-05-09T03:00:00.000Z");

const SES = (suffix: string) => `ses_01HXABCDEF1234567890ABC${suffix}`;
const APPR = (suffix: string) => `appr_01HXABCDEF1234567890ABC${suffix}`;
const EVT = (suffix: string) => `evt_01HXABCDEF1234567890ABC${suffix}`;

let tmpRepo: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-approval-cli-test-"));
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

type ApprovalFixture = {
  id: string;
  sessionId?: string;
  status?: "pending" | "approved" | "rejected" | "expired";
  riskLevel?: "low" | "medium" | "high" | "critical";
  action?: { kind: string } & Record<string, unknown>;
  reason?: string;
  createdAt?: string;
  expiresAt?: string | null;
  resolver?: string | null;
  resolvedAt?: string | null;
  note?: string | null;
  rejectionReason?: string | null;
  /** "pending" or "resolved" — directory the YAML lives in. */
  location?: "pending" | "resolved";
};

async function createApproval(repo: string, fixture: ApprovalFixture): Promise<string> {
  const paths = basouPaths(repo);
  const sessionId = fixture.sessionId ?? SES("S00");
  const status = fixture.status ?? "pending";
  const location = fixture.location ?? (status === "pending" ? "pending" : "resolved");
  const dir = paths.approvals[location];
  await mkdir(dir, { recursive: true });
  const body = {
    schema_version: "0.1.0" as const,
    id: fixture.id,
    session_id: sessionId,
    created_at: fixture.createdAt ?? "2026-05-04T10:00:00+09:00",
    status,
    risk_level: fixture.riskLevel ?? "medium",
    action: fixture.action ?? { kind: "shell_command", command: "rm -rf dist" },
    reason: fixture.reason ?? "Destructive command requires approval",
    expires_at: fixture.expiresAt === undefined ? null : fixture.expiresAt,
    resolver: fixture.resolver === undefined ? null : fixture.resolver,
    resolved_at: fixture.resolvedAt === undefined ? null : fixture.resolvedAt,
    note: fixture.note === undefined ? null : fixture.note,
    rejection_reason: fixture.rejectionReason === undefined ? null : fixture.rejectionReason,
  };
  await writeYamlFile(join(dir, `${fixture.id}.yaml`), body);
  return fixture.id;
}

async function ensureSessionDir(repo: string, sessionId: string): Promise<string> {
  const paths = basouPaths(repo);
  const dir = join(paths.sessions, sessionId);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function appendRequestedEvent(
  repo: string,
  sessionId: string,
  approvalId: string,
  occurredAt: string,
  evtSuffix: string,
): Promise<void> {
  const dir = await ensureSessionDir(repo, sessionId);
  const line = `${JSON.stringify({
    schema_version: "0.1.0",
    type: "approval_requested",
    id: EVT(evtSuffix),
    session_id: sessionId,
    occurred_at: occurredAt,
    source: "claude-code-adapter",
    approval_id: approvalId,
    expires_at: null,
    risk_level: "medium",
    action: { kind: "shell_command", command: "rm -rf dist" },
    reason: "Destructive command requires approval",
    status: "pending",
  })}\n`;
  await writeFile(join(dir, "events.jsonl"), line, { flag: "a" });
}

async function appendApprovedEvent(
  repo: string,
  sessionId: string,
  approvalId: string,
  occurredAt: string,
  evtSuffix: string,
  note: string | null = null,
): Promise<void> {
  const dir = await ensureSessionDir(repo, sessionId);
  const line = `${JSON.stringify({
    schema_version: "0.1.0",
    type: "approval_approved",
    id: EVT(evtSuffix),
    session_id: sessionId,
    occurred_at: occurredAt,
    source: "local-cli",
    approval_id: approvalId,
    resolver: "local-cli",
    note,
  })}\n`;
  await writeFile(join(dir, "events.jsonl"), line, { flag: "a" });
}

async function appendRejectedEvent(
  repo: string,
  sessionId: string,
  approvalId: string,
  occurredAt: string,
  evtSuffix: string,
  reason: string,
): Promise<void> {
  const dir = await ensureSessionDir(repo, sessionId);
  const line = `${JSON.stringify({
    schema_version: "0.1.0",
    type: "approval_rejected",
    id: EVT(evtSuffix),
    session_id: sessionId,
    occurred_at: occurredAt,
    source: "local-cli",
    approval_id: approvalId,
    resolver: "local-cli",
    reason,
  })}\n`;
  await writeFile(join(dir, "events.jsonl"), line, { flag: "a" });
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

async function readEventsLines(repo: string, sessionId: string): Promise<string[]> {
  const paths = basouPaths(repo);
  const filePath = join(paths.sessions, sessionId, "events.jsonl");
  const body = await readFile(filePath, "utf8");
  return body.split("\n").filter((line) => line.length > 0);
}

// === doRunApprovalList ===

describe("doRunApprovalList", () => {
  it("case 1: rejects an uninitialized workspace with the standard hint", async () => {
    const repo = await realpath(getTmpRepo());
    let captured: unknown;
    try {
      await doRunApprovalList({}, { cwd: repo });
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("Workspace not initialized. Run 'basou init' first.");
  });

  it("case 2: prints No approvals found. when both directories are empty", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunApprovalList({}, { cwd: repo });
    expect(joinCalls(out)).toBe("No approvals found.");
  });

  it("case 3: lists pending and resolved entries newest-first with SHORT_ID column", async () => {
    const repo = await setupInitedRepo();
    await createApproval(repo, {
      id: APPR("P01"),
      createdAt: "2026-05-08T11:00:00+09:00",
    });
    await createApproval(repo, {
      id: APPR("P02"),
      createdAt: "2026-05-09T11:00:00+09:00",
    });
    await createApproval(repo, {
      id: APPR("P03"),
      createdAt: "2026-05-07T11:00:00+09:00",
      status: "approved",
      resolver: "local-cli",
      resolvedAt: "2026-05-07T11:01:00+09:00",
    });
    const out = captureStdout();
    await doRunApprovalList({}, { cwd: repo });
    const lines = joinCalls(out).split("\n");
    expect(lines[0]).toContain("SHORT_ID");
    expect(lines[0]).toContain("STATUS");
    expect(lines[1]).toContain("2026-05-09"); // P02 newest
    expect(lines[2]).toContain("2026-05-08"); // P01
    expect(lines[3]).toContain("2026-05-07"); // P03 oldest
  });

  it("case 4: --json emits Approval array with lazy_expired field on every entry", async () => {
    const repo = await setupInitedRepo();
    await createApproval(repo, { id: APPR("P01") });
    const out = captureStdout();
    await doRunApprovalList({ json: true }, { cwd: repo });
    const body = joinCalls(out);
    const parsed = JSON.parse(body) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.lazy_expired).toBe(false);
    expect(parsed[0]?.id).toBe(APPR("P01"));
  });

  it("case 5: --status filters by approval status; invalid values are caught at parser level", async () => {
    const repo = await setupInitedRepo();
    await createApproval(repo, { id: APPR("P01") });
    await createApproval(repo, {
      id: APPR("P02"),
      status: "approved",
      resolver: "local-cli",
      resolvedAt: "2026-05-04T10:01:23+09:00",
    });
    const outPending = captureStdout();
    await doRunApprovalList({ status: "pending" }, { cwd: repo });
    const lines = joinCalls(outPending).split("\n");
    // Header + one row only — the approved entry must be filtered out.
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("pending");
    expect(lines[1]).not.toContain("approved");

    // The invalid-status path is exercised through parseApprovalStatus, which
    // commander wires up as the --status converter. Surfacing it through the
    // commander instance keeps the test honest about how end users hit it —
    // commander writes the error to its configured `writeErr`, not console.error.
    const program = new Command();
    registerApprovalCommand(program);
    program.exitOverride();
    let stderrBuf = "";
    program.configureOutput({
      writeErr: (msg) => {
        stderrBuf += msg;
      },
      writeOut: () => undefined,
    });
    let captured: unknown;
    try {
      await program.parseAsync(["node", "basou", "approval", "list", "--status", "invalid"]);
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeDefined();
    // Commander wraps the parser-thrown Error in an InvalidArgumentError;
    // either the thrown message or the writeErr stream may carry the body.
    const errorBody = captured instanceof Error ? captured.message : String(captured);
    expect(`${errorBody}\n${stderrBuf}`).toContain("Invalid approval status: invalid");
  });

  it("case 6: surfaces a stale-pending warning + lazy_expired label when YAML is duplicated", async () => {
    const repo = await setupInitedRepo();
    const id = APPR("P01");
    // Place the same id in BOTH directories: pending-side is stale.
    await createApproval(repo, {
      id,
      status: "pending",
      expiresAt: "2024-01-01T00:00:00+09:00",
    });
    await createApproval(repo, {
      id,
      status: "approved",
      resolver: "local-cli",
      resolvedAt: "2026-05-04T10:01:23+09:00",
      location: "resolved",
    });
    // Add a separate pending entry that triggers the lazy-expired label.
    await createApproval(repo, {
      id: APPR("P02"),
      status: "pending",
      expiresAt: "2024-01-01T00:00:00+09:00",
    });
    const out = captureStdout();
    const err = captureStderr();
    await doRunApprovalList({}, { cwd: repo });
    const stderrText = err.mock.calls.flat().join("\n");
    expect(stderrText).toContain("Warning: stale pending entry");
    const stdoutText = joinCalls(out);
    expect(stdoutText).toContain("pending (expired)");
  });
});

// === doRunApprovalShow ===

describe("doRunApprovalShow", () => {
  it("case 7: rejects an uninitialized workspace", async () => {
    const repo = await realpath(getTmpRepo());
    let captured: unknown;
    try {
      await doRunApprovalShow(APPR("P01"), {}, { cwd: repo });
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("Workspace not initialized. Run 'basou init' first.");
  });

  it("case 8: throws Approval not found for a missing id", async () => {
    const repo = await setupInitedRepo();
    let captured: unknown;
    try {
      await doRunApprovalShow(APPR("ZZZ"), {}, { cwd: repo });
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain("Approval not found");
  });

  it("case 9: ambiguous prefix is reported with match count", async () => {
    const repo = await setupInitedRepo();
    await createApproval(repo, { id: APPR("AMB") });
    await createApproval(repo, { id: APPR("AMC") });
    let captured: unknown;
    try {
      // "01HXABCDEF1234567890ABCAM" matches both AMB and AMC.
      await doRunApprovalShow("01HXABCDEF1234567890ABCAM", {}, { cwd: repo });
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain("Ambiguous approval id");
  });

  it("case 10: text output for a pending approval includes the approval_requested event", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P01");
    const sessionId = SES("S01");
    await createApproval(repo, { id: approvalId, sessionId });
    await appendRequestedEvent(repo, sessionId, approvalId, "2026-05-04T10:00:00+09:00", "E01");
    const out = captureStdout();
    await doRunApprovalShow(approvalId, {}, { cwd: repo });
    const body = joinCalls(out);
    expect(body).toContain(`Approval: ${approvalId}`);
    expect(body).toContain("status: pending");
    expect(body).toContain("Related events: 1 total");
    expect(body).toContain("approval_requested");
  });

  it("case 11: text output for a resolved approval shows requested + approved events", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P01");
    const sessionId = SES("S01");
    await createApproval(repo, {
      id: approvalId,
      sessionId,
      status: "approved",
      resolver: "local-cli",
      resolvedAt: "2026-05-04T10:01:23+09:00",
      note: "OK",
    });
    await appendRequestedEvent(repo, sessionId, approvalId, "2026-05-04T10:00:00+09:00", "E01");
    await appendApprovedEvent(
      repo,
      sessionId,
      approvalId,
      "2026-05-04T10:01:23+09:00",
      "E02",
      "OK",
    );
    const out = captureStdout();
    await doRunApprovalShow(approvalId, {}, { cwd: repo });
    const body = joinCalls(out);
    expect(body).toContain("status: approved");
    expect(body).toContain("Related events: 2 total");
    expect(body).toContain("approval_requested");
    expect(body).toContain("approval_approved");
  });

  it("case 12: --json emits { approval, events } with lazy_expired set", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P01");
    const sessionId = SES("S01");
    await createApproval(repo, { id: approvalId, sessionId });
    await appendRequestedEvent(repo, sessionId, approvalId, "2026-05-04T10:00:00+09:00", "E01");
    const out = captureStdout();
    await doRunApprovalShow(approvalId, { json: true }, { cwd: repo });
    const parsed = JSON.parse(joinCalls(out)) as {
      approval: { id: string; lazy_expired: boolean };
      events: Array<{ type: string }>;
    };
    expect(parsed.approval.id).toBe(approvalId);
    expect(parsed.approval.lazy_expired).toBe(false);
    expect(parsed.events.length).toBe(1);
    expect(parsed.events[0]?.type).toBe("approval_requested");
  });

  it("case 13: events.jsonl I/O failure surfaces Failed to read events.jsonl", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P01");
    const sessionId = SES("S01");
    await createApproval(repo, { id: approvalId, sessionId });
    // Drop a *directory* in place of events.jsonl so the read fails with
    // EISDIR; this is a deterministic substitute for chmod-based exclusion
    // that does not require running the test as a non-root user.
    const sessionDir = await ensureSessionDir(repo, sessionId);
    await mkdir(join(sessionDir, "events.jsonl"));
    let captured: unknown;
    try {
      await doRunApprovalShow(approvalId, {}, { cwd: repo });
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("Failed to read events.jsonl");
  });
});

// === runApprovalApprove ===

describe("runApprovalApprove", () => {
  it("case 14: approves a pending approval, appending event + writing resolved YAML + unlinking pending", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P01");
    const sessionId = SES("S01");
    await createApproval(repo, { id: approvalId, sessionId });
    await appendRequestedEvent(repo, sessionId, approvalId, "2026-05-04T10:00:00+09:00", "E01");

    const out = captureStdout();
    await runApprovalApprove(approvalId, {}, { cwd: repo });
    expect(joinCalls(out)).toContain(
      `Approved approval ${approvalId.slice("appr_".length, "appr_".length + 6)}`,
    );

    const paths = basouPaths(repo);
    const pendingExists = await readdir(paths.approvals.pending);
    expect(pendingExists).not.toContain(`${approvalId}.yaml`);
    const resolvedExists = await readdir(paths.approvals.resolved);
    expect(resolvedExists).toContain(`${approvalId}.yaml`);

    const lines = await readEventsLines(repo, sessionId);
    expect(lines.length).toBe(2); // requested + approved
    const lastLine = JSON.parse(lines[1] as string) as {
      type: string;
      resolver: string;
      note: unknown;
    };
    expect(lastLine.type).toBe("approval_approved");
    expect(lastLine.resolver).toBe("local-cli");
    expect(lastLine.note).toBeNull();
  });

  it("case 15: --note is propagated into both event and resolved YAML", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P01");
    const sessionId = SES("S01");
    await createApproval(repo, { id: approvalId, sessionId });
    // Seed the session directory + a requested event so events.jsonl exists
    // before approve appends the resolution event.
    await appendRequestedEvent(repo, sessionId, approvalId, "2026-05-04T10:00:00+09:00", "E01");

    captureStdout();
    await runApprovalApprove(approvalId, { note: "Reviewed by team lead" }, { cwd: repo });

    const lines = await readEventsLines(repo, sessionId);
    const parsed = JSON.parse(lines[1] as string) as { note: string };
    expect(parsed.note).toBe("Reviewed by team lead");

    const paths = basouPaths(repo);
    const yamlBody = await readFile(join(paths.approvals.resolved, `${approvalId}.yaml`), "utf8");
    expect(yamlBody).toContain("note: Reviewed by team lead");
  });

  it("case 16: missing id triggers the standard not-found message and exit 1", async () => {
    const repo = await setupInitedRepo();
    captureStderr();
    await runApprovalApprove(APPR("ZZZ"), {}, { cwd: repo });
    expect(process.exitCode).toBe(1);
  });

  it("case 17: an already-resolved approval cannot be approved again", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P01");
    await createApproval(repo, {
      id: approvalId,
      status: "approved",
      resolver: "local-cli",
      resolvedAt: "2026-05-04T10:01:23+09:00",
    });
    const stderr = captureStderr();
    await runApprovalApprove(approvalId, {}, { cwd: repo });
    expect(process.exitCode).toBe(1);
    expect(stderr.mock.calls.flat().join("\n")).toContain("Approval already resolved");
  });

  it("case 18: lazy-expired pending approve is rejected without mutating events or YAML", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P01");
    const sessionId = SES("S01");
    await createApproval(repo, {
      id: approvalId,
      sessionId,
      expiresAt: "2024-01-01T00:00:00+09:00",
    });
    const stderr = captureStderr();
    await runApprovalApprove(approvalId, {}, { cwd: repo });
    expect(process.exitCode).toBe(1);
    expect(stderr.mock.calls.flat().join("\n")).toContain("Approval already expired");
    // events.jsonl absent (no requested event was seeded), pending YAML untouched.
    const paths = basouPaths(repo);
    const pendingFiles = await readdir(paths.approvals.pending);
    expect(pendingFiles).toContain(`${approvalId}.yaml`);
  });

  it("case 19: events.jsonl fence prevents a second approval_approved write", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P01");
    const sessionId = SES("S01");
    // Reproduce the crash window: events have an approval_approved already
    // but the pending YAML has not been unlinked yet (resolved YAML missing
    // is not required by the fence — events alone is the source-of-truth).
    await createApproval(repo, { id: approvalId, sessionId });
    await appendApprovedEvent(repo, sessionId, approvalId, "2026-05-04T10:01:23+09:00", "E02");

    const stderr = captureStderr();
    await runApprovalApprove(approvalId, {}, { cwd: repo });
    expect(process.exitCode).toBe(1);
    expect(stderr.mock.calls.flat().join("\n")).toContain(
      "Approval already resolved (per events.jsonl)",
    );
    // Confirm no second approval_approved line was appended.
    const lines = await readEventsLines(repo, sessionId);
    expect(lines.length).toBe(1);
  });
});

// === runApprovalReject ===

describe("runApprovalReject", () => {
  it("case 20: rejects a pending approval with --reason, writing event + YAML + unlinking pending", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P01");
    const sessionId = SES("S01");
    await createApproval(repo, { id: approvalId, sessionId });
    await appendRequestedEvent(repo, sessionId, approvalId, "2026-05-04T10:00:00+09:00", "E01");

    const out = captureStdout();
    await runApprovalReject(approvalId, { reason: "Not allowed" }, { cwd: repo });
    expect(joinCalls(out)).toContain(
      `Rejected approval ${approvalId.slice("appr_".length, "appr_".length + 6)}`,
    );

    const lines = await readEventsLines(repo, sessionId);
    const last = JSON.parse(lines[1] as string) as { type: string; reason: string };
    expect(last.type).toBe("approval_rejected");
    expect(last.reason).toBe("Not allowed");

    const paths = basouPaths(repo);
    const yamlBody = await readFile(join(paths.approvals.resolved, `${approvalId}.yaml`), "utf8");
    expect(yamlBody).toContain("rejection_reason: Not allowed");
  });

  it("case 21: omitting --reason triggers commander's required-option error", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P01");
    await createApproval(repo, { id: approvalId });
    const program = new Command();
    registerApprovalCommand(program);
    program.exitOverride();
    let stderrBuf = "";
    program.configureOutput({
      writeErr: (msg) => {
        stderrBuf += msg;
      },
      writeOut: () => undefined,
    });
    let captured: unknown;
    try {
      await program.parseAsync(["node", "basou", "approval", "reject", approvalId]);
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeDefined();
    expect(stderrBuf).toContain("required option");
    void repo;
  });

  it("case 22: empty --reason fails with a fixed message", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P01");
    await createApproval(repo, { id: approvalId });
    const stderr = captureStderr();
    await runApprovalReject(approvalId, { reason: "" }, { cwd: repo });
    expect(process.exitCode).toBe(1);
    expect(stderr.mock.calls.flat().join("\n")).toContain("--reason must not be empty");
  });

  it("case 23: an already-resolved approval cannot be rejected again", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P01");
    await createApproval(repo, {
      id: approvalId,
      status: "rejected",
      resolver: "local-cli",
      resolvedAt: "2026-05-04T10:01:23+09:00",
      rejectionReason: "Earlier rejection",
    });
    const stderr = captureStderr();
    await runApprovalReject(approvalId, { reason: "Try again" }, { cwd: repo });
    expect(process.exitCode).toBe(1);
    expect(stderr.mock.calls.flat().join("\n")).toContain("Approval already resolved");
  });

  it("case 24: lazy-expired pending reject is fenced before any mutation", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P01");
    const sessionId = SES("S01");
    await createApproval(repo, {
      id: approvalId,
      sessionId,
      expiresAt: "2024-01-01T00:00:00+09:00",
    });
    const stderr = captureStderr();
    await runApprovalReject(approvalId, { reason: "x" }, { cwd: repo });
    expect(process.exitCode).toBe(1);
    expect(stderr.mock.calls.flat().join("\n")).toContain("Approval already expired");
    const paths = basouPaths(repo);
    const pendingFiles = await readdir(paths.approvals.pending);
    expect(pendingFiles).toContain(`${approvalId}.yaml`);
  });

  it("case 25: events.jsonl fence prevents a second approval_rejected", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P01");
    const sessionId = SES("S01");
    await createApproval(repo, { id: approvalId, sessionId });
    await appendRejectedEvent(
      repo,
      sessionId,
      approvalId,
      "2026-05-04T10:01:23+09:00",
      "E02",
      "Prior rejection",
    );

    const stderr = captureStderr();
    await runApprovalReject(approvalId, { reason: "Try again" }, { cwd: repo });
    expect(process.exitCode).toBe(1);
    expect(stderr.mock.calls.flat().join("\n")).toContain(
      "Approval already resolved (per events.jsonl)",
    );
    const lines = await readEventsLines(repo, sessionId);
    expect(lines.length).toBe(1);
  });
});

// === post-impl review fixes ===

describe("post-impl review fixes", () => {
  it("case 27 (M1): approve refuses a pending-side YAML whose status is no longer pending", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P01");
    const sessionId = SES("S01");
    // Place an `approved` YAML in the pending directory — the kind of
    // corruption a half-completed manual edit could leave behind.
    await createApproval(repo, {
      id: approvalId,
      sessionId,
      status: "approved",
      resolver: "local-cli",
      resolvedAt: "2026-05-04T10:01:23+09:00",
      location: "pending",
    });
    const stderr = captureStderr();
    await runApprovalApprove(approvalId, {}, { cwd: repo });
    expect(process.exitCode).toBe(1);
    expect(stderr.mock.calls.flat().join("\n")).toContain("Approval status mismatch");
  });

  it("case 28 (M2): approve wraps zod parse errors of the pending YAML as Failed to read approval", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P01");
    const paths = basouPaths(repo);
    // Write a YAML body with an invalid status enum directly so that we
    // exercise the zod failure path inside doRunApprovalResolve.
    const pendingPath = join(paths.approvals.pending, `${approvalId}.yaml`);
    await writeFile(
      pendingPath,
      [
        'schema_version: "0.1.0"',
        `id: "${approvalId}"`,
        'session_id: "ses_01HXSE01ABCDEFGHJKMNPQRSTV"',
        'created_at: "2026-05-04T10:00:00+09:00"',
        'status: "completely-invalid"',
        'risk_level: "medium"',
        "action:",
        '  kind: "shell_command"',
        'reason: "test"',
        "expires_at: null",
        "resolver: null",
        "resolved_at: null",
        "note: null",
        "rejection_reason: null",
        "",
      ].join("\n"),
      "utf8",
    );
    const stderr = captureStderr();
    await runApprovalApprove(approvalId, {}, { cwd: repo });
    expect(process.exitCode).toBe(1);
    expect(stderr.mock.calls.flat().join("\n")).toContain("Failed to read approval");
  });

  it("case 29 (L1): warning rendering strips the ses_ prefix from session-derived short ids", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P01");
    const sessionId = SES("S01");
    await createApproval(repo, { id: approvalId, sessionId });
    // Drop a partial trailing line so replayEvents emits the
    // `partial_trailing_line` warning, which is keyed by session id.
    const sessionDir = await ensureSessionDir(repo, sessionId);
    const partial = JSON.stringify({
      schema_version: "0.1.0",
      type: "session_started",
      id: EVT("E01"),
      session_id: sessionId,
      occurred_at: "2026-05-04T10:00:00+09:00",
      source: "terminal-recording",
    });
    // Note: NO trailing newline, so replayEvents flags the line as partial.
    await writeFile(join(sessionDir, "events.jsonl"), partial, "utf8");

    const err = captureStderr();
    await doRunApprovalShow(approvalId, {}, { cwd: repo });
    const stderrText = err.mock.calls.flat().join("\n");
    expect(stderrText).toContain("partial trailing line");
    // The session ULID prefix MUST appear without the `ses_` head; if the
    // bug regressed we'd see `ses_01/events.jsonl` instead.
    expect(stderrText).toContain("01HXAB/events.jsonl");
    expect(stderrText).not.toContain("ses_01HXAB/events.jsonl");
  });
});

// === resolveApprovalId regression ===

describe("resolveApprovalId regression", () => {
  it("case 26: same full id in pending + resolved → resolved wins with a warning", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P01");
    const sessionId = SES("S01");
    // Same full id in both directories — the dedupe should pick resolved
    // and the show command should reflect status=approved.
    await createApproval(repo, {
      id: approvalId,
      sessionId,
      status: "pending",
      location: "pending",
    });
    await createApproval(repo, {
      id: approvalId,
      sessionId,
      status: "approved",
      resolver: "local-cli",
      resolvedAt: "2026-05-04T10:01:23+09:00",
      location: "resolved",
    });

    const out = captureStdout();
    const err = captureStderr();
    await doRunApprovalShow(approvalId, {}, { cwd: repo });
    const stderrText = err.mock.calls.flat().join("\n");
    expect(stderrText).toContain("Warning: stale pending entry");
    expect(joinCalls(out)).toContain("status: approved");
  });
});
