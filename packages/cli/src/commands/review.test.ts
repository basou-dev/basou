import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { basouPaths, createManifest, ensureBasouDirectory, writeManifest } from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doRunReviewRecord } from "./review.js";

const execFileAsync = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
};

const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const FIXED_DATE = new Date("2026-06-29T03:00:00.000Z");
const FIXED_NOW = new Date("2026-06-30T12:00:00.000Z");

let tmpRepo: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-review-cli-test-"));
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

function captureStdout() {
  return vi.spyOn(console, "log").mockImplementation(() => undefined);
}

function joinCalls(spy: ReturnType<typeof captureStdout>): string {
  return spy.mock.calls.map((c) => String(c[0])).join("\n");
}

async function findAdHocSessionId(repo: string): Promise<string> {
  const dirs = (await readdir(basouPaths(repo).sessions)).filter((d) => d.startsWith("ses_"));
  if (dirs.length === 0) throw new Error("no ad-hoc session directory was created");
  return dirs[0] as string;
}

async function readAdHocEvents(repo: string): Promise<Record<string, unknown>[]> {
  const sid = await findAdHocSessionId(repo);
  return (await readFile(join(basouPaths(repo).sessions, sid, "events.jsonl"), "utf8"))
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const ctx = (repo: string, input: string) => ({
  cwd: repo,
  nowProvider: () => FIXED_NOW,
  readInput: async () => input,
});

describe("doRunReviewRecord (ad-hoc path)", () => {
  it("rev-1: a minimum record lands in ONE ad-hoc session (4 lifecycle + 1 review)", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunReviewRecord({}, ctx(repo, '{ "reviewer": "codex", "target": "working-tree" }'));

    const events = await readAdHocEvents(repo);
    expect(events.map((e) => e.type)).toEqual([
      "session_started",
      "session_status_changed",
      "review_recorded",
      "session_status_changed",
      "session_ended",
    ]);
    const review = events.find((e) => e.type === "review_recorded") as Record<string, unknown>;
    expect(review.reviewer).toBe("codex");
    expect(review.target).toBe("working-tree");
    expect(review.source).toBe("local-cli");
    const dirs = (await readdir(basouPaths(repo).sessions)).filter((d) => d.startsWith("ses_"));
    expect(dirs).toHaveLength(1);
  });

  it("rev-2: rich fields are persisted onto the review event", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    const input = JSON.stringify({
      reviewer: "codex",
      target: "PR #145",
      verdict: "needs-attention",
      findings: [{ title: "off-by-one", severity: "medium", location: "src/p.ts:42" }],
      blocked: [{ title: "drop singleton", reason: "design-reversal", why: "settled" }],
    });
    await doRunReviewRecord({}, ctx(repo, input));
    const review = (await readAdHocEvents(repo)).find(
      (e) => e.type === "review_recorded",
    ) as Record<string, unknown>;
    expect(review.verdict).toBe("needs-attention");
    expect(review.findings).toEqual([
      { title: "off-by-one", severity: "medium", location: "src/p.ts:42" },
    ]);
    expect(review.blocked).toEqual([
      { title: "drop singleton", reason: "design-reversal", why: "settled" },
    ]);
  });

  it("rev-3: an explicit empty blocked array round-trips (reviewed, blocked nothing)", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await doRunReviewRecord(
      {},
      ctx(repo, '{ "reviewer": "codex", "target": "wt", "blocked": [] }'),
    );
    const review = (await readAdHocEvents(repo)).find(
      (e) => e.type === "review_recorded",
    ) as Record<string, unknown>;
    expect(review.blocked).toEqual([]);
  });

  it("rev-4: text output names reviewer, target, and the ad-hoc session", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunReviewRecord(
      {},
      ctx(repo, '{ "reviewer": "codex", "target": "working-tree", "verdict": "pass" }'),
    );
    const stdout = joinCalls(out);
    expect(stdout).toContain("Recorded review by codex of working-tree");
    expect(stdout).toContain("verdict: pass");
    expect(stdout).toContain("in ad-hoc session");
  });

  it("rev-5: --json emits mode, session, event id, and the review payload", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunReviewRecord(
      { json: true },
      ctx(repo, '{ "reviewer": "self", "target": "wt", "findings": [{ "title": "x" }] }'),
    );
    const payload = JSON.parse(joinCalls(out)) as Record<string, unknown>;
    expect(payload.mode).toBe("ad-hoc");
    expect(payload.session_status).toBe("completed");
    expect(String(payload.event_id)).toMatch(/^evt_/);
    expect(payload.review).toEqual({
      reviewer: "self",
      target: "wt",
      findings: [{ title: "x" }],
    });
  });

  it("rev-6: --dry-run validates and previews without writing", async () => {
    const repo = await setupInitedRepo();
    const out = captureStdout();
    await doRunReviewRecord(
      { dryRun: true },
      ctx(repo, '{ "reviewer": "codex", "target": "wt", "blocked": [] }'),
    );
    const stdout = joinCalls(out);
    expect(stdout).toContain("Would record review by codex of wt");
    expect(stdout).toContain("dry run; nothing written");
    const dirs = (await readdir(basouPaths(repo).sessions)).filter((d) => d.startsWith("ses_"));
    expect(dirs).toHaveLength(0);
  });
});

describe("doRunReviewRecord (validation errors surface to the agent)", () => {
  it("rev-err-1: a missing reviewer rejects without writing a session", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await expect(doRunReviewRecord({}, ctx(repo, '{ "target": "wt" }'))).rejects.toThrow(
      /reviewer must be/,
    );
    const dirs = (await readdir(basouPaths(repo).sessions)).filter((d) => d.startsWith("ses_"));
    expect(dirs).toHaveLength(0);
  });

  it("rev-err-2: an array input is rejected (one invocation = one review)", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await expect(
      doRunReviewRecord({}, ctx(repo, '[{ "reviewer": "codex", "target": "wt" }]')),
    ).rejects.toThrow(/single JSON object/);
  });

  it("rev-err-3: an unknown blocked reason rejects", async () => {
    const repo = await setupInitedRepo();
    captureStdout();
    await expect(
      doRunReviewRecord(
        {},
        ctx(
          repo,
          '{ "reviewer": "c", "target": "wt", "blocked": [{ "title": "x", "reason": "nit" }] }',
        ),
      ),
    ).rejects.toThrow(/blocked\[0\]\.reason must be one of/);
  });
});

describe("doRunReviewRecord (workspace guard)", () => {
  it("rev-ws-1: an uninitialized workspace fails with an actionable hint", async () => {
    const repo = await realpath(getTmpRepo()); // git repo but no `basou init`
    captureStdout();
    await expect(
      doRunReviewRecord({}, ctx(repo, '{ "reviewer": "codex", "target": "wt" }')),
    ).rejects.toThrow(/Workspace not initialized/);
  });
});
