import { join } from "node:path";
import { enumerateApprovals } from "../approval/approval-store.js";
import { type ReplayWarning, replayEvents } from "../events/event-replay.js";
import { isTrailingStale, pickLatestSubstantiveEntry } from "../lib/recency.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import {
  loadSessionEntries,
  type SessionEntry,
  type SessionSkipReason,
  type SuspectReason,
} from "../storage/sessions.js";
import { loadTaskEntries, type TaskDocument, type TaskSkipReason } from "../storage/tasks.js";

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

// An open (non-voided) `kind: "track"` decision — a strategic, unfinished
// direction the handoff resurfaces until it is closed via `decision void`.
// Mirrors the orientation renderer so the two outputs agree.
type TrackRecord = {
  decisionId: string;
  title: string;
  rationale: string | null;
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
 * 2. `直近の変更ファイル`: the most recent session's `related_files`, dedup +
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
  // `kind: "track"` decisions (a strategic, unfinished direction); the open
  // subset (minus voided) is surfaced as 未完トラック and resurfaces until closed.
  const tracks: TrackRecord[] = [];
  // decision_ids marked no longer in force; the 直近の判断 pointer skips them so
  // a voided decision is never surfaced as current (mirrors the orientation
  // renderer, keeping the two outputs in agreement).
  const voidedDecisionIds = new Set<string>();
  const tasksCreated: TaskCreatedRecord[] = [];
  const tasksStatusChanged: TaskStatusChangedRecord[] = [];
  // Activity tail over NON-archived sessions = max of the session boundary
  // (ended_at ?? started_at) AND every event's occurred_at. Mirrors the
  // orientation renderer so the 直近の判断 staleness note fires identically (a
  // decision that real work continued past is not presented as current).
  let latestActivityAt: string | null = null;
  const noteActivity = (iso: string): void => {
    if (latestActivityAt === null || Date.parse(iso) > Date.parse(latestActivityAt)) {
      latestActivityAt = iso;
    }
  };
  for (const entry of entries) {
    const sessionDir = join(input.paths.sessions, entry.sessionId);
    const counted = entry.session.session.status !== "archived";
    if (counted) noteActivity(entry.session.session.ended_at ?? entry.session.session.started_at);
    try {
      for await (const ev of replayEvents(sessionDir, {
        onWarning: (w) => input.onWarning?.(w, entry.sessionId),
      })) {
        if (counted) noteActivity(ev.occurred_at);
        if (ev.type === "decision_recorded") {
          decisions.push({
            decisionId: ev.decision_id,
            title: ev.title,
            occurredAt: ev.occurred_at,
            sessionId: entry.sessionId,
          });
          if (ev.kind === "track") {
            tracks.push({
              decisionId: ev.decision_id,
              title: ev.title,
              rationale: ev.rationale ?? null,
              occurredAt: ev.occurred_at,
              sessionId: entry.sessionId,
            });
          }
        } else if (ev.type === "decision_voided") {
          voidedDecisionIds.add(ev.decision_id);
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
  // Newest decision NOT voided — the 直近の判断 pointer. A voided decision stays
  // in decisions.md (struck) but must not pose as the current direction.
  let latestDecision: DecisionRecord | undefined;
  for (let i = decisions.length - 1; i >= 0; i -= 1) {
    const d = decisions[i];
    if (d !== undefined && !voidedDecisionIds.has(d.decisionId)) {
      latestDecision = d;
      break;
    }
  }
  // Open tracks: non-voided `kind: "track"` decisions, newest first. Mirrors the
  // orientation renderer so handoff and orient surface the same strategic
  // continuation.
  const openTracks: TrackRecord[] = tracks
    .filter((t) => !voidedDecisionIds.has(t.decisionId))
    .sort((a, b) => {
      const c = Date.parse(b.occurredAt) - Date.parse(a.occurredAt);
      return c !== 0 ? c : b.decisionId.localeCompare(a.decisionId);
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
  // Represent 最終 session with the most recent SUBSTANTIVE session, not a bare
  // resume/refresh session (e.g. 1 command, 0 files) that merely happens to be
  // newest — the latter hides the real-work session and disagrees with 直近の判断.
  const latestSession = pickLatestSubstantiveEntry(liveEntries);

  // 「直近の変更ファイル」 shows the files touched by the most recent SUBSTANTIVE
  // session — the same session surfaced as 最終 session above — so the section
  // reflects the latest real activity rather than the whole history. (A bare
  // resume session has no related_files anyway, so following 最終 session here
  // shows the substantive work's files instead of an empty list.) Unioning every
  // session's related_files turned this into a whole-history dump once transcript
  // imports became the primary source, since each import carries a full day of
  // file changes.
  const latestFiles = latestSession?.session.session.related_files ?? [];
  const sortedFiles = [...new Set(latestFiles)].sort();
  const displayedFiles = sortedFiles.slice(0, limit);
  const overflow = Math.max(0, sortedFiles.length - limit);

  const suspectCount = entries.filter((e) => e.suspect).length;

  const firstEntry = entries[0];
  const lastEntry = entries[entries.length - 1];
  const sessionRange =
    firstEntry !== undefined && lastEntry !== undefined
      ? `${shortIdWithPrefix(firstEntry.sessionId)}..${shortIdWithPrefix(lastEntry.sessionId)}`
      : "";

  const body = formatHandoffBody({
    nowIso: input.nowIso,
    sessionRange,
    sessionCount: entries.length,
    latestSession,
    latestActivityAt,
    decisions,
    latestDecision,
    openTracks,
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
  latestActivityAt: string | null;
  decisions: ReadonlyArray<DecisionRecord>;
  latestDecision: DecisionRecord | undefined;
  openTracks: ReadonlyArray<TrackRecord>;
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
    const status = args.latestSession.session.session.status;
    const label = args.latestSession.session.session.label;
    const shortId = shortIdWithPrefix(args.latestSession.sessionId);
    // Lead with the human-readable label; the raw id is demoted to a trailing
    // [short id]. When the session has no label the short id is the only handle
    // available, so it becomes the primary text and the bracket is dropped to
    // avoid repeating it.
    if (label !== undefined && label !== "") {
      lines.push(`- 最終 session: ${label} (${status}) [${shortId}]`);
    } else {
      lines.push(`- 最終 session: ${shortId} (${status})`);
    }
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
    // Surface linked_sessions cardinality inside the status parenthetical when
    // the latest task spans more than one session. Suppressed when the
    // task is single-session (the common case) or when task.md is
    // unavailable, keeping single-session output visually quiet.
    const linkedCount = args.latestTaskDoc?.task.task.linked_sessions?.length;
    const linkedSuffix =
      linkedCount !== undefined && linkedCount > 1 ? `, linked_sessions: ${linkedCount}` : "";
    // Lead with the task title; the raw id is demoted to a trailing [short id]
    // and linked_sessions rides alongside the status.
    lines.push(
      `- 最終 task: ${args.latestActivityRecord.title} (${statusLabel}${linkedSuffix}) [${shortIdWithPrefix(args.latestActivityRecord.taskId)}]`,
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
  if (args.latestDecision === undefined) {
    // Either no decisions, or every recorded decision has been voided — in
    // both cases there is no current recorded direction to surface.
    lines.push("(no decisions recorded yet)");
  } else {
    const last = args.latestDecision;
    // Lead with the decision title; the raw id is demoted to a trailing
    // [short id].
    lines.push(`- ${last.title} [${shortIdWithPrefix(last.decisionId)}]`);
    // Staleness caveat (mirrors orientation): when real work continued well past
    // this decision, it may already be resolved/executed — do not let a resume
    // treat it as the current next step. handoff had no such note before, so a
    // stale recorded decision posed unguarded as "直近の判断".
    if (args.latestActivityAt !== null && isTrailingStale(args.latestActivityAt, last.occurredAt)) {
      lines.push(
        "  - 注: 最終活動はこの判断より後です。会話で既に解決済みの可能性があるため、再開前に継続点を確認してください(会話での意思決定は自動記録されません。`basou decision capture` で記録できます)。",
      );
    }
    // When the latest decision is from a DIFFERENT session than 最終 session, the
    // two "latest" pointers disagree; surface it so the timeline is unambiguous.
    if (args.latestSession !== undefined && last.sessionId !== args.latestSession.sessionId) {
      lines.push(
        `  - 注: この判断は最終 session とは別の session [${shortIdWithPrefix(last.sessionId)}] のものです。`,
      );
    }
    lines.push("");
    lines.push(`(${args.decisions.length} decisions total — see decisions.md)`);
  }
  lines.push("");

  // 未完トラック — open strategic directions that resurface until closed. Placed
  // right after 直近の判断 (both decision-derived) and ahead of the mechanical
  // task list: an open track is the strongest "where to resume" signal, carrying
  // the next essential direction + why across the session boundary. Mirrors the
  // orientation renderer's forward section. Omitted entirely when none are open.
  if (args.openTracks.length > 0) {
    const TRACK_DISPLAY_LIMIT = 10;
    const shown = args.openTracks.slice(0, TRACK_DISPLAY_LIMIT);
    const overflow = args.openTracks.length - shown.length;
    lines.push("## 未完トラック (close まで継続表示)");
    lines.push("");
    for (const t of shown) {
      lines.push(`- ${t.title} [${shortIdWithPrefix(t.decisionId)}]`);
      if (t.rationale !== null && t.rationale.trim() !== "") {
        lines.push(`  - 理由: ${handoffRationale(t.rationale)}`);
      }
    }
    if (overflow > 0) lines.push(`- ... +${overflow} more (see decisions.md)`);
    lines.push("");
    lines.push("完了したら `basou decision void <decision_id>` で閉じてください。");
    lines.push("");
  }

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
      // Lead with the task title; the raw id is demoted to a trailing [short id].
      lines.push(
        `- ${t.task.task.title} (${t.task.task.status}) [${shortIdWithPrefix(t.task.task.id)}]`,
      );
    }
  }
  lines.push("");

  // セッション一覧 — the main table lists the operator's own sessions newest
  // first. This deliberately includes `claude-code-import` sessions: a
  // transcript captured after the fact via `basou import claude-code` is still
  // the operator's own work, so it belongs here rather than below. The separate
  // 「Imported sessions」 sub-section holds ONLY cross-workspace round-trips
  // brought in via `basou session import` (source.kind === "import"), so it is
  // absent whenever there are none. The "(no sessions yet)" placeholder fires
  // only when the workspace is completely empty; "(no live sessions; …)" fires
  // when every session is such a round-trip import.
  const liveTableEntries = args.entries.filter((e) => e.session.session.source.kind !== "import");
  const importedTableEntries = args.entries.filter(
    (e) => e.session.session.source.kind === "import",
  );
  lines.push("## セッション一覧");
  lines.push("");
  if (args.entries.length === 0) {
    lines.push("(no sessions yet)");
  } else if (liveTableEntries.length === 0) {
    lines.push("(no live sessions; see Imported sessions below)");
  } else {
    lines.push("| short_id | status | started_at | label |");
    lines.push("|---|---|---|---|");
    for (const e of [...liveTableEntries].reverse()) {
      const sid = shortHandoffId(e.sessionId);
      const status = e.session.session.status + suspectLabel(e.suspectReason);
      const startedAt = e.session.session.started_at;
      const label = e.session.session.label ?? "";
      lines.push(`| ${sid} | ${status} | ${startedAt} | ${label} |`);
    }
  }
  if (importedTableEntries.length > 0) {
    lines.push("");
    lines.push("### Imported sessions");
    lines.push("");
    lines.push("| short_id | status | started_at | label |");
    lines.push("|---|---|---|---|");
    for (const e of [...importedTableEntries].reverse()) {
      const sid = shortHandoffId(e.sessionId);
      const status = e.session.session.status + suspectLabel(e.suspectReason);
      const startedAt = e.session.session.started_at;
      const label = e.session.session.label ?? "";
      lines.push(`| ${sid} | ${status} | ${startedAt} | ${label} |`);
    }
  }
  lines.push("");
  // Session-status breakdown: surface completed / failed / running counts
  // alongside the total so an at-a-glance read distinguishes "ten sessions,
  // all done" from "ten sessions, three still failing". Order is fixed
  // (completed first since handoff is read after the work) and zero-count
  // statuses are omitted. When the workspace is empty the breakdown
  // parenthetical is suppressed entirely so the existing terse line stays.
  const statusCounts = new Map<string, number>();
  for (const e of args.entries) {
    const s = e.session.session.status;
    statusCounts.set(s, (statusCounts.get(s) ?? 0) + 1);
  }
  const orderedStatuses = [
    "completed",
    "failed",
    "running",
    "interrupted",
    "waiting_approval",
    "initialized",
    "imported",
  ] as const;
  const breakdown = orderedStatuses
    .filter((s) => (statusCounts.get(s) ?? 0) > 0)
    .map((s) => `${s} ${statusCounts.get(s)}`)
    .join(", ");
  const sessionsLine =
    breakdown !== ""
      ? `Sessions: ${args.sessionCount} (${breakdown}). Tasks: ${args.totalTaskCount}.`
      : `Sessions: ${args.sessionCount}. Tasks: ${args.totalTaskCount}.`;
  lines.push(sessionsLine);

  return lines.join("\n");
}

// A track's rationale (the WHY) can be multi-line and long; collapse whitespace
// to one line and cap it so the handoff stays scannable. The full text lives in
// the decision_recorded event (see decisions.md).
const HANDOFF_TRACK_RATIONALE_MAX = 240;
function handoffRationale(rationale: string): string {
  const oneLine = rationale.replace(/\s+/g, " ").trim();
  return oneLine.length > HANDOFF_TRACK_RATIONALE_MAX
    ? `${oneLine.slice(0, HANDOFF_TRACK_RATIONALE_MAX - 1)}…`
    : oneLine;
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

// Prose-line short id: keeps the type prefix (`ses_` / `task_` / `decision_`)
// and truncates the ULID body to its first 10 chars, e.g.
// `task_01KRNHYRS91F5GBX2VTN9ADJFV` -> `task_01KRNHYRS9`. Unlike the session
// table — whose column header already marks the column as ids — body lines mix
// session / task / decision ids inline, so the prefix is kept to keep each id
// self-describing while still demoting it behind the human-readable text.
function shortIdWithPrefix(id: string): string {
  const sep = id.indexOf("_");
  if (sep === -1) return id.slice(0, 10);
  return id.slice(0, sep + 1) + id.slice(sep + 1, sep + 1 + 10);
}
