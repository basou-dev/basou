import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doRunNote } from "./note.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
};

const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const FIXED_DATE = new Date("2026-05-09T03:00:00.000Z");
const FIXED_NOW = new Date("2026-05-11T12:00:00.000Z");
const FIXED_CTX = { nowProvider: () => FIXED_NOW };

const SES = (suffix: string) => `ses_01HXABCDEF1234567890ABC${suffix}`;

let tmpRepo: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-note-cli-test-"));
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: tmpRepo, env: ENV });
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

async function createSession(repo: string, id: string, status: string): Promise<string> {
  const paths = basouPaths(repo);
  const sessionDir = join(paths.sessions, id);
  await mkdir(sessionDir, { recursive: true });
  await writeYamlFile(join(sessionDir, "session.yaml"), {
    schema_version: "0.1.0" as const,
    session: {
      id,
      label: "test",
      task_id: null,
      workspace_id: FIXED_WS_ID,
      source: { kind: "terminal" as const, version: "0.1.0" as const },
      started_at: "2026-05-08T11:00:00+09:00",
      status,
      working_directory: repo,
      invocation: { command: "echo", args: [], exit_code: 0 },
      related_files: [],
      events_log: "events.jsonl",
    },
  });
  await writeFile(join(sessionDir, "events.jsonl"), "");
  return id;
}

function captureStdout() {
  return vi.spyOn(console, "log").mockImplementation(() => undefined);
}

function joinCalls(spy: ReturnType<typeof captureStdout>): string {
  return spy.mock.calls.map((c) => String(c[0])).join("\n");
}

async function findAdHocSessionId(repo: string): Promise<string> {
  const dirs = await readdir(basouPaths(repo).sessions);
  const found = dirs.find((d) => d.startsWith("ses_"));
  if (found === undefined) throw new Error("no ad-hoc session directory was created");
  return found;
}

async function readEvents(repo: string, sid: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(basouPaths(repo).sessions, sid, "events.jsonl"), "utf8"))
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("doRunNote (ad-hoc path)", () => {
  it("creates an ad-hoc session holding a note_added event", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunNote("resume from: ship v0.24.0", {}, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(out)).toContain("in ad-hoc session");

    const sid = await findAdHocSessionId(repo);
    const events = await readEvents(repo, sid);
    const note = events.find((e) => e.type === "note_added");
    expect(note).toBeDefined();
    expect((note as { body?: unknown }).body).toBe("resume from: ship v0.24.0");
    // `basou note` marks its note as a resume hint so orient surfaces it.
    expect((note as { kind?: unknown }).kind).toBe("next_step");
  });

  it("rejects an empty / whitespace-only body even via the programmatic entry", async () => {
    const repo = await setupInitedRepo();
    await expect(doRunNote("   ", {}, { cwd: repo, ...FIXED_CTX })).rejects.toThrow(
      /must not be empty/,
    );
  });

  it("truncates a long body in the ad-hoc label", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    const longBody = "y".repeat(100);
    await doRunNote(longBody, {}, { cwd: repo, ...FIXED_CTX });
    const sid = await findAdHocSessionId(repo);
    // Parse the yaml (a long quoted label is line-folded in the raw text).
    const parsed = (await readYamlFile(join(basouPaths(repo).sessions, sid, "session.yaml"))) as {
      session: { label: string };
    };
    // LABEL_BODY_MAX = 80 -> head 77 chars + "..."
    expect(parsed.session.label).toBe(`Ad-hoc note: ${"y".repeat(77)}...`);
  });

  it("--json emits mode=ad-hoc with the note body", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunNote("next step", { json: true }, { cwd: repo, ...FIXED_CTX });
    const payload = JSON.parse(joinCalls(out)) as Record<string, unknown>;
    expect(payload.mode).toBe("ad-hoc");
    expect(payload.session_status).toBe("completed");
    expect(payload.body).toBe("next step");
    expect(typeof payload.event_id).toBe("string");
    expect(typeof payload.session_id).toBe("string");
  });

  it("collapses a multi-line body into a single-line ad-hoc label", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunNote("line one\n  line two", {}, { cwd: repo, ...FIXED_CTX });
    const sid = await findAdHocSessionId(repo);
    const yaml = await readFile(join(basouPaths(repo).sessions, sid, "session.yaml"), "utf8");
    expect(yaml).toContain("Ad-hoc note: line one line two");
  });
});

describe("doRunNote (--session attach path)", () => {
  it("attaches a note_added to an attachable session", async () => {
    const repo = await setupInitedRepo();
    const id = await createSession(repo, SES("S01"), "running");
    const out = captureStdout();
    await doRunNote("a note", { session: id }, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(out)).toContain(`in session`);
    const events = await readEvents(repo, id);
    const note = events.find((e) => e.type === "note_added");
    expect((note as { body?: unknown }).body).toBe("a note");
  });

  it("refuses to attach to an imported (non-attachable) session", async () => {
    // This is exactly why `basou note` defaults to an ad-hoc session: imported
    // sessions (the operator's main workflow) are status=imported, not attachable.
    const repo = await setupInitedRepo();
    const id = await createSession(repo, SES("S02"), "imported");
    await expect(doRunNote("x", { session: id }, { cwd: repo, ...FIXED_CTX })).rejects.toThrow();
    // No note_added event was written to the imported session.
    const events = await readEvents(repo, id);
    expect(events.some((e) => e.type === "note_added")).toBe(false);
  });
});
