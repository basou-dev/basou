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
    endedAt?: string;
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
      ...(fixture.endedAt !== undefined ? { ended_at: fixture.endedAt } : {}),
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

function noteLine(
  id: string,
  evt: string,
  body: string,
  occurredAt: string,
  kind?: "note" | "next_step",
): string {
  return `${JSON.stringify({
    schema_version: "0.1.0",
    type: "note_added",
    id: EVT(evt),
    session_id: id,
    occurred_at: occurredAt,
    // `basou note` / `basou session note` both write source: local-cli.
    source: "local-cli",
    body,
    ...(kind !== undefined ? { kind } : {}),
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
    // Plain verdict (no sessions yet) replaces the raw telemetry in the default view.
    expect(result.body).toContain("まだ記録がありません。");
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

    // Raw freshness telemetry (ISO, per-source counts, source roots) now lives
    // under --verbose; render verbose to assert it is still emitted.
    const result = await renderOrientation({ paths, nowIso: FIXED_NOW_ISO, verbose: true });

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

  it("これは最新か: a zero-staleness probe renders the ✅ current verdict with a translated tool name", async () => {
    const paths = await setupPaths();
    await placeSession(paths, {
      id: SES("S01"),
      status: "completed",
      source: "codex-import",
      startedAt: FIXED_NOW_ISO,
    });
    const result = await renderOrientation({
      paths,
      nowIso: FIXED_NOW_ISO,
      staleness: { newSessions: 0, updatedSessions: 0 },
    });
    expect(result.body).toContain(
      "✅ 取り込みは最新です。最後の作業は たった今(Codex)。未取り込みの native セッションはありません。",
    );
    // The verdict scopes its claim: it must NOT imply provenance is comprehensive,
    // and it explicitly states what it does not detect (drift / unrecorded decisions).
    expect(result.body).not.toContain("取りこぼし・要注意なし");
    expect(result.body).toContain("計画↔実装のドリフトや未記録の意思決定までは検知しません");
    // The default verdict translates the tool and hides the internal source enum.
    expect(result.body).not.toContain("codex-import");
  });

  it("これは最新か: a non-zero staleness probe renders the ⚠️ stale verdict pointing at refresh", async () => {
    const paths = await setupPaths();
    await placeSession(paths, {
      id: SES("S01"),
      status: "completed",
      source: "claude-code-import",
      startedAt: "2026-05-08T11:00:00+09:00",
    });
    const result = await renderOrientation({
      paths,
      nowIso: FIXED_NOW_ISO,
      staleness: { newSessions: 2, updatedSessions: 1 },
    });
    expect(result.body).toContain("⚠️ 古いかもしれません。");
    expect(result.body).toContain("新規 2 件");
    expect(result.body).toContain("更新 1 件");
    expect(result.body).toContain("`basou refresh`");
  });

  it("これは最新か: an unrun probe (null) says it cannot confirm rather than claiming current", async () => {
    const paths = await setupPaths();
    await placeSession(paths, {
      id: SES("S01"),
      status: "completed",
      source: "claude-code-import",
      startedAt: FIXED_NOW_ISO,
    });
    const result = await renderOrientation({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.body).toContain("ℹ️ 取り込み済みの状態を表示しています。");
    expect(result.body).toContain("最新か確認するには `basou refresh`");
    expect(result.body).not.toContain("✅ 取り込みは最新です。");
  });

  it("これは最新か: a fresh capture with suspect sessions still cautions in the verdict", async () => {
    const paths = await setupPaths();
    const id = SES("R01");
    await placeSession(
      paths,
      { id, status: "running", source: "claude-code-import", startedAt: FIXED_NOW_ISO },
      startedLine(id, "E01", "2026-05-08T11:00:00+09:00") +
        endedLine(id, "E02", "2026-05-08T11:05:00+09:00"),
    );
    const result = await renderOrientation({
      paths,
      nowIso: FIXED_NOW_ISO,
      staleness: { newSessions: 0, updatedSessions: 0 },
    });
    expect(result.body).toContain("✅ 取り込みは最新です。");
    expect(result.body).toContain("ただし要注意セッションが 1 件あります");
  });

  it("これは最新か: unverifiable grown sessions block ✅ and point at verify/--force (no false-clear)", async () => {
    const paths = await setupPaths();
    await placeSession(paths, {
      id: SES("S01"),
      status: "completed",
      source: "claude-code-import",
      startedAt: FIXED_NOW_ISO,
    });
    // newSessions/updatedSessions are 0 — without the unverifiable signal this
    // would render the ✅ "current" verdict even though a grown source could
    // not be re-imported safely. That silent ✅ is the false-clear F5 removes.
    const result = await renderOrientation({
      paths,
      nowIso: FIXED_NOW_ISO,
      staleness: { newSessions: 0, updatedSessions: 0, unverifiableSessions: 2 },
    });
    expect(result.body).toContain("⚠️ 最新か確認できません。");
    expect(result.body).toContain("2 件");
    expect(result.body).toContain("`basou verify`");
    expect(result.body).toContain("`basou refresh --force`");
    expect(result.body).not.toContain("✅ 取り込みは最新です。");
  });

  it("--verbose appends the raw freshness telemetry under the verdict", async () => {
    const paths = await setupPaths();
    await placeSession(paths, {
      id: SES("S01"),
      status: "completed",
      source: "claude-code-import",
      startedAt: FIXED_NOW_ISO,
    });
    const plain = await renderOrientation({
      paths,
      nowIso: FIXED_NOW_ISO,
      staleness: { newSessions: 0, updatedSessions: 0 },
    });
    const verbose = await renderOrientation({
      paths,
      nowIso: FIXED_NOW_ISO,
      staleness: { newSessions: 0, updatedSessions: 0 },
      verbose: true,
    });
    expect(plain.body).not.toContain("newest captured session:");
    expect(plain.body).not.toContain("staleness probe:");
    expect(verbose.body).toContain("newest captured session: ");
    expect(verbose.body).toContain("- sessions: 1 (claude-code-import 1)");
    expect(verbose.body).toContain("- staleness probe: new 0, updated 0");
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
        "- 直近の判断: (no decisions recorded yet; capture with `basou decision capture`)",
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
        "- (no planned tasks or recorded next step yet)",
        "",
        "## これは最新か",
        "",
        "ℹ️ まだ記録がありません。",
        "このワークスペースで作業すると、ここに現在地が表示されます。",
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
        endedAt: FIXED_NOW_ISO,
        relatedFiles: ["src/d.ts", "src/c.ts", "src/b.ts", "src/a.ts"],
      },
      decisionLine(live, "E01", DEC("D01"), "earlier decision", "2026-05-08T12:00:00+09:00") +
        decisionLine(live, "E02", DEC("D02"), "wire portfolio API", "2026-05-09T11:30:00+09:00"),
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

    const result = await renderOrientation({
      paths,
      nowIso: FIXED_NOW_ISO,
      relatedFilesLimit: 2,
      staleness: { newSessions: 0, updatedSessions: 0 },
    });

    expect(result.body).toBe(
      [
        "# Orientation",
        "",
        "> Generated at 2026-05-09T03:00:00.000Z · sessions 2 · newest just now · pending 1 · suspect 0",
        "",
        "## 今どこにいる",
        "",
        "- 最終 session: fixture S01 (completed) [ses_01HXABCDEF]",
        "- 直近の判断: wire portfolio API [decision_01HXABCDEF] (30分前)",
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
        "✅ 取り込みは最新です。最後の作業は たった今(Claude Code)。未取り込みの native セッションはありません。",
        "注: この判定は取り込み済み native セッションの鮮度と suspect の有無だけを見ます。計画↔実装のドリフトや未記録の意思決定までは検知しません。",
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
    expect(summary.latestNote).toBeNull();
    expect(summary.relatedFiles).toEqual({ displayed: [], overflow: 0 });
    expect(summary.inFlightTasks).toEqual([]);
    expect(summary.plannedTasks).toEqual([]);
    expect(summary.pendingApprovals).toEqual([]);
    expect(summary.suspects).toEqual([]);
    expect(summary.freshness).toEqual({
      newestStartedAt: null,
      newestSource: null,
      latestActivityAt: null,
      bySource: [],
      sourceRoots: null,
    });
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
      host: null,
    });
    expect(summary.latestDecision).toEqual({
      decisionId: DEC("D01"),
      title: "adopt orientation re-centering",
      occurredAt: "2026-05-08T12:00:00+09:00",
      sessionId: live,
      host: null,
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
    expect(summary.freshness.newestSource).toBe("claude-code-import");
    expect(summary.freshness.bySource).toEqual([{ kind: "claude-code-import", count: 1 }]);
    // No ended_at; the activity tail folds in the decision event's occurred_at
    // (12:00) which is later than started_at (11:00).
    expect(summary.freshness.latestActivityAt).toBe("2026-05-08T12:00:00+09:00");
  });

  it("flags a latest decision that trails real activity (recency honesty)", async () => {
    const paths = await setupPaths();
    const id = SES("S01");
    // 10h session: lone decision near the start, activity continues for hours.
    await placeSession(
      paths,
      {
        id,
        status: "completed",
        source: "claude-code-import",
        startedAt: "2026-05-08T10:00:00+09:00",
        endedAt: "2026-05-08T20:00:00+09:00",
      },
      decisionLine(id, "E01", DEC("D01"), "push wordpress-v0.1.1 tag", "2026-05-08T11:00:00+09:00"),
    );

    const summary = await summarizeOrientation({ paths, nowIso: FIXED_NOW_ISO });
    expect(summary.freshness.latestActivityAt).toBe("2026-05-08T20:00:00+09:00");

    const result = await renderOrientation({ paths, nowIso: FIXED_NOW_ISO });
    // The decision still shows, now carrying its (stale) age...
    expect(result.body).toContain("直近の判断: push wordpress-v0.1.1 tag");
    // ...and the full note, including the interpolated activity age (ended
    // 2026-05-08T20:00+09 = 11:00Z; now 2026-05-09T03:00Z → 16時間前), so the
    // stale decision does not masquerade as the current direction.
    expect(result.body).toContain(
      "注: これは最後に「記録された」判断です。最終活動 (16時間前) はこれより後のため、現在の方針が反映されていない可能性があります(会話での意思決定は自動記録されません。`basou decision capture` でこの session の判断を記録できます)。",
    );
  });

  it("does not flag a decision made near the end of activity (no false note)", async () => {
    const paths = await setupPaths();
    const id = SES("S01");
    // Decision 30m before the session's last activity → within the gap.
    await placeSession(
      paths,
      {
        id,
        status: "completed",
        source: "claude-code-import",
        startedAt: "2026-05-08T10:00:00+09:00",
        endedAt: "2026-05-08T20:00:00+09:00",
      },
      decisionLine(id, "E01", DEC("D01"), "adopt lockstep release", "2026-05-08T19:30:00+09:00"),
    );

    const result = await renderOrientation({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.body).toContain("直近の判断: adopt lockstep release");
    expect(result.body).not.toContain("注: これは最後に「記録された」判断です。");
  });

  it("flags a trailing decision when the later activity is in another session", async () => {
    const paths = await setupPaths();
    const a = SES("S01");
    // Session A: a single mid-morning decision, then it ends.
    await placeSession(
      paths,
      {
        id: a,
        status: "completed",
        source: "claude-code-import",
        startedAt: "2026-05-08T10:00:00+09:00",
        endedAt: "2026-05-08T11:00:00+09:00",
      },
      decisionLine(
        a,
        "E01",
        DEC("D01"),
        "adopt orientation re-centering",
        "2026-05-08T10:30:00+09:00",
      ),
    );
    // Session B: later work, no decision recorded — its end is the activity tail.
    await placeSession(paths, {
      id: SES("S02"),
      status: "completed",
      source: "codex-import",
      startedAt: "2026-05-08T18:00:00+09:00",
      endedAt: "2026-05-08T22:00:00+09:00",
    });

    const summary = await summarizeOrientation({ paths, nowIso: FIXED_NOW_ISO });
    // The activity tail is session B's end, not the decision's own session —
    // latestActivityAt is the max over all non-archived sessions.
    expect(summary.freshness.latestActivityAt).toBe("2026-05-08T22:00:00+09:00");

    const result = await renderOrientation({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.body).toContain("直近の判断: adopt orientation re-centering");
    // Firing across sessions is intentional: the recorded decision predates the
    // most recent captured work regardless of which session that work lives in.
    expect(result.body).toContain(
      "注: これは最後に「記録された」判断です。最終活動 (14時間前) はこれより後のため、現在の方針が反映されていない可能性があります(会話での意思決定は自動記録されません。`basou decision capture` でこの session の判断を記録できます)。",
    );
  });

  it("surfaces the latest note as the recorded next step in the forward section", async () => {
    const paths = await setupPaths();
    const id = SES("S01");
    await placeSession(
      paths,
      {
        id,
        status: "completed",
        source: "claude-code-import",
        startedAt: "2026-05-08T11:00:00+09:00",
        endedAt: "2026-05-08T12:00:00+09:00",
      },
      noteLine(id, "E01", "earlier note", "2026-05-08T11:30:00+09:00", "next_step") +
        // 2026-05-08T12:00+09 = 2026-05-08T03:00Z, exactly 24h before FIXED_NOW.
        noteLine(
          id,
          "E02",
          "resume from: ship v0.24.0 (steps 1-6)",
          "2026-05-08T12:00:00+09:00",
          "next_step",
        ),
    );

    const summary = await summarizeOrientation({ paths, nowIso: FIXED_NOW_ISO });
    // The newest note (by occurred_at) wins.
    expect(summary.latestNote).toEqual({
      body: "resume from: ship v0.24.0 (steps 1-6)",
      sessionId: id,
      occurredAt: "2026-05-08T12:00:00+09:00",
      host: null,
    });

    const result = await renderOrientation({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.body).toContain(
      `- 次の起点 (記録済み, 1日前): resume from: ship v0.24.0 (steps 1-6) [session ${id.slice(0, 14)}]`,
    );
    // With a recorded next step present, the empty-direction fallback is gone.
    expect(result.body).not.toContain("(no planned tasks");
  });

  it("collapses a multi-line note body to a single bounded line", async () => {
    const paths = await setupPaths();
    const id = SES("S01");
    await placeSession(
      paths,
      { id, status: "completed", source: "claude-code-import" },
      noteLine(
        id,
        "E01",
        "line one\n  line two\n\nline three",
        "2026-05-08T12:00:00+09:00",
        "next_step",
      ),
    );

    const result = await renderOrientation({ paths, nowIso: FIXED_NOW_ISO });
    // Newlines/indents collapse to single spaces so the note stays one bullet.
    expect(result.body).toContain("次の起点 (記録済み, ");
    expect(result.body).toContain("line one line two line three");
  });

  it("ignores notes on archived sessions for the forward next step", async () => {
    const paths = await setupPaths();
    const archived = SES("S01");
    await placeSession(
      paths,
      { id: archived, status: "archived", source: "claude-code-import" },
      noteLine(archived, "E01", "stale archived note", "2026-05-08T12:00:00+09:00", "next_step"),
    );

    const summary = await summarizeOrientation({ paths, nowIso: FIXED_NOW_ISO });
    expect(summary.latestNote).toBeNull();
    const result = await renderOrientation({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.body).not.toContain("次の起点");
    expect(result.body).not.toContain("stale archived note");
  });

  it("does not surface a plain note (no next_step kind) as the next step", async () => {
    const paths = await setupPaths();
    const id = SES("S01");
    await placeSession(
      paths,
      { id, status: "completed", source: "claude-code-import" },
      // A `basou session note` annotation carries no kind — not a resume hint.
      noteLine(id, "E01", "started exploring auth.ts", "2026-05-08T12:00:00+09:00"),
    );

    const summary = await summarizeOrientation({ paths, nowIso: FIXED_NOW_ISO });
    expect(summary.latestNote).toBeNull();
    const result = await renderOrientation({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.body).not.toContain("次の起点");
    expect(result.body).not.toContain("started exploring auth.ts");
  });

  it("flags a next-step note that trails real activity", async () => {
    const paths = await setupPaths();
    const id = SES("S01");
    await placeSession(
      paths,
      {
        id,
        status: "completed",
        source: "claude-code-import",
        startedAt: "2026-05-08T10:00:00+09:00",
        endedAt: "2026-05-08T20:00:00+09:00",
      },
      // Note at 11:00+09; activity continues to 20:00+09 (>1h later).
      noteLine(id, "E01", "resume from X", "2026-05-08T11:00:00+09:00", "next_step"),
    );

    const result = await renderOrientation({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.body).toContain("次の起点 (記録済み,");
    expect(result.body).toContain(
      "注: この起点の記録後 (最終活動 16時間前) も作業が続いています。再開点が古い可能性があります。",
    );
  });

  it("truncates a very long next-step note body with an ellipsis", async () => {
    const paths = await setupPaths();
    const id = SES("S01");
    const longBody = "x".repeat(250);
    await placeSession(
      paths,
      { id, status: "completed", source: "claude-code-import" },
      noteLine(id, "E01", longBody, "2026-05-08T12:00:00+09:00", "next_step"),
    );

    const result = await renderOrientation({ paths, nowIso: FIXED_NOW_ISO });
    // Body is capped (199 chars + ellipsis) so a verbose handoff cannot dominate.
    expect(result.body).toContain(`${"x".repeat(199)}…`);
    expect(result.body).not.toContain("x".repeat(201));
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

// Resume coherence (HypArt triage): orient must not present a stale decision as
// direction (F-A), must represent 最終 session with a substantive session (F-B),
// and must flag when the latest decision is from a different session (F-C).
// NOTE: SES/EVT/DEC suffixes must be exactly 3 Crockford chars (no I/L/O/U) so
// the synthesized ids pass ULID validation.
describe("renderOrientation (resume coherence)", () => {
  it("F-A: a stale latest decision is NOT presented as direction in the forward section", async () => {
    const paths = await setupPaths();
    const s = SES("FA1");
    // decision at 12:00, activity continues to 14:00 (2h later) -> stale
    await placeSession(
      paths,
      {
        id: s,
        status: "completed",
        source: "claude-code-import",
        startedAt: "2026-05-08T11:00:00Z",
        endedAt: "2026-05-08T14:00:00Z",
        relatedFiles: ["src/x.ts"],
      },
      decisionLine(s, "FA1", DEC("FA1"), "apply migration 0014-0018?", "2026-05-08T12:00:00Z"),
    );
    const { body } = await renderOrientation({ paths, nowIso: FIXED_NOW_ISO });
    expect(body).toContain("継続点をユーザに確認してください");
    expect(body).toContain("参考 (古い可能性");
    expect(body).not.toContain("direction is inferred from recent decisions");
  });

  it("F-A: a fresh latest decision IS shown as inferred direction", async () => {
    const paths = await setupPaths();
    const s = SES("FA2");
    // decision at 12:00, activity ends 12:30 (within 1h) -> not stale
    await placeSession(
      paths,
      {
        id: s,
        status: "completed",
        source: "claude-code-import",
        startedAt: "2026-05-08T11:00:00Z",
        endedAt: "2026-05-08T12:30:00Z",
        relatedFiles: ["src/x.ts"],
      },
      decisionLine(s, "FA2", DEC("FA2"), "use pnpm", "2026-05-08T12:00:00Z"),
    );
    const { body } = await renderOrientation({ paths, nowIso: FIXED_NOW_ISO });
    expect(body).toContain("direction is inferred from recent decisions");
    expect(body).toContain("直近の判断: use pnpm");
    expect(body).not.toContain("継続点をユーザに確認してください");
  });

  it("F-B: 最終 session is the substantive session, not a newer empty resume session", async () => {
    const paths = await setupPaths();
    const work = SES("WRK");
    const resume = SES("RSM");
    await placeSession(paths, {
      id: work,
      status: "completed",
      source: "claude-code-import",
      startedAt: "2026-05-08T09:00:00Z",
      relatedFiles: ["src/a.ts", "src/b.ts"],
      label: "real work",
    });
    // newer, but a bare resume (0 files) — must NOT win
    await placeSession(paths, {
      id: resume,
      status: "completed",
      source: "claude-code-import",
      startedAt: "2026-05-08T11:00:00Z",
      relatedFiles: [],
      label: "resume",
    });
    const summary = await summarizeOrientation({ paths, nowIso: FIXED_NOW_ISO });
    expect(summary.latestSession?.sessionId).toBe(work);
  });

  it("F-C: flags when the latest decision is from a different session than 最終 session", async () => {
    const paths = await setupPaths();
    const work = SES("WK2"); // substantive + newest -> 最終 session
    const older = SES("PR2"); // prior session that holds the decision
    await placeSession(paths, {
      id: work,
      status: "completed",
      source: "claude-code-import",
      startedAt: "2026-05-08T13:00:00Z",
      relatedFiles: ["src/a.ts"],
    });
    await placeSession(
      paths,
      {
        id: older,
        status: "completed",
        source: "claude-code-import",
        startedAt: "2026-05-08T09:00:00Z",
        relatedFiles: [],
      },
      decisionLine(older, "PE2", DEC("DC2"), "an older decision", "2026-05-08T09:30:00Z"),
    );
    const { body } = await renderOrientation({ paths, nowIso: FIXED_NOW_ISO });
    expect(body).toContain("この判断は最終 session とは別の session");
  });

  it("F-C: does NOT flag when the latest decision is in 最終 session", async () => {
    const paths = await setupPaths();
    const s = SES("SAM");
    await placeSession(
      paths,
      {
        id: s,
        status: "completed",
        source: "claude-code-import",
        startedAt: "2026-05-08T13:00:00Z",
        relatedFiles: ["src/a.ts"],
      },
      decisionLine(s, "SE3", DEC("DC3"), "same-session decision", "2026-05-08T13:10:00Z"),
    );
    const { body } = await renderOrientation({ paths, nowIso: FIXED_NOW_ISO });
    expect(body).not.toContain("別の session");
  });
});

describe("renderOrientation (federation / multi-host)", () => {
  // Federated host stores live in their own temp dirs (mirrors of another
  // host's `.basou`, reachable here as local paths). Track + clean them
  // separately from the module-level `workDir`.
  let hostDirs: string[] = [];
  afterEach(async () => {
    for (const d of hostDirs) await rm(d, { recursive: true, force: true });
    hostDirs = [];
  });
  async function setupHostStore(): Promise<BasouPaths> {
    const d = await mkdtemp(join(tmpdir(), "basou-orient-host-"));
    hostDirs.push(d);
    return ensureBasouDirectory(d);
  }

  it("merges a remote host's sessions, attributing latest session + decision to the host", async () => {
    const local = await setupPaths();
    await placeSession(
      local,
      { id: SES("A01"), status: "completed", startedAt: "2026-05-08T10:00:00Z" },
      startedLine(SES("A01"), "E01", "2026-05-08T10:00:00Z") +
        decisionLine(SES("A01"), "E02", DEC("D01"), "local decision", "2026-05-08T10:05:00Z"),
    );

    const laptop = await setupHostStore();
    await placeSession(
      laptop,
      {
        id: SES("R01"),
        status: "completed",
        startedAt: "2026-05-08T12:00:00Z",
        label: "laptop work",
        relatedFiles: ["remote.ts"],
      },
      startedLine(SES("R01"), "E03", "2026-05-08T12:00:00Z") +
        decisionLine(SES("R01"), "E04", DEC("D02"), "remote decision", "2026-05-08T12:30:00Z"),
    );

    const federatedRoots = [{ paths: laptop, host: "laptop" }];
    const summary = await summarizeOrientation({
      paths: local,
      nowIso: FIXED_NOW_ISO,
      federatedRoots,
    });

    expect(summary.sessionCount).toBe(2);
    expect(summary.hosts).toEqual(["laptop"]);
    expect(summary.latestSession?.sessionId).toBe(SES("R01"));
    expect(summary.latestSession?.host).toBe("laptop");
    // The remote decision can only be the latest if its events were replayed
    // from the LAPTOP store (entry.sourceRoot.sessions). If the renderer still
    // read events from the local store, R01's events would be unreadable there
    // and "remote decision" would never surface — so this pins the seam.
    expect(summary.latestDecision?.title).toBe("remote decision");
    expect(summary.latestDecision?.host).toBe("laptop");

    const { body } = await renderOrientation({
      paths: local,
      nowIso: FIXED_NOW_ISO,
      federatedRoots,
    });
    expect(body).toContain("@laptop");
    expect(body).toContain("> hosts: local, laptop");
    expect(body).toContain("他ホストの取りこぼしは判定できません");
  });

  it("de-duplicates a session id present in both stores, local winning", async () => {
    const local = await setupPaths();
    await placeSession(
      local,
      { id: SES("C01"), status: "completed", startedAt: "2026-05-08T10:00:00Z" },
      startedLine(SES("C01"), "E01", "2026-05-08T10:00:00Z"),
    );
    const laptop = await setupHostStore();
    await placeSession(
      laptop,
      { id: SES("C01"), status: "completed", startedAt: "2026-05-08T10:00:00Z" },
      startedLine(SES("C01"), "E02", "2026-05-08T10:00:00Z"),
    );

    const summary = await summarizeOrientation({
      paths: local,
      nowIso: FIXED_NOW_ISO,
      federatedRoots: [{ paths: laptop, host: "laptop" }],
    });
    expect(summary.sessionCount).toBe(1);
    // Local-first: the survivor is the local copy (host null), so no host banner.
    expect(summary.hosts).toEqual([]);
  });

  it("skips an unreadable host mirror via onHostUnavailable; local still renders", async () => {
    const local = await setupPaths();
    await placeSession(
      local,
      { id: SES("A01"), status: "completed", startedAt: "2026-05-08T10:00:00Z" },
      startedLine(SES("A01"), "E01", "2026-05-08T10:00:00Z"),
    );
    const laptop = await setupHostStore();
    // Replace the sessions dir with a file so enumerateSessionDirs throws ENOTDIR
    // (present-but-unreadable, not ENOENT) — the onRootUnavailable path.
    await rm(laptop.sessions, { recursive: true, force: true });
    await writeFile(laptop.sessions, "not a dir");

    const unavailable: string[] = [];
    const summary = await summarizeOrientation({
      paths: local,
      nowIso: FIXED_NOW_ISO,
      federatedRoots: [{ paths: laptop, host: "laptop" }],
      onHostUnavailable: (host) => unavailable.push(host),
    });
    expect(unavailable).toEqual(["laptop"]);
    expect(summary.sessionCount).toBe(1);
    expect(summary.latestSession?.sessionId).toBe(SES("A01"));
  });

  it("an absent host path contributes nothing, silently (no onHostUnavailable)", async () => {
    const local = await setupPaths();
    await placeSession(
      local,
      { id: SES("A01"), status: "completed", startedAt: "2026-05-08T10:00:00Z" },
      startedLine(SES("A01"), "E01", "2026-05-08T10:00:00Z"),
    );
    const unavailable: string[] = [];
    const summary = await summarizeOrientation({
      paths: local,
      nowIso: FIXED_NOW_ISO,
      // A store whose sessions dir does not exist (ENOENT) → silently empty.
      federatedRoots: [{ paths: await missingStorePaths(), host: "ghost" }],
      onHostUnavailable: (host) => unavailable.push(host),
    });
    expect(unavailable).toEqual([]);
    expect(summary.sessionCount).toBe(1);
    expect(summary.hosts).toEqual([]);
  });

  async function missingStorePaths(): Promise<BasouPaths> {
    // A real BasouPaths whose store dirs do not exist (parent temp dir is empty).
    const d = await mkdtemp(join(tmpdir(), "basou-orient-ghost-"));
    hostDirs.push(d);
    const paths = await ensureBasouDirectory(d);
    await rm(paths.sessions, { recursive: true, force: true });
    return paths;
  }

  it("is byte-identical to local-only when no federated roots are given", async () => {
    const local = await setupPaths();
    await placeSession(
      local,
      { id: SES("A01"), status: "completed", startedAt: "2026-05-08T10:00:00Z" },
      startedLine(SES("A01"), "E01", "2026-05-08T10:00:00Z"),
    );
    const withEmpty = await renderOrientation({
      paths: local,
      nowIso: FIXED_NOW_ISO,
      federatedRoots: [],
    });
    const without = await renderOrientation({ paths: local, nowIso: FIXED_NOW_ISO });
    expect(withEmpty.body).toBe(without.body);
    expect(without.body).not.toContain("> hosts: local");
    expect(without.body).not.toContain("@laptop");
  });
});
