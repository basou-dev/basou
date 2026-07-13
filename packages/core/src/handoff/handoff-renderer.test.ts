import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import type { TaskStatus } from "../schemas/task.schema.js";
import { type BasouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";
import { createManifest, writeManifest } from "../storage/manifest.js";
import { renderHandoff } from "./handoff-renderer.js";

const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const FIXED_NOW_ISO = "2026-05-09T03:00:00.000Z";

// 23-char Crockford body + 3-char suffix = 26-char ULID body.
const SES = (s: string): string => `ses_01HXABCDEF1234567890ABC${s}`;
const EVT = (s: string): string => `evt_01HXABCDEF1234567890ABC${s}`;
const DEC = (s: string): string => `decision_01HXABCDEF1234567890ABC${s}`;
const APPR = (s: string): string => `appr_01HXABCDEF1234567890ABC${s}`;
const TASK = (s: string): string => `task_01HXABCDEF1234567890ABC${s}`;
const WS_ID = "ws_01HXABCDEF1234567890ABCDEF";

// Mirror handoff-renderer's prose-line short id: type prefix + the first 10
// chars of the ULID body (e.g. `task_01HXABCDEF...`). NOTE: every fixture id in
// this file shares the same leading ULID chars, so distinct sessions / tasks /
// decisions collapse to the SAME short id here — assertions therefore key on
// human text (label / title) to distinguish records, and use SHORT only to pin
// the rendered shape.
const SHORT = (id: string): string => {
  const sep = id.indexOf("_");
  return id.slice(0, sep + 1) + id.slice(sep + 1, sep + 1 + 10);
};

let workDir: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "basou-handoff-test-"));
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

type SessionFixture = {
  id: string;
  status?:
    | "initialized"
    | "running"
    | "waiting_approval"
    | "completed"
    | "failed"
    | "interrupted"
    | "imported"
    | "archived";
  startedAt?: string;
  endedAt?: string;
  source?:
    | "claude-code-adapter"
    | "claude-code-import"
    | "codex-import"
    | "human"
    | "import"
    | "terminal";
  label?: string;
  /** Omit the `label` field entirely, to exercise the no-label fallback. */
  omitLabel?: boolean;
  relatedFiles?: string[];
};

async function placeSession(
  paths: BasouPaths,
  fixture: SessionFixture,
  events?: string,
): Promise<void> {
  const sessionDir = join(paths.sessions, fixture.id);
  await mkdir(sessionDir, { recursive: true });
  const yaml = stringify({
    schema_version: "0.1.0",
    session: {
      id: fixture.id,
      ...(fixture.omitLabel === true
        ? {}
        : { label: fixture.label ?? `fixture ${fixture.id.slice(-3)}` }),
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
  if (events !== undefined) {
    await writeFile(join(sessionDir, "events.jsonl"), events);
  }
}

function sessionStartedLine(id: string, evt: string, occurredAt: string): string {
  return `${JSON.stringify({
    schema_version: "0.1.0",
    type: "session_started",
    id: EVT(evt),
    session_id: id,
    occurred_at: occurredAt,
    source: "human",
  })}\n`;
}

function sessionEndedLine(id: string, evt: string, occurredAt: string): string {
  return `${JSON.stringify({
    schema_version: "0.1.0",
    type: "session_ended",
    id: EVT(evt),
    session_id: id,
    occurred_at: occurredAt,
    source: "human",
    final_status: "completed",
  })}\n`;
}

function decisionRecordedLine(
  id: string,
  evt: string,
  decisionId: string,
  title: string,
  occurredAt: string,
  opts?: { kind?: "decision" | "track"; rationale?: string | null },
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
    ...(opts?.kind !== undefined ? { kind: opts.kind } : {}),
    ...(opts?.rationale !== undefined ? { rationale: opts.rationale } : {}),
  })}\n`;
}

function taskCreatedLine(
  sessionId: string,
  evt: string,
  taskId: string,
  title: string,
  occurredAt: string,
): string {
  return `${JSON.stringify({
    schema_version: "0.1.0",
    type: "task_created",
    id: EVT(evt),
    session_id: sessionId,
    occurred_at: occurredAt,
    source: "human",
    task_id: taskId,
    title,
  })}\n`;
}

function taskStatusChangedLine(
  sessionId: string,
  evt: string,
  taskId: string,
  fromStatus: string,
  toStatus: string,
  occurredAt: string,
): string {
  return `${JSON.stringify({
    schema_version: "0.1.0",
    type: "task_status_changed",
    id: EVT(evt),
    session_id: sessionId,
    occurred_at: occurredAt,
    source: "human",
    task_id: taskId,
    from: fromStatus,
    to: toStatus,
  })}\n`;
}

async function placeTaskFile(
  paths: BasouPaths,
  fixture: {
    id: string;
    title: string;
    status: TaskStatus;
    createdAt: string;
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
      created_at: fixture.createdAt,
      updated_at: fixture.createdAt,
      workspace_id: WS_ID,
      created_in_session: fixture.sessionId,
      linked_sessions: fixture.linkedSessions ?? [fixture.sessionId],
    },
  });
  await writeFile(join(paths.tasks, `${fixture.id}.md`), `---\n${yaml}---\n\n`);
}

async function placePendingApproval(paths: BasouPaths, approvalId: string): Promise<void> {
  await writeFile(
    join(paths.approvals.pending, `${approvalId}.yaml`),
    stringify({ approval_id: approvalId }),
  );
}

/** Extract the substring of `body` from `startHeader` up to the next line starting with `endPrefix`. */
function sliceSection(body: string, startHeader: string, endPrefix: string): string {
  const startIdx = body.indexOf(startHeader);
  if (startIdx < 0) return "";
  const afterHeader = body.indexOf("\n", startIdx) + 1;
  const tail = body.slice(afterHeader);
  const nextHeaderRel = tail.search(new RegExp(`^${endPrefix}`, "m"));
  return nextHeaderRel < 0 ? tail : tail.slice(0, nextHeaderRel);
}

describe("handoff-renderer", () => {
  it("case 1: empty workspace produces no-sessions / no-decisions placeholders", async () => {
    const paths = await setupPaths();
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.sessionCount).toBe(0);
    expect(result.decisionCount).toBe(0);
    expect(result.pendingApprovalsCount).toBe(0);
    expect(result.suspectCount).toBe(0);
    expect(result.body).toContain("(no sessions yet)");
    expect(result.body).toContain("(no decisions recorded yet)");
  });

  it("case 2: a single completed session renders the session range from its own id", async () => {
    const paths = await setupPaths();
    const id = SES("X01");
    await placeSession(paths, { id, status: "completed" });
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.sessionCount).toBe(1);
    expect(result.body).toContain(`from ${SHORT(id)}..${SHORT(id)}`);
  });

  it("case 3: 直近の変更ファイル shows only the most recent session's related_files", async () => {
    const paths = await setupPaths();
    // Older session — its unique files must NOT appear once a newer session
    // supersedes it.
    await placeSession(paths, {
      id: SES("X02"),
      relatedFiles: ["src/a.ts", "src/b.ts"],
    });
    // More recent session (later started_at) — this one wins.
    await placeSession(paths, {
      id: SES("X03"),
      relatedFiles: ["src/b.ts", "src/c.ts"],
      startedAt: "2026-05-08T12:00:00+09:00",
    });
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.sessionCount).toBe(2);
    const recentSection = sliceSection(result.body, "## Recently changed files", "##");
    // src/a.ts is only in the older session, so it is excluded; the newer
    // session's files appear, sorted asc.
    expect(recentSection).not.toContain("- src/a.ts");
    const idxB = recentSection.indexOf("- src/b.ts");
    const idxC = recentSection.indexOf("- src/c.ts");
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxC).toBeGreaterThan(idxB);
    expect(recentSection.split("- src/b.ts\n").length - 1).toBe(1);
  });

  it("case 4: includes the latest decision_recorded in the 直近の判断 section", async () => {
    const paths = await setupPaths();
    const id = SES("X04");
    const dec1 = DEC("D01");
    const dec2 = DEC("D02");
    const dec3 = DEC("D03");
    const events =
      decisionRecordedLine(id, "E01", dec1, "first", "2026-05-08T11:00:00+09:00") +
      decisionRecordedLine(id, "E02", dec2, "second", "2026-05-08T12:00:00+09:00") +
      decisionRecordedLine(id, "E03", dec3, "third", "2026-05-08T13:00:00+09:00");
    await placeSession(paths, { id }, events);
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.decisionCount).toBe(3);
    expect(result.body).toContain(`- third [${SHORT(dec3)}]`);
    expect(result.body).toContain("(3 decisions total — see decisions.md)");
  });

  it("case 5: suspect sessions render inline labels and contribute to summary", async () => {
    const paths = await setupPaths();
    // Rule A: running yaml + session_ended event
    const ruleA = SES("X05");
    const eventsA =
      sessionStartedLine(ruleA, "E0A", "2026-05-08T11:00:00+09:00") +
      sessionEndedLine(ruleA, "E0B", "2026-05-08T11:00:30+09:00");
    await placeSession(paths, { id: ruleA, status: "running" }, eventsA);
    // Rule B: running yaml + last event > 24h old
    const ruleB = SES("X06");
    const eventsB = sessionStartedLine(ruleB, "E0C", "2026-05-07T03:00:00+00:00");
    await placeSession(
      paths,
      { id: ruleB, status: "running", startedAt: "2026-05-07T03:00:00+00:00" },
      eventsB,
    );
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.suspectCount).toBe(2);
    expect(result.body).toContain("⚠ ended (yaml stale)");
    expect(result.body).toContain("⚠ no end event");
    expect(result.body).toContain("2 suspect sessions detected");
  });

  it("case 6: pending approvals surface as a count in the 未決事項 section", async () => {
    const paths = await setupPaths();
    await placeSession(paths, { id: SES("X07") });
    await placePendingApproval(paths, APPR("A01"));
    await placePendingApproval(paths, APPR("A02"));
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.pendingApprovalsCount).toBe(2);
    expect(result.body).toContain("- 2 pending approvals");
  });

  it("case 7: related_files truncate at the configured limit emits +N more", async () => {
    const paths = await setupPaths();
    await placeSession(paths, {
      id: SES("X08"),
      relatedFiles: ["a", "b", "c", "d", "e"],
    });
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO, relatedFilesLimit: 2 });
    expect(result.body).toContain("- a");
    expect(result.body).toContain("- b");
    expect(result.body).toContain("- ... +3 more");
    expect(result.body).not.toMatch(/^- c$/m);
  });

  it("case 8: zero decisions renders the no-decisions placeholder", async () => {
    const paths = await setupPaths();
    await placeSession(paths, { id: SES("X09") });
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.body).toContain("(no decisions recorded yet)");
    expect(result.decisionCount).toBe(0);
  });

  it("case 9: partial trailing line in events.jsonl emits a replay warning but renders", async () => {
    const paths = await setupPaths();
    const id = SES("X0A");
    // Append decision + dangling JSON without a trailing newline.
    const events = `${decisionRecordedLine(id, "E0D", DEC("D04"), "k", "2026-05-08T11:00:00+09:00")}{"schema_version":"0.1.0","type":"session_started","incomplete`;
    await placeSession(paths, { id }, events);
    const warnings: string[] = [];
    const result = await renderHandoff({
      paths,
      nowIso: FIXED_NOW_ISO,
      onWarning: (w) => warnings.push(w.kind),
    });
    expect(result.decisionCount).toBe(1);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("case 10: missing events.jsonl on a session is silently ignored", async () => {
    const paths = await setupPaths();
    await placeSession(paths, { id: SES("X0B") }); // no events param
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.sessionCount).toBe(1);
    expect(result.decisionCount).toBe(0);
  });

  it("case 11: snapshot the formatting of the most basic 1-session, 1-decision body", async () => {
    const paths = await setupPaths();
    const id = SES("X0C");
    const dec = DEC("D05");
    const events = decisionRecordedLine(id, "E0E", dec, "pick A", "2026-05-08T13:00:00+09:00");
    await placeSession(paths, { id, status: "completed", relatedFiles: ["src/x.ts"] }, events);
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.body).toContain("# Handoff");
    expect(result.body).toContain(
      `- Last session: fixture ${id.slice(-3)} (completed) [${SHORT(id)}]`,
    );
    expect(result.body).toContain("- src/x.ts");
    expect(result.body).toContain(`- pick A [${SHORT(dec)}]`);
    expect(result.body).toContain("| short_id | status | started_at | label |");
    expect(result.body).toContain("Sessions: 1 (completed 1). Tasks: 0.");
  });

  it("case 11b: 最終 session falls back to the short id when the session has no label", async () => {
    const paths = await setupPaths();
    const id = SES("X0R");
    await placeSession(paths, { id, status: "completed", omitLabel: true });
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    // No label -> the short id becomes the primary text and the trailing [id]
    // bracket is dropped so the same id is not repeated.
    expect(result.body).toContain(`- Last session: ${SHORT(id)} (completed)`);
    const stateSection = sliceSection(result.body, "## Current state", "## ");
    expect(stateSection).not.toContain(`[${SHORT(id)}]`);
  });

  it("case 12: nowIso is reflected in the generated_at header", async () => {
    const paths = await setupPaths();
    const customNow = "2026-12-31T23:59:59.000Z";
    const result = await renderHandoff({ paths, nowIso: customNow });
    expect(result.body).toContain(`> Generated at ${customNow}`);
  });

  it("case 13: 最終 task / 次に実行すべき作業 stay placeholder when no tasks exist", async () => {
    const paths = await setupPaths();
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.taskCount).toBe(0);
    expect(result.pendingTaskCount).toBe(0);
    expect(result.body).toContain("- Last task: (no tasks recorded yet)");
    expect(result.body).toContain("(no pending tasks)");
  });

  it("case 14: a single planned task surfaces as 最終 task and in 次に実行すべき作業", async () => {
    const paths = await setupPaths();
    const sid = SES("X0D");
    const taskId = TASK("T01");
    const events = taskCreatedLine(sid, "E10", taskId, "form revamp", "2026-05-08T14:00:00+09:00");
    await placeSession(paths, { id: sid, status: "running" }, events);
    await placeTaskFile(paths, {
      id: taskId,
      title: "form revamp",
      status: "planned",
      createdAt: "2026-05-08T14:00:00+09:00",
      sessionId: sid,
    });
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.taskCount).toBe(1);
    expect(result.pendingTaskCount).toBe(1);
    expect(result.body).toContain(`- Last task: form revamp (planned) [${SHORT(taskId)}]`);
    expect(result.body).toContain(`- form revamp (planned) [${SHORT(taskId)}]`);
    expect(result.body).toContain("Sessions: 1 (running 1). Tasks: 1.");
  });

  it("case 15: multi tasks select the latest task_created event for 最終 task", async () => {
    const paths = await setupPaths();
    const sid = SES("X0E");
    const t1 = TASK("T02");
    const t2 = TASK("T03");
    const events =
      taskCreatedLine(sid, "E11", t1, "first task", "2026-05-08T11:00:00+09:00") +
      taskCreatedLine(sid, "E12", t2, "second task", "2026-05-08T14:00:00+09:00");
    await placeSession(paths, { id: sid, status: "running" }, events);
    await placeTaskFile(paths, {
      id: t1,
      title: "first task",
      status: "in_progress",
      createdAt: "2026-05-08T11:00:00+09:00",
      sessionId: sid,
    });
    await placeTaskFile(paths, {
      id: t2,
      title: "second task",
      status: "planned",
      createdAt: "2026-05-08T14:00:00+09:00",
      sessionId: sid,
    });
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.body).toContain(`- Last task: second task (planned) [${SHORT(t2)}]`);
  });

  it("case 15b: latest task_status_changed wins over task_created when both exist", async () => {
    const paths = await setupPaths();
    const sid = SES("X0H");
    const t1 = TASK("T08"); // older task that later gets status-changed to done
    const t2 = TASK("T09"); // newer task_created (would have won under the old logic)
    const events =
      taskCreatedLine(sid, "E17", t1, "older task", "2026-05-08T10:00:00+09:00") +
      taskCreatedLine(sid, "E18", t2, "newer task", "2026-05-08T11:00:00+09:00") +
      taskStatusChangedLine(sid, "E19", t1, "planned", "done", "2026-05-08T12:00:00+09:00");
    await placeSession(paths, { id: sid, status: "running" }, events);
    await placeTaskFile(paths, {
      id: t1,
      title: "older task",
      status: "done",
      createdAt: "2026-05-08T10:00:00+09:00",
      sessionId: sid,
    });
    await placeTaskFile(paths, {
      id: t2,
      title: "newer task",
      status: "planned",
      createdAt: "2026-05-08T11:00:00+09:00",
      sessionId: sid,
    });
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    // The status-change wins: t1 (now done) surfaces in 最終 task, NOT t2.
    expect(result.body).toContain(`- Last task: older task (done) [${SHORT(t1)}]`);
    // t2 collapses to the same short id as t1 in this fixture set, so
    // distinguish by title: the newer task's title must not appear in 現在の状態.
    const stateSection = sliceSection(result.body, "## Current state", "## ");
    expect(stateSection).not.toContain("newer task");
  });

  it("case 15e: task_status_changed without matching task_created falls back to (title unknown)", async () => {
    const paths = await setupPaths();
    const sid = SES("X3A");
    const taskId = TASK("T0C");
    // Only a status_changed event — no task_created in the events stream.
    // This is a legitimate degraded state (e.g. an old events.jsonl trimmed
    // by external tooling, or a status-only import); the renderer must
    // surface a sentinel rather than crash or hide the latest activity.
    const events = taskStatusChangedLine(
      sid,
      "E1C",
      taskId,
      "planned",
      "in_progress",
      "2026-05-08T12:00:00+09:00",
    );
    await placeSession(paths, { id: sid, status: "running" }, events);
    await placeTaskFile(paths, {
      id: taskId,
      title: "task without created event",
      status: "in_progress",
      createdAt: "2026-05-08T10:00:00+09:00",
      sessionId: sid,
    });
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.body).toContain(`- Last task: (title unknown) (in_progress) [${SHORT(taskId)}]`);
  });

  it("case 15c: multi-session task surfaces a (linked_sessions: N) suffix", async () => {
    const paths = await setupPaths();
    // SES suffix avoids the ULID-forbidden letters I / L / O / U.
    const s1 = SES("X0M");
    const s2 = SES("X0N");
    const s3 = SES("X0P");
    const taskId = TASK("T0A");
    const events = taskCreatedLine(
      s1,
      "E1A",
      taskId,
      "spans 3 sessions",
      "2026-05-08T09:00:00+09:00",
    );
    await placeSession(paths, { id: s1, status: "completed" }, events);
    await placeSession(paths, { id: s2, status: "completed" }, "");
    await placeSession(paths, { id: s3, status: "running" }, "");
    await placeTaskFile(paths, {
      id: taskId,
      title: "spans 3 sessions",
      status: "in_progress",
      createdAt: "2026-05-08T09:00:00+09:00",
      sessionId: s1,
      linkedSessions: [s1, s2, s3],
    });
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.body).toContain(
      `- Last task: spans 3 sessions (in_progress, linked_sessions: 3) [${SHORT(taskId)}]`,
    );
  });

  it("case 15d: single-session task omits the linked_sessions suffix", async () => {
    const paths = await setupPaths();
    const sid = SES("X0Q");
    const taskId = TASK("T0B");
    const events = taskCreatedLine(sid, "E1B", taskId, "lone task", "2026-05-08T09:00:00+09:00");
    await placeSession(paths, { id: sid, status: "running" }, events);
    await placeTaskFile(paths, {
      id: taskId,
      title: "lone task",
      status: "planned",
      createdAt: "2026-05-08T09:00:00+09:00",
      sessionId: sid,
      // linkedSessions defaults to [sid] = single-session — suffix MUST NOT appear.
    });
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.body).toContain(`- Last task: lone task (planned) [${SHORT(taskId)}]`);
    expect(result.body).not.toContain("linked_sessions:");
  });

  it("case 16b: latestTask without task.md surfaces 'status unknown'", async () => {
    const paths = await setupPaths();
    const sid = SES("X0G");
    const taskId = TASK("T07");
    // task_created event exists but the corresponding task.md is intentionally
    // NOT placed — the renderer must not fabricate a "planned" status.
    const events = taskCreatedLine(sid, "E16", taskId, "orphaned", "2026-05-08T15:00:00+09:00");
    await placeSession(paths, { id: sid, status: "running" }, events);
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.body).toContain(
      `- Last task: orphaned (status unknown — task.md missing or invalid) [${SHORT(taskId)}]`,
    );
    // The fabricated "planned" status must not leak in: there is no task.md, so
    // no pending task exists and "(planned)" should appear nowhere.
    expect(result.body).not.toContain("(planned)");
  });

  it("case 16: pending list excludes done / cancelled tasks", async () => {
    const paths = await setupPaths();
    const sid = SES("X0F");
    const t1 = TASK("T04");
    const t2 = TASK("T05");
    const t3 = TASK("T06");
    const events =
      taskCreatedLine(sid, "E13", t1, "ongoing", "2026-05-08T11:00:00+09:00") +
      taskCreatedLine(sid, "E14", t2, "completed", "2026-05-08T12:00:00+09:00") +
      taskCreatedLine(sid, "E15", t3, "abandoned", "2026-05-08T13:00:00+09:00");
    await placeSession(paths, { id: sid, status: "running" }, events);
    await placeTaskFile(paths, {
      id: t1,
      title: "ongoing",
      status: "in_progress",
      createdAt: "2026-05-08T11:00:00+09:00",
      sessionId: sid,
    });
    await placeTaskFile(paths, {
      id: t2,
      title: "completed",
      status: "done",
      createdAt: "2026-05-08T12:00:00+09:00",
      sessionId: sid,
    });
    await placeTaskFile(paths, {
      id: t3,
      title: "abandoned",
      status: "cancelled",
      createdAt: "2026-05-08T13:00:00+09:00",
      sessionId: sid,
    });
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.taskCount).toBe(3);
    expect(result.pendingTaskCount).toBe(1);
    // Pending list shows only the in_progress task; done / cancelled excluded.
    // Scope to the section because the latest-activity task (t3, cancelled)
    // still surfaces in 最終 task above with its title.
    const pendingSection = sliceSection(result.body, "## Work to do next", "## ");
    expect(pendingSection).toContain(`- ongoing (in_progress) [${SHORT(t1)}]`);
    expect(pendingSection).not.toContain("completed");
    expect(pendingSection).not.toContain("abandoned");
  });

  it("case 17a: Sessions line splits mixed completed / failed sessions", async () => {
    const paths = await setupPaths();
    const s1 = SES("X1A");
    const s2 = SES("X1B");
    const s3 = SES("X1C");
    const s4 = SES("X1D");
    await placeSession(paths, { id: s1, status: "completed" });
    await placeSession(paths, { id: s2, status: "completed" });
    await placeSession(paths, { id: s3, status: "failed" });
    await placeSession(paths, { id: s4, status: "running" });
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.body).toContain("Sessions: 4 (completed 2, failed 1, running 1). Tasks: 0.");
  });

  it("case 17b: Sessions line omits the breakdown when no sessions exist", async () => {
    const paths = await setupPaths();
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    // Empty workspace → breakdown suppressed, terse line preserved.
    expect(result.body).toContain("Sessions: 0. Tasks: 0.");
    expect(result.body).not.toContain("Sessions: 0 (");
  });

  it("case 17c: Sessions line lists only non-zero statuses", async () => {
    const paths = await setupPaths();
    const s1 = SES("X1E");
    const s2 = SES("X1F");
    const s3 = SES("X1G");
    await placeSession(paths, { id: s1, status: "completed" });
    await placeSession(paths, { id: s2, status: "completed" });
    await placeSession(paths, { id: s3, status: "completed" });
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    // Only "completed" shows, other statuses suppressed.
    expect(result.body).toContain("Sessions: 3 (completed 3). Tasks: 0.");
    expect(result.body).not.toContain("failed 0");
    expect(result.body).not.toContain("running 0");
  });

  it("case 18a: imported session related_files stay out of 直近の変更ファイル", async () => {
    const paths = await setupPaths();
    const liveSid = SES("X2A");
    const importedSid = SES("X2B");
    await placeSession(paths, {
      id: liveSid,
      status: "completed",
      relatedFiles: ["src/live-only.ts"],
    });
    await placeSession(paths, {
      id: importedSid,
      status: "imported",
      source: "import",
      relatedFiles: ["src/imported-from-elsewhere.ts"],
    });
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    const filesSection = sliceSection(result.body, "## Recently changed files", "## ");
    expect(filesSection).toContain("- src/live-only.ts");
    expect(filesSection).not.toContain("src/imported-from-elsewhere.ts");
  });

  it("case 18b: imported sessions surface in a separate Imported sessions subsection", async () => {
    const paths = await setupPaths();
    const liveSid = SES("X2C");
    const importedSid = SES("X2D");
    await placeSession(paths, {
      id: liveSid,
      status: "completed",
      label: "live work",
    });
    await placeSession(paths, {
      id: importedSid,
      status: "imported",
      source: "import",
      label: "from-external",
    });
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    // Live session row sits under the main table, imported session under the
    // separated subsection.
    expect(result.body).toContain("## Sessions");
    expect(result.body).toContain("### Imported sessions");
    const importedSection = sliceSection(result.body, "### Imported sessions", "Sessions:");
    expect(importedSection).toContain("from-external");
    const liveSection = sliceSection(result.body, "## Sessions", "### Imported sessions");
    expect(liveSection).toContain("live work");
    expect(liveSection).not.toContain("from-external");
  });
});

// Resume coherence (HypArt triage): handoff must carry a staleness caveat on a
// trailing decision (F-A, which handoff previously lacked entirely), represent
// 最終 session with a substantive session (F-B), and flag a cross-session
// decision (F-C). SES/EVT/DEC suffixes must be 3 Crockford chars (no I/L/O/U).
describe("renderHandoff (resume coherence)", () => {
  it("F-A: a trailing (stale) latest decision carries a staleness caveat", async () => {
    const paths = await setupPaths();
    const s = SES("HA1");
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
      decisionRecordedLine(s, "HA1", DEC("HA1"), "apply migration?", "2026-05-08T12:00:00Z"),
    );
    const { body } = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(body).toContain("the latest activity postdates this decision");
    expect(body).toContain("confirm the continuation point");
  });

  it("F-A: a fresh latest decision carries no staleness caveat", async () => {
    const paths = await setupPaths();
    const s = SES("HA2");
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
      decisionRecordedLine(s, "HA2", DEC("HA2"), "use pnpm", "2026-05-08T12:00:00Z"),
    );
    const { body } = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(body).toContain("use pnpm");
    expect(body).not.toContain("the latest activity postdates this decision");
  });

  it("F-B: 最終 session is the substantive session, not a newer empty resume session", async () => {
    const paths = await setupPaths();
    const work = SES("HWK");
    const resume = SES("HRS");
    await placeSession(paths, {
      id: work,
      status: "completed",
      source: "claude-code-import",
      startedAt: "2026-05-08T09:00:00Z",
      relatedFiles: ["src/a.ts"],
      label: "real work",
    });
    await placeSession(paths, {
      id: resume,
      status: "completed",
      source: "claude-code-import",
      startedAt: "2026-05-08T11:00:00Z",
      relatedFiles: [],
      label: "bare resume",
    });
    const { body } = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    // The 現在の状態 section's 最終 session line should name the substantive session.
    const stateSection = body.slice(body.indexOf("## Current state"));
    expect(stateSection).toContain("Last session: real work");
    expect(stateSection).not.toContain("Last session: bare resume");
    // 直近の変更ファイル is coupled to 最終 session, so it shows the substantive
    // session's files (not the bare resume's empty list).
    const filesSection = sliceSection(body, "## Recently changed files", "## ");
    expect(filesSection).toContain("src/a.ts");
    expect(filesSection).not.toContain("(no related files recorded)");
  });

  it("F-C: flags when the latest decision is from a different session than 最終 session", async () => {
    const paths = await setupPaths();
    const work = SES("HC2"); // substantive + newest -> 最終 session
    const older = SES("HP2"); // prior session that holds the decision
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
      decisionRecordedLine(older, "HE2", DEC("HD2"), "an older decision", "2026-05-08T09:30:00Z"),
    );
    const { body } = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(body).toContain("this decision comes from a different session");
  });
});

function decisionVoidedLine(
  id: string,
  evt: string,
  decisionId: string,
  occurredAt: string,
  reason?: string,
): string {
  return `${JSON.stringify({
    schema_version: "0.1.0",
    type: "decision_voided",
    id: EVT(evt),
    session_id: id,
    occurred_at: occurredAt,
    source: "local-cli",
    decision_id: decisionId,
    ...(reason !== undefined ? { reason } : {}),
  })}\n`;
}

describe("renderHandoff (voided decisions)", () => {
  it("skips a voided decision when surfacing 直近の判断", async () => {
    const paths = await setupPaths();
    const id = SES("VH1");
    const kept = DEC("HK1");
    const voided = DEC("HV1");
    const events =
      decisionRecordedLine(id, "HE1", kept, "keep this direction", "2026-05-08T10:00:00.000Z") +
      decisionRecordedLine(
        id,
        "HE2",
        voided,
        "wrong project decision",
        "2026-05-08T11:00:00.000Z",
      ) +
      decisionVoidedLine(id, "HE3", voided, "2026-05-08T12:00:00.000Z", "belongs to blog");
    await placeSession(
      paths,
      {
        id,
        status: "completed",
        source: "claude-code-import",
        startedAt: "2026-05-08T09:00:00+09:00",
      },
      events,
    );
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.body).toContain("keep this direction");
    expect(result.body).not.toContain("wrong project decision");
    // Both decisions still counted in the total.
    expect(result.body).toContain("2 decisions total");
  });
});

describe("renderHandoff (open tracks)", () => {
  it("surfaces an open track with its rationale in a 未完トラック section", async () => {
    const paths = await setupPaths();
    const id = SES("HT1");
    await placeSession(
      paths,
      {
        id,
        status: "completed",
        source: "claude-code-import",
        startedAt: "2026-05-08T09:00:00+09:00",
      },
      decisionRecordedLine(
        id,
        "HT1",
        DEC("HT1"),
        "admin form coverage",
        "2026-05-08T10:00:00.000Z",
        {
          kind: "track",
          rationale: "raw JSON is a stopgap",
        },
      ),
    );
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.body).toContain("## Open tracks (shown until closed)");
    expect(result.body).toContain("admin form coverage");
    expect(result.body).toContain("Why: raw JSON is a stopgap");
    expect(result.body).toContain("basou decision void");
  });

  it("an open track survives a LATER plain decision (the intent-leak regression)", async () => {
    const paths = await setupPaths();
    const id = SES("HT5");
    const events =
      decisionRecordedLine(
        id,
        "HT6",
        DEC("HT6"),
        "the strategic track",
        "2026-05-08T10:00:00.000Z",
        {
          kind: "track",
        },
      ) +
      // A newer PLAIN decision: under the old model this became 直近の判断 and the
      // track sank into the flat list. The track must still surface.
      decisionRecordedLine(
        id,
        "HT7",
        DEC("HT7"),
        "a later tactical call",
        "2026-05-08T12:00:00.000Z",
      );
    await placeSession(
      paths,
      {
        id,
        status: "completed",
        source: "claude-code-import",
        startedAt: "2026-05-08T09:00:00+09:00",
      },
      events,
    );
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    // Both coexist: the track in its own section, the later decision as 直近の判断.
    expect(result.body).toContain("## Open tracks");
    expect(result.body).toContain("the strategic track");
    expect(result.body).toContain("a later tactical call");
  });

  it("omits the 未完トラック section once the track is voided", async () => {
    const paths = await setupPaths();
    const id = SES("HT2");
    const did = DEC("HT2");
    const events =
      decisionRecordedLine(id, "HT2", did, "closed track", "2026-05-08T10:00:00.000Z", {
        kind: "track",
      }) + decisionVoidedLine(id, "HT3", did, "2026-05-08T11:00:00.000Z", "shipped");
    await placeSession(
      paths,
      {
        id,
        status: "completed",
        source: "claude-code-import",
        startedAt: "2026-05-08T09:00:00+09:00",
      },
      events,
    );
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.body).not.toContain("## Open tracks");
    expect(result.body).not.toContain("closed track");
  });

  it("a plain decision does not produce a 未完トラック section", async () => {
    const paths = await setupPaths();
    const id = SES("HT3");
    await placeSession(
      paths,
      {
        id,
        status: "completed",
        source: "claude-code-import",
        startedAt: "2026-05-08T09:00:00+09:00",
      },
      decisionRecordedLine(id, "HT4", DEC("HT4"), "ordinary decision", "2026-05-08T10:00:00.000Z"),
    );
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.body).not.toContain("## Open tracks");
  });
});

describe("renderHandoff (view language)", () => {
  it("renders Japanese chrome when the manifest anchor declares language: ja", async () => {
    const paths = await setupPaths();
    const manifest = createManifest({ workspaceName: "fixture" });
    manifest.repos = [{ path: ".", language: "ja" }];
    await writeManifest(paths, manifest);
    await placeSession(paths, { id: SES("S01"), status: "completed" });
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.body).toContain("## 現在の状態");
    expect(result.body).toContain("## 直近の変更ファイル");
    expect(result.body).toContain("## 直近の判断");
    expect(result.body).toContain("## 未決事項");
    expect(result.body).toContain("## 次に読むべきファイル");
    expect(result.body).toContain("## 次に実行すべき作業");
    expect(result.body).toContain("## セッション一覧");
    expect(result.body).toContain("- 最終 session: ");
  });
});
