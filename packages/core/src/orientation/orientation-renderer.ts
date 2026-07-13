import { dirname, join } from "node:path";
import { enumerateApprovals, isLazyExpired, loadApproval } from "../approval/approval-store.js";
import { type ReplayWarning, replayEvents } from "../events/event-replay.js";
import { formatDurationMs } from "../lib/format-duration.js";
import { isTrailingStale, pickLatestSubstantiveEntry } from "../lib/recency.js";
import { AGENT_INFRA_DIRS, classifyFilesBySourceRoot } from "../lib/source-root-scope.js";
import {
  resolveViewLanguageFromPaths,
  type ViewLanguage,
  type ViewStrings,
  viewStrings,
} from "../lib/view-strings.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import { readManifest } from "../storage/manifest.js";
import {
  type FederatedRoot,
  loadFederatedSessionEntries,
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
  /**
   * Result of a read-only dry-run staleness probe (sessions a `basou refresh`
   * would add or update), computed by the CLI which holds the import context.
   * Drives the plain "is this current" verdict. `null` / omitted = not probed, so
   * the verdict says it cannot confirm freshness rather than claiming current.
   */
  staleness?: {
    newSessions: number;
    updatedSessions: number;
    unverifiableSessions?: number;
  } | null;
  /**
   * Append the raw freshness telemetry (ISO timestamp, per-source counts, source
   * roots, suspect count) under the plain verdict. Off by default so the section
   * reads as a verdict for a supervisor, not developer diagnostics.
   */
  verbose?: boolean;
  /**
   * Generated-view chrome language. Omitted (the normal path) = resolved from
   * the manifest's anchor repo via {@link resolveViewLanguageFromPaths}; the
   * override exists for tests and programmatic callers that already resolved it.
   */
  language?: ViewLanguage;
  /**
   * Additional trail stores to MERGE into this orientation, each a local path
   * (an SSHFS mount / rsync mirror of another host's `.basou`) tagged with a
   * host label. Absent / empty = local-only (byte-identical to before). basou
   * performs no network I/O; the operator's existing tooling places these paths.
   */
  federatedRoots?: FederatedRoot[];
  /**
   * Called when a federated (non-local) host root is present but cannot be
   * enumerated (e.g. an unreadable mount). That host is skipped; the local
   * store and other hosts still render. An absent root path is silently empty.
   */
  onHostUnavailable?: (host: string, error: unknown) => void;
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
  /** Open (non-voided) `kind: "track"` decisions surfaced as strategic continuation. */
  openTrackCount: number;
};

type DecisionRecord = {
  decisionId: string;
  title: string;
  occurredAt: string;
  sessionId: string;
  host: string | null;
};

/**
 * An open (non-voided) decision recorded with `kind: "track"` — a strategic,
 * unfinished direction the forward section resurfaces every session until it is
 * closed via `decision void` / supersede. Carries the rationale (the WHY) so the
 * surfaced track answers not just "what to build next" but "and why", which is
 * exactly the intent that otherwise lives only in the conversation.
 */
type TrackRecord = {
  decisionId: string;
  title: string;
  rationale: string | null;
  occurredAt: string;
  sessionId: string;
  host: string | null;
};

type NoteRecord = { body: string; sessionId: string; occurredAt: string; host: string | null };

/**
 * One recent session condensed to its direction signal, for the "recent
 * direction" section. Across the last N non-archived sessions
 * (newest first), this surfaces the ARC of recent intent — the decision titles
 * and next-step notes recorded in EACH session — rather than orientation's
 * single latest decision/note, which can be stale or missing. When a session
 * recorded neither a decision nor a note, its top changed files stand in as the
 * activity signal, so the trajectory stays visible even when explicit capture
 * was missed (the read-side safety net for the intent-leak gap).
 */
type RecentSessionDigest = {
  sessionId: string;
  label: string | null;
  /** Session boundary (ended_at ?? started_at); the basis for its relative age. */
  occurredAt: string;
  host: string | null;
  /** Non-voided decision titles recorded in this session, chronological, capped. */
  decisions: string[];
  /** Count of this session's non-voided decisions beyond those in `decisions`. */
  decisionsOverflow: number;
  /** next_step note bodies recorded in this session, chronological, capped. */
  notes: string[];
  /** Top changed files, populated ONLY when the session has no decision and no note. */
  files: string[];
};

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
type SuspectSession = {
  sessionId: string;
  status: string;
  reason: SuspectReason | null;
  host: string | null;
};
type LatestSession = {
  sessionId: string;
  label: string | null;
  status: string;
  host: string | null;
};
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
  /**
   * Open (non-voided) `kind: "track"` decisions — strategic, unfinished
   * directions that the forward section ("where you are heading") resurfaces every session
   * until they are closed with `decision void` / supersede. Newest first. This
   * is the intent-continuity layer: distinct from the single latest decision
   * (point-in-time) and the recorded next step (`note`), an open track keeps
   * carrying "the next essential thing to build, and why" across sessions so it
   * does not sink into the flat decision list. Empty when none are open.
   */
  openTracks: TrackRecord[];
  /**
   * Most recent `note_added` over non-archived sessions — the recorded next
   * step / handoff ("next step") surfaced in the forward section; null when none.
   */
  latestNote: NoteRecord | null;
  /**
   * The last N non-archived sessions (newest first) condensed to their direction
   * signal — the "recent direction" arc. Distinct from the single
   * latest decision/note: it shows the trajectory of intent across recent
   * sessions, and falls back to each session's changed files when no decision or
   * note was captured, so a resuming agent has grounding even when explicit
   * capture was missed. Empty when no non-archived sessions exist.
   */
  recentDirection: RecentSessionDigest[];
  /**
   * related_files of the latest session, deduped + sorted + capped at the
   * display limit. `outOfRoot` lists the entries (over the FULL deduped set,
   * not just `displayed`) that resolve OUTSIDE the project's `source_roots` — a
   * cross-project boundary crossing worth flagging so a resuming agent does not
   * mistake another repo's edits for this project's work. Empty unless the
   * latest session is local (a federated host's source_roots are not loaded
   * here) and confidently has out-of-root edits.
   */
  relatedFiles: { displayed: string[]; overflow: number; outOfRoot: string[] };
  /** Tasks whose status is `planned` or `in_progress`. */
  inFlightTasks: InFlightTask[];
  /** Tasks whose status is `planned` ("where am I heading"). */
  plannedTasks: PlannedTask[];
  pendingApprovals: PendingApproval[];
  suspects: SuspectSession[];
  /**
   * Distinct non-local host labels present in the merged set (sorted). Empty
   * for a local-only orientation. Lets a consumer render the multi-host banner
   * and the local-only-freshness caveat without re-deriving from sessions.
   */
  hosts: string[];
  freshness: {
    /** started_at of the newest non-archived session, or null when none captured. */
    newestStartedAt: string | null;
    /** source.kind of the newest non-archived session, or null when none captured. */
    newestSource: string | null;
    /**
     * Tail of captured activity over non-archived sessions = max of each
     * session's boundary (`ended_at` ?? `started_at`) and every captured event's
     * `occurred_at`. Folding event times covers a live session whose `ended_at`
     * is not yet written. Used to flag a latest-recorded decision that trails
     * real activity; null when no non-archived sessions exist.
     */
    latestActivityAt: string | null;
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
  const entries =
    input.federatedRoots !== undefined && input.federatedRoots.length > 0
      ? await loadFederatedSessionEntries(
          [{ paths: input.paths, host: null }, ...input.federatedRoots],
          {
            ...loadOpts,
            ...(input.onHostUnavailable !== undefined
              ? { onRootUnavailable: input.onHostUnavailable }
              : {}),
          },
        )
      : await loadSessionEntries(input.paths, loadOpts);

  // One replay pass per session yields three facts:
  //  - `decisions`: chronological `decision_recorded` across ALL sessions.
  //  - `latestNote`: the most recent `note_added` over NON-archived sessions —
  //    the operator's recorded next step / handoff ("next step"), surfaced in the
  //    forward section so a free-text resume hint survives into the next session.
  //  - `latestActivityAt`: the tail of captured activity over NON-archived
  //    sessions = max of the session boundary (ended_at ?? started_at) AND every
  //    event's occurred_at. Folding event times (not just ended_at) is what makes
  //    the trailing-decision note fire for a LIVE session: a running session has
  //    no ended_at yet, but its post-decision events (more commands, notes, task
  //    attaches via `decision record --session`) are already captured. Without
  //    this, a mid-session decision in an ongoing long session — the exact case
  //    the note targets — would be silently treated as current (a false-clear).
  //    The population is intentionally asymmetric: decisions span archived
  //    sessions (a past decision still answers "what did I last decide"), while
  //    the activity tail and latest note are non-archived only (they answer "is
  //    there newer work" / "where do I resume").
  const decisions: DecisionRecord[] = [];
  // Decisions recorded with `kind: "track"` (a strategic, unfinished direction).
  // Collected across the same pass; the open subset (minus voided) is surfaced
  // in the forward section and resurfaces until closed.
  const tracks: TrackRecord[] = [];
  // decision_ids marked no longer in force by a `decision_voided` event; the
  // "latest decision" pointer skips them so a voided decision is never
  // surfaced as the current direction.
  const voidedDecisionIds = new Set<string>();
  // Per-session direction signals for the "recent direction" arc: each non-archived
  // session's decision titles (with ids so a later void can be filtered out) and
  // next_step note bodies, in chronological order. The recent-session slice +
  // file fallback are assembled after the scan (voids are resolved first).
  const perSession = new Map<
    string,
    { decisions: { decisionId: string; title: string }[]; notes: string[] }
  >();
  const recordDirection = (
    sessionId: string,
    kind: "decision" | "note",
    value: { decisionId: string; title: string } | string,
  ): void => {
    let bucket = perSession.get(sessionId);
    if (bucket === undefined) {
      bucket = { decisions: [], notes: [] };
      perSession.set(sessionId, bucket);
    }
    if (kind === "decision" && typeof value !== "string") bucket.decisions.push(value);
    else if (kind === "note" && typeof value === "string") bucket.notes.push(value);
  };
  let latestActivityAt: string | null = null;
  let latestNote: NoteRecord | null = null;
  const noteActivity = (iso: string): void => {
    if (latestActivityAt === null || Date.parse(iso) > Date.parse(latestActivityAt)) {
      latestActivityAt = iso;
    }
  };
  for (const entry of entries) {
    const sessionDir = join(entry.sourceRoot.sessions, entry.sessionId);
    const counted = entry.session.session.status !== "archived";
    // Seed with the session boundary so a session whose events are empty or
    // unreadable still contributes its known activity window.
    if (counted) noteActivity(entry.session.session.ended_at ?? entry.session.session.started_at);
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
            host: entry.host,
          });
          // Per-session arc (non-archived only); voided ids are filtered later.
          if (counted) {
            recordDirection(entry.sessionId, "decision", {
              decisionId: ev.decision_id,
              title: ev.title,
            });
          }
          // Tracks (kind === "track") are an unfinished direction; collect them
          // separately with their rationale so the forward section can resurface
          // them until closed. A void recorded later removes the id from the open
          // set (resolved below, after the full scan, so a void seen before its
          // target decision still applies).
          if (ev.kind === "track") {
            tracks.push({
              decisionId: ev.decision_id,
              title: ev.title,
              rationale: ev.rationale ?? null,
              occurredAt: ev.occurred_at,
              sessionId: entry.sessionId,
              host: entry.host,
            });
          }
        } else if (ev.type === "decision_voided") {
          voidedDecisionIds.add(ev.decision_id);
        }
        // Only `next_step`-kind notes (from `basou note`) are resume hints; a
        // plain `basou session note` annotation (kind absent) is not surfaced.
        if (counted && ev.type === "note_added" && ev.kind === "next_step") {
          recordDirection(entry.sessionId, "note", ev.body);
          if (
            latestNote === null ||
            Date.parse(ev.occurred_at) > Date.parse(latestNote.occurredAt)
          ) {
            latestNote = {
              body: ev.body,
              sessionId: entry.sessionId,
              occurredAt: ev.occurred_at,
              host: entry.host,
            };
          }
        }
        if (counted) noteActivity(ev.occurred_at);
      }
    } catch {
      input.onSessionSkip?.(entry.sessionId, "events_jsonl_unreadable");
    }
  }
  decisions.sort((a, b) => {
    const c = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
    return c !== 0 ? c : a.decisionId.localeCompare(b.decisionId);
  });
  // The latest-decision pointer is the newest decision NOT voided — a voided
  // decision must not be presented as the current direction. decisions.md still
  // lists it (struck) for the audit trail.
  let latestDecision: DecisionRecord | undefined;
  for (let i = decisions.length - 1; i >= 0; i -= 1) {
    const d = decisions[i];
    if (d !== undefined && !voidedDecisionIds.has(d.decisionId)) {
      latestDecision = d;
      break;
    }
  }

  // Open tracks: every `kind: "track"` decision not yet voided/superseded, newest
  // first (most recent strategic direction leads). These resurface in the forward
  // section every session until explicitly closed — the durable intent layer.
  const openTracks: TrackRecord[] = tracks
    .filter((t) => !voidedDecisionIds.has(t.decisionId))
    .sort((a, b) => {
      const c = Date.parse(b.occurredAt) - Date.parse(a.occurredAt);
      return c !== 0 ? c : b.decisionId.localeCompare(a.decisionId);
    });

  // "Recent direction" arc: the last N non-archived sessions, newest first, each
  // condensed to the decisions/notes it recorded (voided decisions filtered out
  // so a struck decision is never presented as direction). A session with no
  // decision and no note falls back to its changed files, so the trajectory is
  // visible even when explicit capture was missed. Sorted by session boundary so
  // the arc reads newest-first regardless of on-disk entry order; ties break on
  // sessionId (ULIDs are time-ordered, so descending keeps it deterministic and
  // newest-first) so which sessions survive the slice never depends on disk order.
  const recentDirection: RecentSessionDigest[] = entries
    .filter((e) => e.session.session.status !== "archived")
    .map((e) => ({
      entry: e,
      boundary: e.session.session.ended_at ?? e.session.session.started_at,
    }))
    .sort((a, b) => {
      const c = Date.parse(b.boundary) - Date.parse(a.boundary);
      return c !== 0 ? c : b.entry.sessionId.localeCompare(a.entry.sessionId);
    })
    .slice(0, RECENT_DIRECTION_SESSIONS)
    .map(({ entry, boundary }) => {
      const bucket = perSession.get(entry.sessionId);
      const decisionTitles = (bucket?.decisions ?? [])
        .filter((d) => !voidedDecisionIds.has(d.decisionId))
        .map((d) => d.title);
      const notes = bucket?.notes ?? [];
      const hasIntent = decisionTitles.length > 0 || notes.length > 0;
      const files = hasIntent
        ? []
        : [...new Set(entry.session.session.related_files ?? [])].sort().slice(0, FILES_PER_DIGEST);
      return {
        sessionId: entry.sessionId,
        label: entry.session.session.label ?? null,
        occurredAt: boundary,
        host: entry.host,
        decisions: decisionTitles.slice(0, DECISIONS_PER_DIGEST),
        decisionsOverflow: Math.max(0, decisionTitles.length - DECISIONS_PER_DIGEST),
        notes: notes.slice(0, NOTES_PER_DIGEST),
        files,
      };
    });

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
      host: e.host,
    }));

  // "where am I now" latest session: exclude archived + cross-workspace round-trip
  // imports (`source.kind === "import"`), matching the handoff renderer.
  // claude-code-import / codex-import sessions ARE the operator's own captured
  // work, so they remain in scope.
  const liveEntries = entries.filter(
    (e) => e.session.session.status !== "archived" && e.session.session.source.kind !== "import",
  );
  // Represent the last session with the most recent SUBSTANTIVE session, not a bare
  // resume/refresh session (e.g. 1 command, 0 files) that merely happens to be
  // newest — the latter hides the real-work session and makes the last-session and
  // latest-decision pointers disagree. Freshness ("newest captured session", below) still uses
  // pure recency, so the staleness signal stays honest.
  const latestEntry = pickLatestSubstantiveEntry(liveEntries);
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
          host: latestEntry.host,
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
  const sortedFiles = [...uniqueFiles].sort();
  const displayed = sortedFiles.slice(0, limit);
  const overflow = Math.max(0, uniqueFiles.size - limit);

  // Flag the files that resolve OUTSIDE this project's source_roots (a
  // cross-project boundary crossing). Classify the FULL file set, not just the
  // displayed slice, so an out-of-root file past the display cap is still
  // counted. Gated to projects that DECLARE source_roots (a multi-repo
  // workspace): a solo project's effective root is the whole repo, so there is
  // no declared boundary to cross and flagging would be noise. Scoped to a
  // LOCAL latest session — a federated host's source_roots are not loaded here,
  // so classifying its files against the local roots would cry wolf. Agent/tool
  // infra dirs count as in-root so routine plan / memory edits are not mistaken
  // for another project. dirname(.basou) is the repo root the source_roots
  // resolve against.
  let outOfRoot: string[] = [];
  if (
    latestEntry !== undefined &&
    latestEntry.host === null &&
    sortedFiles.length > 0 &&
    sourceRoots !== null &&
    sourceRoots.length > 0
  ) {
    try {
      const scope = await classifyFilesBySourceRoot({
        files: sortedFiles,
        workingDirectory: latestEntry.session.session.working_directory,
        sourceRoots,
        masterRoot: dirname(input.paths.root),
        extraInRoot: AGENT_INFRA_DIRS,
      });
      outOfRoot = scope.outOfRoot;
    } catch {
      // Classification is advisory only; never let it break orientation.
      outOfRoot = [];
    }
  }

  const hosts = [
    ...new Set(entries.map((e) => e.host).filter((h): h is string => h !== null)),
  ].sort();

  return {
    generatedAt: input.nowIso,
    sessionCount: entries.length,
    latestSession,
    latestDecision: latestDecision ?? null,
    decisionCount: decisions.length,
    openTracks,
    latestNote,
    recentDirection,
    relatedFiles: { displayed, overflow, outOfRoot },
    inFlightTasks,
    plannedTasks,
    pendingApprovals,
    suspects,
    hosts,
    freshness: {
      newestStartedAt: newest?.session.session.started_at ?? null,
      newestSource: newest?.session.session.source.kind ?? null,
      latestActivityAt,
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
  const language = input.language ?? (await resolveViewLanguageFromPaths(input.paths));
  return {
    body: formatOrientationBody(summary, {
      staleness: input.staleness ?? null,
      verbose: input.verbose === true,
      language,
    }),
    sessionCount: summary.sessionCount,
    pendingApprovalsCount: summary.pendingApprovals.length,
    suspectCount: summary.suspects.length,
    inFlightTaskCount: summary.inFlightTasks.length,
    decisionCount: summary.decisionCount,
    openTrackCount: summary.openTracks.length,
  };
}

function formatOrientationBody(
  summary: OrientationSummary,
  opts: {
    staleness: {
      newSessions: number;
      updatedSessions: number;
      unverifiableSessions?: number;
    } | null;
    verbose: boolean;
    language: ViewLanguage;
  },
): string {
  const t = viewStrings(opts.language);
  const lines: string[] = [];
  const now = new Date(summary.generatedAt);
  const newestRel = relativeAge(summary.freshness.newestStartedAt ?? undefined, now);
  // Multi-host attribution suffix: only non-local rows carry it, so a
  // single-host (local-only) orientation is byte-identical to before.
  const hostSuffix = (h: string | null): string => (h !== null ? ` @${h}` : "");

  lines.push("# Orientation");
  lines.push("");
  lines.push(
    `> Generated at ${summary.generatedAt} · sessions ${summary.sessionCount} · newest ${newestRel} · pending ${summary.pendingApprovals.length} · suspect ${summary.suspects.length}`,
  );
  if (summary.hosts.length > 0) {
    lines.push(`> hosts: local, ${summary.hosts.join(", ")}`);
  }
  lines.push("");

  // Staleness banner up top: when there is uncaptured/grown native work, a
  // reader grounding top-down should meet the warning BEFORE the direction /
  // "next step" sections, not only in the "is this current" verdict at the very
  // bottom (which is easy to start working before ever reaching). Shown only for
  // the actionable-stale states; the full verdict still renders at the end.
  const banner = stalenessBanner(opts.staleness, t);
  if (banner.length > 0) {
    for (const line of banner) lines.push(line);
    lines.push("");
  }

  // "where am I now"
  lines.push(t.orientation.headingWhere);
  lines.push("");
  if (summary.latestSession !== null) {
    const s = summary.latestSession;
    const sid = shortId(s.sessionId);
    if (s.label !== null && s.label !== "") {
      lines.push(
        `- ${t.common.lastSessionLabel}: ${s.label} (${s.status}) [${sid}]${hostSuffix(s.host)}`,
      );
    } else {
      lines.push(`- ${t.common.lastSessionLabel}: ${sid} (${s.status})${hostSuffix(s.host)}`);
    }
  } else {
    lines.push(`- ${t.common.lastSessionLabel}: (no live sessions)`);
  }
  if (summary.latestDecision !== null) {
    const dec = summary.latestDecision;
    const decAge = t.relativeAge(dec.occurredAt, now);
    lines.push(
      `- ${t.common.latestDecisionLabel}: ${dec.title} [${shortId(dec.decisionId)}] (${decAge})${hostSuffix(dec.host)}`,
    );
    // Honesty over recency theater: this is the latest *recorded* decision, not
    // necessarily the latest decision. When captured activity continued well
    // past it, the operator's current direction may simply be unrecorded
    // (conversational decisions are not auto-captured), so note the gap rather
    // than presenting a stale decision as the current direction. The wording
    // states only what is certain — the decision predates the latest activity —
    // and does not assert that decisions were made in between, so it stays
    // honest whether the later activity is in the same session or another.
    const activityAt = summary.freshness.latestActivityAt;
    if (activityAt !== null && isTrailingStale(activityAt, dec.occurredAt)) {
      lines.push(`  - ${t.orientation.decisionStaleNote(t.relativeAge(activityAt, now))}`);
    }
    // When the latest recorded decision comes from a DIFFERENT session than the
    // representative latest session, the two "latest" pointers disagree. Say so,
    // so a resume reader does not treat an older thread's decision as this
    // session's direction (a linear-timeline cue, not a stale claim).
    if (summary.latestSession !== null && dec.sessionId !== summary.latestSession.sessionId) {
      lines.push(`  - ${t.common.decisionOtherSessionNote(shortId(dec.sessionId))}`);
    }
    if (summary.decisionCount > 1) {
      lines.push(`  - ${summary.decisionCount} decisions total — see decisions.md`);
    }
  } else {
    lines.push(
      `- ${t.common.latestDecisionLabel}: (no decisions recorded yet; capture with \`basou decision capture\`)`,
    );
  }
  if (summary.relatedFiles.displayed.length > 0) {
    const shown = summary.relatedFiles.displayed.join(", ");
    const more =
      summary.relatedFiles.overflow > 0 ? ` (... +${summary.relatedFiles.overflow} more)` : "";
    lines.push(`- ${t.common.recentFilesLabel}: ${shown}${more}`);
    if (summary.relatedFiles.outOfRoot.length > 0) {
      // Cross-project boundary crossing: the latest session edited files
      // outside this project's source_roots. Flag it so a resuming agent does
      // not adopt another repo's work as this project's continuation. The count
      // reflects ALL out-of-root files; the listed paths are capped like the
      // line above.
      const OUT_OF_ROOT_DISPLAY = 10;
      const out = summary.relatedFiles.outOfRoot;
      const shownOut = out.slice(0, OUT_OF_ROOT_DISPLAY).join(", ");
      const outMore =
        out.length > OUT_OF_ROOT_DISPLAY ? ` (... +${out.length - OUT_OF_ROOT_DISPLAY} more)` : "";
      lines.push(`  - ${t.orientation.outOfRootWarning(out.length, `${shownOut}${outMore}`)}`);
    }
  } else {
    lines.push(`- ${t.common.recentFilesLabel}: (none recorded)`);
  }
  lines.push("");

  // "recent direction" — the arc of the last N sessions, the read-side safety
  // net so a resuming agent sees the recent trajectory of intent (decisions /
  // next steps), or the activity (changed files) when capture was missed, rather
  // than only the single latest decision/note above.
  lines.push(t.orientation.headingRecent(RECENT_DIRECTION_SESSIONS));
  lines.push("");
  if (summary.recentDirection.length === 0) {
    lines.push(`- ${t.orientation.recentEmpty}`);
  } else {
    for (const s of summary.recentDirection) {
      const sid = shortId(s.sessionId);
      const age = t.relativeAge(s.occurredAt, now);
      const head = s.label !== null && s.label !== "" ? s.label : sid;
      lines.push(`- ${head} (${age})${hostSuffix(s.host)}`);
      if (s.decisions.length > 0) {
        const more = s.decisionsOverflow > 0 ? ` (+${s.decisionsOverflow})` : "";
        lines.push(
          `  - ${t.orientation.recentDecisionsLabel}: ${s.decisions.map(noteSummary).join("; ")}${more}`,
        );
      }
      for (const note of s.notes) {
        lines.push(`  - ${t.orientation.recentNextStepLabel}: ${noteSummary(note)}`);
      }
      // Files appear only as the fallback (no decision and no note this session).
      if (s.files.length > 0) {
        lines.push(`  - ${t.orientation.recentChangedLabel}: ${s.files.join(", ")}`);
      }
    }
  }
  lines.push("");

  // "what is in flight" — structured facts
  lines.push(t.orientation.headingInFlight);
  lines.push("");
  lines.push(t.orientation.inFlightTasksHeading(summary.inFlightTasks.length));
  if (summary.inFlightTasks.length === 0) {
    lines.push("- (none)");
  } else {
    for (const t of summary.inFlightTasks) {
      const linkedSuffix = t.linkedSessions > 1 ? ` — linked_sessions: ${t.linkedSessions}` : "";
      lines.push(`- ${t.title} (${t.status}) [${shortId(t.id)}]${linkedSuffix}`);
    }
  }
  lines.push("");
  lines.push(t.orientation.pendingApprovalsHeading(summary.pendingApprovals.length));
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
  lines.push(t.orientation.suspectSessionsHeading(summary.suspects.length));
  if (summary.suspects.length === 0) {
    lines.push("- (none)");
  } else {
    for (const e of summary.suspects) {
      lines.push(
        `- ${shortId(e.sessionId)} (${e.status}) — ${suspectText(e.reason)}${hostSuffix(e.host)}`,
      );
    }
  }
  lines.push("");

  // "where am I heading"
  lines.push(t.orientation.headingForward);
  lines.push("");
  // Open tracks lead the forward section: a strategic, unfinished direction
  // ("the next essential thing to build, and why") is the most important thing to
  // carry across a session boundary, and it resurfaces here every time until
  // explicitly closed. Distinct from the recorded next step (a terminal `note`)
  // and from in-flight tasks (mechanical). This is the intent-continuity layer —
  // without it an agreed direction sinks into the flat decision list and the next
  // session never sees it (the failure this section exists to prevent).
  if (summary.openTracks.length > 0) {
    const TRACK_DISPLAY_LIMIT = 10;
    const shownTracks = summary.openTracks.slice(0, TRACK_DISPLAY_LIMIT);
    const trackOverflow = summary.openTracks.length - shownTracks.length;
    lines.push(t.orientation.openTracksHeading(summary.openTracks.length));
    for (const track of shownTracks) {
      const trackAge = t.relativeAge(track.occurredAt, now);
      lines.push(
        `- ${track.title} [${shortId(track.decisionId)}] (${trackAge})${hostSuffix(track.host)}`,
      );
      if (track.rationale !== null && track.rationale.trim() !== "") {
        lines.push(`  - ${t.common.trackWhyLabel}: ${trackRationale(track.rationale)}`);
      }
    }
    if (trackOverflow > 0) {
      lines.push(`- ... +${trackOverflow} more (see decisions.md)`);
    }
    // Section-scoped close instruction: a top-level line (not an indented sub-
    // bullet) so it reads as guidance for the whole list, mirroring handoff.
    lines.push(t.orientation.trackCloseInstruction);
    lines.push("");
  }
  // The recorded next step (a `basou note`) is the operator's explicit resume
  // hint; surface it first so a free-text handoff survives into the next session
  // rather than living only in a decision title or an external memory file.
  if (summary.latestNote !== null) {
    const noteAge = t.relativeAge(summary.latestNote.occurredAt, now);
    lines.push(
      `- ${t.orientation.nextStepRecordedLabel(noteAge)}: ${noteSummary(summary.latestNote.body)} [session ${shortId(summary.latestNote.sessionId)}]${hostSuffix(summary.latestNote.host)}`,
    );
    // Same honesty guard as the latest decision: if captured activity continued
    // well past when this resume hint was recorded, the work may have moved on,
    // so flag it rather than presenting a stale starting point as current.
    const activityAt = summary.freshness.latestActivityAt;
    if (activityAt !== null && isTrailingStale(activityAt, summary.latestNote.occurredAt)) {
      lines.push(`  - ${t.orientation.noteStaleNote(t.relativeAge(activityAt, now))}`);
    }
  }
  for (const t of summary.plannedTasks) {
    lines.push(`- ${t.title} [${shortId(t.id)}]`);
  }
  // Fall back to the decision hint only when there is no open track, no recorded
  // next step, and no planned task — otherwise the section already says where to
  // go (an open track is the strongest such signal).
  if (
    summary.openTracks.length === 0 &&
    summary.latestNote === null &&
    summary.plannedTasks.length === 0
  ) {
    const dec = summary.latestDecision;
    if (dec === null) {
      lines.push("- (no planned tasks or recorded next step yet)");
    } else if (isTrailingStale(summary.freshness.latestActivityAt, dec.occurredAt)) {
      // The misfire guard: do NOT present a STALE decision as direction. Activity
      // continued well after it, so it may already be resolved/executed; an agent
      // that treats it as the next task can re-attempt completed work. Ask for the
      // continuation point instead, and demote the decision to a labelled
      // reference rather than an instruction (aligns the forward section with the
      // staleness warning already shown on the latest-decision line above).
      lines.push(t.orientation.fallbackStaleDirection);
      lines.push(`  - ${t.orientation.fallbackStaleReferenceLabel}: ${dec.title}`);
    } else {
      lines.push("- (no planned tasks — direction is inferred from recent decisions)");
      lines.push(`  - ${t.common.latestDecisionLabel}: ${dec.title}`);
    }
    // Discoverability nudge: fires when there ARE recorded decisions but none give
    // a durable forward direction (latest is stale, or just point-in-time) — the
    // moment a strategic direction is most likely sitting only in conversation.
    // Point the agent at tracks so the next agreed direction is captured durably
    // instead of leaking again. Suppressed for a pristine workspace (no decisions
    // yet) so it is a hint at the right time, not noise, and never shown when an
    // open track / note / planned task already gives direction.
    if (dec !== null) {
      lines.push(`  - ${t.orientation.trackNudge}`);
    }
  }
  lines.push("");

  // "is this current" — a plain verdict for a supervisor, not telemetry: is what
  // I am looking at the latest and complete, and if not, what should I do? Raw
  // ISO / per-source counts / source roots / a zero suspect count are diagnostics
  // and move under `--verbose`.
  lines.push(t.orientation.headingCurrency);
  lines.push("");
  for (const line of freshnessVerdict(summary, opts.staleness, now, t)) lines.push(line);
  // The verdict above reflects the LOCAL store only (the dry-run probe reads
  // this machine's native logs). With federated hosts merged in, do not let it
  // imply the whole multi-host view is current — the other hosts' freshness is
  // unknowable here (their native logs are not on this machine).
  if (summary.hosts.length > 0) {
    lines.push("");
    lines.push(t.orientation.federatedFreshnessNote);
  }

  if (opts.verbose) {
    lines.push("");
    lines.push("<!-- verbose: raw freshness telemetry -->");
    if (summary.freshness.newestStartedAt !== null) {
      lines.push(`- newest captured session: ${summary.freshness.newestStartedAt} (${newestRel})`);
    } else {
      lines.push("- newest captured session: (no sessions captured yet)");
    }
    if (summary.freshness.latestActivityAt !== null) {
      lines.push(
        `- latest activity: ${summary.freshness.latestActivityAt} (${relativeAge(summary.freshness.latestActivityAt, now)})`,
      );
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
    const probe =
      opts.staleness === null
        ? "not run"
        : `new ${opts.staleness.newSessions}, updated ${opts.staleness.updatedSessions}, unverifiable ${opts.staleness.unverifiableSessions ?? 0}`;
    lines.push(`- staleness probe: ${probe}`);
  }

  return lines.join("\n");
}

/**
 * Translate an internal source kind into the tool name a supervisor recognizes.
 * Unknown kinds pass through verbatim so a new adapter is never silently mislabeled.
 */
function toolDisplayName(kind: string | null, t: ViewStrings): string {
  switch (kind) {
    case "claude-code-import":
    case "claude-code-adapter":
      return "Claude Code";
    case "codex-import":
      return "Codex";
    case "terminal":
      return t.orientation.toolTerminal;
    case "human":
      return t.orientation.toolHuman;
    case "import":
      return t.orientation.toolImport;
    default:
      return kind ?? t.orientation.toolUnknown;
  }
}

/**
 * A concise staleness banner for the TOP of the orientation, shown only when
 * there is uncaptured/grown native work to pull in (the states the full
 * "is this current" verdict flags with ⚠️). Surfaced near the header so a reader
 * grounding top-down meets it before the direction / next-step sections, not
 * only at the very bottom. Returns [] when the capture is current, empty, or
 * unprobed — nothing actionable to flag up top (the bottom verdict still covers
 * those neutral states).
 */
function stalenessBanner(
  staleness: { newSessions: number; updatedSessions: number; unverifiableSessions?: number } | null,
  t: ViewStrings,
): string[] {
  if (staleness === null) return [];
  if ((staleness.unverifiableSessions ?? 0) > 0) {
    return [t.orientation.bannerUnverifiable(staleness.unverifiableSessions ?? 0)];
  }
  // Assert ONLY for genuinely uncaptured (never-imported) sessions: those are
  // real backlog a `basou refresh` WILL pull in. A merely GROWN ("updated")
  // session is dominated by the live session you are in — its transcript always
  // advances past the last import, so refreshing re-grows it immediately and a
  // "must refresh" imperative there can never be satisfied (the learned-
  // helplessness dbp_wp reported). That state is the live session (normal), so
  // it gets no top banner — only the calm bottom verdict explains it.
  if (staleness.newSessions > 0) {
    const parts: string[] = [t.orientation.partNew(staleness.newSessions)];
    if (staleness.updatedSessions > 0)
      parts.push(t.orientation.partUpdated(staleness.updatedSessions));
    return [t.orientation.bannerStale(parts.join(t.orientation.partsJoiner))];
  }
  return [];
}

/**
 * The plain "is this current" verdict: a status line plus one human sentence
 * that answers "is this current, and if not what do I do?". Freshness comes
 * from the dry-run `staleness` probe (uncaptured/grown native work); when it
 * was not run the verdict says so instead of claiming current. A non-zero
 * suspect count is surfaced as a caution even when the capture is fresh.
 */
function freshnessVerdict(
  summary: OrientationSummary,
  staleness: { newSessions: number; updatedSessions: number; unverifiableSessions?: number } | null,
  now: Date,
  t: ViewStrings,
): string[] {
  // Unverifiable wins absolutely first: a source that GREW but could not be
  // re-imported safely (broken chain / unreadable / non-append) means the
  // capture is provably behind AND a plain `basou refresh` would skip it again.
  // Claiming "current" here is the false-clear this verdict exists to prevent,
  // so it is surfaced ahead of every other state, including "no records".
  if (staleness !== null && (staleness.unverifiableSessions ?? 0) > 0) {
    return [...t.orientation.verdictUnverifiable(staleness.unverifiableSessions ?? 0)];
  }

  // Genuinely uncaptured (NEVER-imported) sessions are real backlog a refresh
  // WILL pull in, even when the store is still empty — so assert it, and check it
  // before the "no records" branch. A merely GROWN ("updated") session is NOT
  // asserted here: the live session you are in always shows as grown, and a
  // "must refresh" there can never be satisfied (it re-grows immediately). That
  // case is the calm "updated-only" branch below.
  if (staleness !== null && staleness.newSessions > 0) {
    const parts: string[] = [t.orientation.partNew(staleness.newSessions)];
    if (staleness.updatedSessions > 0)
      parts.push(t.orientation.partUpdated(staleness.updatedSessions));
    return [...t.orientation.verdictStale(parts.join(t.orientation.partsJoiner))];
  }

  // Grown ("updated") sessions only — no never-imported, no unverifiable. `basou
  // refresh` CAN import these (e.g. a finished session imported mid-flight that
  // then gained more events), so it stays an actionable ⚠️ and the action is
  // offered — NOT softened to a silent ℹ️ that would hide that backlog. But the
  // imperative is dropped: the LIVE session you are in always shows as grown
  // (its transcript advances past the last import), so a "must refresh" can
  // never drive the count to zero. Explaining that residual is normal removes
  // the learned helplessness dbp_wp reported. Placed before the "no records"
  // branch so an archived-only store with a grown source is not mis-cleared as
  // empty.
  if (staleness !== null && staleness.updatedSessions > 0) {
    const lines = [...t.orientation.verdictUpdatedOnly(staleness.updatedSessions)];
    if (summary.suspects.length > 0) {
      lines.push(t.orientation.verdictSuspectsAlso(summary.suspects.length));
    }
    return lines;
  }

  if (summary.freshness.newestStartedAt === null) {
    return [...t.orientation.verdictEmpty];
  }

  const rel = t.relativeAge(summary.freshness.newestStartedAt, now);
  const tool = toolDisplayName(summary.freshness.newestSource, t);
  const suspectCount = summary.suspects.length;

  if (staleness === null) {
    return [...t.orientation.verdictUnprobed(rel, tool)];
  }

  // The probe ran and found no uncaptured/grown native sessions, so the IMPORT
  // is current. Scope the claim to exactly that — the old wording ("no
  // omissions / nothing to worry about") overclaimed: this verdict only checks
  // that captured native sessions are imported and none are suspect. It does NOT
  // (and from telemetry alone cannot) detect planning/implementation drift or
  // unrecorded decisions, so it must not imply provenance is comprehensive.
  // Federated views merge other hosts' sessions, but this verdict is driven by
  // a LOCAL dry-run probe (the remote hosts' native logs are not on this
  // machine). Scope the green claim to THIS host so it never reads as "the whole
  // multi-host view is current" — the local-only-freshness caveat below adds the
  // per-host sync guidance. Local-only views keep the original wording.
  const lines = [t.orientation.verdictCurrent(rel, tool, summary.hosts.length > 0)];
  if (suspectCount > 0) {
    lines.push(t.orientation.verdictSuspectsCaveat(suspectCount));
  }
  lines.push(t.orientation.verdictScopeDisclaimer);
  return lines;
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

// "Recent direction" caps: how many recent non-archived sessions to digest, and how
// many decisions / notes / fallback files to show per session. Kept small so the
// section stays a compact trajectory, not a full log (that is `basou handoff`).
const RECENT_DIRECTION_SESSIONS = 5;
const DECISIONS_PER_DIGEST = 3;
const NOTES_PER_DIGEST = 2;
const FILES_PER_DIGEST = 3;

// A recorded note can be multi-line and arbitrarily long; collapse whitespace
// to keep it on one orientation bullet and cap it so a verbose handoff does not
// dominate the view. The full body is preserved in the event (see session show).
const NOTE_SUMMARY_MAX = 200;
function noteSummary(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > NOTE_SUMMARY_MAX ? `${oneLine.slice(0, NOTE_SUMMARY_MAX - 1)}…` : oneLine;
}

// A track's rationale is the WHY behind the direction; like a note it can be
// multi-line and long, so collapse whitespace to one line and cap it. The full
// text is preserved in the decision_recorded event (see decisions.md).
const TRACK_RATIONALE_MAX = 240;
function trackRationale(rationale: string): string {
  const oneLine = rationale.replace(/\s+/g, " ").trim();
  return oneLine.length > TRACK_RATIONALE_MAX
    ? `${oneLine.slice(0, TRACK_RATIONALE_MAX - 1)}…`
    : oneLine;
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
