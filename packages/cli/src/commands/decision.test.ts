import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
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
import { doRunDecisionRecord, registerDecisionCommand, runDecisionRecord } from "./decision.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
};

const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const FIXED_DATE = new Date("2026-05-09T03:00:00.000Z");
const FIXED_NOW = new Date("2026-05-11T12:00:00.000Z");

let tmpRepo: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-decision-cli-test-"));
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

const SES = (suffix: string) => `ses_01HXABCDEF1234567890ABC${suffix}`;

async function createSession(
  repo: string,
  fixture: {
    id: string;
    status:
      | "initialized"
      | "running"
      | "waiting_approval"
      | "completed"
      | "failed"
      | "interrupted"
      | "imported"
      | "archived";
    workingDirectory?: string;
  },
): Promise<string> {
  const paths = basouPaths(repo);
  const sessionDir = join(paths.sessions, fixture.id);
  await mkdir(sessionDir, { recursive: true });
  const session = {
    schema_version: "0.1.0" as const,
    session: {
      id: fixture.id,
      label: "test",
      task_id: null,
      workspace_id: FIXED_WS_ID,
      source: { kind: "terminal" as const, version: "0.1.0" as const },
      started_at: "2026-05-08T11:00:00+09:00",
      status: fixture.status,
      working_directory: fixture.workingDirectory ?? repo,
      invocation: { command: "echo", args: [], exit_code: 0 },
      related_files: [],
      events_log: "events.jsonl",
    },
  };
  await writeYamlFile(join(sessionDir, "session.yaml"), session);
  await writeFile(join(sessionDir, "events.jsonl"), "");
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

async function findAdHocSessionId(repo: string): Promise<string> {
  const paths = basouPaths(repo);
  const dirs = await readdir(paths.sessions);
  const newSession = dirs.find((d) => d.startsWith("ses_"));
  if (newSession === undefined) {
    throw new Error("no ad-hoc session directory was created");
  }
  return newSession;
}

const FIXED_CTX = { nowProvider: () => FIXED_NOW };

describe("doRunDecisionRecord (ad-hoc path)", () => {
  it("dec-1: --title only succeeds and writes a 5-event ad-hoc session", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunDecisionRecord({ title: "choose pnpm" }, { cwd: repo, ...FIXED_CTX });
    const stdout = joinCalls(out);
    expect(stdout).toContain("Recorded decision_");
    expect(stdout).toContain("in ad-hoc session");

    const sid = await findAdHocSessionId(repo);
    const events = (await readFile(join(basouPaths(repo).sessions, sid, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0);
    expect(events).toHaveLength(5);
  });

  it("dec-2: --json emits a single-line payload with mode=ad-hoc", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunDecisionRecord({ title: "pnpm", json: true }, { cwd: repo, ...FIXED_CTX });
    const payload = JSON.parse(joinCalls(out)) as Record<string, unknown>;
    expect(payload.mode).toBe("ad-hoc");
    expect(payload.session_status).toBe("completed");
    expect(typeof payload.decision_id).toBe("string");
    expect(typeof payload.event_id).toBe("string");
    expect(typeof payload.session_id).toBe("string");
    expect(payload.title).toBe("pnpm");
    expect("rationale" in payload).toBe(false);
    expect("rationale_saved" in payload).toBe(false);
  });

  it("dec-3: --rationale echoes the value in the text output and is persisted (B-F1 #40)", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunDecisionRecord({ title: "T", rationale: "R" }, { cwd: repo, ...FIXED_CTX });
    const stdout = joinCalls(out);
    expect(stdout).toContain("(rationale: R)");
    // Legacy "not saved in v0.1" wording is gone now that the schema stores it.
    expect(stdout).not.toContain("not saved in v0.1");

    // The rationale MUST now land in the decision_recorded event payload.
    const sid = await findAdHocSessionId(repo);
    const events = (await readFile(join(basouPaths(repo).sessions, sid, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const decision = events.find((e) => e.type === "decision_recorded");
    expect(decision).toBeDefined();
    expect((decision as { rationale?: unknown }).rationale).toBe("R");
  });

  it("dec-4: --rationale --json persists the rationale field on the JSON payload (B-F1 #40)", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunDecisionRecord(
      { title: "T", rationale: "R", json: true },
      { cwd: repo, ...FIXED_CTX },
    );
    const payload = JSON.parse(joinCalls(out)) as Record<string, unknown>;
    expect(payload.rationale).toBe("R");
    // The legacy `rationale_saved: false` indicator is removed now that the
    // value is persisted into events.jsonl.
    expect("rationale_saved" in payload).toBe(false);
  });

  it("dec-5: writes session.yaml status=completed with completed_at and exit_code 0", async () => {
    const repo = await setupInitedRepo();
    await doRunDecisionRecord({ title: "T" }, { cwd: repo, ...FIXED_CTX });
    const sid = await findAdHocSessionId(repo);
    const yaml = await readFile(join(basouPaths(repo).sessions, sid, "session.yaml"), "utf8");
    expect(yaml).toContain("status: completed");
    expect(yaml).toContain("ended_at:");
    expect(yaml).toContain("exit_code: 0");
  });

  it("dec-6: events.jsonl contains the 4 lifecycle + 1 decision events in order", async () => {
    const repo = await setupInitedRepo();
    await doRunDecisionRecord({ title: "order" }, { cwd: repo, ...FIXED_CTX });
    const sid = await findAdHocSessionId(repo);
    const events = (await readFile(join(basouPaths(repo).sessions, sid, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.map((e) => e.type)).toEqual([
      "session_started",
      "session_status_changed",
      "decision_recorded",
      "session_status_changed",
      "session_ended",
    ]);
    expect(events[2]?.title).toBe("order");
  });

  it("dec-7: session-level source.kind is 'human' and event-level source is 'local-cli'", async () => {
    const repo = await setupInitedRepo();
    await doRunDecisionRecord({ title: "src" }, { cwd: repo, ...FIXED_CTX });
    const sid = await findAdHocSessionId(repo);
    const yaml = await readFile(join(basouPaths(repo).sessions, sid, "session.yaml"), "utf8");
    expect(yaml).toContain("kind: human");
    const events = (await readFile(join(basouPaths(repo).sessions, sid, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const event of events) {
      expect(event.source).toBe("local-cli");
    }
  });

  it("dec-8: pathless: stderr error from FailedToFinalizeError does not leak absolute paths", async () => {
    // Direct simulation: throw FailedToFinalizeError out of doRunDecisionRecord
    // by mocking @basou/core's createAdHocSessionWithEvent.
    const repo = await setupInitedRepo();
    const core = await import("@basou/core");
    const spy = vi.spyOn(core, "createAdHocSessionWithEvent");
    spy.mockImplementationOnce(async () => {
      throw new core.FailedToFinalizeError(
        "ses_01HXABCDEF1234567890ABCDE1" as `ses_${string}`,
        "evt_01HXABCDEF1234567890ABCDE1" as `evt_${string}`,
        Object.assign(new Error("Failed to overwrite YAML file"), {
          cause: Object.assign(new Error("simulated"), { code: "EACCES" }),
        }),
      );
    });
    const err = captureStderr();
    await runDecisionRecord({ title: "fail" }, { cwd: repo, ...FIXED_CTX });
    const stderr = joinCalls(err);
    expect(stderr).toContain("Failed to finalize ad-hoc session");
    expect(stderr).toContain("do not rerun");
    expect(stderr).toContain("Warning: session.yaml status update failed");
    expect(stderr).not.toContain(repo);
    expect(process.exitCode).toBe(1);
  });

  it("dec-9: --verbose surfaces 'Caused by: <label>' without leaking cause.message", async () => {
    const repo = await setupInitedRepo();
    const core = await import("@basou/core");
    const spy = vi.spyOn(core, "createAdHocSessionWithEvent");
    spy.mockImplementationOnce(async () => {
      throw new core.FailedToFinalizeError(
        "ses_01HXABCDEF1234567890ABCDE2" as `ses_${string}`,
        "evt_01HXABCDEF1234567890ABCDE2" as `evt_${string}`,
        Object.assign(new Error("Failed to overwrite YAML file"), {
          cause: Object.assign(new Error("absolute path /Users/secret/.basou/sessions/x"), {
            code: "EACCES",
          }),
        }),
      );
    });
    const err = captureStderr();
    await runDecisionRecord({ title: "fail2", verbose: true }, { cwd: repo, ...FIXED_CTX });
    const stderr = joinCalls(err);
    expect(stderr).toContain("Caused by: EACCES");
    expect(stderr).not.toContain("/Users/secret");
  });
});

describe("doRunDecisionRecord (attach path)", () => {
  it("dec-10: --session attaches a decision_recorded event to an existing running session", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("D10");
    await createSession(repo, { id: sid, status: "running" });
    const out = captureStdout();
    await doRunDecisionRecord({ title: "attach", session: sid }, { cwd: repo, ...FIXED_CTX });
    const stdout = joinCalls(out);
    expect(stdout).toContain("Recorded decision_");
    expect(stdout).toContain("(running)");
    const events = (await readFile(join(basouPaths(repo).sessions, sid, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0);
    expect(events).toHaveLength(1);
  });

  it("dec-11: waiting_approval is an attachable status (Y3s-M5 happy path)", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("D11");
    await createSession(repo, { id: sid, status: "waiting_approval" });
    const out = captureStdout();
    await doRunDecisionRecord({ title: "later", session: sid }, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(out)).toContain("(waiting_approval)");
  });

  it("dec-12: session.yaml content stays unchanged when attaching a decision", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("D12");
    await createSession(repo, { id: sid, status: "running" });
    const yamlPath = join(basouPaths(repo).sessions, sid, "session.yaml");
    const before = await readFile(yamlPath, "utf8");
    await doRunDecisionRecord({ title: "no-touch", session: sid }, { cwd: repo, ...FIXED_CTX });
    const after = await readFile(yamlPath, "utf8");
    expect(after).toBe(before);
  });

  it("dec-13: attaching to a completed session is rejected", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("D13");
    await createSession(repo, { id: sid, status: "completed" });
    const err = captureStderr();
    await runDecisionRecord({ title: "no", session: sid }, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(err)).toContain("Session is not active: completed");
    expect(process.exitCode).toBe(1);
  });

  it("dec-14: attaching to an imported session is rejected with the dedicated message", async () => {
    const repo = await setupInitedRepo();
    const sid = SES("D14");
    await createSession(repo, { id: sid, status: "imported" });
    const err = captureStderr();
    await runDecisionRecord({ title: "no", session: sid }, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(err)).toContain("Cannot attach to imported session");
    expect(process.exitCode).toBe(1);
  });

  it("dec-15: --session pointing at a missing prefix is rejected with Session not found", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runDecisionRecord(
      { title: "x", session: "ses_DOES_NOT_EXIST" },
      { cwd: repo, ...FIXED_CTX },
    );
    expect(joinCalls(err)).toContain("Session not found");
    expect(process.exitCode).toBe(1);
  });

  it("dec-16: ambiguous --session prefix is rejected with the dedicated message", async () => {
    const repo = await setupInitedRepo();
    await createSession(repo, { id: SES("D16a"), status: "running" });
    await createSession(repo, { id: SES("D16b"), status: "running" });
    const err = captureStderr();
    await runDecisionRecord(
      { title: "x", session: "ses_01HXABCDEF1234567890ABCD16" },
      { cwd: repo, ...FIXED_CTX },
    );
    expect(joinCalls(err)).toContain("Ambiguous session id");
    expect(process.exitCode).toBe(1);
  });
});

describe("registerDecisionCommand (CLI option converters)", () => {
  it("dec-17: --title missing is rejected by commander", async () => {
    const program = new Command();
    program.exitOverride();
    registerDecisionCommand(program);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(program.parseAsync(["node", "basou", "decision", "record"])).rejects.toBeDefined();
    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderr).toContain("--title");
  });

  it("dec-18: --title '' is rejected by the converter", async () => {
    const program = new Command();
    program.exitOverride();
    registerDecisionCommand(program);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      program.parseAsync(["node", "basou", "decision", "record", "--title", ""]),
    ).rejects.toBeDefined();
    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderr).toContain("Title must not be empty");
  });

  it("dec-19: --rationale '' is rejected by the converter", async () => {
    const program = new Command();
    program.exitOverride();
    registerDecisionCommand(program);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      program.parseAsync([
        "node",
        "basou",
        "decision",
        "record",
        "--title",
        "x",
        "--rationale",
        "",
      ]),
    ).rejects.toBeDefined();
    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderr).toContain("Rationale must not be empty");
  });
});

describe("doRunDecisionRecord (rich fields, Y-3z #40 / B-F1)", () => {
  it("dec-rich-1: --alternative twice produces a 2-entry alternatives array on the event payload", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunDecisionRecord(
      { title: "T", alternative: ["yup", "joi"] },
      { cwd: repo, ...FIXED_CTX },
    );
    const sid = await findAdHocSessionId(repo);
    const events = (await readFile(join(basouPaths(repo).sessions, sid, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const decision = events.find((e) => e.type === "decision_recorded");
    expect((decision as { alternatives?: unknown }).alternatives).toEqual(["yup", "joi"]);
  });

  it("dec-rich-2: --rejected-reason and --linked-event populate the schema fields", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunDecisionRecord(
      {
        title: "T",
        rejectedReason: "yup overkill",
        linkedEvent: ["evt_01HXABCDEF1234567890ABCDR1", "evt_01HXABCDEF1234567890ABCDR2"],
      },
      { cwd: repo, ...FIXED_CTX },
    );
    const sid = await findAdHocSessionId(repo);
    const events = (await readFile(join(basouPaths(repo).sessions, sid, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const decision = events.find((e) => e.type === "decision_recorded") as Record<string, unknown>;
    expect(decision.rejected_reason).toBe("yup overkill");
    expect(decision.linked_events).toEqual([
      "evt_01HXABCDEF1234567890ABCDR1",
      "evt_01HXABCDEF1234567890ABCDR2",
    ]);
  });

  it("dec-rich-3: --linked-file twice persists both paths", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunDecisionRecord(
      { title: "T", linkedFile: ["src/a.ts", "src/b.ts"] },
      { cwd: repo, ...FIXED_CTX },
    );
    const sid = await findAdHocSessionId(repo);
    const events = (await readFile(join(basouPaths(repo).sessions, sid, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const decision = events.find((e) => e.type === "decision_recorded") as Record<string, unknown>;
    expect(decision.linked_files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("dec-rich-4: --linked-event with the wrong prefix is rejected by the converter", async () => {
    const program = new Command();
    program.exitOverride();
    registerDecisionCommand(program);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      program.parseAsync([
        "node",
        "basou",
        "decision",
        "record",
        "--title",
        "x",
        "--linked-event",
        "ses_01HXABCDEF1234567890ABCDEF",
      ]),
    ).rejects.toBeDefined();
    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderr).toContain("Linked event id must match evt_<ULID>");
  });

  it("dec-rich-5: --linked-file '' is rejected by the converter", async () => {
    const program = new Command();
    program.exitOverride();
    registerDecisionCommand(program);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      program.parseAsync([
        "node",
        "basou",
        "decision",
        "record",
        "--title",
        "x",
        "--linked-file",
        "",
      ]),
    ).rejects.toBeDefined();
    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderr).toContain("Linked file path must not be empty");
  });

  it("dec-rich-6: --json --rationale --alternative --rejected-reason exposes all rich fields", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunDecisionRecord(
      {
        title: "T",
        rationale: "fast",
        alternative: ["yup"],
        rejectedReason: "overkill",
        json: true,
      },
      { cwd: repo, ...FIXED_CTX },
    );
    const payload = JSON.parse(joinCalls(out)) as Record<string, unknown>;
    expect(payload.rationale).toBe("fast");
    expect(payload.alternatives).toEqual(["yup"]);
    expect(payload.rejected_reason).toBe("overkill");
  });
});

describe("doRunDecisionRecord (workspace / repo guards)", () => {
  it("dec-20: a non-initialized workspace is reported with the init hint", async () => {
    const repo = await realpath(getTmpRepo());
    const err = captureStderr();
    await runDecisionRecord({ title: "x" }, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(err)).toContain("Workspace not initialized. Run 'basou init' first.");
    expect(process.exitCode).toBe(1);
  });

  it("dec-21: a non-git directory is reported with the git init hint", async () => {
    const nonGit = await mkdtemp(join(tmpdir(), "basou-decision-cli-notgit-"));
    try {
      const err = captureStderr();
      await runDecisionRecord({ title: "x" }, { cwd: nonGit, ...FIXED_CTX });
      expect(joinCalls(err)).toContain(
        "Not a git repository. Run 'git init' first, then re-run 'basou decision record'.",
      );
      expect(process.exitCode).toBe(1);
    } finally {
      await rm(nonGit, { recursive: true, force: true });
    }
  });
});

describe("doRunDecisionRecord (pathless contract)", () => {
  it("dec-22: ad-hoc happy path stderr stays empty (no spurious diagnostics)", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await doRunDecisionRecord({ title: "ok" }, { cwd: repo, ...FIXED_CTX });
    expect(joinCalls(err)).toBe("");
  });
});

describe("doRunDecisionRecord (label cap, Y-3z #63 / B-G1)", () => {
  // The session.yaml `label` field is built by `buildAdHocLabel(title)` =
  // `Ad-hoc decision: ${truncated}` where `truncated` keeps the first 80
  // chars of the title and appends `...` for anything longer. The 3 cases
  // below pin the 80-char cap, the off-by-one boundary at exactly 80 chars,
  // and the truncation marker for 81+ char titles.

  async function readAdHocSessionLabel(repo: string): Promise<string> {
    const sid = await findAdHocSessionId(repo);
    const parsed = (await readYamlFile(join(basouPaths(repo).sessions, sid, "session.yaml"))) as {
      session: { label: string };
    };
    return parsed.session.label;
  }

  it("dec-cap-1: titles up to 80 chars are recorded verbatim (no truncation marker)", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    const eighty = "a".repeat(80);
    await doRunDecisionRecord({ title: eighty }, { cwd: repo, ...FIXED_CTX });
    const label = await readAdHocSessionLabel(repo);
    expect(label).toBe(`Ad-hoc decision: ${eighty}`);
    expect(label.includes("...")).toBe(false);
  });

  it("dec-cap-2: titles of 81+ chars are truncated at 77 chars and gain a `...` marker", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    const tooLong = "a".repeat(100);
    await doRunDecisionRecord({ title: tooLong }, { cwd: repo, ...FIXED_CTX });
    const label = await readAdHocSessionLabel(repo);
    expect(label).toBe(`Ad-hoc decision: ${"a".repeat(77)}...`);
  });

  it("dec-cap-3: short titles (< 80 chars) are unaffected by the cap change", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunDecisionRecord({ title: "short title" }, { cwd: repo, ...FIXED_CTX });
    const label = await readAdHocSessionLabel(repo);
    expect(label).toBe("Ad-hoc decision: short title");
  });
});
