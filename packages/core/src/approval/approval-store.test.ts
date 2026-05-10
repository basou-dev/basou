import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Approval } from "../schemas/approval.schema.js";
import { type BasouPaths, basouPaths } from "../storage/basou-dir.js";
import { ensureBasouDirectory } from "../storage/basou-dir.js";
import { writeYamlFile } from "../storage/yaml-store.js";
import { enumerateApprovals, isLazyExpired, loadApproval } from "./approval-store.js";

let workspace: { paths: BasouPaths; cleanup: () => Promise<void> } | undefined;

beforeEach(async () => {
  const tmp = await mkdtemp(join(tmpdir(), "basou-approval-test-"));
  // realpath() resolves the macOS `/var/folders/...` -> `/private/var/...`
  // canonicalization that mkdtemp does NOT apply, so downstream code that
  // computes paths via `join(repoRoot, ...)` matches what `basouPaths`
  // already produced (continuation backlog #13).
  const repoRoot = await realpath(tmp);
  const paths = basouPaths(repoRoot);
  await ensureBasouDirectory(repoRoot);
  workspace = { paths, cleanup: () => rm(tmp, { recursive: true, force: true }) };
});

afterEach(async () => {
  if (workspace !== undefined) {
    await workspace.cleanup();
    workspace = undefined;
  }
});

function getPaths(): BasouPaths {
  if (workspace === undefined) throw new Error("workspace not initialized");
  return workspace.paths;
}

const PENDING_FIXTURE: Approval = {
  schema_version: "0.1.0",
  id: "appr_01HXMA01ABCDEFGHJKMNPQRSTV",
  session_id: "ses_01HXSE01ABCDEFGHJKMNPQRSTV",
  created_at: "2026-05-04T10:00:00+09:00",
  status: "pending",
  risk_level: "medium",
  action: { kind: "shell_command", command: "rm -rf dist" },
  reason: "Destructive command requires approval",
  expires_at: null,
  resolver: null,
  resolved_at: null,
  note: null,
  rejection_reason: null,
};

describe("approval-store", () => {
  it("loadApproval returns the pending YAML when it exists", async () => {
    const paths = getPaths();
    const filePath = join(paths.approvals.pending, `${PENDING_FIXTURE.id}.yaml`);
    await writeYamlFile(filePath, PENDING_FIXTURE);

    const result = await loadApproval(paths, PENDING_FIXTURE.id);
    expect(result).not.toBeNull();
    expect(result?.location).toBe("pending");
    expect(result?.approval.status).toBe("pending");
    expect(result?.approval.id).toBe(PENDING_FIXTURE.id);
  });

  it("loadApproval returns the resolved YAML when only resolved exists", async () => {
    const paths = getPaths();
    const approved = {
      ...PENDING_FIXTURE,
      status: "approved" as const,
      resolver: "local-cli",
      resolved_at: "2026-05-04T10:01:23+09:00",
      note: "OK",
    };
    const filePath = join(paths.approvals.resolved, `${approved.id}.yaml`);
    await writeYamlFile(filePath, approved);

    const result = await loadApproval(paths, approved.id);
    expect(result).not.toBeNull();
    expect(result?.location).toBe("resolved");
    expect(result?.approval.status).toBe("approved");
    expect(result?.approval.note).toBe("OK");
  });

  it("loadApproval returns null when neither directory contains the id", async () => {
    const paths = getPaths();
    const result = await loadApproval(paths, "appr_01HXMZ99ABCDEFGHJKMNPQRSTV");
    expect(result).toBeNull();
  });

  it("enumerateApprovals lists ids from both directories and ignores non-yaml files", async () => {
    const paths = getPaths();
    const pendingId = "appr_01HXMA01ABCDEFGHJKMNPQRSTV";
    const resolvedId = "appr_01HXMB02ABCDEFGHJKMNPQRSTV";
    await writeYamlFile(join(paths.approvals.pending, `${pendingId}.yaml`), {
      ...PENDING_FIXTURE,
      id: pendingId,
    });
    await writeYamlFile(join(paths.approvals.resolved, `${resolvedId}.yaml`), {
      ...PENDING_FIXTURE,
      id: resolvedId,
      status: "approved",
      resolver: "local-cli",
      resolved_at: "2026-05-04T10:01:23+09:00",
    });
    // Drop a non-yaml file in pending to confirm the filter survives noise.
    await writeFile(join(paths.approvals.pending, "README.txt"), "ignore me\n", "utf8");

    const enumeration = await enumerateApprovals(paths);
    expect(enumeration.pending).toEqual([pendingId]);
    expect(enumeration.resolved).toEqual([resolvedId]);
  });

  it("isLazyExpired returns true only for pending entries past expires_at", () => {
    const baseNow = new Date("2026-05-04T11:00:00+09:00");
    const pendingPast: Approval = {
      ...PENDING_FIXTURE,
      expires_at: "2026-05-04T10:30:00+09:00",
    };
    const pendingFuture: Approval = {
      ...PENDING_FIXTURE,
      expires_at: "2026-05-04T12:00:00+09:00",
    };
    const pendingNullExpiry: Approval = { ...PENDING_FIXTURE, expires_at: null };
    const approvedPast: Approval = {
      ...PENDING_FIXTURE,
      status: "approved",
      expires_at: "2026-05-04T10:30:00+09:00",
    };

    expect(isLazyExpired(pendingPast, baseNow)).toBe(true);
    expect(isLazyExpired(pendingFuture, baseNow)).toBe(false);
    expect(isLazyExpired(pendingNullExpiry, baseNow)).toBe(false);
    expect(isLazyExpired(approvedPast, baseNow)).toBe(false);
  });

  it("loadApproval throws Failed to read approval when YAML fails schema validation", async () => {
    const paths = getPaths();
    const id = "appr_01HXMA01ABCDEFGHJKMNPQRSTV";
    // Write a YAML body that parses but violates the approval schema (status is invalid).
    const filePath = join(paths.approvals.pending, `${id}.yaml`);
    await writeFile(
      filePath,
      [
        'schema_version: "0.1.0"',
        `id: "${id}"`,
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

    let captured: unknown;
    try {
      await loadApproval(paths, id);
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    const err = captured as Error;
    expect(err.message).toBe("Failed to read approval");
    expect(err.cause).toBeDefined();
  });
});
