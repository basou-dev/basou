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
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  doRunDecisionCapture,
  doRunDecisionRecord,
  registerDecisionCommand,
  runDecisionCapture,
  runDecisionRecord,
} from "./decision.js";

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

  it("dec-3: --rationale echoes the value in the text output and is persisted", async () => {
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

  it("dec-4: --rationale --json persists the rationale field on the JSON payload", async () => {
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
        ["evt_01HXABCDEF1234567890ABCDE1" as `evt_${string}`],
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
        ["evt_01HXABCDEF1234567890ABCDE2" as `evt_${string}`],
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

  it("dec-11: waiting_approval is an attachable status (happy path)", async () => {
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

  it("dec-18b: a whitespace-only --title is rejected by the converter", async () => {
    const program = new Command();
    program.exitOverride();
    registerDecisionCommand(program);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      program.parseAsync(["node", "basou", "decision", "record", "--title", "   "]),
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

describe("doRunDecisionRecord (rich fields)", () => {
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

  it("dec-rich-4b: --linked-event with a malformed (too short) evt id is rejected by the converter", async () => {
    // The converter now validates the full ULID shape, not a bare regex, so a
    // value like `evt_X` is rejected up front rather than at write time.
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
        "evt_X",
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

describe("doRunDecisionRecord (label cap)", () => {
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

describe("doRunDecisionCapture (batch ad-hoc capture)", () => {
  async function readAdHocEvents(repo: string): Promise<Record<string, unknown>[]> {
    const sid = await findAdHocSessionId(repo);
    return (await readFile(join(basouPaths(repo).sessions, sid, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  const captureCtx = (repo: string, input: string) => ({
    cwd: repo,
    nowProvider: () => FIXED_NOW,
    readInput: async () => input,
  });

  it("cap-1: a 2-decision batch lands in ONE ad-hoc session (4 lifecycle + 2 decisions)", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    const input = JSON.stringify([{ title: "first" }, { title: "second" }]);
    await doRunDecisionCapture({}, captureCtx(repo, input));

    const events = await readAdHocEvents(repo);
    expect(events.map((e) => e.type)).toEqual([
      "session_started",
      "session_status_changed",
      "decision_recorded",
      "decision_recorded",
      "session_status_changed",
      "session_ended",
    ]);
    const titles = events.filter((e) => e.type === "decision_recorded").map((e) => e.title);
    expect(titles).toEqual(["first", "second"]);
    // exactly one ad-hoc session directory exists
    const dirs = (await readdir(basouPaths(repo).sessions)).filter((d) => d.startsWith("ses_"));
    expect(dirs).toHaveLength(1);
  });

  it("cap-2: text output lists each decision id + title and the ad-hoc session", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunDecisionCapture({}, captureCtx(repo, JSON.stringify([{ title: "ship it" }])));
    const stdout = joinCalls(out);
    expect(stdout).toContain("Captured 1 decision in ad-hoc session");
    expect(stdout).toMatch(/- decision_[0-9A-Z]+: ship it/);
  });

  it("cap-3: rich fields on every item are persisted into the decision events", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    const input = JSON.stringify([
      {
        title: "adopt pnpm",
        rationale: "workspace protocol",
        alternatives: ["npm", "yarn"],
        rejected_reason: "hoisting bugs",
        linked_events: ["evt_01HXABCDEF1234567890ABCDC1"],
        linked_files: ["pnpm-workspace.yaml"],
      },
    ]);
    await doRunDecisionCapture({}, captureCtx(repo, input));
    const decision = (await readAdHocEvents(repo)).find(
      (e) => e.type === "decision_recorded",
    ) as Record<string, unknown>;
    expect(decision.title).toBe("adopt pnpm");
    expect(decision.rationale).toBe("workspace protocol");
    expect(decision.alternatives).toEqual(["npm", "yarn"]);
    expect(decision.rejected_reason).toBe("hoisting bugs");
    expect(decision.linked_events).toEqual(["evt_01HXABCDEF1234567890ABCDC1"]);
    expect(decision.linked_files).toEqual(["pnpm-workspace.yaml"]);
  });

  it("cap-4: --json emits mode=ad-hoc, count, and a decisions array with ids + fields", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    const input = JSON.stringify([
      { title: "a", rationale: "ra" },
      { title: "b", alternatives: ["x"] },
    ]);
    await doRunDecisionCapture({ json: true }, captureCtx(repo, input));
    const payload = JSON.parse(joinCalls(out)) as Record<string, unknown>;
    expect(payload.mode).toBe("ad-hoc");
    expect(payload.session_status).toBe("completed");
    expect(payload.count).toBe(2);
    const decisions = payload.decisions as Record<string, unknown>[];
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.title).toBe("a");
    expect(decisions[0]?.rationale).toBe("ra");
    expect(typeof decisions[0]?.decision_id).toBe("string");
    expect(typeof decisions[0]?.event_id).toBe("string");
    expect(decisions[1]?.alternatives).toEqual(["x"]);
  });

  it("cap-5: --file reads the JSON array from disk instead of stdin", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    const file = join(repo, "decisions.json");
    await writeFile(file, JSON.stringify([{ title: "from-file" }]), "utf8");
    await doRunDecisionCapture(
      { file },
      // no readInput: prove --file is the source
      { cwd: repo, nowProvider: () => FIXED_NOW },
    );
    const titles = (await readAdHocEvents(repo))
      .filter((e) => e.type === "decision_recorded")
      .map((e) => e.title);
    expect(titles).toEqual(["from-file"]);
  });

  it("cap-6: --dry-run writes nothing and previews the decisions", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    const input = JSON.stringify([{ title: "preview-me" }, { title: "and-me" }]);
    await doRunDecisionCapture({ dryRun: true }, captureCtx(repo, input));
    const stdout = joinCalls(out);
    expect(stdout).toContain("Would capture 2 decisions (dry run; nothing written):");
    expect(stdout).toContain("- preview-me");
    expect(stdout).toContain("- and-me");
    const dirs = (await readdir(basouPaths(repo).sessions)).filter((d) => d.startsWith("ses_"));
    expect(dirs).toHaveLength(0);
  });

  it("cap-7: --dry-run --json emits dry_run:true with the parsed decisions and no ids", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    const input = JSON.stringify([{ title: "x", rationale: "y" }]);
    await doRunDecisionCapture({ dryRun: true, json: true }, captureCtx(repo, input));
    const payload = JSON.parse(joinCalls(out)) as Record<string, unknown>;
    expect(payload.dry_run).toBe(true);
    expect(payload.count).toBe(1);
    const decisions = payload.decisions as Record<string, unknown>[];
    expect(decisions[0]?.title).toBe("x");
    expect("decision_id" in (decisions[0] ?? {})).toBe(false);
  });

  it("cap-8: the ad-hoc label states the decision count", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunDecisionCapture(
      {},
      captureCtx(repo, JSON.stringify([{ title: "a" }, { title: "b" }, { title: "c" }])),
    );
    const parsed = (await readYamlFile(
      join(basouPaths(repo).sessions, await findAdHocSessionId(repo), "session.yaml"),
    )) as { session: { label: string } };
    expect(parsed.session.label).toBe("Ad-hoc capture: 3 decisions");
  });

  it("cap-9: input order is preserved (decision ids increase with input order)", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunDecisionCapture(
      {},
      captureCtx(repo, JSON.stringify([{ title: "earliest" }, { title: "latest" }])),
    );
    const decisions = (await readAdHocEvents(repo)).filter((e) => e.type === "decision_recorded");
    const [a, b] = decisions as Record<string, unknown>[];
    expect(a?.title).toBe("earliest");
    expect(b?.title).toBe("latest");
    // same capture instant, monotonic ids => last input sorts last (= latest)
    expect(a?.occurred_at).toBe(b?.occurred_at);
    expect(String(a?.decision_id) < String(b?.decision_id)).toBe(true);
  });

  it("cap-10: the --file path is sanitized (repo-relative) in session.yaml, not leaked absolute", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    const sub = join(repo, "notes");
    await mkdir(sub, { recursive: true });
    const file = join(sub, "decisions.json");
    await writeFile(file, JSON.stringify([{ title: "from-file" }]), "utf8");
    await doRunDecisionCapture({ file }, { cwd: repo, nowProvider: () => FIXED_NOW });
    const yaml = await readFile(
      join(basouPaths(repo).sessions, await findAdHocSessionId(repo), "session.yaml"),
      "utf8",
    );
    // recorded in repo-relative form...
    expect(yaml).toContain("notes/decisions.json");
    // ...and the operator's absolute path never lands in persisted state.
    expect(yaml).not.toContain(file);
  });
});

describe("doRunDecisionCapture (input validation, agent-facing errors)", () => {
  const errCtx = (repo: string, input: string) => ({
    cwd: repo,
    nowProvider: () => FIXED_NOW,
    readInput: async () => input,
  });

  it("cap-err-1: an empty array is rejected", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runDecisionCapture({}, errCtx(repo, "[]"));
    expect(joinCalls(err)).toContain("Input array must contain at least one decision.");
    expect(process.exitCode).toBe(1);
  });

  it("cap-err-2: malformed JSON is rejected with a JSON hint", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runDecisionCapture({}, errCtx(repo, "[{ not json"));
    expect(joinCalls(err)).toContain("Input is not valid JSON:");
    expect(process.exitCode).toBe(1);
  });

  it("cap-err-3: whitespace-only input is rejected with the no-input hint", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runDecisionCapture({}, errCtx(repo, "   \n  "));
    expect(joinCalls(err)).toContain("No input: pipe a JSON array of decisions to stdin");
    expect(process.exitCode).toBe(1);
  });

  it("cap-err-4: a non-array (object) input is rejected", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runDecisionCapture({}, errCtx(repo, JSON.stringify({ title: "x" })));
    expect(joinCalls(err)).toContain("Input must be a JSON array of decision objects.");
    expect(process.exitCode).toBe(1);
  });

  it("cap-err-5: an empty title names the offending index", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runDecisionCapture({}, errCtx(repo, JSON.stringify([{ title: "ok" }, { title: "" }])));
    expect(joinCalls(err)).toContain("decision[1].title must be a non-empty string.");
    expect(process.exitCode).toBe(1);
  });

  it("cap-err-6: an unknown field is rejected (strict) and named", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runDecisionCapture({}, errCtx(repo, JSON.stringify([{ title: "x", rationals: "typo" }])));
    expect(joinCalls(err)).toContain("decision[0]: unknown field 'rationals'.");
    expect(process.exitCode).toBe(1);
  });

  it("cap-err-7: a bad linked_events id names the index path", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runDecisionCapture(
      {},
      errCtx(
        repo,
        JSON.stringify([
          { title: "x", linked_events: ["evt_01HXABCDEF1234567890ABCDC1", "ses_wrong"] },
        ]),
      ),
    );
    expect(joinCalls(err)).toContain("decision[0].linked_events[1] must match evt_<ULID>");
    expect(process.exitCode).toBe(1);
  });

  it("cap-err-8: alternatives that is not an array is rejected", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runDecisionCapture(
      {},
      errCtx(repo, JSON.stringify([{ title: "x", alternatives: "not-an-array" }])),
    );
    expect(joinCalls(err)).toContain("decision[0].alternatives must be an array of strings.");
    expect(process.exitCode).toBe(1);
  });

  it("cap-err-9: --file that does not exist is rejected without hanging", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runDecisionCapture(
      { file: join(repo, "missing.json") },
      { cwd: repo, nowProvider: () => FIXED_NOW },
    );
    expect(joinCalls(err)).toContain("Input file not found:");
    expect(process.exitCode).toBe(1);
  });

  it("cap-err-10: a non-initialized workspace is reported with the init hint", async () => {
    const repo = await realpath(getTmpRepo());
    const err = captureStderr();
    await runDecisionCapture({}, errCtx(repo, JSON.stringify([{ title: "x" }])));
    expect(joinCalls(err)).toContain("Workspace not initialized. Run 'basou init' first.");
    expect(process.exitCode).toBe(1);
  });

  it("cap-err-11: a malformed evt id (too short) is rejected up front, not at write time", async () => {
    // `evt_X` passes a bare `evt_[A-Z0-9]+` regex but fails EventIdSchema, so a
    // loose validator would let it through here only for the chained-append
    // EventSchema.parse to reject it later with a generic error. The canonical
    // check rejects it now with an index-named message.
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runDecisionCapture(
      {},
      errCtx(repo, JSON.stringify([{ title: "x", linked_events: ["evt_X"] }])),
    );
    expect(joinCalls(err)).toContain("decision[0].linked_events[0] must match evt_<ULID>");
    expect(process.exitCode).toBe(1);
  });

  it("cap-err-12: --dry-run rejects a malformed evt id (no false-clear preview)", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runDecisionCapture(
      { dryRun: true },
      errCtx(repo, JSON.stringify([{ title: "x", linked_events: ["evt_X"] }])),
    );
    expect(joinCalls(err)).toContain("decision[0].linked_events[0] must match evt_<ULID>");
    expect(process.exitCode).toBe(1);
  });

  it("cap-err-13: a whitespace-only title is rejected (not persisted as a blank entry)", async () => {
    const repo = await setupInitedRepo();
    const err = captureStderr();
    await runDecisionCapture({}, errCtx(repo, JSON.stringify([{ title: "   " }])));
    expect(joinCalls(err)).toContain("decision[0].title must be a non-empty string.");
    expect(process.exitCode).toBe(1);
    const dirs = (await readdir(basouPaths(repo).sessions)).filter((d) => d.startsWith("ses_"));
    expect(dirs).toHaveLength(0);
  });
});

describe("decision cross-project linked_files guardrail (warn-only)", () => {
  async function repoWithSourceRoots(): Promise<string> {
    const repo = await realpath(getTmpRepo());
    const paths = await ensureBasouDirectory(repo);
    await writeManifest(
      paths,
      createManifest({
        workspaceName: "fixture-ws",
        now: FIXED_DATE,
        workspaceId: FIXED_WS_ID,
        sourceRoots: ["."],
      }),
    );
    return repo;
  }

  it("warns when a captured decision links a file outside source_roots", async () => {
    const repo = await repoWithSourceRoots();
    captureStdout();
    const err = captureStderr();
    const input = JSON.stringify([{ title: "blog runbook", linked_files: ["/etc/hosts"] }]);
    await doRunDecisionCapture(
      {},
      { cwd: repo, nowProvider: () => FIXED_NOW, readInput: async () => input },
    );
    const warnings = joinCalls(err);
    expect(warnings).toContain("outside this project's source_roots");
    expect(warnings).toContain("/etc/hosts");
  });

  it("does not warn for an in-repo linked file", async () => {
    const repo = await repoWithSourceRoots();
    captureStdout();
    const err = captureStderr();
    const input = JSON.stringify([{ title: "ok", linked_files: ["src/a.ts"] }]);
    await doRunDecisionCapture(
      {},
      { cwd: repo, nowProvider: () => FIXED_NOW, readInput: async () => input },
    );
    expect(joinCalls(err)).not.toContain("outside this project's source_roots");
  });

  it("does not warn for a solo project (no declared source_roots)", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    const err = captureStderr();
    const input = JSON.stringify([{ title: "x", linked_files: ["/etc/hosts"] }]);
    await doRunDecisionCapture(
      {},
      { cwd: repo, nowProvider: () => FIXED_NOW, readInput: async () => input },
    );
    expect(joinCalls(err)).not.toContain("outside this project's source_roots");
  });

  it("warns on `decision record --linked-file` outside source_roots", async () => {
    const repo = await repoWithSourceRoots();
    captureStdout();
    const err = captureStderr();
    await doRunDecisionRecord(
      { title: "blog", linkedFile: ["/etc/hosts"] },
      { cwd: repo, ...FIXED_CTX },
    );
    expect(joinCalls(err)).toContain("outside this project's source_roots");
  });

  it("never blocks a `--session` write even if the manifest is unreadable", async () => {
    // The guardrail reads the manifest, but a missing / corrupt manifest must
    // degrade to silent rather than throw on a path that never needed it.
    const repo = await repoWithSourceRoots();
    const sid = SES("DCB");
    await createSession(repo, { id: sid, status: "running" });
    await rm(basouPaths(repo).files.manifest, { force: true });
    const out = captureStdout();
    captureStderr();
    await doRunDecisionRecord(
      { title: "attach", session: sid, linkedFile: ["/etc/hosts"] },
      { cwd: repo, ...FIXED_CTX },
    );
    expect(joinCalls(out)).toContain("Recorded decision_");
    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
    const events = (await readFile(join(basouPaths(repo).sessions, sid, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0);
    expect(events).toHaveLength(1);
  });
});
