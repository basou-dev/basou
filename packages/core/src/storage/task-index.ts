import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findErrorCode } from "../lib/error-codes.js";
import {
  TASK_INDEX_SCHEMA_VERSION,
  type TaskIndex,
  type TaskIndexEntry,
  TaskIndexSchema,
} from "../schemas/task-index.schema.js";
import { atomicReplace } from "./atomic.js";
import type { BasouPaths } from "./basou-dir.js";

/**
 * Absolute path of the workspace's `tasks/index.json`. The index lives
 * INSIDE `<paths.tasks>` (not under `<paths.root>`) so a future
 * monorepo-style layout with multiple task families could carry its own
 * index without colliding at the basou root.
 */
export function taskIndexPath(paths: BasouPaths): string {
  return join(paths.tasks, "index.json");
}

/**
 * Read and validate `tasks/index.json`. Returns the parsed payload only
 * when the schema_version matches the current literal — a mismatch is
 * surfaced as a schema parse failure so the caller falls through to the
 * lazy-rebuild path.
 *
 * Error contract:
 *   - ENOENT → throw `Error("Task index not found", { cause })`
 *   - JSON parse / schema fail / version mismatch → throw
 *     `Error("Invalid task index", { cause })`
 *   - any other I/O failure → throw `Error("Failed to read task index", { cause })`
 *
 * Callers should treat all three as "rebuild from disk"; the distinct
 * messages exist so debug output / dogfood notes can tell them apart.
 */
export async function readTaskIndex(paths: BasouPaths): Promise<TaskIndex> {
  const filePath = taskIndexPath(paths);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) {
      throw new Error("Task index not found", { cause: error });
    }
    throw new Error("Failed to read task index", { cause: error });
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error("Invalid task index", { cause: error });
  }
  const result = TaskIndexSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new Error("Invalid task index", { cause: result.error });
  }
  if (result.data.schema_version !== TASK_INDEX_SCHEMA_VERSION) {
    // Reject older / newer schema versions so a future bump triggers a
    // forced rebuild rather than silent migration.
    throw new Error("Invalid task index", {
      cause: new Error(`Unsupported task index schema_version: ${result.data.schema_version}`),
    });
  }
  return result.data;
}

/**
 * Atomically write `tasks/index.json` with the given entries. Entries
 * are sorted by id (= ULID-ascending) so two rebuilds on the same disk
 * state produce byte-identical output and `git diff` stays clean.
 *
 * Caller-controlled `now` lets tests assert on `last_rebuilt_at`
 * without faking `Date`. When omitted the current wall clock is used.
 */
export async function rebuildTaskIndex(
  paths: BasouPaths,
  entries: ReadonlyArray<TaskIndexEntry>,
  now?: () => Date,
): Promise<TaskIndex> {
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));
  const payload: TaskIndex = {
    schema_version: TASK_INDEX_SCHEMA_VERSION,
    tasks: sorted,
    last_rebuilt_at: (now ?? (() => new Date()))().toISOString(),
  };
  // Self-defense — boundary-parse so a buggy caller cannot smuggle in
  // an invalid entry shape past the read-side schema check.
  TaskIndexSchema.parse(payload);
  await atomicReplace(taskIndexPath(paths), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

/**
 * Mutation kind for {@link updateTaskIndex}. `add` and `update` carry a
 * full entry payload; `remove` carries only the id (the entry is gone
 * from disk by the time we write the index).
 *
 * archiveTask uses `remove` too: the archived task no longer participates
 * in the active task index because `enumerateTaskIds` (= the index's
 * read consumer) scans only `tasks/<id>.md`, not `tasks/archive/<id>.md`.
 */
export type TaskIndexOp =
  | { kind: "add"; entry: TaskIndexEntry }
  | { kind: "update"; entry: TaskIndexEntry }
  | { kind: "remove"; id: string };

/**
 * Apply a single mutation to `tasks/index.json` and atomically rewrite
 * it. Falls through to {@link rebuildTaskIndex} when the current index is
 * missing / invalid so the first write after a workspace migration
 * still produces a valid file.
 *
 * Write failure (atomic-rename ENOSPC / EACCES etc.) is re-thrown
 * unwrapped so the caller (= each task write API) can decide whether to
 * surface it as a warning or escalate. The recommended policy in
 * `tasks.ts` is `console.warn(...)` plus keep the task.md write
 * successful (= index is a soft cache, not source of truth).
 */
export async function updateTaskIndex(
  paths: BasouPaths,
  op: TaskIndexOp,
  options?: { now?: () => Date },
): Promise<TaskIndex> {
  const nowFn = options?.now ?? (() => new Date());
  let current: TaskIndex;
  try {
    current = await readTaskIndex(paths);
  } catch {
    // Index missing or invalid — rebuild empty before applying op.
    current = {
      schema_version: TASK_INDEX_SCHEMA_VERSION,
      tasks: [],
      last_rebuilt_at: nowFn().toISOString(),
    };
  }

  let nextTasks: TaskIndexEntry[];
  switch (op.kind) {
    case "add":
      nextTasks = current.tasks.some((t) => t.id === op.entry.id)
        ? current.tasks.map((t) => (t.id === op.entry.id ? op.entry : t))
        : [...current.tasks, op.entry];
      break;
    case "update":
      nextTasks = current.tasks.some((t) => t.id === op.entry.id)
        ? current.tasks.map((t) => (t.id === op.entry.id ? op.entry : t))
        : [...current.tasks, op.entry];
      break;
    case "remove":
      nextTasks = current.tasks.filter((t) => t.id !== op.id);
      break;
  }

  return await rebuildTaskIndex(paths, nextTasks, nowFn);
}
