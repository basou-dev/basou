import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  basouPaths,
  createManifest,
  ensureBasouDirectory,
  importSessionFromJson,
  readYamlFile,
  type SessionImportPayload,
  writeManifest,
  writeYamlFile,
} from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PASSING_STATUSES, runVerify, type VerifyRow } from "./verify.js";

const execFileAsync = promisify(execFile);
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const FIXED_DATE = new Date("2026-05-09T03:00:00.000Z");
const INPUT_SES_ID = "ses_01HXABCDEF1234567890ABCSE1" as const;
const LIVE_SES_ID = "ses_01HXABCDEF1234567890ABCV01" as const;

let tmpRepo: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-verify-cli-test-"));
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: tmpRepo, env: ENV });
  await execFileAsync("git", ["config", "user.email", "t@e.com"], { cwd: tmpRepo, env: ENV });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: tmpRepo, env: ENV });
});

afterEach(async () => {
  if (tmpRepo !== undefined) await rm(tmpRepo, { recursive: true, force: true });
  tmpRepo = undefined;
  process.exitCode = 0;
  vi.restoreAllMocks();
});

async function setupInitedRepo(): Promise<string> {
  const repo = await realpath(tmpRepo as string);
  const paths = await ensureBasouDirectory(repo);
  await writeManifest(
    paths,
    createManifest({ workspaceName: "verify-ws", now: FIXED_DATE, workspaceId: FIXED_WS_ID }),
  );
  return repo;
}

function makePayload(): SessionImportPayload {
  const evt = (suffix: string, type: string, occurredAt: string, body?: string) =>
    ({
      schema_version: "0.1.0",
      id: `evt_01HXABCDEF1234567890ABCE${suffix}`,
      session_id: INPUT_SES_ID,
      occurred_at: occurredAt,
      source: "codex-import",
      type,
      ...(body !== undefined ? { body } : {}),
    }) as SessionImportPayload["events"][number];
  return {
    schema_version: "0.1.0",
    session: {
      workspace_id: FIXED_WS_ID,
      source: { kind: "codex-import", version: "0.1.0", external_id: "rollout-1" },
      started_at: "2026-05-04T09:00:00+09:00",
      status: "completed",
      working_directory: "/srv/example-project",
      invocation: { command: "codex", args: [], exit_code: 0 },
      related_files: [],
    },
    events: [
      evt("V1", "session_started", "2026-05-04T09:00:00+09:00"),
      evt("V2", "note_added", "2026-05-04T09:01:00+09:00", "hello"),
      evt("V3", "session_ended", "2026-05-04T09:02:00+09:00"),
    ],
  };
}

async function importChainedSession(repo: string): Promise<string> {
  const paths = basouPaths(repo);
  const manifest = createManifest({
    workspaceName: "verify-ws",
    now: FIXED_DATE,
    workspaceId: FIXED_WS_ID,
  });
  const result = await importSessionFromJson(paths, manifest, makePayload(), {});
  return result.sessionId;
}

/** A live-style (unchained, anchor-less) session the verifier must not flag. */
async function writeLiveSession(repo: string): Promise<void> {
  const paths = basouPaths(repo);
  const dir = join(paths.sessions, LIVE_SES_ID);
  await mkdir(dir, { recursive: true });
  await writeYamlFile(join(dir, "session.yaml"), {
    schema_version: "0.1.0",
    session: {
      id: LIVE_SES_ID,
      task_id: null,
      workspace_id: FIXED_WS_ID,
      source: { kind: "terminal", version: "0.1.0" },
      started_at: "2026-05-04T09:00:00+09:00",
      status: "completed",
      working_directory: "~/projects/example",
      invocation: { command: "bash", args: [], exit_code: 0 },
      related_files: [],
      events_log: "events.jsonl",
      summary: null,
    },
  });
  const line = JSON.stringify({
    schema_version: "0.1.0",
    id: "evt_01HXABCDEF1234567890ABCV01",
    session_id: LIVE_SES_ID,
    occurred_at: "2026-05-04T09:00:00+09:00",
    source: "terminal-recording",
    type: "session_started",
  });
  await writeFile(join(dir, "events.jsonl"), `${line}\n`);
}

function captureStdout() {
  return vi.spyOn(console, "log").mockImplementation(() => undefined);
}

function captureStderr() {
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

function joinCalls(spy: ReturnType<typeof captureStdout>): string {
  return spy.mock.calls.flat().map(String).join("\n");
}

describe("basou verify", () => {
  it("verifies an imported session and reports a live one unchained (exit 0)", async () => {
    const repo = await setupInitedRepo();
    const importedId = await importChainedSession(repo);
    await writeLiveSession(repo);

    const out = captureStdout();
    await runVerify({}, { cwd: repo });

    const text = joinCalls(out);
    // Whole lines, so a note appended to a valid session's row fails the test.
    const lines = text.split("\n");
    expect(lines).toContain(`${importedId}  verified (3 events)`);
    expect(lines).toContain(
      `${LIVE_SES_ID}  unchained (session created before event-log chaining)`,
    );
    expect(text).toContain(
      "Sessions: 2 total — 1 verified, 1 unchained, 0 empty, 0 incomplete, 0 in_progress, 0 unsupported, 0 tampered",
    );
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("flags a tampered imported session and exits non-zero", async () => {
    const repo = await setupInitedRepo();
    const importedId = await importChainedSession(repo);
    const eventsPath = join(basouPaths(repo).sessions, importedId, "events.jsonl");
    const tampered = (await readFile(eventsPath, "utf8")).replace('"hello"', '"hacked"');
    await writeFile(eventsPath, tampered);

    const out = captureStdout();
    await runVerify({}, { cwd: repo });

    expect(joinCalls(out)).toContain("TAMPERED (broken_link at line 3)");
    expect(process.exitCode).toBe(1);
  });

  // POSIX only: creating a symlink needs privileges on Windows.
  it.skipIf(process.platform === "win32")(
    "ignores entries not named as a session id and reports a symlinked session as symlink",
    async () => {
      const repo = await setupInitedRepo();
      const importedId = await importChainedSession(repo);
      await writeLiveSession(repo);
      const sessions = basouPaths(repo).sessions;
      await mkdir(join(sessions, "notes"));
      await cp(join(sessions, importedId), join(sessions, `${importedId}.bak`), {
        recursive: true,
      });
      const outside = join(repo, "moved-session");
      await cp(join(sessions, LIVE_SES_ID), outside, { recursive: true });
      await rm(join(sessions, LIVE_SES_ID), { recursive: true });
      await symlink(outside, join(sessions, LIVE_SES_ID));

      const out = captureStdout();
      await runVerify({ json: true }, { cwd: repo });
      expect(JSON.parse(joinCalls(out))).toEqual(
        [
          { session_id: importedId, status: "verified", event_count: 3 },
          { session_id: LIVE_SES_ID, status: "tampered", event_count: 0, reason: "symlink" },
        ].sort((a, b) => (a.session_id < b.session_id ? -1 : 1)),
      );
      expect(process.exitCode).toBe(1);

      // --session naming the symlink gives its row rather than "not found".
      process.exitCode = 0;
      out.mockClear();
      await runVerify({ json: true, session: LIVE_SES_ID }, { cwd: repo });
      expect(JSON.parse(joinCalls(out))).toEqual([
        { session_id: LIVE_SES_ID, status: "tampered", event_count: 0, reason: "symlink" },
      ]);
      expect(process.exitCode).toBe(1);

      // The copy no longer makes the original's full id ambiguous.
      process.exitCode = 0;
      out.mockClear();
      await runVerify({ json: true, session: importedId }, { cwd: repo });
      expect(JSON.parse(joinCalls(out))).toEqual([
        { session_id: importedId, status: "verified", event_count: 3 },
      ]);
      expect(process.exitCode ?? 0).toBe(0);
    },
  );

  it("reports a null line as tampered and still reports every other session", async () => {
    const repo = await setupInitedRepo();
    const importedId = await importChainedSession(repo);
    await writeLiveSession(repo);
    const eventsPath = join(basouPaths(repo).sessions, importedId, "events.jsonl");
    const lines = (await readFile(eventsPath, "utf8")).split("\n");
    lines[1] = "null";
    await writeFile(eventsPath, lines.join("\n"));

    const out = captureStdout();
    await runVerify({ json: true }, { cwd: repo });

    const rows = JSON.parse(joinCalls(out)) as VerifyRow[];
    expect(new Map(rows.map((r) => [r.session_id, r]))).toEqual(
      new Map<string, VerifyRow>([
        [
          importedId,
          {
            session_id: importedId,
            status: "tampered",
            event_count: 3,
            reason: "missing_prev_hash",
            line: 2,
          },
        ],
        [LIVE_SES_ID, { session_id: LIVE_SES_ID, status: "unchained", event_count: 1 }],
      ]),
    );
    expect(process.exitCode).toBe(1);
  });

  it("emits machine-readable rows with --json", async () => {
    const repo = await setupInitedRepo();
    const importedId = await importChainedSession(repo);
    await writeLiveSession(repo);

    const out = captureStdout();
    await runVerify({ json: true }, { cwd: repo });

    const rows = JSON.parse(joinCalls(out)) as VerifyRow[];
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.session_id, r]));
    expect(byId.get(importedId)).toEqual({
      session_id: importedId,
      status: "verified",
      event_count: 3,
    });
    expect(byId.get(LIVE_SES_ID)?.status).toBe("unchained");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("judges a session on its anchor when another session.yaml field fails validation", async () => {
    const repo = await setupInitedRepo();
    const importedId = await importChainedSession(repo);
    const yamlPath = join(basouPaths(repo).sessions, importedId, "session.yaml");
    const record = (await readYamlFile(yamlPath)) as {
      session: { source: Record<string, unknown> };
    };
    record.session.source.version = "0.2.0";
    await writeYamlFile(yamlPath, record);

    const out = captureStdout();
    await runVerify({}, { cwd: repo });
    const text = joinCalls(out);
    expect(text).toContain(
      `${importedId}  verified (3 events) — session.yaml does not load as a whole document (session_yaml_invalid)`,
    );
    expect(text).toContain("1 verified");
    expect(text).toContain("0 tampered");
    expect(process.exitCode ?? 0).toBe(0);

    out.mockClear();
    await runVerify({ json: true }, { cwd: repo });
    expect(JSON.parse(joinCalls(out))).toEqual([
      { session_id: importedId, status: "verified", event_count: 3, session_yaml_invalid: true },
    ]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("reports a session.yaml a newer basou wrote as unsupported and exits non-zero", async () => {
    const repo = await setupInitedRepo();
    const importedId = await importChainedSession(repo);
    const yamlPath = join(basouPaths(repo).sessions, importedId, "session.yaml");
    const record = (await readYamlFile(yamlPath)) as Record<string, unknown>;
    record.schema_version = "1.0.0";
    await writeYamlFile(yamlPath, record);

    const out = captureStdout();
    await runVerify({}, { cwd: repo });
    const lines = joinCalls(out).split("\n");
    expect(lines).toContain(
      `${importedId}  unsupported (session.yaml written by a newer basou; upgrade basou to verify it) — session.yaml does not load as a whole document (session_yaml_invalid)`,
    );
    expect(lines).toContain(
      "Sessions: 1 total — 0 verified, 0 unchained, 0 empty, 0 incomplete, 0 in_progress, 1 unsupported, 0 tampered",
    );
    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
    out.mockClear();
    await runVerify({ json: true }, { cwd: repo });
    expect(JSON.parse(joinCalls(out))).toEqual([
      { session_id: importedId, status: "unsupported", event_count: 3, session_yaml_invalid: true },
    ]);
    expect(process.exitCode).toBe(1);
  });

  // POSIX only: chmod 0o000 has no effect under root.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "aborts with an operational error when a session.yaml cannot be read",
    async () => {
      const repo = await setupInitedRepo();
      const importedId = await importChainedSession(repo);
      const yamlPath = join(basouPaths(repo).sessions, importedId, "session.yaml");
      await chmod(yamlPath, 0o000);
      try {
        const out = captureStdout();
        const err = captureStderr();
        await runVerify({}, { cwd: repo });
        expect(joinCalls(err)).toContain(`Failed to read session.yaml of ${importedId}`);
        expect(joinCalls(out)).not.toContain("TAMPERED");
        expect(process.exitCode).toBe(1);
      } finally {
        await chmod(yamlPath, 0o644);
      }
    },
  );

  it("verifies a single session with --session (prefix resolution)", async () => {
    const repo = await setupInitedRepo();
    const importedId = await importChainedSession(repo);
    await writeLiveSession(repo);

    const out = captureStdout();
    await runVerify({ session: importedId }, { cwd: repo });

    const text = joinCalls(out);
    expect(text).toContain(`${importedId}  verified (3 events)`);
    expect(text).not.toContain(LIVE_SES_ID);
    expect(text).toContain("Sessions: 1 total");
  });

  it("rejects --session combined with --all", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runVerify({ session: "abc", all: true }, { cwd: repo });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err)).toContain("Specify either --session <id> or --all, not both");
  });

  it("requires an initialized workspace", async () => {
    const repo = await realpath(tmpRepo as string);
    const err = captureStderr();
    await runVerify({}, { cwd: repo });
    expect(process.exitCode).toBe(1);
    expect(joinCalls(err)).toContain("Workspace not initialized");
  });

  it("reports an empty workspace as zero sessions (exit 0)", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await runVerify({}, { cwd: repo });
    expect(joinCalls(out)).toContain("Sessions: 0 total");
    expect(process.exitCode ?? 0).toBe(0);
  });
});

// docs/spec/schemas.md §7.5 documents the rows of `basou verify --json`: their
// fields and the values of `status` and `reason`. These records are exhaustive
// over the code's types, so typecheck fails when a field or value is added to
// or removed from the code alone, and the test below fails when the doc's
// lists differ from the records or its Exit column from PASSING_STATUSES. The
// doc's other columns are not pinned here.
const ROW_FIELDS: Record<keyof VerifyRow, true> = {
  session_id: true,
  status: true,
  event_count: true,
  reason: true,
  line: true,
  session_yaml_invalid: true,
};
const STATUSES: Record<VerifyRow["status"], true> = {
  verified: true,
  unchained: true,
  empty: true,
  incomplete: true,
  in_progress: true,
  unsupported: true,
  tampered: true,
};
const REASONS: Record<NonNullable<VerifyRow["reason"]>, true> = {
  torn_tail: true,
  blank_line: true,
  malformed_line: true,
  missing_prev_hash: true,
  genesis_mismatch: true,
  broken_link: true,
  session_id_mismatch: true,
  anchor_missing: true,
  anchor_mismatch: true,
  anchor_without_chain: true,
  yaml_unreadable: true,
  yaml_missing: true,
  symlink: true,
  not_a_directory: true,
};

// The cells of each row of the table under `header`, with the first cell's
// backticks removed.
function tableRows(section: string, header: string): [string, ...string[]][] {
  const lines = section.split("\n");
  const start = lines.indexOf(header);
  if (start === -1) throw new Error(`table not found: ${header}`);
  const rows: [string, ...string[]][] = [];
  for (const row of lines.slice(start + 2)) {
    if (!row.startsWith("|")) break;
    const cells = row
      .slice(1, -1)
      .split(" | ")
      .map((c) => c.trim());
    const first = /^`([^`]+)`$/.exec(cells[0] ?? "");
    if (first === null) throw new Error(`row without a backticked first cell: ${row}`);
    rows.push([first[1] as string, ...cells.slice(1)]);
  }
  return rows;
}

describe("basou verify --json as documented", () => {
  it("lists the same fields and values as the code", async () => {
    const doc = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "../../../../docs/spec/schemas.md"),
      "utf8",
    );
    const section = doc.slice(doc.indexOf("## §7.5 "));
    const first = (header: string): string[] => tableRows(section, header).map((r) => r[0]);
    expect(first("| Field | Value | Present | Meaning |")).toEqual(Object.keys(ROW_FIELDS));
    expect(first("| `reason` | `status` | `line` | Meaning |")).toEqual(Object.keys(REASONS));
    const verdicts = tableRows(section, "| Verdict | Meaning | Exit |");
    expect(verdicts.map((r) => r[0])).toEqual(Object.keys(STATUSES));
    expect(verdicts.map((r) => [r[0], r[2]])).toEqual(
      Object.keys(STATUSES).map((status) => [
        status,
        PASSING_STATUSES.has(status as VerifyRow["status"]) ? "0" : "non-zero",
      ]),
    );
  });

  it("prints an empty array for a workspace with no sessions", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await runVerify({ json: true }, { cwd: repo });
    expect(JSON.parse(joinCalls(out))).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("prints no array when the command stops before verifying", async () => {
    const repo = await setupInitedRepo();
    await importChainedSession(repo);
    const out = captureStdout();
    const err = captureStderr();
    await runVerify({ json: true, session: "ses_nomatch" }, { cwd: repo });
    expect(out).not.toHaveBeenCalled();
    expect(joinCalls(err)).toContain("Session not found: ses_nomatch");
    expect(process.exitCode).toBe(1);
  });
});
