import { join } from "node:path";
import { type ReplayWarning, replayEvents } from "../events/event-replay.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import { type SessionSkipReason, loadSessionEntries } from "../storage/sessions.js";

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
};

/**
 * Render the body of `decisions.md` from `decision_recorded` events across
 * every healthy session in the workspace.
 *
 * Session enumeration goes through {@link loadSessionEntries} (the same path
 * the handoff renderer uses) so that `session.yaml`-broken sessions are
 * skipped in BOTH outputs and the handoff's `decisionCount` summary stays
 * consistent with the number of sections rendered here (Codex#1 Y3q-M3).
 *
 * Order: `occurred_at` ascending with `decisionId` (= ULID) as tie-breaker.
 * Both fields are monotonic, so the result is a stable cross-session
 * timeline.
 *
 * Y-2 §10.4 lists rationale / alternatives / rejected_reason / linked_events
 * / linked_files in addition to the 4 core fields below; those will be added
 * together with the `basou decision record` CLI (継続宿題 #24) when the
 * schema is extended (Codex#1 Y3q-L1).
 */
export async function renderDecisions(
  input: DecisionsRendererInput,
): Promise<DecisionsRendererResult> {
  const now = new Date(input.nowIso);
  // Codex#3 Y3q-M1: same rationale as handoff-renderer. Track which
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
    return c !== 0 ? c : a.decisionId.localeCompare(b.decisionId);
  });

  const body = formatDecisionsBody({ nowIso: input.nowIso, decisions });
  return { body, decisionCount: decisions.length };
}

function formatDecisionsBody(args: {
  nowIso: string;
  decisions: ReadonlyArray<DecisionRecord>;
}): string {
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
    lines.push(`## ${d.decisionId}: ${d.title}`);
    lines.push("");
    const occurredDate = d.occurredAt.slice(0, 10); // YYYY-MM-DD
    lines.push(`- 決定日: ${occurredDate}`);
    lines.push(`- session: ${shortDecisionSessionId(d.sessionId)}`);
    lines.push(`- 判断: ${d.title}`);
    lines.push("");
  }
  return lines.join("\n");
}

function shortDecisionSessionId(sessionId: string): string {
  const SES = "ses_";
  if (sessionId.startsWith(SES)) return sessionId.slice(SES.length, SES.length + 10);
  return sessionId.slice(0, 10);
}
