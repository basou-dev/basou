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
 * Allowed transitions enforced by the storage layer:
 *   planned → in_progress → {done | cancelled}
 *   in_progress → cancelled
 * `done` and `cancelled` are terminal.
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
   * Session id where the task was created (= the session that wrote the
   * `task_created` event). For ad-hoc paths this is the freshly minted
   * ad-hoc session id; for attach paths it is the target session id.
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
