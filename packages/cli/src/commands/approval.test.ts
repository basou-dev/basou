import { execFile } from "node:child_process";
import {
  chmod,
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
  ensureBasouDirectory,
  readYamlFile,
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
  runApprovalList,
  runApprovalReject,
  runApprovalShow,
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
    let stderrBuf = "";
    // commander 14 stopped propagating `exitOverride()` and `configureOutput()`
    // from the parent program to nested subcommands. The missing-required-option
    // error is raised on the leaf `approval reject` subcommand, so the same
    // overrides have to be re-applied across the whole tree to keep the test
    // hermetic (otherwise commander writes to process.stderr and exits the
    // worker).
    const applyOverrides = (cmd: Command): void => {
      cmd.exitOverride();
      cmd.configureOutput({
        writeErr: (msg) => {
          stderrBuf += msg;
        },
        writeOut: () => undefined,
      });
      for (const sub of cmd.commands) applyOverrides(sub);
    };
    applyOverrides(program);
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

describe("attachable-status fence (D-6b)", () => {
  async function writeSessionYamlWithStatus(
    repo: string,
    sessionId: string,
    status: string,
  ): Promise<void> {
    const paths = basouPaths(repo);
    await mkdir(join(paths.sessions, sessionId), { recursive: true });
    await writeYamlFile(join(paths.sessions, sessionId, "session.yaml"), {
      schema_version: "0.1.0",
      session: {
        id: sessionId,
        task_id: null,
        workspace_id: FIXED_WS_ID,
        source: { kind: "codex-import", version: "0.1.0" },
        started_at: "2026-05-04T09:00:00+09:00",
        status,
        working_directory: "~/projects/example",
        invocation: { command: "codex", args: [], exit_code: 0 },
        related_files: [],
        events_log: "events.jsonl",
        summary: null,
      },
    });
  }

  it("approve refuses to append a resolution event to an imported session", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P31");
    const sessionId = SES("S31");
    await createApproval(repo, { id: approvalId, sessionId });
    await appendRequestedEvent(repo, sessionId, approvalId, "2026-05-04T10:00:00+09:00", "E31");
    await writeSessionYamlWithStatus(repo, sessionId, "imported");

    const err = captureStderr();
    await runApprovalApprove(approvalId, {}, { cwd: repo });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err)).toContain("status=imported");

    // Nothing was appended and the pending YAML is untouched.
    const lines = await readEventsLines(repo, sessionId);
    expect(lines.length).toBe(1);
    const paths = basouPaths(repo);
    expect(await readdir(paths.approvals.pending)).toContain(`${approvalId}.yaml`);
  });

  it("reject refuses to append a resolution event to an imported session", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P32");
    const sessionId = SES("S32");
    await createApproval(repo, { id: approvalId, sessionId });
    await appendRequestedEvent(repo, sessionId, approvalId, "2026-05-04T10:00:00+09:00", "E32");
    await writeSessionYamlWithStatus(repo, sessionId, "imported");

    const err = captureStderr();
    await runApprovalReject(approvalId, { reason: "no" }, { cwd: repo });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err)).toContain("status=imported");
    expect((await readEventsLines(repo, sessionId)).length).toBe(1);
  });

  it("refuses to resolve an approval for a finalized (terminal) session", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P33");
    const sessionId = SES("S33");
    await createApproval(repo, { id: approvalId, sessionId });
    await appendRequestedEvent(repo, sessionId, approvalId, "2026-05-04T10:00:00+09:00", "E33");
    await writeSessionYamlWithStatus(repo, sessionId, "completed");

    const err = captureStderr();
    await runApprovalApprove(approvalId, {}, { cwd: repo });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err)).toContain("status=completed");
    // No resolution line was chained onto the finalized session.
    expect((await readEventsLines(repo, sessionId)).length).toBe(1);
  });
});

describe("an approval an outside orchestrator wrote without seconds", () => {
  it("is listed, not skipped as an invalid approval", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("T01");
    await createApproval(repo, { id: approvalId, createdAt: "2026-05-04T10:00+09:00" });
    const out = captureStdout();
    const err = captureStderr();
    await doRunApprovalList({}, { cwd: repo });
    expect(joinCalls(err)).not.toContain("invalid approval schema");
    expect(joinCalls(out)).toContain(approvalId.slice("appr_".length, "appr_".length + 6));
  });

  it("can be approved, rather than failing to be read", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("T02");
    const sessionId = SES("S01");
    await createApproval(repo, {
      id: approvalId,
      sessionId,
      createdAt: "2026-05-04T10:00+09:00",
      expiresAt: "2099-05-04T10:00+09:00",
    });
    await appendRequestedEvent(repo, sessionId, approvalId, "2026-05-04T10:00:00+09:00", "E01");
    captureStdout();
    await runApprovalApprove(approvalId, {}, { cwd: repo });
    const resolved = await readdir(basouPaths(repo).approvals.resolved);
    expect(resolved).toContain(`${approvalId}.yaml`);
  });
});

// POSIX only: creating a symlink needs privileges on Windows.
describe.skipIf(process.platform === "win32")("a recorded session that is not a directory", () => {
  const notADirectory = (id: string): string =>
    `Session ${id} is not a directory; a symlink or a file there is not followed`;

  // A running (attachable) session with one requested event, moved out of the
  // store and linked back in at its name: following the link would succeed.
  async function linkedRunningSession(
    repo: string,
    sessionId: string,
    approvalId: string,
  ): Promise<string> {
    const paths = basouPaths(repo);
    await createApproval(repo, { id: approvalId, sessionId });
    await appendRequestedEvent(repo, sessionId, approvalId, "2026-05-04T10:00:00+09:00", "E41");
    await writeYamlFile(join(paths.sessions, sessionId, "session.yaml"), {
      schema_version: "0.1.0",
      session: {
        id: sessionId,
        task_id: null,
        workspace_id: FIXED_WS_ID,
        source: { kind: "claude-code", version: "0.1.0" },
        started_at: "2026-05-04T09:00:00+09:00",
        status: "running",
        working_directory: "~/projects/example",
        invocation: { command: "claude", args: [], exit_code: null },
        related_files: [],
        events_log: "events.jsonl",
        summary: null,
      },
    });
    const outside = join(repo, "moved-session");
    await rename(join(paths.sessions, sessionId), outside);
    await symlink(outside, join(paths.sessions, sessionId));
    return outside;
  }

  it("approve and reject append nothing through it and leave the approval pending", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P41");
    const sessionId = SES("S41");
    const outside = await linkedRunningSession(repo, sessionId, approvalId);
    const before = await readFile(join(outside, "events.jsonl"), "utf8");

    const err = captureStderr();
    await runApprovalApprove(approvalId, {}, { cwd: repo });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err)).toContain(notADirectory(sessionId));
    process.exitCode = 0;
    await runApprovalReject(approvalId, { reason: "no" }, { cwd: repo });
    expect(process.exitCode).toBe(1);

    expect(await readFile(join(outside, "events.jsonl"), "utf8")).toBe(before);
    const paths = basouPaths(repo);
    expect(await readdir(paths.approvals.pending)).toContain(`${approvalId}.yaml`);
    expect(await readdir(paths.approvals.resolved).catch(() => [])).not.toContain(
      `${approvalId}.yaml`,
    );
  });

  it("approve reads nothing behind it: a resolution there is not what stops it", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P44");
    const sessionId = SES("S44");
    const outside = await linkedRunningSession(repo, sessionId, approvalId);
    // Were the log behind the link read, the fence would stop on this line.
    await writeFile(
      join(outside, "events.jsonl"),
      `${JSON.stringify({
        schema_version: "0.1.0",
        type: "approval_approved",
        id: EVT("E44"),
        session_id: sessionId,
        occurred_at: "2026-05-04T10:05:00+09:00",
        source: "local-cli",
        approval_id: approvalId,
        resolver: "local-cli",
        note: null,
      })}\n`,
      { flag: "a" },
    );
    const err = captureStderr();
    await runApprovalApprove(approvalId, {}, { cwd: repo });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err)).toContain(notADirectory(sessionId));
    expect(joinCalls(err)).not.toContain("already resolved");
  });

  it("show prints the approval without the events behind it, and warns", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P42");
    const sessionId = SES("S42");
    // The log behind the link holds this approval's requested event.
    await linkedRunningSession(repo, sessionId, approvalId);
    const out = captureStdout();
    const err = captureStderr();
    await doRunApprovalShow(approvalId, { json: true }, { cwd: repo });
    const shown = JSON.parse(joinCalls(out)) as {
      approval: { id: string; session_id: string };
      events: unknown[];
    };
    expect(shown.approval.id).toBe(approvalId);
    expect(shown.approval.session_id).toBe(sessionId);
    expect(shown.events).toEqual([]);
    expect(joinCalls(err)).toBe(
      `Warning: session ${sessionId} is not a directory (a symlink or a file is not followed); its events are not shown`,
    );
  });

  it("show prints the approval in text and exits 0 for a symlink or a file", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P45");
    const sessionId = SES("S45");
    await linkedRunningSession(repo, sessionId, approvalId);
    const warning = `Warning: session ${sessionId} is not a directory (a symlink or a file is not followed); its events are not shown`;
    const entry = join(basouPaths(repo).sessions, sessionId);
    for (const makeEntry of [
      async () => undefined, // the symlink linkedRunningSession left
      async () => {
        await rm(entry);
        await writeFile(entry, "");
      },
    ]) {
      await makeEntry();
      vi.restoreAllMocks();
      process.exitCode = 0;
      const out = captureStdout();
      const err = captureStderr();
      await runApprovalShow(approvalId, {}, { cwd: repo });
      expect(process.exitCode ?? 0).toBe(0);
      expect(joinCalls(out)).toContain(approvalId);
      expect(joinCalls(out)).toContain("Related events: 0 total");
      expect(joinCalls(err)).toBe(warning);
    }
  });

  it("control: the same session as a directory in the store is approved", async () => {
    const repo = await setupInitedRepo();
    const approvalId = APPR("P43");
    const sessionId = SES("S43");
    const outside = await linkedRunningSession(repo, sessionId, approvalId);
    const paths = basouPaths(repo);
    await rm(join(paths.sessions, sessionId));
    await rename(outside, join(paths.sessions, sessionId));
    captureStdout();
    await runApprovalApprove(approvalId, {}, { cwd: repo });
    expect(process.exitCode).not.toBe(1);
    expect(await readEventsLines(repo, sessionId)).toHaveLength(2);
  });
});

/** Every file under `dir`, with its bytes, so a test can prove nothing changed. */
async function snapshotTree(dir: string): Promise<Record<string, string>> {
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

// POSIX only: creating a symlink needs privileges on Windows.
describe.skipIf(process.platform === "win32")("an unsafe approval store", () => {
  /**
   * Two pending approvals of a running session, each resolvable as it stands,
   * with `relative` (under `.basou/`) moved out of the store and linked back
   * in: a command that followed the link would find them.
   */
  async function linkedApprovals(
    relative: string,
  ): Promise<{ repo: string; outside: string; sessionId: string }> {
    const repo = await setupInitedRepo();
    const paths = basouPaths(repo);
    const sessionId = SES("S61");
    for (const suffix of ["P61", "P62"]) {
      await createApproval(repo, { id: APPR(suffix), sessionId });
      await appendRequestedEvent(
        repo,
        sessionId,
        APPR(suffix),
        "2026-05-04T10:00:00+09:00",
        `E${suffix.slice(1)}`,
      );
    }
    await writeYamlFile(join(paths.sessions, sessionId, "session.yaml"), {
      schema_version: "0.1.0",
      session: {
        id: sessionId,
        task_id: null,
        workspace_id: FIXED_WS_ID,
        source: { kind: "claude-code", version: "0.1.0" },
        started_at: "2026-05-04T09:00:00+09:00",
        status: "running",
        working_directory: "~/projects/example",
        invocation: { command: "claude", args: [], exit_code: null },
        related_files: [],
        events_log: "events.jsonl",
        summary: null,
      },
    });
    const inside = join(paths.root, relative);
    const outside = join(repo, "moved-approvals");
    await mkdir(paths.approvals.resolved, { recursive: true });
    await rename(inside, outside);
    await symlink(outside, inside);
    return { repo, outside, sessionId };
  }

  for (const relative of ["approvals", "approvals/pending", "approvals/resolved"]) {
    const label = `.basou/${relative}`;

    it(`a ${label} that is a symlink stops every approval command, moving and appending nothing`, async () => {
      const { repo, outside, sessionId } = await linkedApprovals(relative);
      const paths = basouPaths(repo);
      const outsideBefore = await snapshotTree(outside);
      const eventsBefore = await readFile(join(paths.sessions, sessionId, "events.jsonl"), "utf8");

      const commands: Array<[string, () => Promise<void>]> = [
        ["list", () => runApprovalList({}, { cwd: repo })],
        ["show", () => runApprovalShow(APPR("P61"), {}, { cwd: repo })],
        ["approve", () => runApprovalApprove(APPR("P61"), {}, { cwd: repo })],
        ["reject", () => runApprovalReject(APPR("P62"), { reason: "no" }, { cwd: repo })],
      ];
      for (const [name, run] of commands) {
        const err = captureStderr();
        const out = captureStdout();
        process.exitCode = 0;
        await run();
        expect(process.exitCode, name).toBe(1);
        expect(joinCalls(err), name).toContain(`${label} is a symlink; refusing to operate`);
        expect(joinCalls(out), name).toBe("");
        err.mockRestore();
        out.mockRestore();
      }
      expect(await snapshotTree(outside)).toEqual(outsideBefore);
      expect(await readFile(join(paths.sessions, sessionId, "events.jsonl"), "utf8")).toBe(
        eventsBefore,
      );
    });
  }

  it("a .basou/locks that is a symlink stops approve and reject before they create, lock or record anything", async () => {
    const { repo, sessionId } = await linkedApprovals("approvals");
    const paths = basouPaths(repo);
    await rm(join(paths.root, "approvals"));
    await rename(join(repo, "moved-approvals"), join(paths.root, "approvals"));
    await rm(paths.approvals.resolved, { recursive: true });
    const outsideLocks = join(repo, "outside-locks");
    await rename(paths.locks, outsideLocks);
    await symlink(outsideLocks, paths.locks);
    const eventsBefore = await readFile(join(paths.sessions, sessionId, "events.jsonl"), "utf8");
    const commands: Array<[string, () => Promise<void>]> = [
      ["approve", () => runApprovalApprove(APPR("P61"), {}, { cwd: repo })],
      ["reject", () => runApprovalReject(APPR("P62"), { reason: "no" }, { cwd: repo })],
    ];
    for (const [name, run] of commands) {
      const err = captureStderr();
      process.exitCode = 0;
      await run();
      expect(process.exitCode, name).toBe(1);
      expect(joinCalls(err), name).toBe(".basou/locks is a symlink; refusing to operate");
      err.mockRestore();
    }
    expect(await readdir(outsideLocks)).toEqual([]);
    await expect(readdir(paths.approvals.resolved)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(paths.sessions, sessionId, "events.jsonl"), "utf8")).toBe(
      eventsBefore,
    );
  });

  it("approve and reject create a missing resolved/ before recording the resolution", async () => {
    const { repo, sessionId } = await linkedApprovals("approvals");
    const paths = basouPaths(repo);
    await rm(join(paths.root, "approvals"));
    await rename(join(repo, "moved-approvals"), join(paths.root, "approvals"));
    await rm(paths.approvals.resolved, { recursive: true });
    captureStdout();
    await runApprovalApprove(APPR("P61"), {}, { cwd: repo });
    expect(process.exitCode).not.toBe(1);
    await rm(paths.approvals.resolved, { recursive: true });
    await runApprovalReject(APPR("P62"), { reason: "no" }, { cwd: repo });
    expect(process.exitCode).not.toBe(1);
    expect(await readdir(paths.approvals.resolved)).toEqual([`${APPR("P62")}.yaml`]);
    expect(await readdir(paths.approvals.pending)).toEqual([]);
    const events = await readFile(join(paths.sessions, sessionId, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"approval_approved"');
    expect(events).toContain('"type":"approval_rejected"');
  });

  // POSIX only, and not as root, who is never denied the mkdir.
  it.skipIf(process.getuid?.() === 0)(
    "approve and reject that cannot create resolved/ record nothing",
    async () => {
      const { repo, sessionId } = await linkedApprovals("approvals");
      const paths = basouPaths(repo);
      const approvals = join(paths.root, "approvals");
      await rm(approvals);
      await rename(join(repo, "moved-approvals"), approvals);
      await rm(paths.approvals.resolved, { recursive: true });
      const eventsBefore = await readFile(join(paths.sessions, sessionId, "events.jsonl"), "utf8");
      await chmod(approvals, 0o555);
      try {
        const commands: Array<[string, () => Promise<void>]> = [
          ["approve", () => runApprovalApprove(APPR("P61"), {}, { cwd: repo })],
          ["reject", () => runApprovalReject(APPR("P62"), { reason: "no" }, { cwd: repo })],
        ];
        for (const [name, run] of commands) {
          const err = captureStderr();
          process.exitCode = 0;
          await run();
          expect(process.exitCode, name).toBe(1);
          expect(joinCalls(err), name).toContain("Failed to create .basou/approvals/resolved");
          err.mockRestore();
        }
      } finally {
        await chmod(approvals, 0o755);
      }
      expect(await readFile(join(paths.sessions, sessionId, "events.jsonl"), "utf8")).toBe(
        eventsBefore,
      );
      expect((await readdir(paths.approvals.pending)).sort()).toEqual([
        `${APPR("P61")}.yaml`,
        `${APPR("P62")}.yaml`,
      ]);
    },
  );

  it("control: the same approvals, in the store, are approved and rejected", async () => {
    const { repo } = await linkedApprovals("approvals");
    const paths = basouPaths(repo);
    await rm(join(paths.root, "approvals"));
    await rename(join(repo, "moved-approvals"), join(paths.root, "approvals"));
    captureStdout();
    await runApprovalApprove(APPR("P61"), {}, { cwd: repo });
    await runApprovalReject(APPR("P62"), { reason: "no" }, { cwd: repo });
    expect(process.exitCode).not.toBe(1);
    expect((await readdir(paths.approvals.resolved)).sort()).toEqual([
      `${APPR("P61")}.yaml`,
      `${APPR("P62")}.yaml`,
    ]);
  });
});

// POSIX only: creating a symlink needs privileges on Windows.
describe.skipIf(process.platform === "win32")("an approval file that is not followed", () => {
  /**
   * A running session with two pending approvals. P71's pending file is moved
   * out of the store and linked back in. P72's pending file stays, and an
   * approved copy of it, outside the store, is linked in as its resolved file.
   */
  async function linkedApprovalFiles(): Promise<{
    repo: string;
    outside: string;
    sessionId: string;
  }> {
    const repo = await setupInitedRepo();
    const paths = basouPaths(repo);
    const sessionId = SES("S71");
    for (const suffix of ["P71", "P72"]) {
      await createApproval(repo, { id: APPR(suffix), sessionId });
      await appendRequestedEvent(
        repo,
        sessionId,
        APPR(suffix),
        "2026-05-04T10:00:00+09:00",
        `E${suffix.slice(1)}`,
      );
    }
    await writeYamlFile(join(paths.sessions, sessionId, "session.yaml"), {
      schema_version: "0.1.0",
      session: {
        id: sessionId,
        task_id: null,
        workspace_id: FIXED_WS_ID,
        source: { kind: "claude-code", version: "0.1.0" },
        started_at: "2026-05-04T09:00:00+09:00",
        status: "running",
        working_directory: "~/projects/example",
        invocation: { command: "claude", args: [], exit_code: null },
        related_files: [],
        events_log: "events.jsonl",
        summary: null,
      },
    });
    const outside = join(repo, "outside");
    await mkdir(outside);
    const p71 = join(paths.approvals.pending, `${APPR("P71")}.yaml`);
    await rename(p71, join(outside, "p71.yaml"));
    await symlink(join(outside, "p71.yaml"), p71);
    await mkdir(paths.approvals.resolved, { recursive: true });
    const p72 = await readYamlFile(join(paths.approvals.pending, `${APPR("P72")}.yaml`));
    await writeYamlFile(join(outside, "p72-approved.yaml"), {
      ...(p72 as Record<string, unknown>),
      status: "approved",
      resolver: "outside",
      resolved_at: "2026-05-04T10:05:00+09:00",
    });
    await symlink(
      join(outside, "p72-approved.yaml"),
      join(paths.approvals.resolved, `${APPR("P72")}.yaml`),
    );
    return { repo, outside, sessionId };
  }

  it("list leaves both entries out and names each on stderr", async () => {
    const { repo } = await linkedApprovalFiles();
    const err = captureStderr();
    const out = captureStdout();
    await doRunApprovalList({}, { cwd: repo });
    const stderrText = joinCalls(err);
    expect(stderrText).toContain(
      `Skipped ${APPR("P71")} in pending: not a file (a symlink or a directory is not followed)`,
    );
    expect(stderrText).toContain(
      `Skipped ${APPR("P72")} in resolved: not a file (a symlink or a directory is not followed)`,
    );
    // P72's pending file is the only approval read, and it is still pending.
    const stdoutText = joinCalls(out);
    expect(stdoutText).toContain("pending");
    expect(stdoutText).not.toContain("approved");
    expect(stdoutText.split("\n")).toHaveLength(2);
  });

  it("show, approve and reject name an approval that is only a symlink, reading and writing nothing", async () => {
    const { repo, outside, sessionId } = await linkedApprovalFiles();
    const paths = basouPaths(repo);
    const outsideBefore = await snapshotTree(outside);
    const eventsBefore = await readFile(join(paths.sessions, sessionId, "events.jsonl"), "utf8");
    const commands: Array<[string, () => Promise<void>]> = [
      ["show", () => runApprovalShow(APPR("P71"), {}, { cwd: repo })],
      ["approve", () => runApprovalApprove(APPR("P71"), {}, { cwd: repo })],
      ["reject", () => runApprovalReject(APPR("P71"), { reason: "no" }, { cwd: repo })],
    ];
    for (const [name, run] of commands) {
      const err = captureStderr();
      const out = captureStdout();
      process.exitCode = 0;
      await run();
      expect(process.exitCode, name).toBe(1);
      expect(joinCalls(err), name).toBe(
        `Approval ${APPR("P71")} is not a file; a symlink or a directory there is not followed`,
      );
      expect(joinCalls(out), name).toBe("");
      err.mockRestore();
      out.mockRestore();
    }
    expect(await snapshotTree(outside)).toEqual(outsideBefore);
    expect(await readFile(join(paths.sessions, sessionId, "events.jsonl"), "utf8")).toBe(
      eventsBefore,
    );
  });

  it("a prefix an entry that is not followed shares with an approval is ambiguous", async () => {
    const { repo } = await linkedApprovalFiles();
    const err = captureStderr();
    process.exitCode = 0;
    // `APPR("P7")` is a prefix of both P71 (a symlink) and P72 (a file).
    await runApprovalShow(APPR("P7"), {}, { cwd: repo });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err)).toContain("Ambiguous approval id");
  });

  it("show reads the pending file, not the symlinked resolved one, and says so", async () => {
    const { repo } = await linkedApprovalFiles();
    const err = captureStderr();
    const out = captureStdout();
    await doRunApprovalShow(APPR("P72"), {}, { cwd: repo });
    expect(joinCalls(out)).toContain(`Approval: ${APPR("P72")}  (status: pending)`);
    expect(joinCalls(out)).not.toContain("outside");
    expect(joinCalls(err)).toContain(
      `Warning: ${APPR("P72")} in resolved is not a file (a symlink or a directory is not followed)`,
    );
  });

  it("approve and reject refuse while a symlink holds the resolved name, recording nothing", async () => {
    const { repo, outside, sessionId } = await linkedApprovalFiles();
    const paths = basouPaths(repo);
    const outsideBefore = await snapshotTree(outside);
    const eventsBefore = await readFile(join(paths.sessions, sessionId, "events.jsonl"), "utf8");
    const commands: Array<[string, () => Promise<void>]> = [
      ["approve", () => runApprovalApprove(APPR("P72"), {}, { cwd: repo })],
      ["reject", () => runApprovalReject(APPR("P72"), { reason: "no" }, { cwd: repo })],
    ];
    for (const [name, run] of commands) {
      const err = captureStderr();
      const out = captureStdout();
      process.exitCode = 0;
      await run();
      expect(process.exitCode, name).toBe(1);
      expect(joinCalls(err), name).toBe(
        `Approval ${APPR("P72")} cannot be resolved: its entry in resolved is not a file (a symlink or a directory is not followed)`,
      );
      expect(joinCalls(out), name).toBe("");
      err.mockRestore();
      out.mockRestore();
    }
    expect(await snapshotTree(outside)).toEqual(outsideBefore);
    expect(await readFile(join(paths.sessions, sessionId, "events.jsonl"), "utf8")).toBe(
      eventsBefore,
    );
    expect(await readdir(paths.approvals.pending)).toContain(`${APPR("P72")}.yaml`);
  });

  it("approve and reject refuse a directory at the resolved name too, recording nothing", async () => {
    const { repo, sessionId } = await linkedApprovalFiles();
    const paths = basouPaths(repo);
    const resolved = join(paths.approvals.resolved, `${APPR("P72")}.yaml`);
    await rm(resolved);
    await mkdir(resolved);
    const eventsBefore = await readFile(join(paths.sessions, sessionId, "events.jsonl"), "utf8");
    const commands: Array<[string, () => Promise<void>]> = [
      ["approve", () => runApprovalApprove(APPR("P72"), {}, { cwd: repo })],
      ["reject", () => runApprovalReject(APPR("P72"), { reason: "no" }, { cwd: repo })],
    ];
    for (const [name, run] of commands) {
      const err = captureStderr();
      process.exitCode = 0;
      await run();
      expect(process.exitCode, name).toBe(1);
      expect(joinCalls(err), name).toBe(
        `Approval ${APPR("P72")} cannot be resolved: its entry in resolved is not a file (a symlink or a directory is not followed)`,
      );
      err.mockRestore();
    }
    expect(await readFile(join(paths.sessions, sessionId, "events.jsonl"), "utf8")).toBe(
      eventsBefore,
    );
  });

  it("show reads the resolved file, not the symlinked pending one, and says so", async () => {
    const { repo } = await linkedApprovalFiles();
    // P71's pending entry is a symlink; give it a resolved file in the store.
    await createApproval(repo, {
      id: APPR("P71"),
      sessionId: SES("S71"),
      status: "approved",
      resolver: "local-cli",
      resolvedAt: "2026-05-04T10:01:23+09:00",
      location: "resolved",
    });
    const err = captureStderr();
    const out = captureStdout();
    await doRunApprovalShow(APPR("P71"), {}, { cwd: repo });
    expect(joinCalls(out)).toContain(`Approval: ${APPR("P71")}  (status: approved)`);
    expect(joinCalls(err)).toContain(
      `Warning: ${APPR("P71")} in pending is not a file (a symlink or a directory is not followed)`,
    );
  });

  it("control: with the symlink gone, the same approval is approved", async () => {
    const { repo, sessionId } = await linkedApprovalFiles();
    const paths = basouPaths(repo);
    await rm(join(paths.approvals.resolved, `${APPR("P72")}.yaml`));
    captureStdout();
    process.exitCode = 0;
    await runApprovalApprove(APPR("P72"), {}, { cwd: repo });
    expect(process.exitCode).toBe(0);
    expect(await readdir(paths.approvals.resolved)).toEqual([`${APPR("P72")}.yaml`]);
    const events = await readFile(join(paths.sessions, sessionId, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"approval_approved"');
  });
});

describe("basou approval from a workspace view", () => {
  it("resolves a git-untracked view to the repo it links", async () => {
    const repo = await setupInitedRepo();
    const view = await mkdtemp(join(tmpdir(), "basou-approval-view-"));
    try {
      await symlink(repo, join(view, "fixture-planning"));
      const out = captureStdout();
      const err = captureStderr();
      await doRunApprovalList({}, { cwd: view });
      expect(joinCalls(out)).toBe("No approvals found.");
      expect(joinCalls(err)).toContain("Resolved workspace view to");
    } finally {
      await rm(view, { recursive: true, force: true });
    }
  });
});
