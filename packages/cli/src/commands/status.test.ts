import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type BasouPaths,
  StatusSchema,
  basouPaths,
  createManifest,
  ensureBasouDirectory,
  writeManifest,
} from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doRunStatus, runStatus } from "./status.js";

const execFileAsync = promisify(execFile);

let tmpRepo: string | undefined;

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
};

const FIXED_DATE = new Date("2026-05-04T09:00:00.000Z");
const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-status-cli-test-"));
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
    // Re-grant traversal in case a test (chmod-based EACCES) left .basou
    // without x permission, which would otherwise break recursive rm.
    try {
      await chmod(join(tmpRepo, ".basou"), 0o755);
    } catch {
      // .basou may not exist for this test; ignore.
    }
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

async function setupInitedRepo(): Promise<{ repo: string; paths: BasouPaths }> {
  const repo = getTmpRepo();
  const paths = await ensureBasouDirectory(repo);
  const manifest = createManifest({
    workspaceName: "client-foo-lp",
    now: FIXED_DATE,
    workspaceId: FIXED_WS_ID,
  });
  await writeManifest(paths, manifest);
  return { repo, paths };
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

describe("doRunStatus (pure runner)", () => {
  it("prints workspace identity + subdirectory count for an inited repo", async () => {
    const { repo } = await setupInitedRepo();
    const out = captureStdout();
    await doRunStatus({}, { cwd: repo });
    const stdout = joinCalls(out);
    expect(stdout).toContain(`Workspace: client-foo-lp (${FIXED_WS_ID})`);
    expect(stdout).toContain("Basou version: 0.1.0");
    expect(stdout).toContain("Generated at: ");
    expect(stdout).toContain("Subdirectories present: 7/7");
    // pure runner must not flip exitCode to 1 on success (Node leaves it
    // undefined unless a non-zero value is set explicitly).
    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
  });

  it("--json emits a valid JSON document parseable by StatusSchema", async () => {
    const { repo } = await setupInitedRepo();
    const out = captureStdout();
    await doRunStatus({ json: true }, { cwd: repo });
    const stdout = joinCalls(out);
    const parsed = JSON.parse(stdout) as unknown;
    const result = StatusSchema.safeParse(parsed);
    expect(result.success).toBe(true);
    // No human-readable text leaked into the JSON-only output.
    expect(stdout.startsWith("{")).toBe(true);
  });

  it("--json still writes .basou/status.json (B2 semantics)", async () => {
    const { repo, paths } = await setupInitedRepo();
    captureStdout();
    await doRunStatus({ json: true }, { cwd: repo });
    await access(paths.files.status);
  });

  it("observes the repo-root .basou/ when invoked from a subdirectory", async () => {
    const { repo } = await setupInitedRepo();
    const sub = join(repo, "src", "deep");
    await mkdir(sub, { recursive: true });
    const out = captureStdout();
    await doRunStatus({ json: true }, { cwd: sub });
    const stdout = joinCalls(out);
    const parsed = StatusSchema.parse(JSON.parse(stdout));
    expect(parsed.workspace.id).toBe(FIXED_WS_ID);
  });

  it("reflects partial directories_present in stdout (sessions removed)", async () => {
    const { repo, paths } = await setupInitedRepo();
    await rm(paths.sessions, { recursive: true });
    const out = captureStdout();
    await doRunStatus({}, { cwd: repo });
    expect(joinCalls(out)).toContain("Subdirectories present: 6/7");
  });

  it("rewrites generated_at and leaves no leftover tmp files on consecutive runs", async () => {
    const { repo, paths } = await setupInitedRepo();
    captureStdout();
    await doRunStatus({ json: true }, { cwd: repo });
    const out = captureStdout();
    await doRunStatus({ json: true }, { cwd: repo });
    const second = StatusSchema.parse(JSON.parse(joinCalls(out)));
    expect(second.generated_at.length).toBeGreaterThan(0);
    const entries = await readdir(paths.root);
    expect(entries).toContain("status.json");
    expect(entries.some((name) => name.startsWith("status.json.tmp."))).toBe(false);
  });
});

describe("runStatus (process-state wrapper)", () => {
  it("uninitialized repo: exit 1 with pathless 'Workspace not initialized' hint", async () => {
    const repo = getTmpRepo();
    const errSpy = captureStderr();
    captureStdout();
    await runStatus({}, { cwd: repo });
    const stderr = joinCalls(errSpy);
    expect(stderr).toContain("Workspace not initialized. Run 'basou init' first.");
    expect(stderr).not.toContain(repo);
    expect(process.exitCode).toBe(1);
  });

  it("corrupt manifest: exit 1, stderr is pathless even in verbose mode", async () => {
    const { repo, paths } = await setupInitedRepo();
    // Overwrite manifest with content that fails ManifestSchema.parse but is
    // still valid YAML, so the underlying error is a ZodError thrown by
    // readManifest. ZodError carries its issues in `message`, not in `cause`,
    // so `Caused by:` is intentionally not asserted here — the contract that
    // matters is "exit 1, no absolute path leaks".
    await writeFile(paths.files.manifest, 'schema_version: "0.2.0"\n', "utf8");
    const errSpy = captureStderr();
    captureStdout();
    await runStatus({ verbose: true }, { cwd: repo });
    const stderr = joinCalls(errSpy);
    expect(stderr).not.toContain(repo);
    expect(process.exitCode).toBe(1);
  });

  it(".basou symlink to outside repo: exit 1 and target is not written", async () => {
    const repo = getTmpRepo();
    const externalTarget = await mkdtemp(join(tmpdir(), "basou-status-external-"));
    try {
      const paths = basouPaths(repo);
      await symlink(externalTarget, paths.root);
      const errSpy = captureStderr();
      captureStdout();
      await runStatus({}, { cwd: repo });
      const stderr = joinCalls(errSpy);
      expect(stderr).toContain(".basou root is a symlink");
      expect(stderr).not.toContain(repo);
      expect(process.exitCode).toBe(1);
      // The symlink target must not have been written into.
      const externalEntries = await readdir(externalTarget);
      expect(externalEntries).not.toContain("status.json");
    } finally {
      await rm(externalTarget, { recursive: true, force: true });
    }
  });

  // POSIX: dropping .basou's traversal (x) bit makes every fs operation
  // under .basou (lstat / readFile / open / ...) fail with EACCES on its
  // first traversal. doRunStatus reaches readManifest before the directory
  // probes, so the surfaced error is "Failed to read YAML file" rather
  // than "Failed to inspect .basou subdirectory". Either way the
  // observable contract is "exit 1 + pathless stderr". Skipped on root
  // because chmod is a no-op for euid 0.
  it.skipIf(process.geteuid?.() === 0)(
    "EACCES under .basou: exit 1, stderr is pathless",
    async () => {
      const { repo, paths } = await setupInitedRepo();
      await chmod(paths.root, 0o600);
      const errSpy = captureStderr();
      captureStdout();
      try {
        await runStatus({}, { cwd: repo });
      } finally {
        await chmod(paths.root, 0o755);
      }
      const stderr = joinCalls(errSpy);
      expect(stderr).not.toContain(repo);
      expect(process.exitCode).toBe(1);
    },
  );
});
