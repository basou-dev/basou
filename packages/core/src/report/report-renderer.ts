import { join } from "node:path";
import {
  enumerateApprovals,
  type LoadedApproval,
  loadApproval,
} from "../approval/approval-store.js";
import { type ReplayWarning, replayEvents } from "../events/event-replay.js";
import { type ChainVerdictStatus, verifyEventsChain } from "../events/verify.js";
import { formatDurationMs } from "../lib/format-duration.js";
import type {
  ApprovalStatus,
  RiskLevel,
  SessionSourceKind,
  SessionStatus,
  TaskStatus,
} from "../schemas/index.js";
import { computeWorkStats, type StatusCount } from "../stats/work-stats.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import {
  loadSessionEntries,
  type SessionEntry,
  type SessionSkipReason,
} from "../storage/sessions.js";
import { loadTaskEntries, type TaskSkipReason } from "../storage/tasks.js";

/**
 * Caps on how many items each section lists in the rendered markdown. The
 * structured `ReportData` always keeps the FULL set (machine consumers get
 * everything); only the human-facing markdown truncates (with a `... +N more`
 * line) so a report over a large workspace stays readable and "簡易".
 */
const CHANGED_FILES_MARKDOWN_LIMIT = 50;
const DECISIONS_MARKDOWN_LIMIT = 20;
const SESSIONS_MARKDOWN_LIMIT = 30;
const TASKS_MARKDOWN_LIMIT = 30;
const APPROVALS_MARKDOWN_LIMIT = 30;

/** Render order for the session-status breakdown (most-relevant-first). */
const SESSION_STATUS_ORDER: readonly SessionStatus[] = [
  "completed",
  "failed",
  "running",
  "waiting_approval",
  "interrupted",
  "initialized",
  "imported",
  "archived",
];

/** Render order for the task-status breakdown. */
const TASK_STATUS_ORDER: readonly TaskStatus[] = ["planned", "in_progress", "done", "cancelled"];

export type ReportRendererInput = {
  paths: BasouPaths;
  /** ISO timestamp stamped into the report header and used as the clock. */
  nowIso: string;
  /** Optional subject line surfaced in the report title. */
  title?: string;
  /**
   * IANA timezone passed through to {@link computeWorkStats} (it labels the
   * time figures with the zone). The CLI omits this (host default); tests and
   * the SDK pass a fixed value for deterministic output. [Codex #5]
   */
  timeZone?: string;
  onWarning?: (warning: ReplayWarning, sessionId: string) => void;
  onSessionSkip?: (sessionId: string, reason: SessionSkipReason) => void;
  onTaskSkip?: (taskId: string, reason: TaskSkipReason) => void;
};

export type ReportSessionItem = {
  id: string;
  label: string | null;
  status: SessionStatus;
  source: SessionSourceKind;
  startedAt: string;
  activeMs: number;
  outputTokens: number;
};

export type ReportDecisionItem = { id: string; title: string; occurredAt: string };
export type ReportTaskItem = { id: string; title: string; status: TaskStatus };
export type ReportApprovalItem = {
  id: string;
  reason: string;
  status: ApprovalStatus;
  riskLevel: RiskLevel;
};
export type TaskStatusCount = { status: TaskStatus; count: number };

/**
 * Curated, purpose-built structured shape behind `basou report generate
 * --json`. Deliberately NOT the full {@link WorkStatsResult} — report's JSON
 * stays a stable contract decoupled from the stats schema. Field names avoid
 * the word "billable": a report is a neutral work-explanation export, not a
 * billing artifact. [Codex #2]
 */
export type ReportData = {
  generatedAt: string;
  title?: string;
  /** Earliest session start .. latest session end (or `now` for open sessions). */
  period: { from: string | null; to: string | null };
  sessions: { total: number; byStatus: StatusCount[]; items: ReportSessionItem[] };
  volume: {
    outputTokens: number;
    reasoningTokens: number;
    commandCount: number;
    fileChangedCount: number;
    decisionCount: number;
    tokensAvailable: boolean;
  };
  time: {
    activeMs: number;
    machineActiveMs: number;
    machineAvailable: boolean;
    spanMs: number;
    commandTimeMs: number;
    timeZone: string;
  };
  decisions: { count: number; items: ReportDecisionItem[] };
  approvals: {
    pending: number;
    approved: number;
    rejected: number;
    expired: number;
    items: ReportApprovalItem[];
  };
  tasks: { total: number; byStatus: TaskStatusCount[]; items: ReportTaskItem[] };
  /** Union of related files across non-`import` sessions (full; markdown truncates). */
  changedFiles: string[];
  integrity: {
    total: number;
    verified: number;
    unchained: number;
    empty: number;
    incomplete: number;
    in_progress: number;
    tampered: number;
    /** Session ids whose chain is `tampered`, surfaced for follow-up. */
    tamperedSessions: string[];
  };
};

export type ReportRendererResult = { body: string; data: ReportData };

/**
 * Render a neutral "work report" — a point-in-time export that explains the
 * work captured in a workspace: how much, what was decided / approved /
 * undertaken, which files changed, and whether the local provenance is
 * internally consistent. It composes existing read primitives only and writes
 * nothing; the caller chooses where `body` goes (stdout / a file) and whether
 * to emit the structured `data` as JSON.
 *
 * Warning surfaces mirror the sibling renderers: `loadSessionEntries` (suspect
 * classification) and the decision-aggregation replay (with the same
 * unreadable-skip wrapper as `decisions-renderer.ts`) report through the
 * callbacks. {@link computeWorkStats} runs SILENTLY here — it re-reads the same
 * sessions/events, so surfacing its warnings too would double-emit. [Codex #6]
 */
export async function renderReport(input: ReportRendererInput): Promise<ReportRendererResult> {
  const now = new Date(input.nowIso);

  // Track which sessions already surfaced `events_jsonl_unreadable` so a
  // non-running session whose log is unreadable still warns once (not twice,
  // not zero times) across the suspect pass and the decision replay.
  const unreadableEmitted = new Set<string>();
  const wrappedSkip: (sid: string, reason: SessionSkipReason) => void = (sid, reason) => {
    if (reason === "events_jsonl_unreadable") unreadableEmitted.add(sid);
    input.onSessionSkip?.(sid, reason);
  };

  const loadOpts: Parameters<typeof loadSessionEntries>[1] = { now, onSkip: wrappedSkip };
  if (input.onWarning !== undefined) loadOpts.onWarning = input.onWarning;
  const entries = await loadSessionEntries(input.paths, loadOpts);

  // Volume / time / per-session active+tokens. Silent: the warning surface is
  // the two passes above (this re-reads the same data).
  const statsInput: Parameters<typeof computeWorkStats>[0] = { paths: input.paths, now };
  if (input.timeZone !== undefined) statsInput.timeZone = input.timeZone;
  const stats = await computeWorkStats(statsInput);
  const statsBySession = new Map(stats.sessions.map((s) => [s.sessionId, s]));

  // Decisions: replicate decisions-renderer's full collection — the
  // unreadable-skip wrapper AND the (occurred_at, id) sort, not just the loop.
  const decisions: ReportDecisionItem[] = [];
  for (const entry of entries) {
    const sessionDir = join(input.paths.sessions, entry.sessionId);
    try {
      for await (const ev of replayEvents(sessionDir, {
        onWarning: (w) => input.onWarning?.(w, entry.sessionId),
      })) {
        if (ev.type === "decision_recorded") {
          decisions.push({ id: ev.decision_id, title: ev.title, occurredAt: ev.occurred_at });
        }
      }
    } catch {
      if (!unreadableEmitted.has(entry.sessionId)) {
        wrappedSkip(entry.sessionId, "events_jsonl_unreadable");
      }
    }
  }
  decisions.sort((a, b) => {
    const c = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
    return c !== 0 ? c : a.id.localeCompare(b.id);
  });

  // Tasks.
  const taskLoadOpts: Parameters<typeof loadTaskEntries>[1] = {};
  if (input.onTaskSkip !== undefined) taskLoadOpts.onSkip = input.onTaskSkip;
  const taskEntries = await loadTaskEntries(input.paths, taskLoadOpts);
  const taskItems: ReportTaskItem[] = taskEntries.map((t) => ({
    id: t.task.task.id,
    title: t.task.task.title,
    status: t.task.task.status,
  }));
  const tasksByStatus = tallyTaskStatus(taskItems);

  // Approvals: dedupe a stale pending id that is also resolved (resolved wins),
  // then tally by status (mirrors the SDK's listApprovals dedupe).
  const approvalIds = await enumerateApprovals(input.paths);
  const resolvedSet = new Set(approvalIds.resolved);
  const pendingIds = approvalIds.pending.filter((id) => !resolvedSet.has(id));
  const loadedApprovals = (
    await Promise.all(
      [...pendingIds, ...approvalIds.resolved].map((id) => loadApproval(input.paths, id)),
    )
  ).filter((a): a is LoadedApproval => a !== null);
  const approvalItems: ReportApprovalItem[] = loadedApprovals.map((a) => ({
    id: a.approval.id,
    reason: a.approval.reason,
    status: a.approval.status,
    riskLevel: a.approval.risk_level,
  }));
  const approvalCounts = { pending: 0, approved: 0, rejected: 0, expired: 0 };
  for (const a of approvalItems) approvalCounts[a.status] += 1;

  // Changed files: union over NON-import sessions only, so cross-workspace
  // round-trip imports don't dominate (matches handoff's precedent). [Codex #4]
  const changedSet = new Set<string>();
  for (const entry of entries) {
    if (entry.session.session.source.kind === "import") continue;
    for (const f of entry.session.session.related_files) changedSet.add(f);
  }
  const changedFiles = [...changedSet].sort();

  // Integrity: verify each session's chain and tally by verdict. A session
  // whose events.jsonl is unreadable (a non-ENOENT I/O error) makes
  // verifyEventsChain throw; surface it as a skip and leave it out of the tally
  // so a single bad file never fails the whole report (a successful render must
  // exit 0). `total` therefore counts only the sessions that could be verified.
  const integrity = {
    total: 0,
    verified: 0,
    unchained: 0,
    empty: 0,
    incomplete: 0,
    in_progress: 0,
    tampered: 0,
    tamperedSessions: [] as string[],
  };
  for (const entry of entries) {
    const verdict = await verifyEventsChain(input.paths, entry.sessionId).catch(() => null);
    if (verdict === null) {
      if (!unreadableEmitted.has(entry.sessionId)) {
        wrappedSkip(entry.sessionId, "events_jsonl_unreadable");
      }
      continue;
    }
    integrity.total += 1;
    integrity[verdict.status] += 1;
    if (verdict.status === "tampered") integrity.tamperedSessions.push(entry.sessionId);
  }

  // Session table rows + period, from the per-session stats joined onto the
  // canonical session list (newest-first).
  const sessionItems: ReportSessionItem[] = [...entries]
    .sort(
      (a, b) => Date.parse(b.session.session.started_at) - Date.parse(a.session.session.started_at),
    )
    .map((e) => {
      const w = statsBySession.get(e.sessionId);
      return {
        id: e.sessionId,
        label: e.session.session.label ?? null,
        status: e.session.session.status,
        source: e.session.session.source.kind,
        startedAt: e.session.session.started_at,
        activeMs: w?.activeTimeMs ?? 0,
        outputTokens: w?.tokens.output ?? 0,
      };
    });
  const period = computePeriod(entries, input.nowIso);

  const t = stats.totals;
  const data: ReportData = {
    generatedAt: input.nowIso,
    ...(input.title !== undefined ? { title: input.title } : {}),
    period,
    sessions: { total: entries.length, byStatus: stats.byStatus, items: sessionItems },
    volume: {
      outputTokens: t.tokens.output,
      reasoningTokens: t.tokens.reasoning,
      commandCount: t.commandCount,
      fileChangedCount: t.fileChangedCount,
      decisionCount: t.decisionCount,
      tokensAvailable: t.tokensAvailable,
    },
    time: {
      activeMs: t.billableActiveTimeMs,
      machineActiveMs: t.machineActiveTimeMs,
      machineAvailable: t.machineActiveAvailable,
      spanMs: t.sessionSpanMs,
      commandTimeMs: t.commandTimeMs,
      timeZone: stats.timeZone,
    },
    decisions: { count: decisions.length, items: decisions },
    approvals: { ...approvalCounts, items: approvalItems },
    tasks: { total: taskEntries.length, byStatus: tasksByStatus, items: taskItems },
    changedFiles,
    integrity,
  };

  return { body: formatReportBody(data), data };
}

function computePeriod(
  entries: ReadonlyArray<SessionEntry>,
  nowIso: string,
): { from: string | null; to: string | null } {
  if (entries.length === 0) return { from: null, to: null };
  let from = entries[0]?.session.session.started_at ?? nowIso;
  let to = nowIso;
  let sawEnd = false;
  for (const e of entries) {
    const s = e.session.session.started_at;
    if (Date.parse(s) < Date.parse(from)) from = s;
    const end = e.session.session.ended_at ?? nowIso;
    if (!sawEnd || Date.parse(end) > Date.parse(to)) {
      to = end;
      sawEnd = true;
    }
  }
  // Guard a clock-skewed session (ended_at < started_at) from producing a
  // reversed window where `to` precedes `from`.
  if (Date.parse(to) < Date.parse(from)) to = from;
  return { from, to };
}

function tallyTaskStatus(items: ReadonlyArray<ReportTaskItem>): TaskStatusCount[] {
  const counts = new Map<TaskStatus, number>();
  for (const i of items) counts.set(i.status, (counts.get(i.status) ?? 0) + 1);
  return TASK_STATUS_ORDER.filter((s) => (counts.get(s) ?? 0) > 0).map((status) => ({
    status,
    count: counts.get(status) as number,
  }));
}

function formatReportBody(data: ReportData): string {
  const lines: string[] = [];
  const titleSuffix = data.title !== undefined ? ` — ${data.title}` : "";
  lines.push(`# Report${titleSuffix}`);
  lines.push("");
  const periodSuffix =
    data.period.from !== null && data.period.to !== null
      ? ` (${data.period.from.slice(0, 10)}..${data.period.to.slice(0, 10)})`
      : "";
  lines.push(`> Generated at ${data.generatedAt}${periodSuffix}`);
  lines.push("");

  // Summary
  lines.push("## 概要");
  lines.push("");
  lines.push(`- ${formatSessionsLine(data)}`);
  lines.push(
    `- Active time ${formatDurationMs(data.time.activeMs)}, ${formatInt(data.volume.outputTokens)} output tokens`,
  );
  lines.push("");

  // Volume + time
  lines.push("## 作業量");
  lines.push("");
  const tokenCaveat = data.volume.tokensAvailable ? "" : "  (no token data captured)";
  lines.push(`- Output tokens: ${formatInt(data.volume.outputTokens)}${tokenCaveat}`);
  if (data.volume.reasoningTokens > 0) {
    lines.push(`- Reasoning tokens: ${formatInt(data.volume.reasoningTokens)}  (Codex)`);
  }
  lines.push(
    `- Actions: ${data.volume.commandCount} commands, ${data.volume.fileChangedCount} files, ${data.volume.decisionCount} decisions`,
  );
  lines.push(
    `- Active time: ${formatDurationMs(data.time.activeMs)}  (union; idle gaps > 5m excluded; tz ${data.time.timeZone})`,
  );
  if (data.time.machineAvailable) {
    lines.push(
      `- Model working: ${formatDurationMs(data.time.machineActiveMs)}  (model compute, subset of active)`,
    );
  }
  lines.push(`- Span: ${formatDurationMs(data.time.spanMs)}  (total elapsed)`);
  lines.push("");

  // Decisions — the most recent ones (the report explains what was decided;
  // ids live in --json, omitted here to keep the human narrative clean and
  // because batch-imported ids share a ULID timestamp prefix).
  lines.push("## 判断");
  lines.push("");
  if (data.decisions.items.length === 0) {
    lines.push("(no decisions recorded yet)");
  } else {
    const total = data.decisions.items.length;
    const shown =
      total > DECISIONS_MARKDOWN_LIMIT
        ? data.decisions.items.slice(-DECISIONS_MARKDOWN_LIMIT)
        : data.decisions.items;
    if (total > DECISIONS_MARKDOWN_LIMIT) {
      lines.push(`(showing the ${DECISIONS_MARKDOWN_LIMIT} most recent of ${total})`);
      lines.push("");
    }
    for (const d of shown) {
      lines.push(`- ${d.occurredAt.slice(0, 10)} · ${d.title}`);
    }
  }
  lines.push("");

  // Approvals
  lines.push("## 承認");
  lines.push("");
  if (data.approvals.items.length === 0) {
    lines.push("(none)");
  } else {
    const a = data.approvals;
    lines.push(
      `Pending ${a.pending} · Approved ${a.approved} · Rejected ${a.rejected} · Expired ${a.expired}`,
    );
    lines.push("");
    for (const item of data.approvals.items.slice(0, APPROVALS_MARKDOWN_LIMIT)) {
      lines.push(`- ${item.reason} (${item.status}, ${item.riskLevel})`);
    }
    const overflow = data.approvals.items.length - APPROVALS_MARKDOWN_LIMIT;
    if (overflow > 0) lines.push(`- ... +${overflow} more`);
  }
  lines.push("");

  // Tasks
  lines.push("## タスク");
  lines.push("");
  if (data.tasks.items.length === 0) {
    lines.push("(no tasks recorded yet)");
  } else {
    const breakdown = data.tasks.byStatus.map((s) => `${s.status} ${s.count}`).join(", ");
    lines.push(`Tasks: ${data.tasks.total} (${breakdown})`);
    lines.push("");
    for (const item of data.tasks.items.slice(0, TASKS_MARKDOWN_LIMIT)) {
      lines.push(`- ${item.title} (${item.status})`);
    }
    const overflow = data.tasks.items.length - TASKS_MARKDOWN_LIMIT;
    if (overflow > 0) lines.push(`- ... +${overflow} more`);
  }
  lines.push("");

  // Changed files
  lines.push("## 変更ファイル");
  lines.push("");
  if (data.changedFiles.length === 0) {
    lines.push("(no related files recorded)");
  } else {
    for (const f of data.changedFiles.slice(0, CHANGED_FILES_MARKDOWN_LIMIT)) lines.push(`- ${f}`);
    const overflow = data.changedFiles.length - CHANGED_FILES_MARKDOWN_LIMIT;
    if (overflow > 0) lines.push(`- ... +${overflow} more`);
  }
  lines.push("");

  // Sessions — newest first. The started_at is the human row key; full ids are
  // in --json (and would collide as short ids for batch imports).
  lines.push("## セッション一覧");
  lines.push("");
  if (data.sessions.items.length === 0) {
    lines.push("(no sessions yet)");
  } else {
    lines.push("| started_at | source | status | active | out tok |");
    lines.push("|---|---|---|---|---|");
    for (const s of data.sessions.items.slice(0, SESSIONS_MARKDOWN_LIMIT)) {
      lines.push(
        `| ${s.startedAt} | ${s.source} | ${s.status} | ${formatDurationMs(s.activeMs)} | ${formatInt(s.outputTokens)} |`,
      );
    }
    const overflow = data.sessions.items.length - SESSIONS_MARKDOWN_LIMIT;
    if (overflow > 0) {
      lines.push("");
      lines.push(`... +${overflow} more sessions`);
    }
  }
  lines.push("");

  // Integrity
  lines.push("## 整合性");
  lines.push("");
  const i = data.integrity;
  lines.push(
    `Provenance internally tamper-checked: ${i.verified} verified, ${i.unchained} unchained, ${i.empty} empty, ${i.incomplete} incomplete, ${i.in_progress} in_progress, ${i.tampered} tampered (of ${i.total} sessions).`,
  );
  lines.push("");
  lines.push(
    "This reflects internal consistency of the local event-log hash chain — not a third-party cryptographic proof.",
  );
  if (i.tampered > 0) {
    lines.push("");
    // Full ids here: a tampered verdict is actionable, so surface the exact
    // session to investigate with `basou verify --session <id>`.
    for (const id of i.tamperedSessions) lines.push(`- Tampered: ${id}`);
  }

  return lines.join("\n");
}

function formatSessionsLine(data: ReportData): string {
  const counts = new Map<SessionStatus, number>();
  for (const s of data.sessions.byStatus) counts.set(s.status, s.count);
  const breakdown = SESSION_STATUS_ORDER.filter((s) => (counts.get(s) ?? 0) > 0)
    .map((s) => `${s} ${counts.get(s)}`)
    .join(", ");
  return breakdown !== ""
    ? `Sessions: ${data.sessions.total} (${breakdown})`
    : `Sessions: ${data.sessions.total}`;
}

/** "1,234,567" — thousands-separated, fixed en-US so output is deterministic. */
function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}

// Re-export the verdict-status type so callers (and tests) can name it without
// reaching into the events module.
export type { ChainVerdictStatus };
