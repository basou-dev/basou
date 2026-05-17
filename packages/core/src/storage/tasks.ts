import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { PrefixedId } from "../ids/ulid.js";
import { findErrorCode } from "../lib/error-codes.js";
import type { Event } from "../schemas/event.schema.js";
import type { Manifest } from "../schemas/manifest.schema.js";
import type { SessionStatus } from "../schemas/session.schema.js";
import { IsoTimestampSchema, SessionIdSchema, TaskIdSchema } from "../schemas/shared.schema.js";
import {
  type Task,
  TaskSchema,
  type TaskStatus,
  TaskStatusSchema,
} from "../schemas/task.schema.js";
import {
  type AttachableStatus,
  FailedToFinalizeError,
  appendEventToExistingSession,
  createAdHocSessionWithEvent,
} from "./ad-hoc-session.js";
import { atomicCreate, atomicReplace } from "./atomic.js";
import type { BasouPaths } from "./basou-dir.js";
import { enumerateSessionDirs, readSessionYaml } from "./sessions.js";
import { overwriteYamlFile } from "./yaml-store.js";

// ============================================================================
// File format constants
// ============================================================================

const FRONT_MATTER_DELIM = "---";
// Raised from the original 40-char cap to 80 chars so long task /
// reconcile titles retain their core information. The same cap applies
// to `Ad-hoc task:`, `Ad-hoc task status:`, and `Ad-hoc task reconcile:`
// labels so the three ad-hoc label generators stay consistent with the
// decision-side cap (cli/src/commands/decision.ts).
const LABEL_TITLE_MAX = 80;
const LABEL_TRUNCATE_HEAD = LABEL_TITLE_MAX - 3;

const DEFAULT_ATTACHABLE_STATUSES: ReadonlySet<AttachableStatus> = new Set<AttachableStatus>([
  "initialized",
  "running",
  "waiting_approval",
]);

// Boundary parses for direct callers so a malformed task cannot smuggle
// past the CLI-side parsers and commit a `task_created` event. The set
// originally rejected `done` / `cancelled` as initial values, but the
// orchestrator now emits a follow-up `task_status_changed` for terminal
// initial statuses so retroactively-recorded completed tasks can be
// entered in one CLI call; widening the schema lets that path through.
const InitialTaskStatusSchema = TaskStatusSchema;
const TaskTitleSchema = z.string().min(1);
const TaskLabelSchema = z.string().min(1);
// `completedAt` is an optional ISO-8601 string. Validate it at the boundary
// so a direct (non-CLI) caller cannot smuggle a garbage timestamp past the
// orchestrator and leave durable `task_created` / `task_status_changed`
// events with no valid task.md to back them up.
const CompletedAtSchema = IsoTimestampSchema;

const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["done", "cancelled"]);

function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

// ============================================================================
// File read / parse
// ============================================================================

export type TaskDocument = {
  /** Parsed + zod-validated front matter. */
  task: Task;
  /** Raw markdown body after the closing front matter delimiter. */
  body: string;
};

/**
 * Split a task.md file body into the YAML front matter and the trailing
 * markdown body. The expected format is:
 *
 *   ---\n
 *   <yaml>\n
 *   ---\n
 *   <body>
 *
 * Strict rules (Codex Y3t-M3):
 *   - A UTF-8 BOM at the head is rejected.
 *   - CRLF inside the file is normalised to LF before delimiter scanning so
 *     editors that auto-convert line endings stay compatible.
 *   - The closing delimiter is the FIRST `---` line after the opening one,
 *     so `---` lines inside the markdown body do not confuse the parser.
 */
function splitFrontMatter(raw: string): { yamlText: string; body: string } {
  if (raw.length > 0 && raw.charCodeAt(0) === 0xfeff) {
    throw new Error("Invalid task file format");
  }
  const normalised = raw.replace(/\r\n/g, "\n");
  if (!normalised.startsWith(`${FRONT_MATTER_DELIM}\n`)) {
    throw new Error("Invalid task file format");
  }
  const remainder = normalised.slice(FRONT_MATTER_DELIM.length + 1);
  // Find the first line that is exactly `---`. Scan line-by-line so a `---`
  // appearing mid-line inside YAML text is not matched.
  const lines = remainder.split("\n");
  let closingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === FRONT_MATTER_DELIM) {
      closingIdx = i;
      break;
    }
  }
  if (closingIdx < 0) {
    throw new Error("Invalid task file format");
  }
  const yamlText = lines.slice(0, closingIdx).join("\n");
  // The body is everything after the closing delimiter line, with one
  // separating newline consumed (if present) so the body does not start
  // with a stray blank line.
  const afterClosing = lines.slice(closingIdx + 1);
  let body = afterClosing.join("\n");
  if (body.startsWith("\n")) body = body.slice(1);
  return { yamlText, body };
}

/**
 * Read and validate `<paths.tasks>/<taskId>.md`. Returns the parsed front
 * matter (Task) plus the markdown body string. Error contract:
 *
 *   - ENOENT → throw `"Task file not found"`.
 *   - format violation → throw `"Invalid task file format"`.
 *   - YAML parse / schema violation → throw `"Failed to read task file"`.
 *   - any other I/O failure → throw `"Failed to read task file"` with cause.
 */
export async function readTaskFile(paths: BasouPaths, taskId: string): Promise<TaskDocument> {
  const filePath = join(paths.tasks, `${taskId}.md`);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) {
      throw new Error("Task file not found", { cause: error });
    }
    throw new Error("Failed to read task file", { cause: error });
  }
  let split: { yamlText: string; body: string };
  try {
    split = splitFrontMatter(raw);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Invalid task file format") {
      throw error;
    }
    throw new Error("Failed to read task file", { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(split.yamlText);
  } catch (error: unknown) {
    throw new Error("Failed to read task file", { cause: error });
  }
  const result = TaskSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("Failed to read task file", { cause: result.error });
  }
  return { task: result.data, body: split.body };
}

// ============================================================================
// File write (atomic, mode-aware)
// ============================================================================

export type WriteTaskFileMode = "create" | "overwrite";

/**
 * Atomically write `<paths.tasks>/<taskId>.md`.
 *
 * `mode: "create"` delegates to {@link atomicCreate} so a pre-existing file
 * fails fast with EEXIST → `"Task file already exists"`.
 * `mode: "overwrite"` delegates to {@link atomicReplace} and silently
 * replaces any prior file.
 *
 * The serialised body is structured as:
 *
 *   ---\n
 *   <yaml>\n
 *   ---\n
 *   \n
 *   <body>\n        (only when body is non-empty)
 */
export async function writeTaskFile(
  paths: BasouPaths,
  taskId: string,
  doc: TaskDocument,
  options: { mode: WriteTaskFileMode },
): Promise<void> {
  // Runtime self-defense: even if a caller bypassed the TypeScript boundary,
  // a malformed task object cannot reach disk.
  const validated = TaskSchema.parse(doc.task);

  const filePath = join(paths.tasks, `${taskId}.md`);
  const yamlText = stringifyYaml(validated);
  const trimmedBody =
    doc.body.length === 0 ? "" : `\n${doc.body.endsWith("\n") ? doc.body : `${doc.body}\n`}`;
  const fileBody = `${FRONT_MATTER_DELIM}\n${yamlText}${FRONT_MATTER_DELIM}\n${trimmedBody}`;

  if (options.mode === "create") {
    try {
      await atomicCreate(filePath, fileBody);
    } catch (error: unknown) {
      if (findErrorCode(error, "EEXIST")) {
        throw new Error("Task file already exists", { cause: error });
      }
      throw new Error("Failed to write task file", { cause: error });
    }
    return;
  }

  // overwrite mode
  try {
    await atomicReplace(filePath, fileBody);
  } catch (error: unknown) {
    throw new Error("Failed to write task file", { cause: error });
  }
}

// ============================================================================
// Directory enumeration / loading
// ============================================================================

const TASK_FILENAME_RE = /^(.+)\.md$/;

/**
 * Enumerate task ids by listing `<paths.tasks>/`. Filenames that do not
 * match the `<task_id>.md` shape, or that decode to a non-conforming task
 * id (per `TaskIdSchema`), are silently skipped — they are surfaced via
 * the caller's `options.onSkip` hook in {@link loadTaskEntries} so list
 * commands can show a warning row.
 *
 * Returns ids in ULID-ascending order (filename sort matches ULID order).
 * Empty directory or ENOENT → `[]`. Other I/O failures throw
 * `"Failed to enumerate tasks"`.
 */
export async function enumerateTaskIds(paths: BasouPaths): Promise<string[]> {
  let entries: string[];
  try {
    entries = (await readdir(paths.tasks, { withFileTypes: true }))
      .filter((d) => d.isFile())
      .map((d) => d.name);
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) return [];
    throw new Error("Failed to enumerate tasks", { cause: error });
  }
  const taskIds: string[] = [];
  for (const name of entries) {
    const match = TASK_FILENAME_RE.exec(name);
    if (match === null) continue;
    const candidate = match[1] as string;
    if (!TaskIdSchema.safeParse(candidate).success) continue;
    taskIds.push(candidate);
  }
  taskIds.sort();
  return taskIds;
}

const ARCHIVE_DIR_NAME = "archive";

function archiveTasksDir(paths: BasouPaths): string {
  return join(paths.tasks, ARCHIVE_DIR_NAME);
}

/**
 * Enumerate task ids inside `<paths.tasks>/archive/`. Returns `[]` when the
 * archive directory does not exist (= no task has ever been archived).
 * Filtering / ordering rules mirror {@link enumerateTaskIds}.
 */
export async function enumerateArchivedTaskIds(paths: BasouPaths): Promise<string[]> {
  let entries: string[];
  try {
    entries = (await readdir(archiveTasksDir(paths), { withFileTypes: true }))
      .filter((d) => d.isFile())
      .map((d) => d.name);
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) return [];
    throw new Error("Failed to enumerate archived tasks", { cause: error });
  }
  const taskIds: string[] = [];
  for (const name of entries) {
    const match = TASK_FILENAME_RE.exec(name);
    if (match === null) continue;
    const candidate = match[1] as string;
    if (!TaskIdSchema.safeParse(candidate).success) continue;
    taskIds.push(candidate);
  }
  taskIds.sort();
  return taskIds;
}

/**
 * Read a task.md file looking in the main tasks directory first and falling
 * back to `<paths.tasks>/archive/` if the file is missing there. Returns the
 * parsed document plus a flag indicating whether the hit came from the
 * archive dir. Useful for `basou task show` which surfaces archived tasks
 * read-only without requiring the operator to opt in.
 *
 * Error contract matches {@link readTaskFile} — only the lookup location
 * differs.
 */
export async function readTaskFileWithArchiveFallback(
  paths: BasouPaths,
  taskId: string,
): Promise<{ doc: TaskDocument; archived: boolean }> {
  try {
    const doc = await readTaskFile(paths, taskId);
    return { doc, archived: false };
  } catch (error: unknown) {
    if (!(error instanceof Error && error.message === "Task file not found")) {
      throw error;
    }
  }
  const archiveFilePath = join(archiveTasksDir(paths), `${taskId}.md`);
  let raw: string;
  try {
    raw = await readFile(archiveFilePath, "utf8");
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) {
      throw new Error("Task file not found", { cause: error });
    }
    throw new Error("Failed to read task file", { cause: error });
  }
  // Parsing mirrors readTaskFile; archived files share the schema.
  let split: { yamlText: string; body: string };
  try {
    split = splitFrontMatter(raw);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Invalid task file format") {
      throw error;
    }
    throw new Error("Failed to read task file", { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(split.yamlText);
  } catch (error: unknown) {
    throw new Error("Failed to read task file", { cause: error });
  }
  const result = TaskSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("Failed to read task file", { cause: result.error });
  }
  return { doc: { task: result.data, body: split.body }, archived: true };
}

export type TaskSkipReason = "task_file_invalid" | "task_file_unreadable";

export type LoadTaskEntriesOptions = {
  onSkip?: (taskId: string, reason: TaskSkipReason) => void;
};

/**
 * Read every task.md under `<paths.tasks>/` and return the valid documents,
 * skipping malformed / unreadable files with an `onSkip` callback for each.
 *
 * Returned entries are sorted ascending by `task.created_at` (Codex Y3t-L1:
 * internal asc; the CLI layer reverses for newest-first display).
 */
export async function loadTaskEntries(
  paths: BasouPaths,
  options: LoadTaskEntriesOptions = {},
): Promise<TaskDocument[]> {
  const ids = await enumerateTaskIds(paths);
  const entries: TaskDocument[] = [];
  for (const id of ids) {
    let doc: TaskDocument;
    try {
      doc = await readTaskFile(paths, id);
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "Invalid task file format") {
        options.onSkip?.(id, "task_file_invalid");
      } else if (error instanceof Error && error.message === "Failed to read task file") {
        options.onSkip?.(id, "task_file_invalid");
      } else if (error instanceof Error && error.message === "Task file not found") {
        // Race: file was enumerated then deleted before read. Treat as unreadable.
        options.onSkip?.(id, "task_file_unreadable");
      } else {
        options.onSkip?.(id, "task_file_unreadable");
      }
      continue;
    }
    entries.push(doc);
  }
  entries.sort((a, b) => {
    const c = Date.parse(a.task.task.created_at) - Date.parse(b.task.task.created_at);
    return c !== 0 ? c : a.task.task.id.localeCompare(b.task.task.id);
  });
  return entries;
}

// ============================================================================
// Status transition rules (Step 17 §C.2)
// ============================================================================

// Y-3z #59 / B-B3: `planned -> done` and `planned -> cancelled` are direct
// shortcuts so a task that was queued but completed (or abandoned) outside
// of an explicit `in_progress` phase can be closed with a single CLI call.
// The 1 transition = 1 event invariant is preserved: each shortcut emits
// exactly one `task_status_changed` event capturing the new from / to pair.
const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, ReadonlySet<TaskStatus>>> = {
  planned: new Set<TaskStatus>(["in_progress", "done", "cancelled"]),
  in_progress: new Set<TaskStatus>(["done", "cancelled"]),
  done: new Set<TaskStatus>(),
  cancelled: new Set<TaskStatus>(),
};

function assertTransitionAllowed(from: TaskStatus, to: TaskStatus): void {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed.has(to)) {
    throw new Error(`Invalid task status transition: ${from} -> ${to}`);
  }
}

// ============================================================================
// Specialised error for task.md write failure after the event was persisted
// ============================================================================

/**
 * Thrown when the task event (`task_created` / `task_status_changed`) was
 * fully persisted to events.jsonl but the accompanying `task.md` write
 * failed. The caller is responsible for surfacing a "do not rerun"
 * warning — re-running the same CLI invocation would duplicate the event
 * in events.jsonl.
 *
 * Reconciliation (= regenerating the missing task.md from events) is a
 * v0.2 feature; see Step 17 申し送り #52.
 */
/**
 * `phase` identifies which staged write failed after the event commit:
 *   - `create`: task.md create write (ad-hoc or attach path)
 *   - `overwrite`: task.md overwrite during a status change
 *   - `link-session`: session.yaml `task_id` update during the attach path
 *     (Codex Y3t-3-H2: split out so CLI warnings describe the actual
 *     unsafe artefact instead of always saying "task.md creation failed")
 *   - `reconcile`: task.md overwrite during `basou task reconcile --write`
 *     after the `task_reconciled` event was persisted (Y-3w §F.3 D4-6)
 *   - `reconcile-finalize`: ad-hoc reconcile session finalize failed (=
 *     `FailedToFinalizeError` caught and re-classified, Y-3w §F.3 D4-8)
 *   - `reconcile-concurrent`: task.md was modified between the pre-write
 *     snapshot and the post-event re-read; the operator is told to re-run
 *     reconcile rather than overwrite a stale snapshot (Y-3w §D.1 stage 6)
 */
export type TaskWriteAfterEventPhase =
  | "create"
  | "overwrite"
  | "link-session"
  | "reconcile"
  | "reconcile-finalize"
  | "reconcile-concurrent"
  // Mirror the reconcile-failure phases for the `refreshTaskLinkedSessions`
  // path. Failure semantics are identical (= ad-hoc session committed, then
  // task.md write / concurrency check failed), but the operator-facing
  // recovery hint must point at `basou task refresh-linkage`, not reconcile.
  | "linkage-refresh"
  | "linkage-refresh-finalize"
  | "linkage-refresh-concurrent"
  // `task_deleted` / `task_archived` event was persisted in events.jsonl but
  // the subsequent file mutation (unlink / move to archive) failed. The
  // event remains the authoritative audit record; the operator must reconcile
  // the residual file state by hand.
  | "delete"
  | "archive";

export class TaskWriteAfterEventError extends Error {
  readonly taskId: PrefixedId<"task">;
  readonly eventId: PrefixedId<"evt">;
  readonly sessionId: PrefixedId<"ses">;
  readonly phase: TaskWriteAfterEventPhase;

  constructor(args: {
    taskId: PrefixedId<"task">;
    eventId: PrefixedId<"evt">;
    sessionId: PrefixedId<"ses">;
    phase: TaskWriteAfterEventPhase;
    cause: unknown;
  }) {
    super("Failed to write task file after event was persisted", { cause: args.cause });
    this.name = "TaskWriteAfterEventError";
    this.taskId = args.taskId;
    this.eventId = args.eventId;
    this.sessionId = args.sessionId;
    this.phase = args.phase;
  }
}

// ============================================================================
// Orchestrator: createTaskWithEvent
// ============================================================================

export type CreateAdHocTaskInput = {
  mode: "ad-hoc";
  paths: BasouPaths;
  manifest: Manifest;
  occurredAt: string;
  taskId: PrefixedId<"task">;
  title: string;
  label?: string;
  initialStatus: TaskStatus;
  description: string;
  workingDirectory: string;
  /**
   * Optional override for `task.md.updated_at` when `initialStatus` is a
   * terminal value (done / cancelled). Lets the operator backdate a
   * retroactively-recorded completed task so `task.md` reflects the actual
   * completion moment while `events.jsonl` keeps recording time. Ignored
   * for non-terminal statuses.
   */
  completedAt?: string;
};

export type AttachTaskInput = {
  mode: "attach";
  paths: BasouPaths;
  occurredAt: string;
  sessionId: PrefixedId<"ses">;
  taskId: PrefixedId<"task">;
  title: string;
  label?: string;
  initialStatus: TaskStatus;
  description: string;
  attachableStatuses?: ReadonlySet<AttachableStatus>;
  /** See {@link CreateAdHocTaskInput.completedAt}. */
  completedAt?: string;
};

export type CreateTaskInput = CreateAdHocTaskInput | AttachTaskInput;

export type CreateTaskResult = {
  taskId: PrefixedId<"task">;
  eventId: PrefixedId<"evt">;
  sessionId: PrefixedId<"ses">;
  sessionStatus: SessionStatus;
};

function buildTaskCreatedEvent(input: {
  eventId: PrefixedId<"evt">;
  sessionId: PrefixedId<"ses">;
  taskId: PrefixedId<"task">;
  title: string;
  occurredAt: string;
}): Event {
  return {
    schema_version: "0.1.0",
    id: input.eventId,
    session_id: input.sessionId,
    occurred_at: input.occurredAt,
    source: "local-cli",
    type: "task_created",
    task_id: input.taskId,
    title: input.title,
  };
}

function buildTaskStatusChangedEvent(input: {
  eventId: PrefixedId<"evt">;
  sessionId: PrefixedId<"ses">;
  taskId: PrefixedId<"task">;
  from: TaskStatus;
  to: TaskStatus;
  occurredAt: string;
}): Event {
  return {
    schema_version: "0.1.0",
    id: input.eventId,
    session_id: input.sessionId,
    occurred_at: input.occurredAt,
    source: "local-cli",
    type: "task_status_changed",
    task_id: input.taskId,
    from: input.from,
    to: input.to,
  };
}

function buildAdHocTaskLabel(title: string, mode: "new" | "status"): string {
  const truncated =
    title.length > LABEL_TITLE_MAX ? `${title.slice(0, LABEL_TRUNCATE_HEAD)}...` : title;
  return mode === "new" ? `Ad-hoc task: ${truncated}` : `Ad-hoc task status: ${truncated}`;
}

// Kept distinct from buildAdHocTaskLabel rather than threading a third mode
// through that helper — `basou task reconcile` is a management operation, not
// a creation/status flow, and the label prefix should read that way.
function buildAdHocReconcileLabel(title: string): string {
  const truncated =
    title.length > LABEL_TITLE_MAX ? `${title.slice(0, LABEL_TRUNCATE_HEAD)}...` : title;
  return `Ad-hoc task reconcile: ${truncated}`;
}

// Separate label generator for `basou task refresh-linkage` so the operator
// can distinguish refresh runs from reconcile runs at a glance in session
// listings — both flow through `createAdHocSessionWithEvent` but answer
// different questions (broken-ref repair vs. snapshot-vs-events sync).
function buildAdHocRefreshLinkageLabel(title: string): string {
  const truncated =
    title.length > LABEL_TITLE_MAX ? `${title.slice(0, LABEL_TRUNCATE_HEAD)}...` : title;
  return `Ad-hoc task refresh-linkage: ${truncated}`;
}

function buildAdHocDeleteLabel(title: string): string {
  const truncated =
    title.length > LABEL_TITLE_MAX ? `${title.slice(0, LABEL_TRUNCATE_HEAD)}...` : title;
  return `Ad-hoc task delete: ${truncated}`;
}

function buildAdHocArchiveLabel(title: string): string {
  const truncated =
    title.length > LABEL_TITLE_MAX ? `${title.slice(0, LABEL_TRUNCATE_HEAD)}...` : title;
  return `Ad-hoc task archive: ${truncated}`;
}

function buildTaskReconciledEvent(input: {
  eventId: PrefixedId<"evt">;
  sessionId: PrefixedId<"ses">;
  taskId: PrefixedId<"task">;
  removedCreatedInSession: PrefixedId<"ses"> | null;
  createdInSessionReplacement: PrefixedId<"ses"> | null;
  removedLinkedSessions: PrefixedId<"ses">[];
  occurredAt: string;
}): Event {
  return {
    schema_version: "0.1.0",
    id: input.eventId,
    session_id: input.sessionId,
    occurred_at: input.occurredAt,
    source: "local-cli",
    type: "task_reconciled",
    task_id: input.taskId,
    removed_created_in_session: input.removedCreatedInSession,
    created_in_session_replacement: input.createdInSessionReplacement,
    removed_linked_sessions: input.removedLinkedSessions,
  };
}

function buildTaskDeletedEvent(input: {
  eventId: PrefixedId<"evt">;
  sessionId: PrefixedId<"ses">;
  taskId: PrefixedId<"task">;
  title: string;
  occurredAt: string;
}): Event {
  return {
    schema_version: "0.1.0",
    id: input.eventId,
    session_id: input.sessionId,
    occurred_at: input.occurredAt,
    source: "local-cli",
    type: "task_deleted",
    task_id: input.taskId,
    title: input.title,
  };
}

function buildTaskArchivedEvent(input: {
  eventId: PrefixedId<"evt">;
  sessionId: PrefixedId<"ses">;
  taskId: PrefixedId<"task">;
  title: string;
  occurredAt: string;
}): Event {
  return {
    schema_version: "0.1.0",
    id: input.eventId,
    session_id: input.sessionId,
    occurred_at: input.occurredAt,
    source: "local-cli",
    type: "task_archived",
    task_id: input.taskId,
    title: input.title,
  };
}

function buildTaskLinkageRefreshedEvent(input: {
  eventId: PrefixedId<"evt">;
  sessionId: PrefixedId<"ses">;
  taskId: PrefixedId<"task">;
  addedLinkedSessions: PrefixedId<"ses">[];
  removedLinkedSessions: PrefixedId<"ses">[];
  finalCount: number;
  occurredAt: string;
}): Event {
  return {
    schema_version: "0.1.0",
    id: input.eventId,
    session_id: input.sessionId,
    occurred_at: input.occurredAt,
    source: "local-cli",
    type: "task_linkage_refreshed",
    task_id: input.taskId,
    added_linked_sessions: input.addedLinkedSessions,
    removed_linked_sessions: input.removedLinkedSessions,
    final_count: input.finalCount,
  };
}

/**
 * Create a new task: fires a single `task_created` event and writes
 * `.basou/tasks/<taskId>.md` with status = `initialStatus`.
 *
 * Ad-hoc path: a fresh ad-hoc session is minted (5-event bulk write,
 * `task_created` as the target event, session.yaml.task_id pinned to the
 * new task).
 *
 * Attach path: the target session's `task_id` is validated against the
 * Y-2 §2.1 invariant (null → updated to the new task; existing X → rejected
 * since X is already owned). If validation passes, the event is appended
 * to events.jsonl and session.yaml's `task_id` is updated to the new task.
 *
 * Race window (v0.1 accepts): stage 2 writes the event, stage 3 writes
 * task.md. A failure on stage 3 leaves events.jsonl ahead of task.md;
 * {@link TaskWriteAfterEventError} surfaces this with a "do not rerun"
 * warning so the operator can reconcile manually until v0.2 reconcile
 * arrives (Step 17 申し送り #52).
 */
export async function createTaskWithEvent(input: CreateTaskInput): Promise<CreateTaskResult> {
  // Boundary parses so direct (non-CLI) callers can't smuggle in malformed
  // ids / statuses / titles past the CLI-side guards. All checks here run
  // BEFORE any persistent write, so a rejection leaves events.jsonl and
  // task.md untouched.
  TaskIdSchema.parse(input.taskId);
  InitialTaskStatusSchema.parse(input.initialStatus);
  TaskTitleSchema.parse(input.title);
  if (input.label !== undefined) {
    TaskLabelSchema.parse(input.label);
  }
  if (input.completedAt !== undefined) {
    CompletedAtSchema.parse(input.completedAt);
  }

  if (input.mode === "ad-hoc") {
    return createTaskAdHoc(input);
  }
  return createTaskAttach(input);
}

async function createTaskAdHoc(input: CreateAdHocTaskInput): Promise<CreateTaskResult> {
  const adHoc = await createAdHocSessionWithEvent({
    paths: input.paths,
    manifest: input.manifest,
    label: buildAdHocTaskLabel(input.title, "new"),
    occurredAt: input.occurredAt,
    sessionSource: "human",
    workingDirectory: input.workingDirectory,
    invocation: {
      command: "basou task new",
      args: buildTaskNewInvocationArgs(input.title, input.initialStatus, input.completedAt),
    },
    taskId: input.taskId,
    targetEventBuilders: buildTaskNewTargetEventBuilders({
      taskId: input.taskId,
      title: input.title,
      initialStatus: input.initialStatus,
      occurredAt: input.occurredAt,
    }),
  });

  const task: Task = buildInitialTask({
    taskId: input.taskId,
    title: input.title,
    ...(input.label !== undefined ? { label: input.label } : {}),
    status: input.initialStatus,
    occurredAt: input.occurredAt,
    ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
    workspaceId: input.manifest.workspace.id,
    createdInSession: adHoc.sessionId,
  });
  // `targetEventIds[0]` is the `task_created` anchor (= what the caller cares
  // about); a second `task_status_changed` event may also live in this
  // ad-hoc session when initialStatus is terminal, but it is not the
  // primary task-lifecycle anchor.
  const anchorEventId = adHoc.targetEventIds[0] as PrefixedId<"evt">;
  try {
    await writeTaskFile(
      input.paths,
      input.taskId,
      { task, body: input.description },
      { mode: "create" },
    );
  } catch (error: unknown) {
    throw new TaskWriteAfterEventError({
      taskId: input.taskId,
      eventId: anchorEventId,
      sessionId: adHoc.sessionId,
      phase: "create",
      cause: error,
    });
  }
  return {
    taskId: input.taskId,
    eventId: anchorEventId,
    sessionId: adHoc.sessionId,
    sessionStatus: "completed",
  };
}

async function createTaskAttach(input: AttachTaskInput): Promise<CreateTaskResult> {
  SessionIdSchema.parse(input.sessionId);

  // 1. Read session.yaml + validate the §F.7.2 collision matrix BEFORE writing
  //    anything. status / task_id checks share the same read.
  const sessionDoc = await readSessionYaml(input.paths, input.sessionId);
  const status = sessionDoc.session.status;
  if (status === "imported") {
    throw new Error("Cannot attach to imported session");
  }
  const attachable = input.attachableStatuses ?? DEFAULT_ATTACHABLE_STATUSES;
  if (!attachable.has(status as AttachableStatus)) {
    throw new Error(`Session is not active: ${status}`);
  }
  const existingTaskId = sessionDoc.session.task_id ?? null;
  if (existingTaskId !== null && existingTaskId !== input.taskId) {
    throw new Error(`Session already linked to a different task: ${existingTaskId}`);
  }
  if (existingTaskId === input.taskId) {
    // Re-creating the same task on the same session would duplicate
    // `task_created` in events.jsonl. Reject up front.
    throw new Error(`Task already exists: ${input.taskId}`);
  }

  // 2. Append `task_created` to events.jsonl. We use appendEventToExistingSession
  //    so the same status/imported-rejection logic is shared with Step 16 paths.
  const appendResult = await appendEventToExistingSession({
    paths: input.paths,
    sessionId: input.sessionId,
    ...(input.attachableStatuses !== undefined
      ? { attachableStatuses: input.attachableStatuses }
      : {}),
    eventBuilder: (eventId) =>
      buildTaskCreatedEvent({
        eventId,
        sessionId: input.sessionId,
        taskId: input.taskId,
        title: input.title,
        occurredAt: input.occurredAt,
      }),
  });

  // 3. Update session.yaml task_id (null → new) so the §2.1 invariant holds.
  //    Failure here puts us into the same "event persisted, side-effect
  //    missing" band as task.md. Use phase: "link-session" so the operator
  //    warning identifies the failed artefact correctly (Codex Y3t-3-H2).
  try {
    const updated = {
      ...sessionDoc,
      session: { ...sessionDoc.session, task_id: input.taskId },
    };
    await overwriteYamlFile(join(input.paths.sessions, input.sessionId, "session.yaml"), updated);
  } catch (error: unknown) {
    throw new TaskWriteAfterEventError({
      taskId: input.taskId,
      eventId: appendResult.eventId,
      sessionId: input.sessionId,
      phase: "link-session",
      cause: error,
    });
  }

  // 4. For terminal initialStatus (done / cancelled) append a second target
  //    event `task_status_changed (planned → terminal)` so the events.jsonl
  //    audit trail records the implicit transition. The ALLOWED_TRANSITIONS
  //    shortcut from `planned` to `done|cancelled` makes this a single
  //    permitted edge. The session.yaml `task_id` link from step 3 covers
  //    both events; no further session.yaml write is needed.
  if (isTerminalTaskStatus(input.initialStatus)) {
    await appendEventToExistingSession({
      paths: input.paths,
      sessionId: input.sessionId,
      ...(input.attachableStatuses !== undefined
        ? { attachableStatuses: input.attachableStatuses }
        : {}),
      eventBuilder: (eventId) =>
        buildTaskStatusChangedEvent({
          eventId,
          sessionId: input.sessionId,
          taskId: input.taskId,
          from: "planned",
          to: input.initialStatus,
          occurredAt: input.occurredAt,
        }),
    });
  }

  // 5. Write task.md (create mode, collision = rerun guard).
  const task: Task = buildInitialTask({
    taskId: input.taskId,
    title: input.title,
    ...(input.label !== undefined ? { label: input.label } : {}),
    status: input.initialStatus,
    occurredAt: input.occurredAt,
    ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
    workspaceId: sessionDoc.session.workspace_id,
    createdInSession: input.sessionId,
  });
  try {
    await writeTaskFile(
      input.paths,
      input.taskId,
      { task, body: input.description },
      { mode: "create" },
    );
  } catch (error: unknown) {
    throw new TaskWriteAfterEventError({
      taskId: input.taskId,
      eventId: appendResult.eventId,
      sessionId: input.sessionId,
      phase: "create",
      cause: error,
    });
  }

  return {
    taskId: input.taskId,
    eventId: appendResult.eventId,
    sessionId: input.sessionId,
    sessionStatus: status,
  };
}

function buildInitialTask(input: {
  taskId: PrefixedId<"task">;
  title: string;
  label?: string;
  status: TaskStatus;
  occurredAt: string;
  /**
   * Override for `updated_at` when `status` is terminal. Ignored for
   * non-terminal statuses so backdating a non-completed task is not
   * possible by accident.
   */
  completedAt?: string;
  workspaceId: PrefixedId<"ws">;
  createdInSession: PrefixedId<"ses">;
}): Task {
  const updatedAt =
    input.completedAt !== undefined && isTerminalTaskStatus(input.status)
      ? input.completedAt
      : input.occurredAt;
  return {
    schema_version: "0.1.0",
    task: {
      id: input.taskId,
      title: input.title,
      ...(input.label !== undefined ? { label: input.label } : {}),
      status: input.status,
      created_at: input.occurredAt,
      updated_at: updatedAt,
      workspace_id: input.workspaceId,
      created_in_session: input.createdInSession,
      linked_sessions: [input.createdInSession],
    },
  };
}

// Helpers for the ad-hoc `task new` path. The invocation args list mirrors
// the operator's CLI input so the recorded `session.yaml.invocation.args`
// stays accurate even when `--status` / `--completed-at` were supplied.
function buildTaskNewInvocationArgs(
  title: string,
  initialStatus: TaskStatus,
  completedAt: string | undefined,
): string[] {
  const args = ["--title", title];
  if (initialStatus !== "planned") {
    args.push("--status", initialStatus);
  }
  if (completedAt !== undefined && isTerminalTaskStatus(initialStatus)) {
    args.push("--completed-at", completedAt);
  }
  return args;
}

function buildTaskNewTargetEventBuilders(input: {
  taskId: PrefixedId<"task">;
  title: string;
  initialStatus: TaskStatus;
  occurredAt: string;
}): Array<(sessionId: PrefixedId<"ses">, eventId: PrefixedId<"evt">) => Event> {
  const createdBuilder = (sessionId: PrefixedId<"ses">, eventId: PrefixedId<"evt">): Event =>
    buildTaskCreatedEvent({
      eventId,
      sessionId,
      taskId: input.taskId,
      title: input.title,
      occurredAt: input.occurredAt,
    });
  if (!isTerminalTaskStatus(input.initialStatus)) {
    return [createdBuilder];
  }
  // For terminal initialStatus, emit `task_status_changed (planned → terminal)`
  // right after `task_created` so replay reconstructs the implicit
  // transition. The shortcut edges `planned → done|cancelled` are already
  // allowed by ALLOWED_TRANSITIONS.
  const statusChangedBuilder = (sessionId: PrefixedId<"ses">, eventId: PrefixedId<"evt">): Event =>
    buildTaskStatusChangedEvent({
      eventId,
      sessionId,
      taskId: input.taskId,
      from: "planned",
      to: input.initialStatus,
      occurredAt: input.occurredAt,
    });
  return [createdBuilder, statusChangedBuilder];
}

// ============================================================================
// Orchestrator: updateTaskStatusWithEvent
// ============================================================================

export type UpdateAdHocTaskStatusInput = {
  mode: "ad-hoc";
  paths: BasouPaths;
  manifest: Manifest;
  occurredAt: string;
  taskId: PrefixedId<"task">;
  newStatus: TaskStatus;
  workingDirectory: string;
};

export type AttachUpdateTaskStatusInput = {
  mode: "attach";
  paths: BasouPaths;
  occurredAt: string;
  sessionId: PrefixedId<"ses">;
  taskId: PrefixedId<"task">;
  newStatus: TaskStatus;
  attachableStatuses?: ReadonlySet<AttachableStatus>;
};

export type UpdateTaskStatusInput = UpdateAdHocTaskStatusInput | AttachUpdateTaskStatusInput;

export type UpdateTaskStatusResult = {
  taskId: PrefixedId<"task">;
  eventId: PrefixedId<"evt">;
  sessionId: PrefixedId<"ses">;
  sessionStatus: SessionStatus;
  previousStatus: TaskStatus;
  newStatus: TaskStatus;
};

/**
 * Fire a `task_status_changed` event and overwrite the task.md front matter
 * with the new status / `updated_at` / appended-but-deduped `linked_sessions`.
 *
 * Validates the transition BEFORE any event write so a rejected transition
 * leaves events.jsonl untouched. The canonical edge set lives in
 * {@link ALLOWED_TRANSITIONS}; the current shape (Y-3z #59) is:
 *   planned → {in_progress, done, cancelled}
 *   in_progress → {done, cancelled}
 *   done / cancelled are terminal (= idempotent same-state is rejected too).
 */
export async function updateTaskStatusWithEvent(
  input: UpdateTaskStatusInput,
): Promise<UpdateTaskStatusResult> {
  TaskIdSchema.parse(input.taskId);

  // 1. Load current task.md (= source of truth for current status).
  const currentDoc = await readTaskFile(input.paths, input.taskId);
  const previousStatus = currentDoc.task.task.status;

  // 2. Validate transition before touching any persistent state.
  assertTransitionAllowed(previousStatus, input.newStatus);

  if (input.mode === "ad-hoc") {
    return updateTaskStatusAdHoc(input, currentDoc, previousStatus);
  }
  return updateTaskStatusAttach(input, currentDoc, previousStatus);
}

async function updateTaskStatusAdHoc(
  input: UpdateAdHocTaskStatusInput,
  currentDoc: TaskDocument,
  previousStatus: TaskStatus,
): Promise<UpdateTaskStatusResult> {
  const title = currentDoc.task.task.title;
  const adHoc = await createAdHocSessionWithEvent({
    paths: input.paths,
    manifest: input.manifest,
    label: buildAdHocTaskLabel(title, "status"),
    occurredAt: input.occurredAt,
    sessionSource: "human",
    workingDirectory: input.workingDirectory,
    invocation: { command: "basou task status", args: [input.taskId, input.newStatus] },
    taskId: input.taskId,
    targetEventBuilders: [
      (sessionId, eventId) =>
        buildTaskStatusChangedEvent({
          eventId,
          sessionId,
          taskId: input.taskId,
          from: previousStatus,
          to: input.newStatus,
          occurredAt: input.occurredAt,
        }),
    ],
  });

  const anchorEventId = adHoc.targetEventIds[0] as PrefixedId<"evt">;
  // 3. Overwrite task.md (status + updated_at + linked_sessions append-dedup).
  const updatedDoc = buildUpdatedDoc({
    currentDoc,
    newStatus: input.newStatus,
    occurredAt: input.occurredAt,
    appendSessionId: adHoc.sessionId,
  });
  try {
    await writeTaskFile(input.paths, input.taskId, updatedDoc, { mode: "overwrite" });
  } catch (error: unknown) {
    throw new TaskWriteAfterEventError({
      taskId: input.taskId,
      eventId: anchorEventId,
      sessionId: adHoc.sessionId,
      phase: "overwrite",
      cause: error,
    });
  }
  return {
    taskId: input.taskId,
    eventId: anchorEventId,
    sessionId: adHoc.sessionId,
    sessionStatus: "completed",
    previousStatus,
    newStatus: input.newStatus,
  };
}

async function updateTaskStatusAttach(
  input: AttachUpdateTaskStatusInput,
  currentDoc: TaskDocument,
  previousStatus: TaskStatus,
): Promise<UpdateTaskStatusResult> {
  SessionIdSchema.parse(input.sessionId);

  const sessionDoc = await readSessionYaml(input.paths, input.sessionId);
  const status = sessionDoc.session.status;
  if (status === "imported") {
    throw new Error("Cannot attach to imported session");
  }
  const attachable = input.attachableStatuses ?? DEFAULT_ATTACHABLE_STATUSES;
  if (!attachable.has(status as AttachableStatus)) {
    throw new Error(`Session is not active: ${status}`);
  }
  // task_id collision: the session MUST already be linked to the same task,
  // otherwise a status change on a task that the session does not own would
  // violate Y-2 §2.1.
  const existingTaskId = sessionDoc.session.task_id ?? null;
  if (existingTaskId === null) {
    throw new Error(`Session is not linked to task: ${input.taskId}`);
  }
  if (existingTaskId !== input.taskId) {
    throw new Error(`Session already linked to a different task: ${existingTaskId}`);
  }

  const appendResult = await appendEventToExistingSession({
    paths: input.paths,
    sessionId: input.sessionId,
    ...(input.attachableStatuses !== undefined
      ? { attachableStatuses: input.attachableStatuses }
      : {}),
    eventBuilder: (eventId) =>
      buildTaskStatusChangedEvent({
        eventId,
        sessionId: input.sessionId,
        taskId: input.taskId,
        from: previousStatus,
        to: input.newStatus,
        occurredAt: input.occurredAt,
      }),
  });

  const updatedDoc = buildUpdatedDoc({
    currentDoc,
    newStatus: input.newStatus,
    occurredAt: input.occurredAt,
    appendSessionId: input.sessionId,
  });
  try {
    await writeTaskFile(input.paths, input.taskId, updatedDoc, { mode: "overwrite" });
  } catch (error: unknown) {
    throw new TaskWriteAfterEventError({
      taskId: input.taskId,
      eventId: appendResult.eventId,
      sessionId: input.sessionId,
      phase: "overwrite",
      cause: error,
    });
  }
  return {
    taskId: input.taskId,
    eventId: appendResult.eventId,
    sessionId: input.sessionId,
    sessionStatus: status,
    previousStatus,
    newStatus: input.newStatus,
  };
}

function buildUpdatedDoc(input: {
  currentDoc: TaskDocument;
  newStatus: TaskStatus;
  occurredAt: string;
  appendSessionId: PrefixedId<"ses">;
}): TaskDocument {
  const linked = input.currentDoc.task.task.linked_sessions;
  const merged = linked.includes(input.appendSessionId)
    ? linked
    : [...linked, input.appendSessionId];
  const next: Task = {
    ...input.currentDoc.task,
    task: {
      ...input.currentDoc.task.task,
      status: input.newStatus,
      updated_at: input.occurredAt,
      linked_sessions: merged,
    },
  };
  return { task: next, body: input.currentDoc.body };
}

// ============================================================================
// Reconcile (Y-3w / Step 19)
// ============================================================================

/**
 * Single-task audit result. Always returned by {@link reconcileTask} regardless
 * of mode: in dry-run the `clean` / `broken*` fields describe what would change
 * and `reconcileSession` is `null`; in write mode the same fields describe
 * what did change and `reconcileSession` carries the minted ad-hoc session +
 * `task_reconciled` event ids.
 *
 * Broken `linked_sessions[]` entries are deduplicated against the same session
 * id appearing more than once in the source task.md (Y-3w §C 注 3 / F-3).
 */
export type ReconcileResult = {
  taskId: PrefixedId<"task">;
  clean: boolean;
  brokenCreatedInSession: PrefixedId<"ses"> | null;
  brokenLinkedSessions: PrefixedId<"ses">[];
  reconcileSession: {
    sessionId: PrefixedId<"ses">;
    eventId: PrefixedId<"evt">;
  } | null;
};

/**
 * Per-task failure record collected by {@link reconcileAllTasks}. The scan
 * keeps running on isolated failures so one bad task does not freeze the
 * batch; the CLI layer renders this list and exits 1 if any entry is present.
 *
 * `phase` is populated only for {@link TaskWriteAfterEventError}; for any
 * other error class it is `null` and the operator must use `--verbose` to
 * surface the cause chain.
 */
export type ReconcileFailure = {
  taskId: PrefixedId<"task">;
  errorClass: string;
  phase: TaskWriteAfterEventPhase | null;
};

/**
 * Batch audit result. Order follows `enumerateTaskIds(paths)` (ULID-ascending).
 * `scanned` is the number of readable task.md files processed (= excludes
 * malformed task.md from the count so an integrity-broken file does not
 * pad the total; Y-3w §B.2 注 / test #17).
 */
export type ReconcileAllResult = {
  results: ReconcileResult[];
  failed: ReconcileFailure[];
  scanned: number;
};

export type ReconcileTaskInput = {
  taskId: PrefixedId<"task">;
  occurredAt: string;
  workingDirectory: string;
  write: boolean;
  /**
   * Whether the caller invoked reconcile against a single task (`--task <id>`)
   * or as part of a full scan. The ad-hoc reconcile session records the form
   * on its `invocation.args` so audit trails distinguish targeted repairs
   * from sweeps (Y-3w §B.1):
   *   - `"single"` -> `["--task", <taskId>, "--write"]`
   *   - `"all"`    -> `["--write"]` (= the operator typed no task id, so the
   *     scan-wide intent is preserved instead of synthesising one per task)
   * Defaults to `"single"` so direct callers (tests, programmatic uses) keep
   * the targeted form without an explicit argument.
   */
  scope?: "single" | "all";
  /**
   * Test-only hook (Y-3w §J.4): the test runner uses this to mutate the task
   * file from outside the reconcile flow between the pre-write snapshot and
   * the post-event re-read, simulating a concurrent edit so the
   * `reconcile-concurrent` branch can be exercised deterministically.
   * Production callers leave it undefined.
   */
  _onPhaseCompleted?: (phase: "phase-4-snapshot" | "phase-5-bulk-write") => Promise<void>;
};

export type ReconcileAllTasksInput = {
  /**
   * Per-task timestamp factory. Each reconciled task gets a fresh ISO string
   * so concurrent ad-hoc sessions do not collide on `occurred_at`. The CLI
   * layer wires this to `ctx.nowProvider().toISOString()`.
   */
  occurredAt: () => string;
  workingDirectory: string;
  write: boolean;
};

export type ReconcileAllTasksOptions = {
  /**
   * When true the result includes clean tasks (= no broken refs). The CLI
   * layer leaves this false so the human output only mentions tasks that
   * actually changed.
   */
  includeClean?: boolean;
};

type TaskMdSnapshot = {
  mtimeMs: number;
  hash: string;
};

async function computeTaskMdSnapshot(paths: BasouPaths, taskId: string): Promise<TaskMdSnapshot> {
  const filePath = join(paths.tasks, `${taskId}.md`);
  const [stats, raw] = await Promise.all([stat(filePath), readFile(filePath)]);
  const hash = createHash("sha256").update(raw).digest("hex");
  return { mtimeMs: stats.mtimeMs, hash };
}

// Read task.md and derive its mtime/sha256 snapshot from the SAME raw bytes
// the TaskDocument was parsed from. Codex review #3 M-3 flagged that the
// previous "readTaskFile, then computeTaskMdSnapshot" sequence left a window
// where a concurrent edit between those two reads could leave the caller
// acting on stale content while the snapshot already reflected the new
// content — and stage 7 would then clobber the new bytes with the stale
// TaskDocument. Sharing the raw bytes here means stage 6's re-read is
// compared against the EXACT bytes that produced this document, so any
// drift since this read is caught.
async function readTaskFileWithSnapshot(
  paths: BasouPaths,
  taskId: string,
): Promise<{ doc: TaskDocument; snapshot: TaskMdSnapshot }> {
  const filePath = join(paths.tasks, `${taskId}.md`);
  let rawBuffer: Buffer;
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    [rawBuffer, stats] = await Promise.all([readFile(filePath), stat(filePath)]);
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) {
      throw new Error("Task file not found", { cause: error });
    }
    throw new Error("Failed to read task file", { cause: error });
  }
  const raw = rawBuffer.toString("utf8");
  const hash = createHash("sha256").update(rawBuffer).digest("hex");
  // Parse logic mirrors readTaskFile so the error contract stays identical
  // (Invalid task file format / Failed to read task file). Duplicated here to
  // avoid a second readFile from the public helper.
  let split: { yamlText: string; body: string };
  try {
    split = splitFrontMatter(raw);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Invalid task file format") {
      throw error;
    }
    throw new Error("Failed to read task file", { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(split.yamlText);
  } catch (error: unknown) {
    throw new Error("Failed to read task file", { cause: error });
  }
  const result = TaskSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("Failed to read task file", { cause: result.error });
  }
  return {
    doc: { task: result.data, body: split.body },
    snapshot: { mtimeMs: stats.mtimeMs, hash },
  };
}

type DetectedBrokenRefs = {
  brokenCreatedInSession: PrefixedId<"ses"> | null;
  brokenLinkedSessions: PrefixedId<"ses">[];
};

// `enumerateSessionDirs` returns directory names only — it does NOT validate
// the contents of each `session.yaml`. By treating directory existence alone
// as "reachable", reconcile targets the Y-3u §6.9 milestone-20 failure mode
// (= session directory removed entirely, dangling id remains in task.md) and
// keeps the "broken" predicate cheap. A directory that exists but whose
// session.yaml is missing or schema-invalid is intentionally classified as
// reachable here; that flavour of corruption is the responsibility of session
// integrity tools (Step 21 / Y-3y) and is out of scope for v0.2 reconcile.
async function detectBrokenRefs(
  paths: BasouPaths,
  task: Task["task"],
): Promise<DetectedBrokenRefs> {
  const sessionDirs = new Set(await enumerateSessionDirs(paths));
  const brokenCreatedInSession = sessionDirs.has(task.created_in_session)
    ? null
    : (task.created_in_session as PrefixedId<"ses">);
  // Deduplicate broken entries so duplicate broken ids in a hand-edited task.md
  // surface as a single entry on the event payload (Y-3w F-3 / test #21).
  const seen = new Set<string>();
  const brokenLinkedSessions: PrefixedId<"ses">[] = [];
  for (const sid of task.linked_sessions) {
    if (sessionDirs.has(sid)) continue;
    if (seen.has(sid)) continue;
    seen.add(sid);
    brokenLinkedSessions.push(sid as PrefixedId<"ses">);
  }
  return { brokenCreatedInSession, brokenLinkedSessions };
}

function buildReconciledDoc(input: {
  currentDoc: TaskDocument;
  brokenCreatedInSession: PrefixedId<"ses"> | null;
  brokenLinkedSessions: ReadonlyArray<PrefixedId<"ses">>;
  reconcileSessionId: PrefixedId<"ses">;
  occurredAt: string;
}): TaskDocument {
  const brokenSet = new Set<string>(input.brokenLinkedSessions);
  const filtered = input.currentDoc.task.task.linked_sessions.filter((sid) => !brokenSet.has(sid));
  const merged: PrefixedId<"ses">[] = [...filtered] as PrefixedId<"ses">[];
  if (!merged.includes(input.reconcileSessionId)) {
    merged.push(input.reconcileSessionId);
  }
  const nextCreatedInSession =
    input.brokenCreatedInSession !== null
      ? input.reconcileSessionId
      : input.currentDoc.task.task.created_in_session;
  const next: Task = {
    ...input.currentDoc.task,
    task: {
      ...input.currentDoc.task.task,
      created_in_session: nextCreatedInSession,
      updated_at: input.occurredAt,
      linked_sessions: merged,
    },
  };
  return { task: next, body: input.currentDoc.body };
}

/**
 * Audit a single task's session references. In `write: false` mode this is a
 * pure read-only report (no events, no task.md change). In `write: true` mode,
 * if any broken reference is found, mint an ad-hoc reconcile session, fire
 * `task_reconciled`, and overwrite task.md with the repaired refs.
 *
 * The broken `created_in_session` field is REPLACED with the new reconcile
 * session id rather than nulled out — `TaskSchema.created_in_session` is
 * non-nullable, so dropping it would leave the file schema-invalid (Y-3w D1).
 * The old broken id is preserved on the event payload via
 * `removed_created_in_session` for audit.
 *
 * Stages (Y-3w §D.1) — failures after stage 5 surface a phase-specific
 * {@link TaskWriteAfterEventError} so the CLI can render a tailored "do not
 * rerun" hint:
 *   1. Boundary parse
 *   2. Read task.md AND snapshot its mtime/hash from the same raw bytes,
 *      then detect broken refs (Codex review #3 M-3: sharing the raw bytes
 *      closes the readTaskFile-then-snapshot race window).
 *   3. Early return when clean (no event fired, no overwrite)
 *   4. (no separate stage anymore — snapshot is taken at stage 2)
 *   5. Mint ad-hoc session + `task_reconciled` event (catch
 *      `FailedToFinalizeError` → `phase: "reconcile-finalize"`)
 *   6. Re-snapshot task.md; if changed since stage 2 →
 *      `phase: "reconcile-concurrent"`
 *   7. Overwrite task.md; failure → `phase: "reconcile"`
 */
export async function reconcileTask(
  paths: BasouPaths,
  manifest: Manifest,
  input: ReconcileTaskInput,
): Promise<ReconcileResult> {
  TaskIdSchema.parse(input.taskId);

  const { doc: currentDoc, snapshot: preSnapshot } = await readTaskFileWithSnapshot(
    paths,
    input.taskId,
  );
  const { brokenCreatedInSession, brokenLinkedSessions } = await detectBrokenRefs(
    paths,
    currentDoc.task.task,
  );

  if (brokenCreatedInSession === null && brokenLinkedSessions.length === 0) {
    return {
      taskId: input.taskId,
      clean: true,
      brokenCreatedInSession: null,
      brokenLinkedSessions: [],
      reconcileSession: null,
    };
  }

  if (!input.write) {
    return {
      taskId: input.taskId,
      clean: false,
      brokenCreatedInSession,
      brokenLinkedSessions,
      reconcileSession: null,
    };
  }

  if (input._onPhaseCompleted !== undefined) {
    await input._onPhaseCompleted("phase-4-snapshot");
  }

  let adHoc: Awaited<ReturnType<typeof createAdHocSessionWithEvent>>;
  try {
    adHoc = await createAdHocSessionWithEvent({
      paths,
      manifest,
      label: buildAdHocReconcileLabel(currentDoc.task.task.title),
      occurredAt: input.occurredAt,
      sessionSource: "human",
      workingDirectory: input.workingDirectory,
      invocation: {
        command: "basou task reconcile",
        args:
          (input.scope ?? "single") === "single"
            ? ["--task", input.taskId, "--write"]
            : ["--write"],
      },
      taskId: input.taskId,
      targetEventBuilders: [
        (sessionId, eventId) =>
          buildTaskReconciledEvent({
            eventId,
            sessionId,
            taskId: input.taskId,
            removedCreatedInSession: brokenCreatedInSession,
            createdInSessionReplacement: brokenCreatedInSession !== null ? sessionId : null,
            removedLinkedSessions: brokenLinkedSessions,
            occurredAt: input.occurredAt,
          }),
      ],
    });
  } catch (error: unknown) {
    if (error instanceof FailedToFinalizeError) {
      throw new TaskWriteAfterEventError({
        taskId: input.taskId,
        eventId: error.targetEventIds[0] as PrefixedId<"evt">,
        sessionId: error.sessionId,
        phase: "reconcile-finalize",
        cause: error,
      });
    }
    throw error;
  }

  if (input._onPhaseCompleted !== undefined) {
    await input._onPhaseCompleted("phase-5-bulk-write");
  }

  const anchorEventId = adHoc.targetEventIds[0] as PrefixedId<"evt">;

  const postSnapshot = await computeTaskMdSnapshot(paths, input.taskId);
  if (postSnapshot.mtimeMs !== preSnapshot.mtimeMs || postSnapshot.hash !== preSnapshot.hash) {
    throw new TaskWriteAfterEventError({
      taskId: input.taskId,
      eventId: anchorEventId,
      sessionId: adHoc.sessionId,
      phase: "reconcile-concurrent",
      cause: new Error("task.md changed during reconcile"),
    });
  }

  const repaired = buildReconciledDoc({
    currentDoc,
    brokenCreatedInSession,
    brokenLinkedSessions,
    reconcileSessionId: adHoc.sessionId,
    occurredAt: input.occurredAt,
  });
  try {
    await writeTaskFile(paths, input.taskId, repaired, { mode: "overwrite" });
  } catch (error: unknown) {
    throw new TaskWriteAfterEventError({
      taskId: input.taskId,
      eventId: anchorEventId,
      sessionId: adHoc.sessionId,
      phase: "reconcile",
      cause: error,
    });
  }

  return {
    taskId: input.taskId,
    clean: false,
    brokenCreatedInSession,
    brokenLinkedSessions,
    reconcileSession: {
      sessionId: adHoc.sessionId,
      eventId: anchorEventId,
    },
  };
}

/**
 * Reconcile every task in `.basou/tasks/`. Continues on per-task failures so
 * an isolated {@link TaskWriteAfterEventError} does not stop the batch
 * (Y-3w D4-4). Malformed task.md files are skipped silently and excluded
 * from `scanned`.
 */
export async function reconcileAllTasks(
  paths: BasouPaths,
  manifest: Manifest,
  input: ReconcileAllTasksInput,
  options: ReconcileAllTasksOptions = {},
): Promise<ReconcileAllResult> {
  const taskIds = await enumerateTaskIds(paths);
  const results: ReconcileResult[] = [];
  const failed: ReconcileFailure[] = [];
  let scanned = 0;

  for (const id of taskIds) {
    // Probe readability first so malformed task.md does NOT inflate `scanned`
    // and never reaches the reconcile flow (Y-3w §B.2 注 / test #17). The
    // readTaskFile call is replayed inside reconcileTask itself — re-reading
    // is cheap and keeps reconcileTask's contract single-purpose.
    try {
      await readTaskFile(paths, id);
    } catch {
      continue;
    }
    scanned += 1;

    try {
      const r = await reconcileTask(paths, manifest, {
        taskId: id as PrefixedId<"task">,
        occurredAt: input.occurredAt(),
        workingDirectory: input.workingDirectory,
        write: input.write,
        scope: "all",
      });
      if (options.includeClean === true || !r.clean) {
        results.push(r);
      }
    } catch (error: unknown) {
      const errorClass = error instanceof Error ? error.constructor.name : "Error";
      const phase = error instanceof TaskWriteAfterEventError ? error.phase : null;
      failed.push({
        taskId: id as PrefixedId<"task">,
        errorClass,
        phase,
      });
    }
  }

  return { results, failed, scanned };
}

// ============================================================================
// Linkage refresh: events.jsonl → task.md `linked_sessions[]` forward sync
// ============================================================================

/**
 * Single-task linkage refresh result. In `write: false` mode this is a pure
 * dry-run report (no event, no task.md change); `addedLinkedSessions` and
 * `removedLinkedSessions` describe what would change. In `write: true` mode
 * the same fields describe what did change and `refreshSession` carries the
 * ad-hoc session + `task_linkage_refreshed` event ids that were minted.
 *
 * `clean === true` means the existing `task.md.linked_sessions[]` already
 * matches the union of `session.yaml.task_id` matches plus the anchor
 * (`created_in_session`) — no event fired, no overwrite.
 */
export type RefreshLinkageResult = {
  taskId: PrefixedId<"task">;
  clean: boolean;
  addedLinkedSessions: PrefixedId<"ses">[];
  removedLinkedSessions: PrefixedId<"ses">[];
  /** Number of entries in `linked_sessions[]` after the refresh would run. */
  finalCount: number;
  refreshSession: {
    sessionId: PrefixedId<"ses">;
    eventId: PrefixedId<"evt">;
  } | null;
};

export type RefreshLinkageInput = {
  taskId: PrefixedId<"task">;
  occurredAt: string;
  workingDirectory: string;
  write: boolean;
};

type DetectedLinkageDelta = {
  addedLinkedSessions: PrefixedId<"ses">[];
  removedLinkedSessions: PrefixedId<"ses">[];
  finalLinkedSessions: PrefixedId<"ses">[];
};

// Re-derive `linked_sessions[]` from the source of truth: every
// `session.yaml` whose `task_id` points at this task, plus the
// `created_in_session` anchor (which is preserved even if its session.yaml
// no longer carries the task_id — that flavour of drift is the
// `task reconcile` path's concern, not this one).
//
// `enumerateSessionDirs` already filters to dir-named-`ses_<ulid>` entries.
// Sessions whose `session.yaml` is missing or schema-invalid are silently
// skipped so a single broken session does not abort the workspace-wide
// refresh; surfacing those is the responsibility of the session-integrity
// tooling.
async function detectLinkageDelta(
  paths: BasouPaths,
  task: Task["task"],
): Promise<DetectedLinkageDelta> {
  const sessionIds = await enumerateSessionDirs(paths);
  const reachable = new Set<string>();
  for (const sid of sessionIds) {
    try {
      const doc = await readSessionYaml(paths, sid);
      if (doc.session.task_id === task.id) {
        reachable.add(sid);
      }
    } catch {
      // Missing / malformed session.yaml — skip. Surfacing those is the
      // responsibility of session-integrity tooling, not the linkage-refresh
      // path; a single corrupt session.yaml must not abort the workspace
      // scan.
    }
  }
  // The anchor invariant (Y-2 §2.1) requires `linked_sessions[]` to always
  // contain `created_in_session`. Preserve it here even if the session.yaml
  // was hand-edited to clear task_id (rare; handled by reconcile).
  const finalSet = new Set<string>(reachable);
  finalSet.add(task.created_in_session);

  const currentSet = new Set<string>(task.linked_sessions);
  const addedLinkedSessions: PrefixedId<"ses">[] = [];
  const removedLinkedSessions: PrefixedId<"ses">[] = [];
  for (const sid of finalSet) {
    if (!currentSet.has(sid)) addedLinkedSessions.push(sid as PrefixedId<"ses">);
  }
  for (const sid of currentSet) {
    if (!finalSet.has(sid)) removedLinkedSessions.push(sid as PrefixedId<"ses">);
  }
  // Stable ordering: ULID-ascending so two runs against the same workspace
  // produce identical event payloads (matters for replay determinism).
  addedLinkedSessions.sort();
  removedLinkedSessions.sort();
  const finalLinkedSessions = [...finalSet].sort() as PrefixedId<"ses">[];
  return { addedLinkedSessions, removedLinkedSessions, finalLinkedSessions };
}

function buildRefreshedDoc(input: {
  currentDoc: TaskDocument;
  finalLinkedSessions: ReadonlyArray<PrefixedId<"ses">>;
  refreshSessionId: PrefixedId<"ses">;
  occurredAt: string;
}): TaskDocument {
  // Include the refresh session itself in `linked_sessions` (it is the
  // session that wrote the `task_linkage_refreshed` event, so it is by
  // definition linked). Deduplicate via a Set in case the ad-hoc session id
  // somehow already shows up in finalLinkedSessions (defensive).
  const merged = new Set<string>(input.finalLinkedSessions);
  merged.add(input.refreshSessionId);
  const linked = [...merged].sort() as PrefixedId<"ses">[];
  const next: Task = {
    ...input.currentDoc.task,
    task: {
      ...input.currentDoc.task.task,
      updated_at: input.occurredAt,
      linked_sessions: linked,
    },
  };
  return { task: next, body: input.currentDoc.body };
}

/**
 * Refresh `task.md.linked_sessions[]` so it matches the union of
 * `session.yaml.task_id` references in the workspace plus the
 * `created_in_session` anchor. In `write: false` this is a pure read-only
 * report; in `write: true` the diff is recorded as a
 * `task_linkage_refreshed` event inside a fresh ad-hoc session and the
 * task.md is overwritten with the new snapshot.
 *
 * Stages mirror `reconcileTask` so the operator gets the same
 * "do-not-rerun" hint shape on partial failure:
 *   1. Boundary parse
 *   2. Read task.md AND snapshot its mtime/hash from the same raw bytes
 *   3. Detect linkage delta (= scan workspace session.yaml)
 *   4. Early return when clean
 *   5. Mint ad-hoc session + `task_linkage_refreshed` event (catch
 *      `FailedToFinalizeError` → `phase: "linkage-refresh-finalize"`)
 *   6. Re-snapshot task.md; if changed since stage 2 →
 *      `phase: "linkage-refresh-concurrent"`
 *   7. Overwrite task.md; failure → `phase: "linkage-refresh"`
 *
 * The refresh event is distinct from `task_reconciled` (= broken-ref
 * cleanup, `.strict()` with broken-ref-specific fields) so each event
 * carries a single, focused audit story. Reusing `task_reconciled` here
 * would either redefine its semantics or require widening its strict
 * schema, both of which break replay determinism for older events.
 */
export async function refreshTaskLinkedSessions(
  paths: BasouPaths,
  manifest: Manifest,
  input: RefreshLinkageInput,
): Promise<RefreshLinkageResult> {
  TaskIdSchema.parse(input.taskId);

  const { doc: currentDoc, snapshot: preSnapshot } = await readTaskFileWithSnapshot(
    paths,
    input.taskId,
  );
  const { addedLinkedSessions, removedLinkedSessions, finalLinkedSessions } =
    await detectLinkageDelta(paths, currentDoc.task.task);

  if (addedLinkedSessions.length === 0 && removedLinkedSessions.length === 0) {
    return {
      taskId: input.taskId,
      clean: true,
      addedLinkedSessions: [],
      removedLinkedSessions: [],
      finalCount: finalLinkedSessions.length,
      refreshSession: null,
    };
  }

  if (!input.write) {
    return {
      taskId: input.taskId,
      clean: false,
      addedLinkedSessions,
      removedLinkedSessions,
      finalCount: finalLinkedSessions.length,
      refreshSession: null,
    };
  }

  // The refresh session is itself a new linked entry; account for it on
  // the event payload's `final_count` so the audit number matches the
  // post-write task.md. This is a +1 over the workspace-scan count.
  const finalCountWithRefreshSession = finalLinkedSessions.length + 1;

  let adHoc: Awaited<ReturnType<typeof createAdHocSessionWithEvent>>;
  try {
    adHoc = await createAdHocSessionWithEvent({
      paths,
      manifest,
      label: buildAdHocRefreshLinkageLabel(currentDoc.task.task.title),
      occurredAt: input.occurredAt,
      sessionSource: "human",
      workingDirectory: input.workingDirectory,
      invocation: {
        command: "basou task refresh-linkage",
        args: [input.taskId, "--write"],
      },
      taskId: input.taskId,
      targetEventBuilders: [
        (sessionId, eventId) =>
          buildTaskLinkageRefreshedEvent({
            eventId,
            sessionId,
            taskId: input.taskId,
            addedLinkedSessions,
            removedLinkedSessions,
            finalCount: finalCountWithRefreshSession,
            occurredAt: input.occurredAt,
          }),
      ],
    });
  } catch (error: unknown) {
    if (error instanceof FailedToFinalizeError) {
      throw new TaskWriteAfterEventError({
        taskId: input.taskId,
        eventId: error.targetEventIds[0] as PrefixedId<"evt">,
        sessionId: error.sessionId,
        phase: "linkage-refresh-finalize",
        cause: error,
      });
    }
    throw error;
  }

  const anchorEventId = adHoc.targetEventIds[0] as PrefixedId<"evt">;

  const postSnapshot = await computeTaskMdSnapshot(paths, input.taskId);
  if (postSnapshot.mtimeMs !== preSnapshot.mtimeMs || postSnapshot.hash !== preSnapshot.hash) {
    throw new TaskWriteAfterEventError({
      taskId: input.taskId,
      eventId: anchorEventId,
      sessionId: adHoc.sessionId,
      phase: "linkage-refresh-concurrent",
      cause: new Error("task.md changed during linkage refresh"),
    });
  }

  const refreshed = buildRefreshedDoc({
    currentDoc,
    finalLinkedSessions,
    refreshSessionId: adHoc.sessionId,
    occurredAt: input.occurredAt,
  });
  try {
    await writeTaskFile(paths, input.taskId, refreshed, { mode: "overwrite" });
  } catch (error: unknown) {
    throw new TaskWriteAfterEventError({
      taskId: input.taskId,
      eventId: anchorEventId,
      sessionId: adHoc.sessionId,
      phase: "linkage-refresh",
      cause: error,
    });
  }

  return {
    taskId: input.taskId,
    clean: false,
    addedLinkedSessions,
    removedLinkedSessions,
    finalCount: finalCountWithRefreshSession,
    refreshSession: {
      sessionId: adHoc.sessionId,
      eventId: anchorEventId,
    },
  };
}

// ============================================================================
// editTask — field-level update (no event for pure title edits)
// ============================================================================

export type EditTaskInput = {
  paths: BasouPaths;
  taskId: PrefixedId<"task">;
  /** New title; rejected when empty. Undefined leaves the field unchanged. */
  title?: string;
  /**
   * New status; routed through transition rules so the call rejects
   * invalid edges (e.g. `done -> planned`). Undefined leaves the field
   * unchanged.
   */
  newStatus?: TaskStatus;
  occurredAt: string;
  /**
   * Required when {@link newStatus} is provided — the status change fires
   * a `task_status_changed` event in a fresh ad-hoc session, which needs
   * a Manifest to seed the new session record. Title-only edits ignore
   * this field.
   */
  manifest?: Manifest;
  /** Working directory for the ad-hoc status-change session. */
  workingDirectory?: string;
};

export type EditTaskResult = {
  taskId: PrefixedId<"task">;
  titleUpdated: boolean;
  statusUpdated: boolean;
  /** When {@link statusUpdated} is true, the previous status before the edit. */
  previousStatus: TaskStatus | null;
  /** When {@link statusUpdated} is true, the new status. */
  newStatus: TaskStatus | null;
  /** ad-hoc session minted when status was changed; null for title-only edits. */
  statusChangeSession: {
    sessionId: PrefixedId<"ses">;
    eventId: PrefixedId<"evt">;
  } | null;
};

/**
 * Update one or both of the user-editable fields on a task.md.
 *
 * - `title`: in-place overwrite of `task.md` only. v0.1 does not emit a
 *   `task_title_changed` event — title changes are storage-level metadata
 *   maintenance, not part of the audit trail.
 * - `newStatus`: routed through {@link updateTaskStatusWithEvent} so the
 *   ALLOWED_TRANSITIONS gate is honored and a `task_status_changed` event is
 *   appended to the audit trail.
 *
 * When both are supplied the status change runs first (= event committed)
 * and then the title overwrite runs against the freshly updated task.md
 * (= same `updated_at` from the status change). A failure of the
 * subsequent title overwrite leaves the status change committed; the
 * status-change side of an edit is the only side with an event, so the
 * audit trail is consistent regardless.
 */
export async function editTask(input: EditTaskInput): Promise<EditTaskResult> {
  TaskIdSchema.parse(input.taskId);
  if (input.title === undefined && input.newStatus === undefined) {
    throw new Error("Nothing to edit: provide --title or --status");
  }
  if (input.title !== undefined) {
    TaskTitleSchema.parse(input.title);
  }

  let statusUpdated = false;
  let previousStatus: TaskStatus | null = null;
  let newStatus: TaskStatus | null = null;
  let statusChangeSession: EditTaskResult["statusChangeSession"] = null;

  // Stage 1: status change (if any). Failure here exits with the existing
  // transition / not-found errors and leaves task.md untouched.
  if (input.newStatus !== undefined) {
    if (input.manifest === undefined || input.workingDirectory === undefined) {
      throw new Error("editTask requires manifest + workingDirectory when newStatus is supplied");
    }
    const result = await updateTaskStatusWithEvent({
      mode: "ad-hoc",
      paths: input.paths,
      manifest: input.manifest,
      occurredAt: input.occurredAt,
      taskId: input.taskId,
      newStatus: input.newStatus,
      workingDirectory: input.workingDirectory,
    });
    statusUpdated = true;
    previousStatus = result.previousStatus;
    newStatus = result.newStatus;
    statusChangeSession = { sessionId: result.sessionId, eventId: result.eventId };
  }

  // Stage 2: title overwrite (if any). Re-read so the status change above
  // (which updated linked_sessions / updated_at) is preserved.
  let titleUpdated = false;
  if (input.title !== undefined) {
    const doc = await readTaskFile(input.paths, input.taskId);
    if (doc.task.task.title !== input.title) {
      const next: Task = {
        ...doc.task,
        task: {
          ...doc.task.task,
          title: input.title,
          updated_at: input.occurredAt,
        },
      };
      await writeTaskFile(
        input.paths,
        input.taskId,
        { task: next, body: doc.body },
        { mode: "overwrite" },
      );
      titleUpdated = true;
    }
  }

  return {
    taskId: input.taskId,
    titleUpdated,
    statusUpdated,
    previousStatus,
    newStatus,
    statusChangeSession,
  };
}

// ============================================================================
// deleteTask — destructive removal with audit event
// ============================================================================

export type DeleteTaskInput = {
  paths: BasouPaths;
  manifest: Manifest;
  taskId: PrefixedId<"task">;
  occurredAt: string;
  workingDirectory: string;
};

export type DeleteTaskResult = {
  taskId: PrefixedId<"task">;
  title: string;
  sessionId: PrefixedId<"ses">;
  eventId: PrefixedId<"evt">;
};

/**
 * Hard-delete a task.md file with a `task_deleted` audit event.
 *
 * Sequence:
 *   1. Read task.md to capture the current title (which goes onto the
 *      event payload so the audit record is self-describing even after
 *      the file is gone).
 *   2. Mint an ad-hoc session, fire `task_deleted` as the target event.
 *      The session's `task_id` is intentionally NOT pinned to the
 *      to-be-deleted task — otherwise the audit session would carry a
 *      broken reference the moment we unlink the file.
 *   3. Unlink `<paths.tasks>/<task_id>.md`.
 *
 * Failure of step 3 after the event is committed surfaces as a
 * {@link TaskWriteAfterEventError} with `phase: "delete"`; the operator
 * is told the event is durable but task.md still exists, and that a
 * manual `rm` (or a rerun) is required.
 *
 * v0.1 contract: no tombstone, no recovery. Restoring a deleted task is
 * not supported; the event payload (`task_id` + `title`) is the only
 * persistent record after the unlink succeeds.
 */
export async function deleteTask(input: DeleteTaskInput): Promise<DeleteTaskResult> {
  TaskIdSchema.parse(input.taskId);

  // Stage 1: capture the current title before mint.
  const doc = await readTaskFile(input.paths, input.taskId);
  const title = doc.task.task.title;

  // Stage 2: fire the audit event. NOTE we do NOT pass `taskId` to the
  // ad-hoc session — pinning the session to a task that is about to vanish
  // would create a guaranteed broken reference on session.yaml.task_id.
  const adHoc = await createAdHocSessionWithEvent({
    paths: input.paths,
    manifest: input.manifest,
    label: buildAdHocDeleteLabel(title),
    occurredAt: input.occurredAt,
    sessionSource: "human",
    workingDirectory: input.workingDirectory,
    invocation: {
      command: "basou task delete",
      args: [input.taskId, "--yes"],
    },
    targetEventBuilders: [
      (sessionId, eventId) =>
        buildTaskDeletedEvent({
          eventId,
          sessionId,
          taskId: input.taskId,
          title,
          occurredAt: input.occurredAt,
        }),
    ],
  });
  const eventId = adHoc.targetEventIds[0] as PrefixedId<"evt">;

  // Stage 3: unlink the file.
  try {
    await unlink(join(input.paths.tasks, `${input.taskId}.md`));
  } catch (error: unknown) {
    throw new TaskWriteAfterEventError({
      taskId: input.taskId,
      eventId,
      sessionId: adHoc.sessionId,
      phase: "delete",
      cause: error,
    });
  }

  return {
    taskId: input.taskId,
    title,
    sessionId: adHoc.sessionId,
    eventId,
  };
}

// ============================================================================
// archiveTask — move main/<id>.md to archive/<id>.md with audit event
// ============================================================================

export type ArchiveTaskInput = {
  paths: BasouPaths;
  manifest: Manifest;
  taskId: PrefixedId<"task">;
  occurredAt: string;
  workingDirectory: string;
};

export type ArchiveTaskResult = {
  taskId: PrefixedId<"task">;
  title: string;
  sessionId: PrefixedId<"ses">;
  eventId: PrefixedId<"evt">;
};

/**
 * Move a task.md file from `<paths.tasks>/<id>.md` to
 * `<paths.tasks>/archive/<id>.md` with a `task_archived` audit event.
 *
 * Sequence:
 *   1. Read task.md to capture the current title and existing content.
 *   2. Mint an ad-hoc session, fire `task_archived` as the target event.
 *      The session's `task_id` IS pinned to the archived task — unlike
 *      `task_deleted`, the task continues to exist (just at a new path),
 *      so the session-task linkage stays a valid forward reference.
 *   3. Append the audit session to the task's `linked_sessions[]` and
 *      overwrite the source task.md so the snapshot reflects the archive
 *      session before the move.
 *   4. Ensure the archive directory exists.
 *   5. Rename main/<id>.md to archive/<id>.md (= atomic on the same fs).
 *
 * Failure modes after step 2 surface as
 * {@link TaskWriteAfterEventError} with `phase: "archive"`; the operator
 * is told the event is durable but the on-disk move is incomplete and
 * must be resolved manually (typically by rerunning `task archive`).
 */
export async function archiveTask(input: ArchiveTaskInput): Promise<ArchiveTaskResult> {
  TaskIdSchema.parse(input.taskId);

  const doc = await readTaskFile(input.paths, input.taskId);
  const title = doc.task.task.title;

  const adHoc = await createAdHocSessionWithEvent({
    paths: input.paths,
    manifest: input.manifest,
    label: buildAdHocArchiveLabel(title),
    occurredAt: input.occurredAt,
    sessionSource: "human",
    workingDirectory: input.workingDirectory,
    invocation: {
      command: "basou task archive",
      args: [input.taskId, "--yes"],
    },
    taskId: input.taskId,
    targetEventBuilders: [
      (sessionId, eventId) =>
        buildTaskArchivedEvent({
          eventId,
          sessionId,
          taskId: input.taskId,
          title,
          occurredAt: input.occurredAt,
        }),
    ],
  });
  const eventId = adHoc.targetEventIds[0] as PrefixedId<"evt">;

  // Stage 3-5 share the same recovery contract: any failure surfaces as
  // phase "archive" so the operator gets a uniform "rerun task archive"
  // hint. Specific failure cases:
  //   - 3: writeTaskFile (overwrite) — fs/yaml-serialize error
  //   - 4: mkdir of archive dir — usually EACCES
  //   - 5: rename across the same fs — EEXIST when archive/<id>.md is
  //        already there, EACCES, or rare ENOSPC
  try {
    const linked = doc.task.task.linked_sessions;
    const merged = linked.includes(adHoc.sessionId) ? linked : [...linked, adHoc.sessionId];
    const next: Task = {
      ...doc.task,
      task: {
        ...doc.task.task,
        updated_at: input.occurredAt,
        linked_sessions: merged,
      },
    };
    await writeTaskFile(
      input.paths,
      input.taskId,
      { task: next, body: doc.body },
      { mode: "overwrite" },
    );

    await mkdir(archiveTasksDir(input.paths), { recursive: true });
    await rename(
      join(input.paths.tasks, `${input.taskId}.md`),
      join(archiveTasksDir(input.paths), `${input.taskId}.md`),
    );
  } catch (error: unknown) {
    throw new TaskWriteAfterEventError({
      taskId: input.taskId,
      eventId,
      sessionId: adHoc.sessionId,
      phase: "archive",
      cause: error,
    });
  }

  return {
    taskId: input.taskId,
    title,
    sessionId: adHoc.sessionId,
    eventId,
  };
}
