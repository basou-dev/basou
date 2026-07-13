import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import type { SessionSourceKind } from "../schemas/index.js";
import { type BasouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";
import { createManifest, writeManifest } from "../storage/manifest.js";
import { renderReport } from "./report-renderer.js";

const WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const NOW_ISO = "2026-05-09T03:00:00.000Z";
const TZ = "UTC";

const SES = (s: string): string => `ses_01HXABCDEF1234567890ABC${s}`;
const EVT = (s: string): string => `evt_01HXABCDEF1234567890ABC${s}`;
const DEC = (s: string): string => `decision_01HXABCDEF1234567890ABC${s}`;
const TASK = (s: string): string => `task_01HXABCDEF1234567890ABC${s}`;
const APPR = (s: string): string => `appr_01HXABCDEF1234567890ABC${s}`;

let workDir: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "basou-report-test-"));
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
    startedAt: string;
    endedAt?: string;
    sourceKind?: SessionSourceKind;
    relatedFiles?: string[];
    events?: string;
  },
): Promise<void> {
  const sessionDir = join(paths.sessions, fixture.id);
  await mkdir(sessionDir, { recursive: true });
  const inner: Record<string, unknown> = {
    id: fixture.id,
    label: `fixture ${fixture.id.slice(-3)}`,
    task_id: null,
    workspace_id: WS_ID,
    source: { kind: fixture.sourceKind ?? "terminal", version: "0.1.0" },
    started_at: fixture.startedAt,
    status: "completed",
    working_directory: "/tmp/fixture",
    invocation: { command: "echo", args: [], exit_code: 0 },
    related_files: fixture.relatedFiles ?? [],
    events_log: "events.jsonl",
  };
  if (fixture.endedAt !== undefined) inner.ended_at = fixture.endedAt;
  await writeFile(
    join(sessionDir, "session.yaml"),
    stringify({ schema_version: "0.1.0", session: inner }),
  );
  if (fixture.events !== undefined) {
    await writeFile(join(sessionDir, "events.jsonl"), fixture.events);
  }
}

function startedLine(sessionId: string, evt: string, occurredAt: string): string {
  return `${JSON.stringify({
    schema_version: "0.1.0",
    type: "session_started",
    id: EVT(evt),
    session_id: sessionId,
    occurred_at: occurredAt,
    source: "terminal-recording",
  })}\n`;
}

function decisionLine(
  sessionId: string,
  evt: string,
  decisionId: string,
  title: string,
  occurredAt: string,
  opts?: { kind?: "decision" | "track" },
): string {
  return `${JSON.stringify({
    schema_version: "0.1.0",
    type: "decision_recorded",
    id: EVT(evt),
    session_id: sessionId,
    occurred_at: occurredAt,
    source: "human",
    decision_id: decisionId,
    title,
    ...(opts?.kind !== undefined ? { kind: opts.kind } : {}),
  })}\n`;
}

async function placeTask(
  paths: BasouPaths,
  fixture: { id: string; title: string; status: string; createdAt: string; sessionId: string },
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
      linked_sessions: [fixture.sessionId],
    },
  });
  await writeFile(join(paths.tasks, `${fixture.id}.md`), `---\n${yaml}---\n\n`);
}

async function placeApproval(
  paths: BasouPaths,
  fixture: {
    id: string;
    sessionId: string;
    status: "pending" | "approved" | "rejected" | "expired";
    reason: string;
    riskLevel?: "low" | "medium" | "high" | "critical";
    resolved?: boolean;
  },
): Promise<void> {
  const dir = fixture.resolved ? paths.approvals.resolved : paths.approvals.pending;
  const resolved = fixture.status !== "pending";
  const yaml = stringify({
    schema_version: "0.1.0",
    id: fixture.id,
    session_id: fixture.sessionId,
    created_at: "2026-05-04T09:00:00.000Z",
    status: fixture.status,
    risk_level: fixture.riskLevel ?? "medium",
    action: { kind: "command", command: "echo hi" },
    reason: fixture.reason,
    expires_at: null,
    resolver: resolved ? "human" : null,
    resolved_at: resolved ? "2026-05-04T09:05:00.000Z" : null,
    note: null,
    rejection_reason: null,
  });
  await writeFile(join(dir, `${fixture.id}.yaml`), yaml);
}

async function seedPopulated(paths: BasouPaths): Promise<void> {
  // Two non-import sessions carrying decisions + related files.
  await placeSession(paths, {
    id: SES("0A1"),
    startedAt: "2026-05-04T09:00:00.000Z",
    endedAt: "2026-05-04T10:00:00.000Z",
    sourceKind: "terminal",
    relatedFiles: ["src/b.ts", "src/a.ts"],
    events:
      startedLine(SES("0A1"), "E01", "2026-05-04T09:00:00.000Z") +
      decisionLine(SES("0A1"), "E02", DEC("D01"), "Decision A", "2026-05-04T09:30:00.000Z"),
  });
  await placeSession(paths, {
    id: SES("0B1"),
    startedAt: "2026-05-05T09:00:00.000Z",
    endedAt: "2026-05-05T09:30:00.000Z",
    sourceKind: "codex-import",
    relatedFiles: ["src/c.ts"],
    events: decisionLine(SES("0B1"), "E03", DEC("D02"), "Decision B", "2026-05-05T09:10:00.000Z"),
  });
  // A round-trip import session: its related files MUST be excluded. [Codex #4]
  await placeSession(paths, {
    id: SES("0C1"),
    startedAt: "2026-05-03T09:00:00.000Z",
    endedAt: "2026-05-03T09:10:00.000Z",
    sourceKind: "import",
    relatedFiles: ["vendor/imported.ts"],
    events: startedLine(SES("0C1"), "E04", "2026-05-03T09:00:00.000Z"),
  });

  await placeTask(paths, {
    id: TASK("T01"),
    title: "Ship the report command",
    status: "done",
    createdAt: "2026-05-04T09:00:00.000Z",
    sessionId: SES("0A1"),
  });

  await placeApproval(paths, {
    id: APPR("AP1"),
    sessionId: SES("0A1"),
    status: "pending",
    reason: "Approve the deploy",
  });
  await placeApproval(paths, {
    id: APPR("AP2"),
    sessionId: SES("0A1"),
    status: "approved",
    reason: "Approve the migration",
    resolved: true,
  });
}

describe("report-renderer", () => {
  it("renders placeholders and zeroed data for an empty workspace", async () => {
    const paths = await setupPaths();
    const { body, data } = await renderReport({ paths, nowIso: NOW_ISO, timeZone: TZ });

    expect(body).toContain("# Report");
    expect(body).toContain("(no sessions yet)");
    expect(body).toContain("(no decisions recorded yet)");
    expect(body).toContain("(no tasks recorded yet)");
    expect(body).toContain("(no related files recorded)");
    expect(data.sessions.total).toBe(0);
    expect(data.decisions.count).toBe(0);
    expect(data.integrity.total).toBe(0);
    expect(data.period).toEqual({ from: null, to: null });
    // Deterministic timezone is threaded into the stats figures. [Codex #5]
    expect(data.time.timeZone).toBe(TZ);
  });

  it("composes sections, counts, and the curated data for a populated workspace", async () => {
    const paths = await setupPaths();
    await seedPopulated(paths);
    const { body, data } = await renderReport({
      paths,
      nowIso: NOW_ISO,
      title: "Client X",
      timeZone: TZ,
    });

    // Title + all sections present.
    expect(body).toContain("# Report — Client X");
    for (const h of [
      "## Summary",
      "## Work volume",
      "## Decisions",
      "## Approvals",
      "## Tasks",
      "## Changed files",
      "## Sessions",
      "## Integrity",
    ]) {
      expect(body).toContain(h);
    }

    // Sessions + decisions.
    expect(data.sessions.total).toBe(3);
    expect(data.decisions.count).toBe(2);
    expect(body).toContain("Decision A");
    expect(body).toContain("Decision B");

    // Changed files: union of NON-import sessions only, sorted; import excluded.
    expect(data.changedFiles).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(data.changedFiles).not.toContain("vendor/imported.ts");
    expect(body).not.toContain("vendor/imported.ts");

    // Tasks + approvals.
    expect(data.tasks.total).toBe(1);
    expect(data.tasks.byStatus).toEqual([{ status: "done", count: 1 }]);
    expect(data.approvals.pending).toBe(1);
    expect(data.approvals.approved).toBe(1);
    expect(body).toContain("Approve the deploy");

    // Period spans every session (imports included).
    expect(data.period.from).toBe("2026-05-03T09:00:00.000Z");
    expect(data.period.to).toBe("2026-05-05T09:30:00.000Z");
  });

  it("tallies integrity verdicts and stays neutral (no 'billable', honest caveat)", async () => {
    const paths = await setupPaths();
    await seedPopulated(paths);
    const { body, data } = await renderReport({ paths, nowIso: NOW_ISO, timeZone: TZ });

    // All three seeded sessions are plain (anchor-less) logs => unchained.
    expect(data.integrity.total).toBe(3);
    expect(data.integrity.unchained).toBe(3);
    expect(data.integrity.tampered).toBe(0);
    expect(body).toContain("0 tampered (of 3 sessions)");
    expect(body).toContain("not a third-party cryptographic proof");

    // Neutral-export framing: the field/heading surface never says "billable".
    expect(JSON.stringify(data)).not.toMatch(/billable/i);
    expect(body).not.toMatch(/billable/i);
  });

  it("skips an unreadable session from the integrity tally and still renders", async () => {
    const paths = await setupPaths();
    await placeSession(paths, {
      id: SES("0A1"),
      startedAt: "2026-05-04T09:00:00.000Z",
      sourceKind: "terminal",
      events: startedLine(SES("0A1"), "E01", "2026-05-04T09:00:00.000Z"),
    });
    // A session whose events.jsonl is a DIRECTORY: readFile throws EISDIR (a
    // non-ENOENT I/O error), which verifyEventsChain surfaces by throwing.
    await placeSession(paths, { id: SES("0X1"), startedAt: "2026-05-04T08:00:00.000Z" });
    await mkdir(join(paths.sessions, SES("0X1"), "events.jsonl"), { recursive: true });

    const skips: Array<{ id: string; reason: string }> = [];
    const { data } = await renderReport({
      paths,
      nowIso: NOW_ISO,
      timeZone: TZ,
      onSessionSkip: (id, reason) => skips.push({ id, reason }),
    });

    // Both sessions load, but only the healthy one is verifiable: the bad one
    // is left out of the tally (a successful render must not be aborted).
    expect(data.sessions.total).toBe(2);
    expect(data.integrity.total).toBe(1);
    expect(data.integrity.unchained).toBe(1);
    expect(skips.some((s) => s.id === SES("0X1") && s.reason === "events_jsonl_unreadable")).toBe(
      true,
    );
  });

  it("clamps a clock-skewed session so the period window is not reversed", async () => {
    const paths = await setupPaths();
    await placeSession(paths, {
      id: SES("0S1"),
      startedAt: "2026-05-05T10:00:00.000Z",
      endedAt: "2026-05-05T09:00:00.000Z", // ended before started (skew)
      sourceKind: "terminal",
      events: startedLine(SES("0S1"), "E01", "2026-05-05T10:00:00.000Z"),
    });
    const { data } = await renderReport({ paths, nowIso: NOW_ISO, timeZone: TZ });
    expect(data.period.from).toBe("2026-05-05T10:00:00.000Z");
    expect(data.period.to).toBe("2026-05-05T10:00:00.000Z"); // clamped, not reversed
  });
});

function voidedLine(
  sessionId: string,
  evt: string,
  decisionId: string,
  occurredAt: string,
): string {
  return `${JSON.stringify({
    schema_version: "0.1.0",
    type: "decision_voided",
    id: EVT(evt),
    session_id: sessionId,
    occurred_at: occurredAt,
    source: "local-cli",
    decision_id: decisionId,
    reason: "belongs to blog",
  })}\n`;
}

describe("renderReport (voided decisions)", () => {
  it("annotates a voided decision and leaves others clean", async () => {
    const paths = await setupPaths();
    const sid = SES("R01");
    const kept = DEC("RK1");
    const voided = DEC("RV1");
    await placeSession(paths, {
      id: sid,
      startedAt: "2026-05-08T09:00:00.000Z",
      events:
        decisionLine(sid, "RE1", kept, "kept direction", "2026-05-08T10:00:00.000Z") +
        decisionLine(sid, "RE2", voided, "retracted direction", "2026-05-08T11:00:00.000Z") +
        voidedLine(sid, "RE3", voided, "2026-05-08T12:00:00.000Z"),
    });
    const { body, data } = await renderReport({ paths, nowIso: NOW_ISO, timeZone: TZ });
    expect(body).toContain("retracted direction (voided)");
    expect(body).toContain("kept direction");
    expect(body).not.toContain("kept direction (voided)");
    expect(data.decisions.items.find((d) => d.id === voided)?.voided).toBe(true);
    expect(data.decisions.items.find((d) => d.id === kept)?.voided).toBeUndefined();
  });
});

describe("renderReport (track decisions)", () => {
  it("tags a track decision [track]; a plain decision is untagged", async () => {
    const paths = await setupPaths();
    const sid = SES("R02");
    const track = DEC("RT1");
    const plain = DEC("RP1");
    await placeSession(paths, {
      id: sid,
      startedAt: "2026-05-08T09:00:00.000Z",
      events:
        decisionLine(sid, "RT1", track, "admin form coverage", "2026-05-08T10:00:00.000Z", {
          kind: "track",
        }) + decisionLine(sid, "RP1", plain, "ordinary call", "2026-05-08T11:00:00.000Z"),
    });
    const { body, data } = await renderReport({ paths, nowIso: NOW_ISO, timeZone: TZ });
    expect(body).toContain("admin form coverage [track]");
    expect(body).toContain("ordinary call");
    expect(body).not.toContain("ordinary call [track]");
    expect(data.decisions.items.find((d) => d.id === track)?.track).toBe(true);
    expect(data.decisions.items.find((d) => d.id === plain)?.track).toBeUndefined();
  });
});

describe("renderReport (view language)", () => {
  it("renders Japanese section headings when the manifest anchor declares language: ja", async () => {
    const paths = await setupPaths();
    const manifest = createManifest({ workspaceName: "fixture" });
    manifest.repos = [{ path: ".", language: "ja" }];
    await writeManifest(paths, manifest, { force: true });
    await placeSession(paths, { id: SES("S01"), startedAt: "2026-05-08T11:00:00Z" });
    const { body } = await renderReport({ paths, nowIso: NOW_ISO, timeZone: "UTC" });
    for (const h of [
      "## 概要",
      "## 作業量",
      "## 判断",
      "## 承認",
      "## タスク",
      "## 変更ファイル",
      "## セッション一覧",
      "## 整合性",
    ]) {
      expect(body).toContain(h);
    }
  });
});
