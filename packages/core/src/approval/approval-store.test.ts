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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Approval } from "../schemas/approval.schema.js";
import { type BasouPaths, basouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";
import { writeYamlFile } from "../storage/yaml-store.js";
import {
  assertApprovalStoreSafe,
  enumerateApprovals,
  inspectApprovalEntry,
  isLazyExpired,
  loadApproval,
} from "./approval-store.js";

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
  // Regression guard for the boundary clause in docs/spec/schemas.md §7.3.
  // Approvals are written by an outside orchestrator, so the version that
  // required seconds could only land here with a normalizer. Without it the
  // failure is worse than the dropped line the rule is written around:
  // `loadApproval` THROWS, and neither the orientation nor the report renderer
  // catches it, so a single seconds-less file takes both commands down and
  // hides a pending approval from `approval list`.
  it("reads an approval whose timestamps omit seconds, as an outside producer may write them", async () => {
    const paths = getPaths();
    const secondsLess = {
      ...PENDING_FIXTURE,
      created_at: "2026-05-04T10:00+09:00",
      expires_at: "2026-05-04T18:00Z",
    };
    await writeYamlFile(join(paths.approvals.pending, `${PENDING_FIXTURE.id}.yaml`), secondsLess);

    const loaded = await loadApproval(paths, PENDING_FIXTURE.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.location).toBe("pending");
    // Repaired to the accepted spelling, with the offset preserved.
    expect(loaded?.approval.created_at).toBe("2026-05-04T10:00:00+09:00");
    expect(loaded?.approval.expires_at).toBe("2026-05-04T18:00:00Z");
    // The document still appears where it must.
    const { pending } = await enumerateApprovals(paths);
    expect([...pending]).toContain(PENDING_FIXTURE.id);
  });

  it("still refuses a timestamp the normalizer does not recognize", async () => {
    // The boundary repairs one spelling; it does not widen the accepted set.
    const paths = getPaths();
    await writeYamlFile(join(paths.approvals.pending, `${PENDING_FIXTURE.id}.yaml`), {
      ...PENDING_FIXTURE,
      created_at: "2026-05-04t10:00:00z",
    });
    await expect(loadApproval(paths, PENDING_FIXTURE.id)).rejects.toThrow(
      "Failed to read approval",
    );
  });

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

  it("loadApproval throws Failed to read approval when filename id and YAML body id disagree", async () => {
    const paths = getPaths();
    const filenameId = "appr_01HXMA01ABCDEFGHJKMNPQRSTV";
    const bodyId = "appr_01HXMB02ABCDEFGHJKMNPQRSTV";
    // Save a YAML body whose `id` field deliberately disagrees with the
    // filename it lives under — exactly the split-brain a hand-edited
    // dogfood approval can produce.
    const filePath = join(paths.approvals.pending, `${filenameId}.yaml`);
    await writeYamlFile(filePath, { ...PENDING_FIXTURE, id: bodyId });

    let captured: unknown;
    try {
      await loadApproval(paths, filenameId);
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    const err = captured as Error;
    expect(err.message).toBe("Failed to read approval");
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toContain("Approval id mismatch");
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

const RESOLVED_FIXTURE: Approval = {
  ...PENDING_FIXTURE,
  id: "appr_01HXMA02ABCDEFGHJKMNPQRSTV",
  status: "approved",
  resolver: "local-cli",
  resolved_at: "2026-05-04T11:00:00+09:00",
};

/** One pending and one resolved approval, each in its directory. */
async function seedApprovals(paths: BasouPaths): Promise<void> {
  await writeYamlFile(join(paths.approvals.pending, `${PENDING_FIXTURE.id}.yaml`), PENDING_FIXTURE);
  await writeYamlFile(
    join(paths.approvals.resolved, `${RESOLVED_FIXTURE.id}.yaml`),
    RESOLVED_FIXTURE,
  );
}

const APPROVAL_STORE_DIRECTORIES = ["approvals", "approvals/pending", "approvals/resolved"];

describe("assertApprovalStoreSafe", () => {
  it("passes when the approval store is absent or holds directories", async () => {
    const paths = getPaths();
    await expect(assertApprovalStoreSafe(paths)).resolves.toBeUndefined();
    await rm(paths.approvals.resolved, { recursive: true });
    await expect(assertApprovalStoreSafe(paths)).resolves.toBeUndefined();
    await rm(join(paths.root, "approvals"), { recursive: true });
    await expect(assertApprovalStoreSafe(paths)).resolves.toBeUndefined();
  });

  it("control: both readers see the seeded approvals", async () => {
    const paths = getPaths();
    await seedApprovals(paths);
    expect(await enumerateApprovals(paths)).toEqual({
      pending: [PENDING_FIXTURE.id],
      resolved: [RESOLVED_FIXTURE.id],
      unfollowed: [],
    });
    expect((await loadApproval(paths, PENDING_FIXTURE.id))?.location).toBe("pending");
    expect((await loadApproval(paths, RESOLVED_FIXTURE.id))?.location).toBe("resolved");
  });

  // POSIX only: creating a symlink needs privileges on Windows.
  for (const relative of APPROVAL_STORE_DIRECTORIES) {
    const label = `.basou/${relative}`;

    it.skipIf(process.platform === "win32")(
      `refuses a ${label} that is a symlink: both readers stop before reading`,
      async () => {
        const paths = getPaths();
        await seedApprovals(paths);
        const inside = join(paths.root, relative);
        const outside = join(paths.root, "..", "outside");
        await rename(inside, outside);
        await symlink(outside, inside);
        const before = await snapshot(outside);
        const refusal = new Error(`${label} is a symlink; refusing to operate`);
        await expect(assertApprovalStoreSafe(paths)).rejects.toThrow(refusal);
        await expect(enumerateApprovals(paths)).rejects.toThrow(refusal);
        await expect(loadApproval(paths, PENDING_FIXTURE.id)).rejects.toThrow(refusal);
        await expect(loadApproval(paths, RESOLVED_FIXTURE.id)).rejects.toThrow(refusal);
        expect(await snapshot(outside)).toEqual(before);
      },
    );

    it(`refuses a ${label} that is a file: both readers stop before reading`, async () => {
      const paths = getPaths();
      await seedApprovals(paths);
      const inside = join(paths.root, relative);
      await rm(inside, { recursive: true });
      await writeFile(inside, "");
      const refusal = new Error(`${label} exists but is not a directory`);
      await expect(assertApprovalStoreSafe(paths)).rejects.toThrow(refusal);
      await expect(enumerateApprovals(paths)).rejects.toThrow(refusal);
      await expect(loadApproval(paths, PENDING_FIXTURE.id)).rejects.toThrow(refusal);
    });
  }

  it("checks .basou/approvals before the directories in it", async () => {
    const paths = getPaths();
    await rm(join(paths.root, "approvals"), { recursive: true });
    await mkdir(paths.root, { recursive: true });
    await writeFile(join(paths.root, "approvals"), "");
    // pending and resolved cannot be inspected under a file (ENOTDIR); the
    // refusal names the file, not a failure to inspect what is under it.
    await expect(assertApprovalStoreSafe(paths)).rejects.toThrow(
      new Error(".basou/approvals exists but is not a directory"),
    );
  });
});

// An approval file is read only when it is a regular file. POSIX only:
// creating a symlink needs privileges on Windows.
describe.skipIf(process.platform === "win32")("approval files that are not followed", () => {
  /** A file outside the store holding `approval`, and a symlink to it at `link`. */
  async function linkOutside(paths: BasouPaths, link: string, approval: Approval): Promise<string> {
    const outside = join(paths.root, "..", "outside.yaml");
    await writeYamlFile(outside, { ...approval, reason: "read from outside the store" });
    await symlink(outside, link);
    return outside;
  }

  it("leaves a symlinked pending file out of the listing and looks it up as absent", async () => {
    const paths = getPaths();
    const link = join(paths.approvals.pending, `${PENDING_FIXTURE.id}.yaml`);
    await linkOutside(paths, link, PENDING_FIXTURE);

    expect(await enumerateApprovals(paths)).toEqual({
      pending: [],
      resolved: [],
      unfollowed: [{ id: PENDING_FIXTURE.id, location: "pending", kind: "symlink" }],
    });
    expect(await loadApproval(paths, PENDING_FIXTURE.id)).toBeNull();
    expect(await inspectApprovalEntry(paths, "pending", PENDING_FIXTURE.id)).toBe("symlink");
  });

  it("reports a dangling symlink and a directory named as an approval", async () => {
    const paths = getPaths();
    await symlink(
      join(paths.root, "..", "nowhere.yaml"),
      join(paths.approvals.pending, `${PENDING_FIXTURE.id}.yaml`),
    );
    await mkdir(join(paths.approvals.resolved, `${RESOLVED_FIXTURE.id}.yaml`));

    const enumeration = await enumerateApprovals(paths);
    expect(enumeration.pending).toEqual([]);
    expect(enumeration.resolved).toEqual([]);
    expect(enumeration.unfollowed).toEqual(
      expect.arrayContaining([
        { id: PENDING_FIXTURE.id, location: "pending", kind: "symlink" },
        { id: RESOLVED_FIXTURE.id, location: "resolved", kind: "not_a_file" },
      ]),
    );
    expect(enumeration.unfollowed).toHaveLength(2);
    expect(await loadApproval(paths, PENDING_FIXTURE.id)).toBeNull();
    expect(await loadApproval(paths, RESOLVED_FIXTURE.id)).toBeNull();
    expect(await inspectApprovalEntry(paths, "resolved", RESOLVED_FIXTURE.id)).toBe("not_a_file");
    expect(await inspectApprovalEntry(paths, "resolved", PENDING_FIXTURE.id)).toBe("missing");
  });

  it("reads the pending file when the resolved entry of the same id is a symlink", async () => {
    const paths = getPaths();
    await writeYamlFile(
      join(paths.approvals.pending, `${PENDING_FIXTURE.id}.yaml`),
      PENDING_FIXTURE,
    );
    await linkOutside(paths, join(paths.approvals.resolved, `${PENDING_FIXTURE.id}.yaml`), {
      ...PENDING_FIXTURE,
      status: "approved",
    });

    const loaded = await loadApproval(paths, PENDING_FIXTURE.id);
    expect(loaded?.location).toBe("pending");
    expect(loaded?.approval).toEqual(PENDING_FIXTURE);
    expect(await enumerateApprovals(paths)).toEqual({
      pending: [PENDING_FIXTURE.id],
      resolved: [],
      unfollowed: [{ id: PENDING_FIXTURE.id, location: "resolved", kind: "symlink" }],
    });
  });

  it("reads the resolved file when the pending entry of the same id is a symlink", async () => {
    const paths = getPaths();
    await writeYamlFile(
      join(paths.approvals.resolved, `${RESOLVED_FIXTURE.id}.yaml`),
      RESOLVED_FIXTURE,
    );
    await linkOutside(
      paths,
      join(paths.approvals.pending, `${RESOLVED_FIXTURE.id}.yaml`),
      RESOLVED_FIXTURE,
    );

    const loaded = await loadApproval(paths, RESOLVED_FIXTURE.id);
    expect(loaded?.location).toBe("resolved");
    expect(loaded?.approval).toEqual(RESOLVED_FIXTURE);
  });
});
