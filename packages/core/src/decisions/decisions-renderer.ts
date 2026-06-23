import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type ReplayWarning, replayEvents } from "../events/event-replay.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import { loadSessionEntries, type SessionSkipReason } from "../storage/sessions.js";

export type DecisionsRendererInput = {
  paths: BasouPaths;
  nowIso: string;
  onWarning?: (warning: ReplayWarning, sessionId: string) => void;
  onSessionSkip?: (sessionId: string, reason: SessionSkipReason) => void;
};

export type DecisionsRendererResult = {
  /** Generated body WITHOUT BASOU:GENERATED markers. */
  body: string;
  decisionCount: number;
};

type DecisionRecord = {
  decisionId: string;
  title: string;
  occurredAt: string;
  sessionId: string;
  // Rich fields. All optional; populated only when the decision_recorded
  // event carried the field.
  rationale: string | null | undefined;
  alternatives: readonly string[] | undefined;
  rejectedReason: string | null | undefined;
  linkedEvents: readonly string[] | undefined;
  linkedFiles: readonly string[] | undefined;
  // "track" when the decision was recorded as a strategic, unfinished direction
  // (resurfaced by orientation/handoff until voided); undefined / "decision" is
  // a plain point-in-time decision.
  kind: "decision" | "track" | undefined;
  // Set when a later `decision_voided` event targets this decision. The
  // decision is kept (append-only) but rendered struck-through; orientation
  // skips it as the "latest" direction.
  voided: { reason: string | null | undefined; supersededBy: string | undefined } | undefined;
};

/**
 * Render the body of `decisions.md` from `decision_recorded` events across
 * every healthy session in the workspace.
 *
 * Session enumeration goes through {@link loadSessionEntries} (the same path
 * the handoff renderer uses) so that `session.yaml`-broken sessions are
 * skipped in BOTH outputs and the handoff's `decisionCount` summary stays
 * consistent with the number of sections rendered here.
 *
 * Order: `occurred_at` ascending with `decisionId` (= ULID) as tie-breaker.
 * Both fields are monotonic, so the result is a stable cross-session
 * timeline.
 *
 * The decision rich fields (rationale / alternatives / rejected_reason /
 * linked_events / linked_files) are rendered when the event carries them.
 * `linked_events` and `linked_files` are OPAQUE references: the schema only
 * validates the SHAPE, not existence — references that cannot be resolved
 * to a known event id or an existing file on disk are surfaced inline as
 * `(missing)` so cross-workspace round-trips never reject parse-time.
 */
export async function renderDecisions(
  input: DecisionsRendererInput,
): Promise<DecisionsRendererResult> {
  const now = new Date(input.nowIso);
  // Same rationale as handoff-renderer. Track which
  // sessions already had `events_jsonl_unreadable` surfaced so non-running
  // sessions whose events.jsonl is unreadable still produce a stderr
  // warning instead of silently dropping their decisions.
  const unreadableEmitted = new Set<string>();
  const wrappedSkip: (sid: string, reason: SessionSkipReason) => void = (sid, reason) => {
    if (reason === "events_jsonl_unreadable") unreadableEmitted.add(sid);
    input.onSessionSkip?.(sid, reason);
  };
  const loadOpts: Parameters<typeof loadSessionEntries>[1] = { now, onSkip: wrappedSkip };
  if (input.onWarning !== undefined) loadOpts.onWarning = input.onWarning;
  const entries = await loadSessionEntries(input.paths, loadOpts);

  const decisions: DecisionRecord[] = [];
  // decision_id -> void record (last void wins). Collected in the same scan so
  // a void recorded in any session marks the target decision wherever it lives.
  const voids = new Map<
    string,
    { reason: string | null | undefined; supersededBy: string | undefined }
  >();
  // Workspace-wide event id index, populated during the same scan that
  // collects decisions, so `linked_events` membership can be resolved
  // without a second pass over events.jsonl.
  const knownEventIds = new Set<string>();
  for (const entry of entries) {
    const sessionDir = join(input.paths.sessions, entry.sessionId);
    try {
      for await (const ev of replayEvents(sessionDir, {
        onWarning: (w) => input.onWarning?.(w, entry.sessionId),
      })) {
        knownEventIds.add(ev.id);
        if (ev.type === "decision_recorded") {
          decisions.push({
            decisionId: ev.decision_id,
            title: ev.title,
            occurredAt: ev.occurred_at,
            sessionId: entry.sessionId,
            rationale: ev.rationale,
            alternatives: ev.alternatives,
            rejectedReason: ev.rejected_reason,
            linkedEvents: ev.linked_events,
            linkedFiles: ev.linked_files,
            kind: ev.kind,
            voided: undefined,
          });
        } else if (ev.type === "decision_voided") {
          voids.set(ev.decision_id, { reason: ev.reason, supersededBy: ev.superseded_by });
        }
      }
    } catch {
      if (!unreadableEmitted.has(entry.sessionId)) {
        wrappedSkip(entry.sessionId, "events_jsonl_unreadable");
      }
    }
  }
  for (const d of decisions) {
    const v = voids.get(d.decisionId);
    if (v !== undefined) d.voided = v;
  }
  decisions.sort((a, b) => {
    const c = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
    return c !== 0 ? c : a.decisionId.localeCompare(b.decisionId);
  });

  // Resolve linked_files relative to the repository root (= parent of
  // `.basou/`). Existence is checked with `lstat` so symlinks are treated
  // honestly — a dangling symlink is reported as `(missing)`. The check
  // runs once per unique path so repeated references share their lookup.
  const repoRoot = dirname(input.paths.root);
  const fileExistenceCache = new Map<string, boolean>();
  async function fileExists(relPath: string): Promise<boolean> {
    const cached = fileExistenceCache.get(relPath);
    if (cached !== undefined) return cached;
    const abs = resolve(repoRoot, relPath);
    let exists: boolean;
    try {
      await lstat(abs);
      exists = true;
    } catch {
      exists = false;
    }
    fileExistenceCache.set(relPath, exists);
    return exists;
  }

  const body = await formatDecisionsBody({
    nowIso: input.nowIso,
    decisions,
    knownEventIds,
    fileExists,
  });
  return { body, decisionCount: decisions.length };
}

async function formatDecisionsBody(args: {
  nowIso: string;
  decisions: ReadonlyArray<DecisionRecord>;
  knownEventIds: ReadonlySet<string>;
  fileExists: (relPath: string) => Promise<boolean>;
}): Promise<string> {
  const lines: string[] = [];
  lines.push("# Decisions");
  lines.push("");
  lines.push(`> Generated at ${args.nowIso}`);
  lines.push("");
  if (args.decisions.length === 0) {
    lines.push("(no decisions recorded yet)");
    return lines.join("\n");
  }
  for (const d of args.decisions) {
    // A track marker rides on the heading so the audit shows the decision was a
    // strategic direction; for an open track it precedes the `- 種別` line below.
    const trackMark = d.kind === "track" ? " [TRACK]" : "";
    if (d.voided !== undefined) {
      // Struck heading + a void line; the decision body is kept for the audit
      // trail but visibly marked no longer in force.
      lines.push(`## ~~${d.decisionId}: ${d.title}~~ [VOIDED]${trackMark}`);
      lines.push("");
      const supersededBy =
        d.voided.supersededBy !== undefined ? `, superseded by ${d.voided.supersededBy}` : "";
      const reason =
        typeof d.voided.reason === "string" && d.voided.reason.length > 0
          ? `: ${d.voided.reason}`
          : "";
      lines.push(`- ⚠ VOIDED${reason}${supersededBy}`);
    } else {
      lines.push(`## ${d.decisionId}: ${d.title}${trackMark}`);
      lines.push("");
    }
    const occurredDate = d.occurredAt.slice(0, 10); // YYYY-MM-DD
    lines.push(`- 決定日: ${occurredDate}`);
    // An OPEN track keeps resurfacing in orientation/handoff; note that here so
    // the full record explains why it is still surfaced (a voided track is closed
    // and carries the VOIDED line instead).
    if (d.kind === "track" && d.voided === undefined) {
      lines.push("- 種別: track (close まで orient/handoff に継続表示)");
    }
    lines.push(`- session: ${shortDecisionSessionId(d.sessionId)}`);
    lines.push(`- 判断: ${d.title}`);
    if (typeof d.rationale === "string" && d.rationale.length > 0) {
      lines.push(`- rationale: ${d.rationale}`);
    }
    if (d.alternatives !== undefined && d.alternatives.length > 0) {
      lines.push(`- alternatives: ${d.alternatives.join(", ")}`);
    }
    if (typeof d.rejectedReason === "string" && d.rejectedReason.length > 0) {
      lines.push(`- rejected_reason: ${d.rejectedReason}`);
    }
    if (d.linkedEvents !== undefined && d.linkedEvents.length > 0) {
      const parts = d.linkedEvents.map((eid) =>
        args.knownEventIds.has(eid) ? eid : `${eid} (missing)`,
      );
      lines.push(`- linked_events: ${parts.join(", ")}`);
    }
    if (d.linkedFiles !== undefined && d.linkedFiles.length > 0) {
      const parts = await Promise.all(
        d.linkedFiles.map(async (path) =>
          (await args.fileExists(path)) ? path : `${path} (missing)`,
        ),
      );
      lines.push(`- linked_files: ${parts.join(", ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function shortDecisionSessionId(sessionId: string): string {
  const SES = "ses_";
  if (sessionId.startsWith(SES)) return sessionId.slice(SES.length, SES.length + 10);
  return sessionId.slice(0, 10);
}
