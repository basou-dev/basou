import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusSchema } from "../schemas/status.schema.js";
import { basouPaths, ensureBasouDirectory } from "./basou-dir.js";
import { createManifest } from "./manifest.js";
import {
  assertBasouRootSafe,
  buildStatusSnapshot,
  DIRECTORY_CHECKS,
  findErrorCode,
  readStatus,
  writeStatus,
} from "./status.js";

let repoRoot: string | undefined;

beforeEach(async () => {
  repoRoot = await fsp.mkdtemp(join(tmpdir(), "basou-status-test-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (repoRoot !== undefined) {
    // Re-grant traversal so recursive rm can descend even if a test
    // intentionally dropped .basou's x permission (the EACCES test does).
    try {
      await fsp.chmod(join(repoRoot, ".basou"), 0o755);
    } catch {
      // .basou may not exist for this test; ignore.
    }
    await fsp.rm(repoRoot, { recursive: true, force: true });
    repoRoot = undefined;
  }
});

function getRepoRoot(): string {
  if (repoRoot === undefined) throw new Error("repoRoot not initialized");
  return repoRoot;
}

const FIXED_DATE = new Date("2026-05-04T09:00:00.000Z");
const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;

function makeManifest() {
  return createManifest({
    workspaceName: "client-foo-lp",
    now: FIXED_DATE,
    workspaceId: FIXED_WS_ID,
  });
}

describe("buildStatusSnapshot", () => {
  it("reports all directories_present as true after ensureBasouDirectory", async () => {
    const paths = await ensureBasouDirectory(getRepoRoot());
    const snapshot = await buildStatusSnapshot({ manifest: makeManifest(), paths });
    expect(snapshot.directories_present).toEqual({
      sessions: true,
      tasks: true,
      approvals_pending: true,
      approvals_resolved: true,
      logs: true,
      raw: true,
      tmp: true,
    });
  });

  it("reports false for ENOENT directories", async () => {
    const paths = await ensureBasouDirectory(getRepoRoot());
    await fsp.rm(paths.sessions, { recursive: true });
    const snapshot = await buildStatusSnapshot({ manifest: makeManifest(), paths });
    expect(snapshot.directories_present.sessions).toBe(false);
    expect(snapshot.directories_present.tasks).toBe(true);
  });

  it("uses provided now for generated_at", async () => {
    const paths = await ensureBasouDirectory(getRepoRoot());
    const snapshot = await buildStatusSnapshot({
      manifest: makeManifest(),
      paths,
      now: FIXED_DATE,
    });
    expect(snapshot.generated_at).toBe(FIXED_DATE.toISOString());
  });

  it("transcribes manifest workspace fields verbatim", async () => {
    const paths = await ensureBasouDirectory(getRepoRoot());
    const manifest = makeManifest();
    const snapshot = await buildStatusSnapshot({ manifest, paths });
    expect(snapshot.workspace.id).toBe(manifest.workspace.id);
    expect(snapshot.workspace.name).toBe(manifest.workspace.name);
    expect(snapshot.workspace.basou_version).toBe(manifest.basou_version);
  });

  it("reports false when a directory slot is a regular file", async () => {
    const paths = await ensureBasouDirectory(getRepoRoot());
    await fsp.rm(paths.sessions, { recursive: true });
    await fsp.writeFile(paths.sessions, "i am a file, not a dir", "utf8");
    const snapshot = await buildStatusSnapshot({ manifest: makeManifest(), paths });
    expect(snapshot.directories_present.sessions).toBe(false);
  });

  it("reports false for a symlink-to-directory (lstat does not follow symlinks)", async () => {
    const paths = await ensureBasouDirectory(getRepoRoot());
    await fsp.rm(paths.sessions, { recursive: true });
    const realDir = join(getRepoRoot(), "real-dir");
    await fsp.mkdir(realDir, { recursive: true });
    await fsp.symlink(realDir, paths.sessions);
    const snapshot = await buildStatusSnapshot({ manifest: makeManifest(), paths });
    expect(snapshot.directories_present.sessions).toBe(false);
  });

  it("reports false for a broken symlink", async () => {
    const paths = await ensureBasouDirectory(getRepoRoot());
    await fsp.rm(paths.sessions, { recursive: true });
    await fsp.symlink(join(getRepoRoot(), "nonexistent-target"), paths.sessions);
    const snapshot = await buildStatusSnapshot({ manifest: makeManifest(), paths });
    expect(snapshot.directories_present.sessions).toBe(false);
  });

  it("reports false when an ancestor of the slot is a regular file (ENOTDIR)", async () => {
    const paths = await ensureBasouDirectory(getRepoRoot());
    // Replace .basou/approvals (a directory) with a regular file so that
    // lstat'ing any child path fails with ENOTDIR rather than ENOENT —
    // exercising the ENOTDIR branch of dirPresent independently of ENOENT.
    await fsp.rm(paths.approvals.pending, { recursive: true });
    await fsp.rm(paths.approvals.resolved, { recursive: true });
    const approvalsBase = join(paths.root, "approvals");
    await fsp.rm(approvalsBase, { recursive: true });
    await fsp.writeFile(approvalsBase, "not a directory", "utf8");
    const snapshot = await buildStatusSnapshot({ manifest: makeManifest(), paths });
    expect(snapshot.directories_present.approvals_pending).toBe(false);
    expect(snapshot.directories_present.approvals_resolved).toBe(false);
  });

  // POSIX: lstat(path) requires traversal (x) permission on the parent
  // directory, NOT on `path` itself. Dropping the .basou directory's x bits
  // therefore makes every lstat(.basou/<child>) fail with EACCES, while
  // .basou itself still resolves (the repo root keeps its x bit). This is
  // skipped on root because chmod is ignored for euid 0.
  it.skipIf(process.geteuid?.() === 0)(
    "rethrows EACCES from lstat with a pathless message and cause (real-fs, chmod parent)",
    async () => {
      const paths = await ensureBasouDirectory(getRepoRoot());
      await fsp.chmod(paths.root, 0o600);
      let captured: unknown;
      try {
        await buildStatusSnapshot({ manifest: makeManifest(), paths });
      } catch (error: unknown) {
        captured = error;
      } finally {
        // Restore traversal so afterEach's recursive rm can descend.
        await fsp.chmod(paths.root, 0o755);
      }
      expect(captured).toBeInstanceOf(Error);
      const err = captured as Error;
      expect(err.message).toBe("Failed to inspect .basou subdirectory");
      expect(err.message).not.toContain(getRepoRoot());
      expect(err.cause).toBeInstanceOf(Error);
      expect((err.cause as { code?: string }).code).toBe("EACCES");
    },
  );
});

describe("writeStatus / readStatus", () => {
  it("round-trips a snapshot", async () => {
    const paths = await ensureBasouDirectory(getRepoRoot());
    const snapshot = await buildStatusSnapshot({
      manifest: makeManifest(),
      paths,
      now: FIXED_DATE,
    });
    await writeStatus(paths, snapshot);
    const readBack = await readStatus(paths);
    expect(readBack).toEqual(snapshot);
  });

  it("rejects an invalid snapshot before writing, leaving status.json untouched", async () => {
    const paths = await ensureBasouDirectory(getRepoRoot());
    const valid = await buildStatusSnapshot({
      manifest: makeManifest(),
      paths,
      now: FIXED_DATE,
    });
    await writeStatus(paths, valid);
    // biome-ignore lint/suspicious/noExplicitAny: deliberate invalid snapshot for negative test
    const broken = { ...valid, schema_version: "1.0.0" } as any; // higher major -> gated
    await expect(writeStatus(paths, broken)).rejects.toThrow();
    const readBack = await readStatus(paths);
    expect(readBack).toEqual(valid);
  });

  it("leaves no leftover tmp file after a successful write", async () => {
    const paths = await ensureBasouDirectory(getRepoRoot());
    const snapshot = await buildStatusSnapshot({
      manifest: makeManifest(),
      paths,
      now: FIXED_DATE,
    });
    await writeStatus(paths, snapshot);
    const entries = await fsp.readdir(paths.root);
    expect(entries).toContain("status.json");
    expect(entries.some((name) => name.startsWith("status.json.tmp."))).toBe(false);
  });

  it("throws pathless 'Status file not found' when status.json is missing", async () => {
    const paths = await ensureBasouDirectory(getRepoRoot());
    let captured: unknown;
    try {
      await readStatus(paths);
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    const err = captured as Error;
    expect(err.message).toBe("Status file not found");
    expect(err.message).not.toContain(getRepoRoot());
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as { code?: string }).code).toBe("ENOENT");
  });

  it("throws on malformed JSON content", async () => {
    const paths = await ensureBasouDirectory(getRepoRoot());
    await fsp.writeFile(paths.files.status, "{ not json", "utf8");
    let captured: unknown;
    try {
      await readStatus(paths);
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("Failed to parse status JSON");
  });

  it("throws when JSON content fails StatusSchema validation", async () => {
    const paths = await ensureBasouDirectory(getRepoRoot());
    await fsp.writeFile(paths.files.status, JSON.stringify({ schema_version: "0.2.0" }), "utf8");
    await expect(readStatus(paths)).rejects.toThrow();
  });

  it("overwrites status.json on consecutive writes", async () => {
    const paths = await ensureBasouDirectory(getRepoRoot());
    const first = await buildStatusSnapshot({
      manifest: makeManifest(),
      paths,
      now: FIXED_DATE,
    });
    await writeStatus(paths, first);
    const second = await buildStatusSnapshot({
      manifest: makeManifest(),
      paths,
      now: new Date("2026-05-04T10:00:00.000Z"),
    });
    await writeStatus(paths, second);
    const readBack = await readStatus(paths);
    expect(readBack.generated_at).toBe(second.generated_at);
  });
});

describe("assertBasouRootSafe", () => {
  it("throws when .basou is a symlink to a directory", async () => {
    const paths = basouPaths(getRepoRoot());
    const realDir = join(getRepoRoot(), "real-basou");
    await fsp.mkdir(realDir, { recursive: true });
    await fsp.symlink(realDir, paths.root);
    await expect(assertBasouRootSafe(paths.root)).rejects.toThrow(/\.basou root is a symlink/);
  });

  it("throws when .basou exists but is a regular file", async () => {
    const paths = basouPaths(getRepoRoot());
    await fsp.writeFile(paths.root, "i am a file", "utf8");
    await expect(assertBasouRootSafe(paths.root)).rejects.toThrow(/not a directory/);
  });

  it("propagates ENOENT (wrapped) when .basou is absent", async () => {
    const paths = basouPaths(getRepoRoot());
    let captured: unknown;
    try {
      await assertBasouRootSafe(paths.root);
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    const err = captured as Error;
    expect(err.message).toBe("Basou workspace not found");
    expect(err.message).not.toContain(getRepoRoot());
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as { code?: string }).code).toBe("ENOENT");
    // findErrorCode should still detect ENOENT through this wrapper.
    expect(findErrorCode(err, "ENOENT")).toBe(true);
  });
});

describe("DIRECTORY_CHECKS", () => {
  it("has the same key set as StatusSchema.shape.directories_present.shape", () => {
    const checkKeys = Object.keys(DIRECTORY_CHECKS).sort();
    const schemaKeys = Object.keys(StatusSchema.shape.directories_present.shape).sort();
    expect(checkKeys).toEqual(schemaKeys);
  });
});
