import { join } from "node:path";
import { type ReplayWarning, readAllEvents } from "../events/event-replay.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import { loadTaskEntries, type TaskSkipReason } from "../storage/tasks.js";
import { listSessions, lostAmong } from "./sessions.js";

/**
 * The version of how the `trail` section measures. Raised whenever a value of
 * the section would change for the same trail.
 */
export const BOARD_TRAIL_METHOD = 1;

/** An open track: a decision recorded with `kind: "track"` and not voided. */
export type BoardTrack = { id: string; title: string };

/**
 * The workspace's own decisions, read from its events (not from
 * decisions.md), on this host only. A decision recorded twice under one id
 * counts once. All three are null, with one not_found entry at `trail`, when
 * an event line could not be read (a torn last line, a write in progress, is
 * not counted as one), an entry named as a session is not a directory, or
 * the sessions cannot be listed (or `.basou/sessions` is refused, being a
 * symlink or not a directory).
 */
export type BoardTrail = {
  decisions_all: number | null;
  /** The decisions not voided. */
  decisions_live: number | null;
  /**
   * Newest first, as orient lists them: by when each was recorded, then by
   * id. The title is as it was recorded.
   */
  tracks_open: BoardTrack[] | null;
};

/** The decisions of the trail, or why they could not be read. */
export type TrailDecisions =
  | { ok: true; decisions_all: number; decisions_live: number; tracks: BoardTrack[] }
  | { ok: false; reason: string };

/** The status of every task that is not archived, or why they could not be read. */
export type TrailTasks = { ok: true; statuses: string[] } | { ok: false; reason: string };

export type TrailInput = {
  paths: BasouPaths;
  onReplayWarning?: (warning: ReplayWarning, sessionId: string) => void;
  onTaskSkip?: (taskId: string, reason: TaskSkipReason) => void;
};

type Recorded = { track: boolean; title: string; occurredAt: number };

/** The workspace's own decisions and open tracks, read from its events. */
export async function readDecisions(input: TrailInput): Promise<TrailDecisions> {
  try {
    const recorded = new Map<string, Recorded>();
    const voided = new Set<string>();
    let lost = 0;
    const listed = await listSessions(input.paths);
    if (!listed.ok) return { ok: false, reason: listed.reason };
    const { dirs, notDirectories } = listed;
    for (const sessionId of dirs) {
      const sessionDir = join(input.paths.sessions, sessionId);
      // A line that is not JSON may be a write in progress; one that is JSON
      // but not an event of the schema is complete, so it is a lost event
      // wherever it is. A retired zero-duration line is not a decision.
      const malformed: number[] = [];
      const events = await readAllEvents(sessionDir, {
        onWarning: (warning) => {
          if (warning.kind === "malformed_json") malformed.push(warning.line);
          else if (warning.kind === "schema_violation") lost++;
          input.onReplayWarning?.(warning, sessionId);
        },
      });
      if (malformed.length > 0)
        lost += await lostAmong(join(sessionDir, "events.jsonl"), malformed);
      for (const event of events) {
        if (event.type === "decision_recorded") {
          // One id is one decision: the earliest record of it stands.
          const occurredAt = Date.parse(event.occurred_at);
          const seen = recorded.get(event.decision_id);
          if (seen === undefined || occurredAt < seen.occurredAt) {
            recorded.set(event.decision_id, {
              track: event.kind === "track",
              title: event.title,
              occurredAt,
            });
          }
        } else if (event.type === "decision_voided") {
          voided.add(event.decision_id);
        }
      }
    }
    const problems: string[] = [];
    if (lost > 0) problems.push(`${lost} event line${lost === 1 ? "" : "s"} could not be read`);
    if (notDirectories.length > 0) {
      const n = notDirectories.length;
      problems.push(
        `${n} session ${n === 1 ? "entry is" : "entries are"} not a directory (a symlink or a file)`,
      );
    }
    if (problems.length > 0) {
      return { ok: false, reason: `${problems.join(", and ")}, so decisions may be missing` };
    }
    const live = [...recorded].filter(([id]) => !voided.has(id));
    const tracks = live
      .filter(([, decision]) => decision.track)
      .sort(([idA, a], [idB, b]) => {
        if (a.occurredAt !== b.occurredAt) return b.occurredAt - a.occurredAt;
        return idA > idB ? -1 : idA < idB ? 1 : 0;
      })
      .map(([id, decision]) => ({ id, title: decision.title }));
    return { ok: true, decisions_all: recorded.size, decisions_live: live.length, tracks };
  } catch {
    return { ok: false, reason: "the sessions of the workspace could not be read" };
  }
}

/** The workspace's tasks that are not archived. Read only: the task index is not rebuilt. */
export async function readTasks(input: TrailInput): Promise<TrailTasks> {
  try {
    let skipped = 0;
    const tasks = await loadTaskEntries(input.paths, {
      rebuildIndex: false,
      onSkip: (taskId, reason) => {
        skipped++;
        input.onTaskSkip?.(taskId, reason);
      },
    });
    if (skipped > 0) {
      return { ok: false, reason: `${skipped} task${skipped === 1 ? "" : "s"} could not be read` };
    }
    return { ok: true, statuses: tasks.map((doc) => doc.task.task.status) };
  } catch {
    return { ok: false, reason: "the tasks of the workspace could not be read" };
  }
}

/** The `trail` section of a measurement, and why it is missing when it is. */
export function trailSection(decisions: TrailDecisions): {
  trail: BoardTrail;
  notFound: { at: string; reason: string }[];
} {
  if (!decisions.ok) {
    return {
      trail: { decisions_all: null, decisions_live: null, tracks_open: null },
      notFound: [{ at: "trail", reason: decisions.reason }],
    };
  }
  const { decisions_all, decisions_live, tracks } = decisions;
  return { trail: { decisions_all, decisions_live, tracks_open: tracks }, notFound: [] };
}
