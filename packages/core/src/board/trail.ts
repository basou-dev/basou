import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ReplayWarning, readAllEvents } from "../events/event-replay.js";
import type { BasouPaths } from "../storage/basou-dir.js";
import { enumerateSessionDirs } from "../storage/sessions.js";
import { loadTaskEntries, type TaskSkipReason } from "../storage/tasks.js";

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
 * an event line could not be read; a torn last line, a write in progress, is
 * not counted as one.
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

// Event lines that were not read as events. A torn last line is a write in
// progress, not a recorded event, and a retired zero-duration line is not a
// decision; anything else may have been one.
const LOST_LINES = new Set<ReplayWarning["kind"]>(["malformed_json", "schema_violation"]);

// Whether line `lineNo` of an events log is its last line with no newline
// after it: a write that has not finished, which replay reports as malformed
// when it is cut in the middle of the JSON.
async function isTornTail(eventsLog: string, lineNo: number): Promise<boolean> {
  let body: Buffer;
  try {
    body = await readFile(eventsLog);
  } catch {
    return false;
  }
  if (body.length === 0 || body[body.length - 1] === 0x0a) return false;
  let newlines = 0;
  for (const byte of body) if (byte === 0x0a) newlines++;
  return lineNo === newlines + 1;
}

type Recorded = { track: boolean; title: string; occurredAt: number };

/** The workspace's own decisions and open tracks, read from its events. */
export async function readDecisions(input: TrailInput): Promise<TrailDecisions> {
  try {
    const recorded = new Map<string, Recorded>();
    const voided = new Set<string>();
    let lost = 0;
    for (const sessionId of await enumerateSessionDirs(input.paths)) {
      const sessionDir = join(input.paths.sessions, sessionId);
      const lostLines: number[] = [];
      const events = await readAllEvents(sessionDir, {
        onWarning: (warning) => {
          if (LOST_LINES.has(warning.kind)) lostLines.push(warning.line);
          input.onReplayWarning?.(warning, sessionId);
        },
      });
      for (const lineNo of lostLines) {
        if (!(await isTornTail(join(sessionDir, "events.jsonl"), lineNo))) lost++;
      }
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
    if (lost > 0) {
      return {
        ok: false,
        reason: `${lost} event line${lost === 1 ? "" : "s"} could not be read, so decisions may be missing`,
      };
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
