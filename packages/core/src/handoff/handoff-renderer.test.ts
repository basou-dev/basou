import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { type BasouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";
import { renderHandoff } from "./handoff-renderer.js";

const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const FIXED_NOW_ISO = "2026-05-09T03:00:00.000Z";

// 23-char Crockford body + 3-char suffix = 26-char ULID body.
const SES = (s: string): string => `ses_01HXABCDEF1234567890ABC${s}`;
const EVT = (s: string): string => `evt_01HXABCDEF1234567890ABC${s}`;
const DEC = (s: string): string => `decision_01HXABCDEF1234567890ABC${s}`;
const APPR = (s: string): string => `appr_01HXABCDEF1234567890ABC${s}`;

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
    // read section deliberately reuses `displayedFiles.slice(0, 3)` (Codex#2
    // Y3q-X2), so a global count would over-report by design.
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
    expect(result.body).toContain("Sessions: 1.");
  });

  it("case 12: nowIso is reflected in the generated_at header", async () => {
    const paths = await setupPaths();
    const customNow = "2026-12-31T23:59:59.000Z";
    const result = await renderHandoff({ paths, nowIso: customNow });
    expect(result.body).toContain(`> Generated at ${customNow}`);
  });
});
