import { join } from "node:path";
import { enumerateApprovals, isLazyExpired, loadApproval } from "../approval/approval-store.js";
import { type ReplayWarning, replayEvents } from "../events/event-replay.js";
import { formatDurationMs } from "../lib/format-duration.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import { readManifest } from "../storage/manifest.js";
import {
  loadSessionEntries,
  type SessionEntry,
  type SessionSkipReason,
  type SuspectReason,
} from "../storage/sessions.js";
import { loadTaskEntries, type TaskDocument, type TaskSkipReason } from "../storage/tasks.js";

/** Input contract for {@link renderOrientation}. */
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
 */
export async function renderOrientation(
  input: OrientationRendererInput,
): Promise<OrientationRendererResult> {
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
  const inFlight = taskEntries.filter(
    (t) => t.task.task.status === "in_progress" || t.task.task.status === "planned",
  );
  const planned = taskEntries.filter((t) => t.task.task.status === "planned");

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

  const suspects = entries.filter((e) => e.suspect);

  // "where am I now" latest session: exclude archived + cross-workspace round-trip
  // imports (`source.kind === "import"`), matching the handoff renderer.
  // claude-code-import / codex-import sessions ARE the operator's own captured
  // work, so they remain in scope.
  const liveEntries = entries.filter(
    (e) => e.session.session.status !== "archived" && e.session.session.source.kind !== "import",
  );
  const latestSession = [...liveEntries].sort(
    (a, b) => Date.parse(b.session.session.started_at) - Date.parse(a.session.session.started_at),
  )[0];

  // Freshness: newest started_at over all non-archived sessions (= most recent
  // captured activity). This is an honest staleness signal, NOT a completeness
  // claim — `basou orient` runs no import, so what is not yet captured is not
  // counted here.
  const activityEntries = entries.filter((e) => e.session.session.status !== "archived");
  const newest = [...activityEntries].sort(
    (a, b) => Date.parse(b.session.session.started_at) - Date.parse(a.session.session.started_at),
  )[0];

  const bySource = new Map<string, number>();
  for (const e of entries) {
    const k = e.session.session.source.kind;
    bySource.set(k, (bySource.get(k) ?? 0) + 1);
  }

  let sourceRoots: ReadonlyArray<string> | undefined;
  try {
    const manifest = await readManifest(input.paths);
    sourceRoots = manifest.import?.source_roots;
  } catch {
    // A missing / unreadable manifest leaves the source-roots line absent; the
    // CLI asserts the workspace is initialized before calling, so this is rare.
    sourceRoots = undefined;
  }

  const latestFiles = latestSession?.session.session.related_files ?? [];
  const displayedFiles = [...new Set(latestFiles)].sort().slice(0, limit);
  const filesOverflow = Math.max(0, new Set(latestFiles).size - limit);

  const body = formatOrientationBody({
    nowIso: input.nowIso,
    now,
    sessionCount: entries.length,
    latestSession,
    latestDecision,
    decisionCount: decisions.length,
    displayedFiles,
    filesOverflow,
    inFlight,
    planned,
    pendingApprovals,
    suspects,
    newest,
    bySource,
    sourceRoots,
  });

  return {
    body,
    sessionCount: entries.length,
    pendingApprovalsCount: pendingApprovals.length,
    suspectCount: suspects.length,
    inFlightTaskCount: inFlight.length,
    decisionCount: decisions.length,
  };
}

function formatOrientationBody(args: {
  nowIso: string;
  now: Date;
  sessionCount: number;
  latestSession: SessionEntry | undefined;
  latestDecision: DecisionRecord | undefined;
  decisionCount: number;
  displayedFiles: ReadonlyArray<string>;
  filesOverflow: number;
  inFlight: ReadonlyArray<TaskDocument>;
  planned: ReadonlyArray<TaskDocument>;
  pendingApprovals: ReadonlyArray<PendingApproval>;
  suspects: ReadonlyArray<SessionEntry>;
  newest: SessionEntry | undefined;
  bySource: ReadonlyMap<string, number>;
  sourceRoots: ReadonlyArray<string> | undefined;
}): string {
  const lines: string[] = [];
  const newestRel = relativeAge(args.newest?.session.session.started_at, args.now);

  lines.push("# Orientation");
  lines.push("");
  lines.push(
    `> Generated at ${args.nowIso} · sessions ${args.sessionCount} · newest ${newestRel} · pending ${args.pendingApprovals.length} · suspect ${args.suspects.length}`,
  );
  lines.push("");

  // "where am I now"
  lines.push("## 今どこにいる");
  lines.push("");
  if (args.latestSession !== undefined) {
    const s = args.latestSession.session.session;
    const sid = shortId(args.latestSession.sessionId);
    if (s.label !== undefined && s.label !== "") {
      lines.push(`- 最終 session: ${s.label} (${s.status}) [${sid}]`);
    } else {
      lines.push(`- 最終 session: ${sid} (${s.status})`);
    }
  } else {
    lines.push("- 最終 session: (no live sessions)");
  }
  if (args.latestDecision !== undefined) {
    lines.push(
      `- 直近の判断: ${args.latestDecision.title} [${shortId(args.latestDecision.decisionId)}]`,
    );
    if (args.decisionCount > 1) {
      lines.push(`  - ${args.decisionCount} decisions total — see decisions.md`);
    }
  } else {
    lines.push("- 直近の判断: (no decisions recorded yet)");
  }
  if (args.displayedFiles.length > 0) {
    const shown = args.displayedFiles.join(", ");
    const more = args.filesOverflow > 0 ? ` (... +${args.filesOverflow} more)` : "";
    lines.push(`- 直近の変更ファイル: ${shown}${more}`);
  } else {
    lines.push("- 直近の変更ファイル: (none recorded)");
  }
  lines.push("");

  // "what is in flight" — structured facts
  lines.push("## 何が動く");
  lines.push("");
  lines.push(`### 進行中 task (${args.inFlight.length})`);
  if (args.inFlight.length === 0) {
    lines.push("- (none)");
  } else {
    for (const t of args.inFlight) {
      const task = t.task.task;
      const linked = task.linked_sessions?.length ?? 0;
      const linkedSuffix = linked > 1 ? ` — linked_sessions: ${linked}` : "";
      lines.push(`- ${task.title} (${task.status}) [${shortId(task.id)}]${linkedSuffix}`);
    }
  }
  lines.push("");
  lines.push(`### 承認待ち (${args.pendingApprovals.length})`);
  if (args.pendingApprovals.length === 0) {
    lines.push("- (none)");
  } else {
    for (const a of args.pendingApprovals) {
      const expired = a.expired ? " (expired)" : "";
      lines.push(
        `- [${a.risk}] ${a.kind}: ${a.reason} — session ${shortId(a.sessionId)}, since ${a.createdAt}${expired}`,
      );
    }
  }
  lines.push("");
  lines.push(`### 要注意 session (${args.suspects.length})`);
  if (args.suspects.length === 0) {
    lines.push("- (none)");
  } else {
    for (const e of args.suspects) {
      lines.push(
        `- ${shortId(e.sessionId)} (${e.session.session.status}) — ${suspectText(e.suspectReason)}`,
      );
    }
  }
  lines.push("");

  // "where am I heading"
  lines.push("## どこへ向かう");
  lines.push("");
  if (args.planned.length === 0) {
    lines.push("- (no planned tasks — direction is inferred from recent decisions)");
    if (args.latestDecision !== undefined) {
      lines.push(`  - 直近の判断: ${args.latestDecision.title}`);
    }
  } else {
    for (const t of args.planned) {
      lines.push(`- ${t.task.task.title} [${shortId(t.task.task.id)}]`);
    }
  }
  lines.push("");

  // "is this current" — capture freshness / coverage
  lines.push("## これは最新か");
  lines.push("");
  if (args.newest !== undefined) {
    lines.push(
      `- newest captured session: ${args.newest.session.session.started_at} (${newestRel})`,
    );
  } else {
    lines.push("- newest captured session: (no sessions captured yet)");
  }
  const sourceBreakdown = [...args.bySource.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
  lines.push(
    `- sessions: ${args.sessionCount}${sourceBreakdown !== "" ? ` (${sourceBreakdown})` : ""}`,
  );
  if (args.sourceRoots !== undefined && args.sourceRoots.length > 0) {
    lines.push(`- source roots: ${args.sourceRoots.join(", ")}`);
  } else {
    lines.push("- source roots: (single root)");
  }
  lines.push(`- suspect sessions: ${args.suspects.length}`);
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
