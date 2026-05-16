import { z } from "zod";
import {
  IsoTimestampSchema,
  SchemaVersionSchema,
  SessionIdSchema,
  TaskIdSchema,
  WorkspaceIdSchema,
} from "./shared.schema.js";

/**
 * Y-2 task lifecycle states (Step 17 確定事項 4).
 *
 * The storage layer's `ALLOWED_TRANSITIONS` map (= source of truth in
 * `tasks.ts`) is the authoritative graph; the comment below is a snapshot.
 * As of Y-3z #59 (B-B3) `planned` now reaches `done` / `cancelled`
 * directly so tasks completed (or abandoned) outside an explicit
 * in-progress phase can close in a single CLI call:
 *
 *   planned → {in_progress | done | cancelled}
 *   in_progress → {done | cancelled}
 *   done / cancelled = terminal
 *
 * Self-edges are rejected so the audit trail stays monotonic.
 */
export const TaskStatusSchema = z.enum(["planned", "in_progress", "done", "cancelled"]);
/** Inferred runtime type for {@link TaskStatusSchema}. */
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

const TaskInnerSchema = z.object({
  id: TaskIdSchema,
  title: z.string().min(1),
  label: z.string().min(1).optional(),
  status: TaskStatusSchema,
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
  workspace_id: WorkspaceIdSchema,
  /**
   * Session id that anchors this task. For freshly created tasks it is the
   * session that wrote the `task_created` event (= ad-hoc reconcile target
   * for ad-hoc paths, or the target session id for attach paths). After
   * `basou task reconcile --write` repairs a broken anchor (Y-3w D1) the
   * value is replaced with the ad-hoc reconcile session id; the old broken
   * session_id is preserved on the `task_reconciled` event payload via
   * `removed_created_in_session` for audit. So this field always names a
   * reachable session, even after the original anchor is gone.
   */
  created_in_session: SessionIdSchema,
  /**
   * Snapshot of sessions linked to this task. The events.jsonl history is
   * the source of truth (Y-2 §10.5); this field is maintained as a UX-only
   * cache so editors can read the task.md and immediately see related
   * sessions. Defaults to `[]` for backward compatibility.
   */
  linked_sessions: z.array(SessionIdSchema).default([]),
});

/**
 * Schema for the YAML front matter of `.basou/tasks/<task_id>.md`.
 *
 * The markdown body after the front matter is intentionally NOT modelled
 * here — it is free-form user-edited content. The storage layer splits
 * the file into `task` (this schema) and `body` (the trailing string).
 */
export const TaskSchema = z.object({
  schema_version: SchemaVersionSchema,
  task: TaskInnerSchema,
});
/** Inferred runtime type for {@link TaskSchema}. */
export type Task = z.infer<typeof TaskSchema>;
