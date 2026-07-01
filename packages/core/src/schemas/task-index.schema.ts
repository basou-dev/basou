import { z } from "zod";
import { CacheVersionSchema, IsoTimestampSchema, TaskIdSchema } from "./shared.schema.js";
import { TaskStatusSchema } from "./task.schema.js";

/**
 * Single entry inside `.basou/tasks/index.json`.
 *
 * Source of truth remains `task.md`; this is a derived cache populated
 * write-through on every task mutation (`createTask`,
 * `updateTaskStatusWithEvent`, `editTask`, `deleteTask`, `archiveTask`,
 * `reconcileTask`, `refreshTaskLinkedSessions`). The minimum field set
 * lets `basou task list` filter / sort without re-parsing every front
 * matter, while keeping the index small enough that rebuilds stay cheap.
 *
 * `label` is omitted when the task has no explicit label so the JSON
 * round-trips without storing `undefined` literals.
 */
export const TaskIndexEntrySchema = z
  .object({
    id: TaskIdSchema,
    status: TaskStatusSchema,
    label: z.string().min(1).optional(),
    updated_at: IsoTimestampSchema,
  })
  .strict();
export type TaskIndexEntry = z.infer<typeof TaskIndexEntrySchema>;

/**
 * Top-level schema for `.basou/tasks/index.json`. `tasks[]` is the
 * compact projection used for fast enumeration; `last_rebuilt_at`
 * records the wall-clock moment of the latest full readdir rebuild so
 * a future migration / debugging tool can spot stale caches without
 * comparing every entry against disk.
 *
 * `schema_version` lets a future bump trigger a forced rebuild instead
 * of attempting silent schema migration — readTaskIndex returns the
 * parsed payload only when the version matches the current literal, so
 * a mismatch falls through to the lazy-rebuild path.
 */
export const TaskIndexSchema = z
  .object({
    // Rebuildable cache: exact-match-or-rebuild, not the durable forward-compat gate.
    schema_version: CacheVersionSchema,
    tasks: z.array(TaskIndexEntrySchema),
    last_rebuilt_at: IsoTimestampSchema,
  })
  .strict();
export type TaskIndex = z.infer<typeof TaskIndexSchema>;

/** Current schema version. Bump triggers a forced rebuild on next read. */
export const TASK_INDEX_SCHEMA_VERSION = "0.1.0" as const;
