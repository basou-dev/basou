import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import type { TaskStatus } from "../schemas/task.schema.js";
import { type BasouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";
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
  source?: "claude-code-adapter" | "human" | "import" | "terminal";
  label?: string;
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
    expect(result.body).toContain(`from ${id}..${id}`);
  });

  it("case 3: aggregates related_files across sessions and dedups", async () => {
    const paths = await setupPaths();
    await placeSession(paths, {
      id: SES("X02"),
      relatedFiles: ["src/a.ts", "src/b.ts"],
    });
    await placeSession(paths, {
      id: SES("X03"),
      relatedFiles: ["src/b.ts", "src/c.ts"],
      startedAt: "2026-05-08T12:00:00+09:00",
    });
    const result = await renderHandoff({ paths, nowIso: FIXED_NOW_ISO });
    expect(result.sessionCount).toBe(2);
    // dedup + sort asc, scoped to the 直近の変更ファイル section. The next-to-
    // read section deliberately reuses `displayedFiles.slice(0, 3)`, so a
    // global count would over-report by design.
    const recentSection = sliceSection(result.body, "## 直近の変更ファイル", "##");
    const idxA = recentSection.indexOf("- src/a.ts");
    const idxB = recentSection.indexOf("- src/b.ts");
    const idxC = recentSection.indexOf("- src/c.ts");
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThan(idxA);
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
    expect(result.body).toContain(`- ${dec3}: third`);
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
    expect(result.body).toContain(`- 最終 session: ${id} (completed)`);
    expect(result.body).toContain("- src/x.ts");
    expect(result.body).toContain(`- ${dec}: pick A`);
    expect(result.body).toContain("| short_id | status | started_at | label |");
    expect(result.body).toContain("Sessions: 1 (completed 1). Tasks: 0.");
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
    expect(result.body).toContain("- 最終 task: (no tasks recorded yet)");
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
    expect(result.body).toContain(`- 最終 task: ${taskId} (planned): form revamp`);
    expect(result.body).toContain(`- ${taskId} (planned): form revamp`);
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
    expect(result.body).toContain(`- 最終 task: ${t2} (planned): second task`);
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
    expect(result.body).toContain(`- 最終 task: ${t1} (done): older task`);
    expect(result.body).not.toContain(`- 最終 task: ${t2}`);
  });

  it("case 15c: multi-session task surfaces a (linked_sessions: N) suffix", async () => {
    const paths = await setupPaths();
    // SES suffix avoids the ULID-forbidden letters I / L / O / U.
    const s1 = SES("X0M");
    const s2 = SES("X0N");
    const s3 = SES("X0P");
    const taskId = TASK("T0A");
    const events = taskCreatedLine(s1, "E1A", taskId, "spans 3 sessions", "2026-05-08T09:00:00+09:00");
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
      `- 最終 task: ${taskId} (in_progress): spans 3 sessions (linked_sessions: 3)`,
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
    expect(result.body).toContain(`- 最終 task: ${taskId} (planned): lone task`);
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
      `- 最終 task: ${taskId} (status unknown — task.md missing or invalid): orphaned`,
    );
    expect(result.body).not.toContain(`- 最終 task: ${taskId} (planned):`);
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
    expect(result.body).toContain(`- ${t1} (in_progress): ongoing`);
    expect(result.body).not.toMatch(new RegExp(`- ${t2} `));
    expect(result.body).not.toMatch(new RegExp(`- ${t3} `));
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
});
