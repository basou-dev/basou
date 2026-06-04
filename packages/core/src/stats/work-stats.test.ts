import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import type {
  SessionMetrics,
  SessionSourceKind,
  SessionStatus,
} from "../schemas/session.schema.js";
import { type BasouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";
import { ACTIVE_GAP_CAP_MS, computeWorkStats } from "./work-stats.js";

const WS_ID = "ws_01HXABCDEF1234567890ABCDEF";
const NOW = new Date("2026-05-10T12:00:00.000Z");

let workDir: string | undefined;
let evtCounter = 0;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "basou-workstats-test-"));
  evtCounter = 0;
});
afterEach(async () => {
  if (workDir !== undefined) await rm(workDir, { recursive: true, force: true });
  workDir = undefined;
});

function getWorkDir(): string {
  if (workDir === undefined) throw new Error("workDir not initialized");
  return workDir;
}

function evtId(): string {
  // 26-char ULID body: 23 fixed + 3-digit counter.
  const n = String(evtCounter++).padStart(3, "0");
  return `evt_01HXABCDEF1234567890ABC${n}`;
}

type SessionFixture = {
  id: string;
  status?: SessionStatus;
  source?: SessionSourceKind;
  startedAt?: string;
  endedAt?: string;
  metrics?: SessionMetrics;
};

async function placeSession(
  paths: BasouPaths,
  fixture: SessionFixture,
  events?: string,
): Promise<string> {
  const sessionDir = join(paths.sessions, fixture.id);
  await mkdir(sessionDir, { recursive: true });
  const yaml = stringify({
    schema_version: "0.1.0",
    session: {
      id: fixture.id,
      workspace_id: WS_ID,
      source: { kind: fixture.source ?? "codex-import", version: "0.1.0" },
      started_at: fixture.startedAt ?? "2026-05-10T00:00:00.000Z",
      ...(fixture.endedAt !== undefined ? { ended_at: fixture.endedAt } : {}),
      status: fixture.status ?? "imported",
      working_directory: "/tmp/fixture",
      invocation: { command: "codex", args: [], exit_code: null },
      related_files: [],
      events_log: "events.jsonl",
      ...(fixture.metrics !== undefined ? { metrics: fixture.metrics } : {}),
    },
  });
  await writeFile(join(sessionDir, "session.yaml"), yaml);
  if (events !== undefined) await writeFile(join(sessionDir, "events.jsonl"), events);
  return sessionDir;
}

function line(obj: Record<string, unknown>): string {
  return `${JSON.stringify({ schema_version: "0.1.0", id: evtId(), source: "codex-import", ...obj })}\n`;
}
function started(id: string, at: string): string {
  return line({ type: "session_started", session_id: id, occurred_at: at });
}
function ended(id: string, at: string): string {
  return line({ type: "session_ended", session_id: id, occurred_at: at });
}
function command(id: string, at: string, durationMs: number): string {
  return line({
    type: "command_executed",
    session_id: id,
    occurred_at: at,
    command: "bash",
    args: ["-c", "ls"],
    cwd: "/tmp/fixture",
    exit_code: 0,
    duration_ms: durationMs,
  });
}
function fileChanged(id: string, at: string): string {
  return line({
    type: "file_changed",
    session_id: id,
    occurred_at: at,
    path: "/tmp/fixture/a.ts",
    change_type: "modified",
  });
}

describe("computeWorkStats", () => {
  it("returns all-zero totals for an empty workspace", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    const result = await computeWorkStats({ paths, now: NOW });
    expect(result.sessions).toHaveLength(0);
    expect(result.totals.sessionCount).toBe(0);
    expect(result.totals.commandTimeReliable).toBe(true);
    expect(result.totals.tokensAvailable).toBe(false);
    expect(result.totals.billableActiveTimeMs).toBe(0);
    expect(result.byDay).toHaveLength(0);
    expect(result.activeGapCapMs).toBe(ACTIVE_GAP_CAP_MS);
    expect(result.generatedAt).toBe(NOW.toISOString());
  });

  it("aggregates a codex session with real command time and token metrics", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    const id = "ses_01HXABCDEF1234567890ABCDE1";
    await placeSession(
      paths,
      {
        id,
        source: "codex-import",
        startedAt: "2026-05-10T00:00:00.000Z",
        endedAt: "2026-05-10T00:10:00.000Z",
        metrics: { output_tokens: 5000, input_tokens: 20000, reasoning_output_tokens: 800 },
      },
      started(id, "2026-05-10T00:00:00.000Z") +
        command(id, "2026-05-10T00:00:30.000Z", 1500) +
        fileChanged(id, "2026-05-10T00:01:00.000Z") +
        ended(id, "2026-05-10T00:10:00.000Z"),
    );
    const r = await computeWorkStats({ paths, now: NOW });
    expect(r.sessions).toHaveLength(1);
    const s = r.sessions[0];
    expect(s?.commandCount).toBe(1);
    expect(s?.fileChangedCount).toBe(1);
    expect(s?.commandTimeMs).toBe(1500);
    expect(s?.sessionSpanMs).toBe(10 * 60 * 1000);
    expect(s?.tokens.output).toBe(5000);
    expect(s?.tokens.reasoning).toBe(800);
    expect(s?.availability.commandTime).toBe(true);
    expect(s?.availability.tokens).toBe(true);
    // No stored engaged-time intervals: active time falls back to the events.
    expect(s?.activeTimeBasis).toBe("events");
    expect(r.totals.commandTimeReliable).toBe(true);
    expect(r.totals.tokensAvailable).toBe(true);
  });

  it("flags claude-code-import: zero command time is not reliable, tokens still count", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    const id = "ses_01HXABCDEF1234567890ABCDE2";
    await placeSession(
      paths,
      {
        id,
        source: "claude-code-import",
        startedAt: "2026-05-10T00:00:00.000Z",
        endedAt: "2026-05-10T00:05:00.000Z",
        metrics: { output_tokens: 800000 },
      },
      started(id, "2026-05-10T00:00:00.000Z") +
        command(id, "2026-05-10T00:01:00.000Z", 0) +
        ended(id, "2026-05-10T00:05:00.000Z"),
    );
    const r = await computeWorkStats({ paths, now: NOW });
    const s = r.sessions[0];
    expect(s?.commandTimeMs).toBe(0);
    expect(s?.availability.commandTime).toBe(false);
    expect(s?.tokens.output).toBe(800000);
    expect(s?.availability.tokens).toBe(true);
    expect(r.totals.commandTimeReliable).toBe(false);
  });

  it("measures a running session (no ended_at) up to now and flags it open", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    const id = "ses_01HXABCDEF1234567890ABCDE3";
    await placeSession(
      paths,
      { id, status: "running", startedAt: "2026-05-10T11:00:00.000Z" },
      started(id, "2026-05-10T11:00:00.000Z"),
    );
    const r = await computeWorkStats({ paths, now: NOW });
    const s = r.sessions[0];
    expect(s?.open).toBe(true);
    expect(s?.sessionSpanMs).toBe(60 * 60 * 1000); // 11:00 -> 12:00 (now)
    expect(r.totals.openSessionCount).toBe(1);
  });

  it("caps a long idle gap and sorts unsorted events for active time", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    const id = "ses_01HXABCDEF1234567890ABCDE4";
    // Events out of order on disk: a 1s gap then a 30-min gap. Active time =
    // 1s + capped 5m, regardless of file order.
    await placeSession(
      paths,
      { id, endedAt: "2026-05-10T00:31:00.000Z" },
      command(id, "2026-05-10T00:30:01.000Z", 0) + // later, written first
        command(id, "2026-05-10T00:00:00.000Z", 0) +
        command(id, "2026-05-10T00:00:01.000Z", 0),
    );
    const r = await computeWorkStats({ paths, now: NOW });
    const s = r.sessions[0];
    expect(s?.activeTimeMs).toBe(1000 + ACTIVE_GAP_CAP_MS);
  });

  it("clamps a negative span (clock skew) to zero and flags it", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    const id = "ses_01HXABCDEF1234567890ABCDE5";
    await placeSession(paths, {
      id,
      startedAt: "2026-05-10T00:10:00.000Z",
      endedAt: "2026-05-10T00:00:00.000Z",
    });
    const r = await computeWorkStats({ paths, now: NOW });
    const s = r.sessions[0];
    expect(s?.sessionSpanMs).toBe(0);
    expect(s?.spanClamped).toBe(true);
  });

  it("has activeTime 0 and unavailable for a session with fewer than 2 events", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    const id = "ses_01HXABCDEF1234567890ABCDE6";
    await placeSession(
      paths,
      { id, endedAt: "2026-05-10T00:05:00.000Z" },
      started(id, "2026-05-10T00:00:00.000Z"),
    );
    const r = await computeWorkStats({ paths, now: NOW });
    const s = r.sessions[0];
    expect(s?.activeTimeMs).toBe(0);
    expect(s?.availability.activeTime).toBe(false);
  });

  it("breaks down by source and marks mixed command-time reliability", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    const codexId = "ses_01HXABCDEF1234567890ABCDE7";
    const claudeId = "ses_01HXABCDEF1234567890ABCDE8";
    await placeSession(
      paths,
      { id: codexId, source: "codex-import", endedAt: "2026-05-10T00:05:00.000Z" },
      command(codexId, "2026-05-10T00:00:00.000Z", 2000),
    );
    await placeSession(
      paths,
      { id: claudeId, source: "claude-code-import", endedAt: "2026-05-10T00:05:00.000Z" },
      command(claudeId, "2026-05-10T00:00:00.000Z", 0),
    );
    const r = await computeWorkStats({ paths, now: NOW });
    expect(r.bySource).toHaveLength(2);
    const codex = r.bySource.find((s) => s.sourceKind === "codex-import");
    const claude = r.bySource.find((s) => s.sourceKind === "claude-code-import");
    expect(codex?.commandTimeReliable).toBe(true);
    expect(claude?.commandTimeReliable).toBe(false);
    expect(r.totals.commandTimeReliable).toBe(false);
  });

  it("prefers stored engaged-time intervals over the event-derived measure", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    const id = "ses_01HXABCDEF1234567890ABCDEA";
    await placeSession(
      paths,
      {
        id,
        endedAt: "2026-05-10T01:00:00.000Z",
        metrics: {
          active_time_ms: 30 * 60 * 1000,
          active_gap_cap_ms: ACTIVE_GAP_CAP_MS,
          active_time_method: "engaged-turns",
          active_intervals: [
            { start: "2026-05-10T00:00:00.000Z", end: "2026-05-10T00:30:00.000Z" },
          ],
        },
      },
      // Sparse events alone would credit only a capped 5 minutes.
      started(id, "2026-05-10T00:00:00.000Z") + ended(id, "2026-05-10T01:00:00.000Z"),
    );
    const r = await computeWorkStats({ paths, now: NOW });
    const s = r.sessions[0];
    expect(s?.activeTimeBasis).toBe("engaged-turns");
    expect(s?.activeTimeMs).toBe(30 * 60 * 1000);
    expect(s?.availability.activeTime).toBe(true);
  });

  it("rolls up machine compute time per-session, by source, and in totals", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    const codex = "ses_01HXABCDEF1234567890ABCDM1";
    const claude = "ses_01HXABCDEF1234567890ABCDM2";
    await placeSession(paths, {
      id: codex,
      source: "codex-import",
      startedAt: "2026-05-10T00:00:00.000Z",
      endedAt: "2026-05-10T00:30:00.000Z",
      metrics: {
        active_time_ms: 30 * 60 * 1000,
        active_intervals: [{ start: "2026-05-10T00:00:00.000Z", end: "2026-05-10T00:30:00.000Z" }],
        active_time_method: "turn-intervals",
        machine_active_time_ms: 12 * 60 * 1000,
      },
    });
    // A claude-code-import session has active time but no machine compute.
    await placeSession(paths, {
      id: claude,
      source: "claude-code-import",
      startedAt: "2026-05-10T00:00:00.000Z",
      endedAt: "2026-05-10T00:30:00.000Z",
      metrics: {
        active_intervals: [{ start: "2026-05-10T00:00:00.000Z", end: "2026-05-10T00:10:00.000Z" }],
        active_time_method: "engaged-turns",
      },
    });
    const r = await computeWorkStats({ paths, now: NOW, timeZone: "UTC" });
    const cs = r.sessions.find((s) => s.sessionId === codex);
    const ls = r.sessions.find((s) => s.sessionId === claude);
    expect(cs?.machineActiveTimeMs).toBe(12 * 60 * 1000);
    expect(cs?.availability.machineActive).toBe(true);
    expect(cs?.activeTimeMethod).toBe("turn-intervals");
    expect(ls?.machineActiveTimeMs).toBe(0);
    expect(ls?.availability.machineActive).toBe(false);
    // Totals: summed (not wall-clock-deduped), available because one session has it.
    expect(r.totals.machineActiveTimeMs).toBe(12 * 60 * 1000);
    expect(r.totals.machineActiveAvailable).toBe(true);
    const codexSource = r.bySource.find((s) => s.sourceKind === "codex-import");
    const claudeSource = r.bySource.find((s) => s.sourceKind === "claude-code-import");
    expect(codexSource?.machineActiveTimeMs).toBe(12 * 60 * 1000);
    expect(codexSource?.machineActiveAvailable).toBe(true);
    expect(claudeSource?.machineActiveAvailable).toBe(false);
    // Per-day: attributed to the session start date.
    expect(r.byDay.find((d) => d.date === "2026-05-10")?.machineActiveTimeMs).toBe(12 * 60 * 1000);
  });

  it("de-duplicates overlapping sessions in the billable total", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    const a = "ses_01HXABCDEF1234567890ABCDEB";
    const b = "ses_01HXABCDEF1234567890ABCDEC";
    await placeSession(paths, {
      id: a,
      startedAt: "2026-05-10T00:00:00.000Z",
      endedAt: "2026-05-10T00:30:00.000Z",
      metrics: {
        active_intervals: [{ start: "2026-05-10T00:00:00.000Z", end: "2026-05-10T00:30:00.000Z" }],
      },
    });
    await placeSession(paths, {
      id: b,
      startedAt: "2026-05-10T00:15:00.000Z",
      endedAt: "2026-05-10T00:45:00.000Z",
      metrics: {
        active_intervals: [{ start: "2026-05-10T00:15:00.000Z", end: "2026-05-10T00:45:00.000Z" }],
      },
    });
    const r = await computeWorkStats({ paths, now: NOW });
    // Summed = 30 + 30 = 60 min; union [00:00, 00:45] = 45 min.
    expect(r.totals.activeTimeMs).toBe(60 * 60 * 1000);
    expect(r.totals.billableActiveTimeMs).toBe(45 * 60 * 1000);
  });

  it("buckets billable time by day in the given timezone, summing to the total", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    const d1 = "ses_01HXABCDEF1234567890ABCDED";
    const d2 = "ses_01HXABCDEF1234567890ABCDEE";
    await placeSession(paths, {
      id: d1,
      startedAt: "2026-05-09T10:00:00.000Z",
      endedAt: "2026-05-09T10:20:00.000Z",
      metrics: {
        active_intervals: [{ start: "2026-05-09T10:00:00.000Z", end: "2026-05-09T10:20:00.000Z" }],
      },
    });
    await placeSession(paths, {
      id: d2,
      startedAt: "2026-05-10T10:00:00.000Z",
      endedAt: "2026-05-10T10:10:00.000Z",
      metrics: {
        active_intervals: [{ start: "2026-05-10T10:00:00.000Z", end: "2026-05-10T10:10:00.000Z" }],
      },
    });
    const r = await computeWorkStats({ paths, now: NOW, timeZone: "UTC" });
    expect(r.timeZone).toBe("UTC");
    expect(r.byDay.map((d) => d.date)).toEqual(["2026-05-09", "2026-05-10"]);
    expect(r.byDay[0]?.billableActiveTimeMs).toBe(20 * 60 * 1000);
    expect(r.byDay[1]?.billableActiveTimeMs).toBe(10 * 60 * 1000);
    const summed = r.byDay.reduce((n, d) => n + d.billableActiveTimeMs, 0);
    expect(summed).toBe(r.totals.billableActiveTimeMs);
  });

  it("flags a session whose events.jsonl is unreadable", async () => {
    const paths = await ensureBasouDirectory(getWorkDir());
    const id = "ses_01HXABCDEF1234567890ABCDE9";
    const dir = await placeSession(paths, { id, endedAt: "2026-05-10T00:05:00.000Z" });
    // Make events.jsonl a directory so the event read throws.
    await mkdir(join(dir, "events.jsonl"));
    const skipped: string[] = [];
    const r = await computeWorkStats({
      paths,
      now: NOW,
      onSessionSkip: (sid) => skipped.push(sid),
    });
    const s = r.sessions[0];
    expect(s?.eventsUnreadable).toBe(true);
    expect(s?.eventCount).toBe(0);
    expect(skipped).toContain(id);
  });
});
