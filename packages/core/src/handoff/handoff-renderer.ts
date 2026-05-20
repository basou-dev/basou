import { join } from "node:path";
import { enumerateApprovals } from "../approval/approval-store.js";
import { type ReplayWarning, replayEvents } from "../events/event-replay.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import {
  type SessionEntry,
  type SessionSkipReason,
  type SuspectReason,
  loadSessionEntries,
} from "../storage/sessions.js";
import { type TaskDocument, type TaskSkipReason, loadTaskEntries } from "../storage/tasks.js";

/** Input contract for {@link renderHandoff}. */
export type HandoffRendererInput = {
  paths: BasouPaths;
  /** ISO timestamp embedded in the generated body header. Caller-provided for testability. */
  nowIso: string;
  /** Forwarded to {@link replayEvents} / {@link loadSessionEntries} per session. */
  onWarning?: (warning: ReplayWarning, sessionId: string) => void;
  /**
   * Per-session degradation reasons (missing/invalid session.yaml or
   * unreadable events.jsonl). The CLI maps `events_jsonl_unreadable` to the
   * existing suspect-check stderr wording to keep the user-facing surface
   * consistent with `basou session list`.
   */
  onSessionSkip?: (sessionId: string, reason: SessionSkipReason) => void;
  /**
   * Per-task degradation reasons (invalid front matter / unreadable file).
   * Surfaced so the CLI can warn the operator about a malformed task.md
   * without aborting the handoff render.
   */
  onTaskSkip?: (taskId: string, reason: TaskSkipReason) => void;
  /** Maximum related_files entries to display before `... +N more`. Default 20. */
  relatedFilesLimit?: number;
};

export type HandoffRendererResult = {
  /** Generated body WITHOUT BASOU:GENERATED markers (markdown-store wraps them). */
  body: string;
  sessionCount: number;
  decisionCount: number;
  pendingApprovalsCount: number;
  suspectCount: number;
  /** Total number of task.md files successfully loaded. */
  taskCount: number;
  /** Tasks whose status is `planned` or `in_progress` (= shown in 次に実行すべき作業). */
  pendingTaskCount: number;
};

type DecisionRecord = {
  decisionId: string;
  title: string;
  occurredAt: string;
  sessionId: string;
};

type TaskCreatedRecord = {
  taskId: string;
  title: string;
  occurredAt: string;
  sessionId: string;
};

type TaskStatusChangedRecord = {
  taskId: string;
  occurredAt: string;
  sessionId: string;
};

/**
 * Render the body of `handoff.md` from the current workspace state.
 *
 * The renderer is a pure function (no I/O beyond {@link replayEvents} /
 * {@link loadSessionEntries} / {@link enumerateApprovals}). It assembles the
 * the spec's `handoff.md` sections in order:
 *
 * 1. `現在の状態`: latest live session (status not archived, source not import).
 * 2. `直近の変更ファイル`: union of `related_files` across sessions, dedup +
 *    sorted asc + truncated to `relatedFilesLimit` (default 20).
 * 3. `直近の判断`: latest `decision_recorded` event (chronological).
 * 4. `未決事項`: pending-approval count + suspect-session count.
 * 5. `次に読むべきファイル`: `.basou/decisions.md` + top-3 related files
 *    (the same `displayedFiles` source is intentionally reused in two
 *    sections — overview vs. resume context).
 * 6. `次に実行すべき作業`: placeholder until task events land.
 * 7. `セッション一覧`: all sessions newest first with inline suspect labels.
 *
 * Session enumeration goes through {@link loadSessionEntries} so the set of
 * sessions whose `decision_recorded` events we replay matches the
 * decisions renderer.
 */
export async function renderHandoff(input: HandoffRendererInput): Promise<HandoffRendererResult> {
  const limit = input.relatedFilesLimit ?? 20;
  const now = new Date(input.nowIso);
  // Wrap the caller's onSkip so we can detect whether loadSessionEntries'
  // suspect pass already emitted `events_jsonl_unreadable` for a session
  // For non-running sessions the suspect pass does not
  // touch events.jsonl, so the second replay below may be the first to
  // hit the unreadable file — without this bookkeeping that error would
  // be silently swallowed.
  const unreadableEmitted = new Set<string>();
  const wrappedSkip: (sid: string, reason: SessionSkipReason) => void = (sid, reason) => {
    if (reason === "events_jsonl_unreadable") unreadableEmitted.add(sid);
    input.onSessionSkip?.(sid, reason);
  };
  // `exactOptionalPropertyTypes` forbids passing literal `undefined` for an
  // optional property, so build the options object conditionally.
  const loadOpts: Parameters<typeof loadSessionEntries>[1] = { now, onSkip: wrappedSkip };
  if (input.onWarning !== undefined) loadOpts.onWarning = input.onWarning;
  const entries = await loadSessionEntries(input.paths, loadOpts);

  const decisions: DecisionRecord[] = [];
  const tasksCreated: TaskCreatedRecord[] = [];
  const tasksStatusChanged: TaskStatusChangedRecord[] = [];
  for (const entry of entries) {
    const sessionDir = join(input.paths.sessions, entry.sessionId);
    try {
      for await (const ev of replayEvents(sessionDir, {
        onWarning: (w) => input.onWarning?.(w, entry.sessionId),
      })) {
        if (ev.type === "decision_recorded") {
          decisions.push({
            decisionId: ev.decision_id,
            title: ev.title,
            occurredAt: ev.occurred_at,
            sessionId: entry.sessionId,
          });
        } else if (ev.type === "task_created") {
          tasksCreated.push({
            taskId: ev.task_id,
            title: ev.title,
            occurredAt: ev.occurred_at,
            sessionId: entry.sessionId,
          });
        } else if (ev.type === "task_status_changed") {
          tasksStatusChanged.push({
            taskId: ev.task_id,
            occurredAt: ev.occurred_at,
            sessionId: entry.sessionId,
          });
        }
      }
    } catch {
      // events.jsonl unreadable on the decision-aggregation pass. If the
      // suspect pass has not already surfaced a warning for this session
      // (e.g. completed session, where classifySuspect short-circuits
      // before reading events.jsonl), emit the skip now so the operator
      // is not left wondering why a decision is missing.
      if (!unreadableEmitted.has(entry.sessionId)) {
        wrappedSkip(entry.sessionId, "events_jsonl_unreadable");
      }
    }
  }
  decisions.sort((a, b) => {
    const c = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
    return c !== 0 ? c : a.decisionId.localeCompare(b.decisionId);
  });
  tasksCreated.sort((a, b) => {
    const c = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
    return c !== 0 ? c : a.taskId.localeCompare(b.taskId);
  });
  tasksStatusChanged.sort((a, b) => {
    const c = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
    return c !== 0 ? c : a.taskId.localeCompare(b.taskId);
  });

  const taskLoadOpts: Parameters<typeof loadTaskEntries>[1] = {};
  if (input.onTaskSkip !== undefined) taskLoadOpts.onSkip = input.onTaskSkip;
  const taskEntries = await loadTaskEntries(input.paths, taskLoadOpts);
  const taskById = new Map<string, TaskDocument>();
  for (const t of taskEntries) taskById.set(t.task.task.id, t);

  // Latest activity = most recent task_status_changed, falling back to the
  // most recent task_created when no status change has been recorded yet.
  // This surfaces "the task whose status most recently changed (including
  // done)" instead of "the most recently created task", so a task that just
  // transitioned to done is no longer hidden from the handoff.
  const latestStatusChange = tasksStatusChanged[tasksStatusChanged.length - 1];
  const latestCreatedRecord = tasksCreated[tasksCreated.length - 1];
  const latestActivityTaskId = latestStatusChange?.taskId ?? latestCreatedRecord?.taskId;
  const latestActivityTitle =
    latestActivityTaskId !== undefined
      ? (tasksCreated.find((t) => t.taskId === latestActivityTaskId)?.title ?? "(title unknown)")
      : undefined;
  const latestActivityRecord =
    latestActivityTaskId !== undefined && latestActivityTitle !== undefined
      ? { taskId: latestActivityTaskId, title: latestActivityTitle }
      : undefined;
  const latestTaskDoc =
    latestActivityRecord !== undefined ? taskById.get(latestActivityRecord.taskId) : undefined;
  const pendingTasks = taskEntries.filter(
    (t) => t.task.task.status === "planned" || t.task.task.status === "in_progress",
  );

  const approvals = await enumerateApprovals(input.paths);
  const pendingApprovalsCount = approvals.pending.length;

  const liveEntries = entries.filter(
    (e) => e.session.session.status !== "archived" && e.session.session.source.kind !== "import",
  );
  const latestSession = [...liveEntries].sort(
    (a, b) => Date.parse(b.session.session.started_at) - Date.parse(a.session.session.started_at),
  )[0];

  const allFiles = new Set<string>();
  for (const e of entries) {
    for (const f of e.session.session.related_files) allFiles.add(f);
  }
  const sortedFiles = [...allFiles].sort();
  const displayedFiles = sortedFiles.slice(0, limit);
  const overflow = Math.max(0, sortedFiles.length - limit);

  const suspectCount = entries.filter((e) => e.suspect).length;

  const firstEntry = entries[0];
  const lastEntry = entries[entries.length - 1];
  const sessionRange =
    firstEntry !== undefined && lastEntry !== undefined
      ? `${firstEntry.sessionId}..${lastEntry.sessionId}`
      : "";

  const body = formatHandoffBody({
    nowIso: input.nowIso,
    sessionRange,
    sessionCount: entries.length,
    latestSession,
    decisions,
    pendingApprovalsCount,
    suspectCount,
    displayedFiles,
    overflow,
    entries,
    latestActivityRecord,
    latestTaskDoc,
    pendingTasks,
    totalTaskCount: taskEntries.length,
  });

  return {
    body,
    sessionCount: entries.length,
    decisionCount: decisions.length,
    pendingApprovalsCount,
    suspectCount,
    taskCount: taskEntries.length,
    pendingTaskCount: pendingTasks.length,
  };
}

function formatHandoffBody(args: {
  nowIso: string;
  sessionRange: string;
  sessionCount: number;
  latestSession: SessionEntry | undefined;
  decisions: ReadonlyArray<DecisionRecord>;
  pendingApprovalsCount: number;
  suspectCount: number;
  displayedFiles: ReadonlyArray<string>;
  overflow: number;
  entries: ReadonlyArray<SessionEntry>;
  latestActivityRecord: { taskId: string; title: string } | undefined;
  latestTaskDoc: TaskDocument | undefined;
  pendingTasks: ReadonlyArray<TaskDocument>;
  totalTaskCount: number;
}): string {
  const lines: string[] = [];
  lines.push("# Handoff");
  lines.push("");
  if (args.sessionRange !== "") {
    lines.push(`> Generated at ${args.nowIso} from ${args.sessionRange}`);
  } else {
    lines.push(`> Generated at ${args.nowIso}`);
  }
  lines.push("");

  // 現在の状態
  lines.push("## 現在の状態");
  lines.push("");
  if (args.latestSession !== undefined) {
    const sid = args.latestSession.sessionId;
    const status = args.latestSession.session.session.status;
    lines.push(`- 最終 session: ${sid} (${status})`);
  } else {
    lines.push("- 最終 session: (no live sessions)");
  }
  if (args.latestActivityRecord !== undefined) {
    // Status comes from task.md when available. If the task_created event
    // exists but task.md is missing / invalid we MUST NOT fabricate
    // "planned" — events alone cannot restore the initial status and
    // operators would miss an unsafe-state reconcile.
    const statusLabel =
      args.latestTaskDoc !== undefined
        ? args.latestTaskDoc.task.task.status
        : "status unknown — task.md missing or invalid";
    lines.push(
      `- 最終 task: ${args.latestActivityRecord.taskId} (${statusLabel}): ${args.latestActivityRecord.title}`,
    );
  } else {
    lines.push("- 最終 task: (no tasks recorded yet)");
  }
  lines.push("");

  // 直近の変更ファイル
  lines.push("## 直近の変更ファイル");
  lines.push("");
  if (args.displayedFiles.length === 0) {
    lines.push("(no related files recorded)");
  } else {
    for (const f of args.displayedFiles) lines.push(`- ${f}`);
    if (args.overflow > 0) lines.push(`- ... +${args.overflow} more`);
  }
  lines.push("");

  // 直近の判断
  lines.push("## 直近の判断");
  lines.push("");
  if (args.decisions.length === 0) {
    lines.push("(no decisions recorded yet)");
  } else {
    const last = args.decisions[args.decisions.length - 1] as DecisionRecord;
    lines.push(`- ${last.decisionId}: ${last.title}`);
    lines.push("");
    lines.push(`(${args.decisions.length} decisions total — see decisions.md)`);
  }
  lines.push("");

  // 未決事項
  lines.push("## 未決事項");
  lines.push("");
  if (args.pendingApprovalsCount > 0) {
    lines.push(`- ${args.pendingApprovalsCount} pending approvals`);
  }
  if (args.suspectCount > 0) {
    lines.push(`- ${args.suspectCount} suspect sessions detected`);
  }
  if (args.pendingApprovalsCount === 0 && args.suspectCount === 0) {
    lines.push("(none)");
  }
  lines.push("");

  // 次に読むべきファイル
  // Drop self-reference to handoff.md, include `.basou/decisions.md` + the
  // top-3 of `displayedFiles` so the section points to concrete files. The
  // same `displayedFiles` source is reused intentionally (overview vs.
  // resume context).
  lines.push("## 次に読むべきファイル");
  lines.push("");
  lines.push("- .basou/decisions.md");
  for (const f of args.displayedFiles.slice(0, 3)) lines.push(`- ${f}`);
  lines.push("");

  // 次に実行すべき作業
  lines.push("## 次に実行すべき作業");
  lines.push("");
  if (args.pendingTasks.length === 0) {
    lines.push("(no pending tasks)");
  } else {
    for (const t of args.pendingTasks) {
      lines.push(`- ${t.task.task.id} (${t.task.task.status}): ${t.task.task.title}`);
    }
  }
  lines.push("");

  // セッション一覧
  lines.push("## セッション一覧");
  lines.push("");
  if (args.entries.length === 0) {
    lines.push("(no sessions yet)");
  } else {
    lines.push("| short_id | status | started_at | label |");
    lines.push("|---|---|---|---|");
    for (const e of [...args.entries].reverse()) {
      const sid = shortHandoffId(e.sessionId);
      const status = e.session.session.status + suspectLabel(e.suspectReason);
      const startedAt = e.session.session.started_at;
      const label = e.session.session.label ?? "";
      lines.push(`| ${sid} | ${status} | ${startedAt} | ${label} |`);
    }
  }
  lines.push("");
  lines.push(`Sessions: ${args.sessionCount}. Tasks: ${args.totalTaskCount}.`);

  return lines.join("\n");
}

function suspectLabel(reason: SuspectReason | null): string {
  if (reason === "events_say_ended_but_yaml_running") return " ⚠ ended (yaml stale)";
  if (reason === "running_no_end_event") return " ⚠ no end event";
  return "";
}

// First 10 chars after the `ses_` prefix. Matches the truncation that
// `basou session list` uses for its shortest display column.
function shortHandoffId(sessionId: string): string {
  const SES = "ses_";
  if (sessionId.startsWith(SES)) return sessionId.slice(SES.length, SES.length + 10);
  return sessionId.slice(0, 10);
}
