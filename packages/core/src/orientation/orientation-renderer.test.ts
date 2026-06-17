import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import type { TaskStatus } from "../schemas/task.schema.js";
import { type BasouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";
import { renderOrientation, summarizeOrientation } from "./orientation-renderer.js";

const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF";
const FIXED_NOW_ISO = "2026-05-09T03:00:00.000Z";

const SES = (s: string): string => `ses_01HXABCDEF1234567890ABC${s}`;
const EVT = (s: string): string => `evt_01HXABCDEF1234567890ABC${s}`;
const DEC = (s: string): string => `decision_01HXABCDEF1234567890ABC${s}`;
const APPR = (s: string): string => `appr_01HXABCDEF1234567890ABC${s}`;
const TASK = (s: string): string => `task_01HXABCDEF1234567890ABC${s}`;

let workDir: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "basou-orient-test-"));
});

afterEach(async () => {
  if (workDir !== undefined) {
    await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function getWorkDir(): string {
  if (workDir === undefined) throw new Error("workDir not initialized");
  return workDir;
}

async function setupPaths(): Promise<BasouPaths> {
  return ensureBasouDirectory(getWorkDir());
}

async function placeSession(
  paths: BasouPaths,
  fixture: {
    id: string;
    status?: string;
    startedAt?: string;
    source?: string;
    label?: string;
    relatedFiles?: string[];
  },
  events?: string,
): Promise<void> {
  const sessionDir = join(paths.sessions, fixture.id);
  await mkdir(sessionDir, { recursive: true });
  const yaml = stringify({
    schema_version: "0.1.0",
    session: {
      id: fixture.id,
      label: fixture.label ?? `fixture ${fixture.id.slice(-3)}`,
      task_id: null,
      workspace_id: FIXED_WS_ID,
      source: { kind: fixture.source ?? "terminal", version: "0.1.0" },
      started_at: fixture.startedAt ?? "2026-05-08T11:00:00+09:00",
      status: fixture.status ?? "completed",
      working_directory: "/tmp/fixture",
      invocation: { command: "echo", args: [], exit_code: 0 },
      related_files: fixture.relatedFiles ?? [],
      events_log: "events.jsonl",
    },
  });
  await writeFile(join(sessionDir, "session.yaml"), yaml);
  if (events !== undefined) await writeFile(join(sessionDir, "events.jsonl"), events);
}

function startedLine(id: string, evt: string, occurredAt: string): string {
  return `${JSON.stringify({
    schema_version: "0.1.0",
    type: "session_started",
    id: EVT(evt),
    session_id: id,
    occurred_at: occurredAt,
    source: "human",
  })}\n`;
}

function endedLine(id: string, evt: string, occurredAt: string): string {
  return `${JSON.stringify({
    schema_version: "0.1.0",
    type: "session_ended",
    id: EVT(evt),
    session_id: id,
    occurred_at: occurredAt,
    source: "human",
  })}\n`;
}

function decisionLine(
  id: string,
  evt: string,
  decisionId: string,
  title: string,
  occurredAt: string,
): string {
  return `${JSON.stringify({
    schema_version: "0.1.0",
    type: "decision_recorded",
    id: EVT(evt),
    session_id: id,
    occurred_at: occurredAt,
    source: "human",
    decision_id: decisionId,
    title,
  })}\n`;
}

async function placeTaskFile(
  paths: BasouPaths,
  fixture: {
    id: string;
    title: string;
    status: TaskStatus;
    sessionId: string;
    linkedSessions?: ReadonlyArray<string>;
  },
): Promise<void> {
  const yaml = stringify({
    schema_version: "0.1.0",
    task: {
      id: fixture.id,
      title: fixture.title,
      status: fixture.status,
      created_at: "2026-05-08T11:00:00+09:00",
      updated_at: "2026-05-08T11:00:00+09:00",
      workspace_id: FIXED_WS_ID,
      created_in_session: fixture.sessionId,
      linked_sessions: fixture.linkedSessions ?? [fixture.sessionId],
    },
  });
  await writeFile(join(paths.tasks, `${fixture.id}.md`), `---\n${yaml}---\n\n`);
}

async function placePendingApproval(
  paths: BasouPaths,
  fixture: {
    id: string;
    sessionId: string;
    risk?: string;
    kind?: string;
    reason?: string;
    expiresAt?: string | null;
  },
): Promise<void> {
  const yaml = stringify({
    schema_version: "0.1.0",
    id: fixture.id,
    session_id: fixture.sessionId,
    created_at: "2026-05-08T11:00:00+09:00",
    status: "pending",
    risk_level: fixture.risk ?? "high",
    action: { kind: fixture.kind ?? "command", command: "deploy.sh" },
    reason: fixture.reason ?? "deploy to production",
    expires_at: fixture.expiresAt ?? null,
  });
  await writeFile(join(paths.approvals.pending, `${fixture.id}.yaml`), yaml);
}

describe("orientation-renderer", () => {
  it("empty workspace renders all four sections with placeholders", async () => {
    const paths = await setupPaths();
    const result = await renderOrientation({ paths, nowIso: FIXED_NOW_ISO });

    expect(result.sessionCount).toBe(0);
    expect(result.pendingApprovalsCount).toBe(0);
    expect(result.suspectCount).toBe(0);
    expect(result.inFlightTaskCount).toBe(0);
    expect(result.decisionCount).toBe(0);

    expect(result.body).toContain("# Orientation");
    expect(result.body).toContain("## 今どこにいる");
    expect(result.body).toContain("## 何が動く");
    expect(result.body).toContain("## どこへ向かう");
    expect(result.body).toContain("## これは最新か");
    expect(result.body).toContain("- 最終 session: (no live sessions)");
    expect(result.body).toContain("newest captured session: (no sessions captured yet)");
    expect(result.body).toContain("run `basou refresh` to re-import");
  });

  it("renders the pending-approval LIST with risk / action / reason (not just a count)", async () => {
    const paths = await setupPaths();
    await placeSession(paths, { id: SES("S01"), status: "completed" });
    await placePendingApproval(paths, {
      id: APPR("A01"),
      sessionId: SES("S01"),
      risk: "critical",
      kind: "command",
      reason: "drop the production table",
    });

    const result = await renderOrientation({ paths, nowIso: FIXED_NOW_ISO });

    expect(result.pendingApprovalsCount).toBe(1);
    expect(result.body).toContain("### 承認待ち (1)");
    expect(result.body).toContain("[critical] command: drop the production table");
    expect(result.body).toMatch(/session ses_01HXABCDEF/);
  });

  it("renders in-flight task linkage (linked_sessions count) — a cross-session fact", async () => {
    const paths = await setupPaths();
    await placeSession(paths, { id: SES("S01"), status: "completed" });
    await placeTaskFile(paths, {
      id: TASK("T01"),
      title: "ship orientation MVP",
      status: "in_progress",
      sessionId: SES("S01"),
      linkedSessions: [SES("S01"), SES("S02"), SES("S03")],
    });

    const result = await renderOrientation({ paths, nowIso: FIXED_NOW_ISO });

    expect(result.inFlightTaskCount).toBe(1);
    expect(result.body).toContain("### 進行中 task (1)");
    expect(result.body).toContain("ship orientation MVP (in_progress)");
    expect(result.body).toContain("linked_sessions: 3");
  });

  it("flags a suspect session with its reason", async () => {
    const paths = await setupPaths();
    const id = SES("R01");
    // A running session whose event log already contains session_ended →
    // classifySuspect returns events_say_ended_but_yaml_running.
    await placeSession(
      paths,
      { id, status: "running" },
      startedLine(id, "E01", "2026-05-08T11:00:00+09:00") +
        endedLine(id, "E02", "2026-05-08T11:05:00+09:00"),
    );

    const result = await renderOrientation({ paths, nowIso: FIXED_NOW_ISO });

    expect(result.suspectCount).toBe(1);
    expect(result.body).toContain("### 要注意 session (1)");
    expect(result.body).toContain("ended (yaml stale)");
  });

  it("surfaces latest decision, freshness and source breakdown", async () => {
    const paths = await setupPaths();
    const id = SES("S01");
    await placeSession(
      paths,
      {
        id,
        status: "completed",
        source: "claude-code-import",
        startedAt: "2026-05-08T11:00:00+09:00",
      },
      decisionLine(
        id,
        "E01",
        DEC("D01"),
        "adopt orientation re-centering",
        "2026-05-08T12:00:00+09:00",
      ),
    );

    const result = await renderOrientation({ paths, nowIso: FIXED_NOW_ISO });

    expect(result.decisionCount).toBe(1);
    expect(result.body).toContain("直近の判断: adopt orientation re-centering");
    expect(result.body).toContain("newest captured session: 2026-05-08T11:00:00+09:00");
    expect(result.body).toMatch(/newest .* ago/);
    expect(result.body).toContain("claude-code-import 1");
    // No manifest written by ensureBasouDirectory → single-root fallback.
    expect(result.body).toContain("source roots: (single root)");
  });

  it("never emits surveillance metrics (negative-positioning guard)", async () => {
    const paths = await setupPaths();
    await placeSession(paths, { id: SES("S01"), status: "completed" });
    const result = await renderOrientation({ paths, nowIso: FIXED_NOW_ISO });
    const lower = result.body.toLowerCase();
    expect(lower).not.toContain("scorecard");
    expect(lower).not.toContain("productivity");
    expect(lower).not.toContain("utilization");
  });

  // Output-invariance lock: renderOrientation must keep emitting byte-identical
  // markdown after the summarizeOrientation extraction. The empty workspace is
  // fully deterministic given FIXED_NOW_ISO (no sessions / decisions / dates).
  it("empty workspace body is byte-stable (regression lock for the summary extraction)", async () => {
    const paths = await setupPaths();
    const result = await renderOrientation({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.body).toBe(
      [
        "# Orientation",
        "",
        "> Generated at 2026-05-09T03:00:00.000Z · sessions 0 · newest (unknown) · pending 0 · suspect 0",
        "",
        "## 今どこにいる",
        "",
        "- 最終 session: (no live sessions)",
        "- 直近の判断: (no decisions recorded yet)",
        "- 直近の変更ファイル: (none recorded)",
        "",
        "## 何が動く",
        "",
        "### 進行中 task (0)",
        "- (none)",
        "",
        "### 承認待ち (0)",
        "- (none)",
        "",
        "### 要注意 session (0)",
        "- (none)",
        "",
        "## どこへ向かう",
        "",
        "- (no planned tasks — direction is inferred from recent decisions)",
        "",
        "## これは最新か",
        "",
        "- newest captured session: (no sessions captured yet)",
        "- sessions: 0",
        "- source roots: (single root)",
        "- suspect sessions: 0",
        "- reflects already-captured state; run `basou refresh` to re-import.",
      ].join("\n"),
    );
  });

  // Output-invariance lock for the populated branches the empty case can't reach:
  // multi-source breakdown ordering, related-file overflow, linked_sessions > 1,
  // an expired approval, a planned task surfaced in both sections, and the
  // `> 1 decisions total` line. The latest session is pinned to `nowIso` so its
  // relative age is the deterministic "just now" (avoids formatDurationMs drift).
  it("populated workspace body is byte-stable (regression lock for the summary extraction)", async () => {
    const paths = await setupPaths();
    const live = SES("S01");
    await placeSession(
      paths,
      {
        id: live,
        status: "completed",
        source: "claude-code-import",
        startedAt: FIXED_NOW_ISO,
        relatedFiles: ["src/d.ts", "src/c.ts", "src/b.ts", "src/a.ts"],
      },
      decisionLine(live, "E01", DEC("D01"), "earlier decision", "2026-05-08T12:00:00+09:00") +
        decisionLine(live, "E02", DEC("D02"), "wire portfolio API", "2026-05-08T13:00:00+09:00"),
    );
    await placeSession(paths, {
      id: SES("S02"),
      status: "completed",
      source: "codex-import",
      startedAt: "2026-05-08T10:00:00+09:00",
    });
    await placeTaskFile(paths, {
      id: TASK("T01"),
      title: "ship portfolio MVP",
      status: "planned",
      sessionId: live,
      linkedSessions: [live, SES("X02"), SES("X03")],
    });
    await placePendingApproval(paths, {
      id: APPR("A01"),
      sessionId: live,
      risk: "high",
      kind: "command",
      reason: "deploy to production",
      expiresAt: "2026-05-08T00:00:00.000Z",
    });

    const result = await renderOrientation({ paths, nowIso: FIXED_NOW_ISO, relatedFilesLimit: 2 });

    expect(result.body).toBe(
      [
        "# Orientation",
        "",
        "> Generated at 2026-05-09T03:00:00.000Z · sessions 2 · newest just now · pending 1 · suspect 0",
        "",
        "## 今どこにいる",
        "",
        "- 最終 session: fixture S01 (completed) [ses_01HXABCDEF]",
        "- 直近の判断: wire portfolio API [decision_01HXABCDEF]",
        "  - 2 decisions total — see decisions.md",
        "- 直近の変更ファイル: src/a.ts, src/b.ts (... +2 more)",
        "",
        "## 何が動く",
        "",
        "### 進行中 task (1)",
        "- ship portfolio MVP (planned) [task_01HXABCDEF] — linked_sessions: 3",
        "",
        "### 承認待ち (1)",
        "- [high] command: deploy to production — session ses_01HXABCDEF, since 2026-05-08T11:00:00+09:00 (expired)",
        "",
        "### 要注意 session (0)",
        "- (none)",
        "",
        "## どこへ向かう",
        "",
        "- ship portfolio MVP [task_01HXABCDEF]",
        "",
        "## これは最新か",
        "",
        "- newest captured session: 2026-05-09T03:00:00.000Z (just now)",
        "- sessions: 2 (claude-code-import 1, codex-import 1)",
        "- source roots: (single root)",
        "- suspect sessions: 0",
        "- reflects already-captured state; run `basou refresh` to re-import.",
      ].join("\n"),
    );
  });
});

describe("summarizeOrientation", () => {
  it("empty workspace yields a zeroed, fully serializable summary", async () => {
    const paths = await setupPaths();
    const summary = await summarizeOrientation({ paths, nowIso: FIXED_NOW_ISO });

    expect(summary.generatedAt).toBe(FIXED_NOW_ISO);
    expect(summary.sessionCount).toBe(0);
    expect(summary.latestSession).toBeNull();
    expect(summary.latestDecision).toBeNull();
    expect(summary.decisionCount).toBe(0);
    expect(summary.relatedFiles).toEqual({ displayed: [], overflow: 0 });
    expect(summary.inFlightTasks).toEqual([]);
    expect(summary.plannedTasks).toEqual([]);
    expect(summary.pendingApprovals).toEqual([]);
    expect(summary.suspects).toEqual([]);
    expect(summary.freshness).toEqual({ newestStartedAt: null, bySource: [], sourceRoots: null });
    // Round-trips through JSON unchanged (no Maps / Dates / class instances).
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  it("surfaces the pending-approval list, in-flight linkage, suspect, decision and freshness as structured fields", async () => {
    const paths = await setupPaths();
    const live = SES("S01");
    await placeSession(
      paths,
      {
        id: live,
        status: "completed",
        source: "claude-code-import",
        startedAt: "2026-05-08T11:00:00+09:00",
        relatedFiles: ["src/a.ts", "src/b.ts"],
      },
      decisionLine(
        live,
        "E01",
        DEC("D01"),
        "adopt orientation re-centering",
        "2026-05-08T12:00:00+09:00",
      ),
    );
    await placeTaskFile(paths, {
      id: TASK("T01"),
      title: "ship portfolio MVP",
      status: "in_progress",
      sessionId: live,
      linkedSessions: [live, SES("S02"), SES("S03")],
    });
    await placePendingApproval(paths, {
      id: APPR("A01"),
      sessionId: live,
      risk: "critical",
      kind: "command",
      reason: "drop the production table",
    });

    const summary = await summarizeOrientation({ paths, nowIso: FIXED_NOW_ISO });

    expect(summary.latestSession).toEqual({
      sessionId: live,
      label: `fixture ${live.slice(-3)}`,
      status: "completed",
    });
    expect(summary.latestDecision).toEqual({
      decisionId: DEC("D01"),
      title: "adopt orientation re-centering",
      occurredAt: "2026-05-08T12:00:00+09:00",
    });
    expect(summary.decisionCount).toBe(1);
    expect(summary.relatedFiles).toEqual({ displayed: ["src/a.ts", "src/b.ts"], overflow: 0 });
    expect(summary.inFlightTasks).toEqual([
      { id: TASK("T01"), title: "ship portfolio MVP", status: "in_progress", linkedSessions: 3 },
    ]);
    expect(summary.pendingApprovals).toEqual([
      {
        id: APPR("A01"),
        risk: "critical",
        kind: "command",
        reason: "drop the production table",
        sessionId: live,
        createdAt: "2026-05-08T11:00:00+09:00",
        expired: false,
      },
    ]);
    expect(summary.freshness.newestStartedAt).toBe("2026-05-08T11:00:00+09:00");
    expect(summary.freshness.bySource).toEqual([{ kind: "claude-code-import", count: 1 }]);
  });

  it("carries no work-stats / surveillance fields (positioning guard)", async () => {
    const paths = await setupPaths();
    await placeSession(paths, { id: SES("S01"), status: "completed" });
    const summary = await summarizeOrientation({ paths, nowIso: FIXED_NOW_ISO });
    const serialized = JSON.stringify(summary).toLowerCase();
    for (const banned of [
      "token",
      "volume",
      "active_time",
      "activetime",
      "utilization",
      "productivity",
      "scorecard",
      "billable",
    ]) {
      expect(serialized).not.toContain(banned);
    }
  });
});
