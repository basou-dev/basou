import { join } from "node:path";
import { enumerateApprovals, isLazyExpired, loadApproval } from "../approval/approval-store.js";
import { type ReplayWarning, replayEvents } from "../events/event-replay.js";
import { formatDurationMs } from "../lib/format-duration.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import { readManifest } from "../storage/manifest.js";
import {
  loadSessionEntries,
  type SessionSkipReason,
  type SuspectReason,
} from "../storage/sessions.js";
import { loadTaskEntries, type TaskSkipReason } from "../storage/tasks.js";

/** Input contract for {@link renderOrientation} and {@link summarizeOrientation}. */
export type OrientationRendererInput = {
  paths: BasouPaths;
  /** ISO timestamp embedded in the header AND used as "now" for freshness + suspect classification. */
  nowIso: string;
  onWarning?: (warning: ReplayWarning, sessionId: string) => void;
  onSessionSkip?: (sessionId: string, reason: SessionSkipReason) => void;
  onTaskSkip?: (taskId: string, reason: TaskSkipReason) => void;
  /** Maximum related_files entries to display before `... +N more`. Default 10. */
  relatedFilesLimit?: number;
};

export type OrientationRendererResult = {
  /** Generated body. orientation.md is overwritten whole (no markers, gitignored). */
  body: string;
  sessionCount: number;
  pendingApprovalsCount: number;
  suspectCount: number;
  /** Tasks whose status is `planned` or `in_progress`. */
  inFlightTaskCount: number;
  decisionCount: number;
};

type DecisionRecord = { decisionId: string; title: string; occurredAt: string };

type PendingApproval = {
  id: string;
  risk: string;
  kind: string;
  reason: string;
  sessionId: string;
  createdAt: string;
  expired: boolean;
};

type InFlightTask = { id: string; title: string; status: string; linkedSessions: number };
type PlannedTask = { id: string; title: string };
type SuspectSession = { sessionId: string; status: string; reason: SuspectReason | null };
type LatestSession = { sessionId: string; label: string | null; status: string };
type SourceCount = { kind: string; count: number };

/**
 * The vendor-neutral, serializable structured summary behind orientation. This
 * is the single source of the four orientation questions (where am I now / what
 * is in flight / where am I heading / is this current). {@link renderOrientation}
 * formats it into markdown; programmatic consumers (e.g. a multi-workspace
 * portfolio view) read it directly without parsing prose.
 *
 * It carries STRUCTURED FACTS only — the pending-approval list with risk/reason,
 * suspect sessions, in-flight task linkage, capture freshness/coverage, the
 * latest decision. It deliberately holds NO work-stats (volume / active time /
 * tokens) and NO per-agent scorecards, productivity, or utilization metrics:
 * orientation shows product state, not surveillance of the fleet.
 */
export type OrientationSummary = {
  /** ISO "now"; the header timestamp and the basis for freshness/suspect classification. */
  generatedAt: string;
  /** All captured sessions (archived included), matching the count line. */
  sessionCount: number;
  /** Newest non-archived, non-import session ("where am I now"); null when none. */
  latestSession: LatestSession | null;
  /** Most recent `decision_recorded` across all sessions; null when none. */
  latestDecision: DecisionRecord | null;
  decisionCount: number;
  /** related_files of the latest session, deduped + sorted + capped at the display limit. */
  relatedFiles: { displayed: string[]; overflow: number };
  /** Tasks whose status is `planned` or `in_progress`. */
  inFlightTasks: InFlightTask[];
  /** Tasks whose status is `planned` ("where am I heading"). */
  plannedTasks: PlannedTask[];
  pendingApprovals: PendingApproval[];
  suspects: SuspectSession[];
  freshness: {
    /** started_at of the newest non-archived session, or null when none captured. */
    newestStartedAt: string | null;
    /** Session counts per source kind, sorted by kind. Counts only — never volume/time. */
    bySource: SourceCount[];
    /** manifest `import.source_roots`, or null when single-root / unreadable. */
    sourceRoots: string[] | null;
  };
};

/**
 * Gather the structured orientation facts for a workspace. Read-only and runs
 * NO imports: freshness reflects already-captured state, so a stale capture is
 * visible rather than silently refreshed (run `basou refresh` to re-import).
 *
 * Returns a fully serializable {@link OrientationSummary}. See its docstring for
 * the positioning constraint (no work-stats, no surveillance metrics).
 */
export async function summarizeOrientation(
  input: OrientationRendererInput,
): Promise<OrientationSummary> {
  const limit = input.relatedFilesLimit ?? 10;
  const now = new Date(input.nowIso);

  // `exactOptionalPropertyTypes` forbids passing literal `undefined`, so build
  // the options object conditionally (mirrors the handoff renderer).
  const loadOpts: Parameters<typeof loadSessionEntries>[1] = { now };
  if (input.onSessionSkip !== undefined) loadOpts.onSkip = input.onSessionSkip;
  if (input.onWarning !== undefined) loadOpts.onWarning = input.onWarning;
  const entries = await loadSessionEntries(input.paths, loadOpts);

  // Decisions: replay `decision_recorded` across every session (chronological).
  const decisions: DecisionRecord[] = [];
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
          });
        }
      }
    } catch {
      input.onSessionSkip?.(entry.sessionId, "events_jsonl_unreadable");
    }
  }
  decisions.sort((a, b) => {
    const c = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
    return c !== 0 ? c : a.decisionId.localeCompare(b.decisionId);
  });
  const latestDecision = decisions[decisions.length - 1];

  // Tasks: in-flight (planned / in_progress) carry the cross-session linkage
  // that a flat transcript scan cannot reconstruct.
  const taskLoadOpts: Parameters<typeof loadTaskEntries>[1] = {};
  if (input.onTaskSkip !== undefined) taskLoadOpts.onSkip = input.onTaskSkip;
  const taskEntries = await loadTaskEntries(input.paths, taskLoadOpts);
  const inFlightTasks: InFlightTask[] = taskEntries
    .filter((t) => t.task.task.status === "in_progress" || t.task.task.status === "planned")
    .map((t) => ({
      id: t.task.task.id,
      title: t.task.task.title,
      status: t.task.task.status,
      linkedSessions: t.task.task.linked_sessions?.length ?? 0,
    }));
  const plannedTasks: PlannedTask[] = taskEntries
    .filter((t) => t.task.task.status === "planned")
    .map((t) => ({ id: t.task.task.id, title: t.task.task.title }));

  // Pending approvals: enumerateApprovals returns IDs only, so each pending id
  // is read via loadApproval to surface risk / action / reason (handoff shows
  // only a count). A null load (race / removed mid-read) is skipped.
  const { pending: pendingIds } = await enumerateApprovals(input.paths);
  const pendingApprovals: PendingApproval[] = [];
  for (const id of [...pendingIds].sort()) {
    const loaded = await loadApproval(input.paths, id);
    if (loaded === null) continue;
    const a = loaded.approval;
    pendingApprovals.push({
      id,
      risk: a.risk_level,
      kind: a.action.kind,
      reason: a.reason,
      sessionId: a.session_id,
      createdAt: a.created_at,
      expired: isLazyExpired(a, now),
    });
  }

  const suspects: SuspectSession[] = entries
    .filter((e) => e.suspect)
    .map((e) => ({
      sessionId: e.sessionId,
      status: e.session.session.status,
      reason: e.suspectReason,
    }));

  // "where am I now" latest session: exclude archived + cross-workspace round-trip
  // imports (`source.kind === "import"`), matching the handoff renderer.
  // claude-code-import / codex-import sessions ARE the operator's own captured
  // work, so they remain in scope.
  const liveEntries = entries.filter(
    (e) => e.session.session.status !== "archived" && e.session.session.source.kind !== "import",
  );
  const latestEntry = [...liveEntries].sort(
    (a, b) => Date.parse(b.session.session.started_at) - Date.parse(a.session.session.started_at),
  )[0];
  // `label` is `z.string().optional()` in the session schema — a parsed session
  // is `string | undefined`, never `null`. So `?? null` only maps `undefined`,
  // and the formatter's `label !== null && label !== ""` is byte-identical to
  // the original `label !== undefined && label !== ""` predicate.
  const latestSession: LatestSession | null =
    latestEntry !== undefined
      ? {
          sessionId: latestEntry.sessionId,
          label: latestEntry.session.session.label ?? null,
          status: latestEntry.session.session.status,
        }
      : null;

  // Freshness: newest started_at over all non-archived sessions (= most recent
  // captured activity). This is an honest staleness signal, NOT a completeness
  // claim — orientation runs no import, so what is not yet captured is not
  // counted here.
  const activityEntries = entries.filter((e) => e.session.session.status !== "archived");
  const newest = [...activityEntries].sort(
    (a, b) => Date.parse(b.session.session.started_at) - Date.parse(a.session.session.started_at),
  )[0];

  const bySourceMap = new Map<string, number>();
  for (const e of entries) {
    const k = e.session.session.source.kind;
    bySourceMap.set(k, (bySourceMap.get(k) ?? 0) + 1);
  }
  const bySource: SourceCount[] = [...bySourceMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([kind, count]) => ({ kind, count }));

  let sourceRoots: string[] | null = null;
  try {
    const manifest = await readManifest(input.paths);
    sourceRoots = manifest.import?.source_roots ?? null;
  } catch {
    // A missing / unreadable manifest leaves the source-roots line absent; the
    // CLI asserts the workspace is initialized before calling, so this is rare.
    sourceRoots = null;
  }

  const latestFiles = latestEntry?.session.session.related_files ?? [];
  const uniqueFiles = new Set(latestFiles);
  const displayed = [...uniqueFiles].sort().slice(0, limit);
  const overflow = Math.max(0, uniqueFiles.size - limit);

  return {
    generatedAt: input.nowIso,
    sessionCount: entries.length,
    latestSession,
    latestDecision: latestDecision ?? null,
    decisionCount: decisions.length,
    relatedFiles: { displayed, overflow },
    inFlightTasks,
    plannedTasks,
    pendingApprovals,
    suspects,
    freshness: {
      newestStartedAt: newest?.session.session.started_at ?? null,
      bySource,
      sourceRoots,
    },
  };
}

/**
 * Render `.basou/orientation.md`: a point-in-time "current position" view for a
 * supervisor who delegated execution to AI agents. Unlike `handoff.md` (a
 * session-resume narrative) this answers four orientation questions —
 * where am I now / what is in flight / where am I heading / is this current —
 * and deliberately leads with STRUCTURED FACTS an LLM cannot reliably derive
 * from raw transcripts (the
 * pending-approval list with risk/reason, suspect sessions, in-flight task
 * linkage, capture freshness/coverage) rather than prose synthesis.
 *
 * The renderer is read-only and runs NO imports: the freshness section reflects
 * already-captured state, so a stale capture is visible rather than silently
 * refreshed (use `basou refresh` to re-import). It must never emit per-agent
 * scorecards, productivity, or utilization metrics — orientation shows product
 * state, not surveillance of the fleet.
 *
 * Formatting only: the facts come from {@link summarizeOrientation}.
 */
export async function renderOrientation(
  input: OrientationRendererInput,
): Promise<OrientationRendererResult> {
  const summary = await summarizeOrientation(input);
  return {
    body: formatOrientationBody(summary),
    sessionCount: summary.sessionCount,
    pendingApprovalsCount: summary.pendingApprovals.length,
    suspectCount: summary.suspects.length,
    inFlightTaskCount: summary.inFlightTasks.length,
    decisionCount: summary.decisionCount,
  };
}

function formatOrientationBody(summary: OrientationSummary): string {
  const lines: string[] = [];
  const now = new Date(summary.generatedAt);
  const newestRel = relativeAge(summary.freshness.newestStartedAt ?? undefined, now);

  lines.push("# Orientation");
  lines.push("");
  lines.push(
    `> Generated at ${summary.generatedAt} · sessions ${summary.sessionCount} · newest ${newestRel} · pending ${summary.pendingApprovals.length} · suspect ${summary.suspects.length}`,
  );
  lines.push("");

  // "where am I now"
  lines.push("## 今どこにいる");
  lines.push("");
  if (summary.latestSession !== null) {
    const s = summary.latestSession;
    const sid = shortId(s.sessionId);
    if (s.label !== null && s.label !== "") {
      lines.push(`- 最終 session: ${s.label} (${s.status}) [${sid}]`);
    } else {
      lines.push(`- 最終 session: ${sid} (${s.status})`);
    }
  } else {
    lines.push("- 最終 session: (no live sessions)");
  }
  if (summary.latestDecision !== null) {
    lines.push(
      `- 直近の判断: ${summary.latestDecision.title} [${shortId(summary.latestDecision.decisionId)}]`,
    );
    if (summary.decisionCount > 1) {
      lines.push(`  - ${summary.decisionCount} decisions total — see decisions.md`);
    }
  } else {
    lines.push("- 直近の判断: (no decisions recorded yet)");
  }
  if (summary.relatedFiles.displayed.length > 0) {
    const shown = summary.relatedFiles.displayed.join(", ");
    const more =
      summary.relatedFiles.overflow > 0 ? ` (... +${summary.relatedFiles.overflow} more)` : "";
    lines.push(`- 直近の変更ファイル: ${shown}${more}`);
  } else {
    lines.push("- 直近の変更ファイル: (none recorded)");
  }
  lines.push("");

  // "what is in flight" — structured facts
  lines.push("## 何が動く");
  lines.push("");
  lines.push(`### 進行中 task (${summary.inFlightTasks.length})`);
  if (summary.inFlightTasks.length === 0) {
    lines.push("- (none)");
  } else {
    for (const t of summary.inFlightTasks) {
      const linkedSuffix = t.linkedSessions > 1 ? ` — linked_sessions: ${t.linkedSessions}` : "";
      lines.push(`- ${t.title} (${t.status}) [${shortId(t.id)}]${linkedSuffix}`);
    }
  }
  lines.push("");
  lines.push(`### 承認待ち (${summary.pendingApprovals.length})`);
  if (summary.pendingApprovals.length === 0) {
    lines.push("- (none)");
  } else {
    for (const a of summary.pendingApprovals) {
      const expired = a.expired ? " (expired)" : "";
      lines.push(
        `- [${a.risk}] ${a.kind}: ${a.reason} — session ${shortId(a.sessionId)}, since ${a.createdAt}${expired}`,
      );
    }
  }
  lines.push("");
  lines.push(`### 要注意 session (${summary.suspects.length})`);
  if (summary.suspects.length === 0) {
    lines.push("- (none)");
  } else {
    for (const e of summary.suspects) {
      lines.push(`- ${shortId(e.sessionId)} (${e.status}) — ${suspectText(e.reason)}`);
    }
  }
  lines.push("");

  // "where am I heading"
  lines.push("## どこへ向かう");
  lines.push("");
  if (summary.plannedTasks.length === 0) {
    lines.push("- (no planned tasks — direction is inferred from recent decisions)");
    if (summary.latestDecision !== null) {
      lines.push(`  - 直近の判断: ${summary.latestDecision.title}`);
    }
  } else {
    for (const t of summary.plannedTasks) {
      lines.push(`- ${t.title} [${shortId(t.id)}]`);
    }
  }
  lines.push("");

  // "is this current" — capture freshness / coverage
  lines.push("## これは最新か");
  lines.push("");
  if (summary.freshness.newestStartedAt !== null) {
    lines.push(`- newest captured session: ${summary.freshness.newestStartedAt} (${newestRel})`);
  } else {
    lines.push("- newest captured session: (no sessions captured yet)");
  }
  const sourceBreakdown = summary.freshness.bySource
    .map(({ kind, count }) => `${kind} ${count}`)
    .join(", ");
  lines.push(
    `- sessions: ${summary.sessionCount}${sourceBreakdown !== "" ? ` (${sourceBreakdown})` : ""}`,
  );
  if (summary.freshness.sourceRoots !== null && summary.freshness.sourceRoots.length > 0) {
    lines.push(`- source roots: ${summary.freshness.sourceRoots.join(", ")}`);
  } else {
    lines.push("- source roots: (single root)");
  }
  lines.push(`- suspect sessions: ${summary.suspects.length}`);
  lines.push("- reflects already-captured state; run `basou refresh` to re-import.");

  return lines.join("\n");
}

/** "3h 05m ago" / "just now" / "(unknown)" for a session's age relative to `now`. */
function relativeAge(startedAt: string | undefined, now: Date): string {
  if (startedAt === undefined) return "(unknown)";
  const ms = now.getTime() - Date.parse(startedAt);
  if (!Number.isFinite(ms)) return "(unknown)";
  if (ms < 0) return "just now";
  if (ms < 1000) return "just now";
  return `${formatDurationMs(ms)} ago`;
}

function suspectText(reason: SuspectReason | null): string {
  if (reason === "events_say_ended_but_yaml_running") return "ended (yaml stale)";
  if (reason === "running_no_end_event") return "no end event";
  return "suspect";
}

// Prose-line short id: keep the type prefix and truncate the ULID body to its
// first 10 chars, e.g. `task_01KRNHYRS91F5GBX...` -> `task_01KRNHYRS9`.
function shortId(id: string): string {
  const sep = id.indexOf("_");
  if (sep === -1) return id.slice(0, 10);
  return id.slice(0, sep + 1) + id.slice(sep + 1, sep + 1 + 10);
}
