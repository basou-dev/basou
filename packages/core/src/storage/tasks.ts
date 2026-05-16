import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { PrefixedId } from "../ids/ulid.js";
import { findErrorCode } from "../lib/error-codes.js";
import type { Event } from "../schemas/event.schema.js";
import type { Manifest } from "../schemas/manifest.schema.js";
import type { SessionStatus } from "../schemas/session.schema.js";
import { SessionIdSchema, TaskIdSchema } from "../schemas/shared.schema.js";
import { type Task, TaskSchema, type TaskStatus } from "../schemas/task.schema.js";
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
const LABEL_TITLE_MAX = 40;
const LABEL_TRUNCATE_HEAD = LABEL_TITLE_MAX - 3;

const DEFAULT_ATTACHABLE_STATUSES: ReadonlySet<AttachableStatus> = new Set<AttachableStatus>([
  "initialized",
  "running",
  "waiting_approval",
]);

// Codex Y3t-3-H1: enforce §C.3 initial-status restriction and TaskSchema
// title/label minimums at the core API boundary so direct callers (tests,
// future programmatic uses) cannot smuggle past the CLI-side parsers and
// commit a `task_created` event for a malformed task.
const InitialTaskStatusSchema = z.enum(["planned", "in_progress"]);
const TaskTitleSchema = z.string().min(1);
const TaskLabelSchema = z.string().min(1);

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
  | "reconcile-concurrent";

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
  initialStatus: "planned" | "in_progress";
  description: string;
  workingDirectory: string;
};

export type AttachTaskInput = {
  mode: "attach";
  paths: BasouPaths;
  occurredAt: string;
  sessionId: PrefixedId<"ses">;
  taskId: PrefixedId<"task">;
  title: string;
  label?: string;
  initialStatus: "planned" | "in_progress";
  description: string;
  attachableStatuses?: ReadonlySet<AttachableStatus>;
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
    invocation: { command: "basou task new", args: ["--title", input.title] },
    taskId: input.taskId,
    targetEventBuilder: (sessionId, eventId) =>
      buildTaskCreatedEvent({
        eventId,
        sessionId,
        taskId: input.taskId,
        title: input.title,
        occurredAt: input.occurredAt,
      }),
  });

  const task: Task = buildInitialTask({
    taskId: input.taskId,
    title: input.title,
    ...(input.label !== undefined ? { label: input.label } : {}),
    status: input.initialStatus,
    occurredAt: input.occurredAt,
    workspaceId: input.manifest.workspace.id,
    createdInSession: adHoc.sessionId,
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
      eventId: adHoc.targetEventId,
      sessionId: adHoc.sessionId,
      phase: "create",
      cause: error,
    });
  }
  return {
    taskId: input.taskId,
    eventId: adHoc.targetEventId,
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

  // 4. Write task.md (create mode, collision = rerun guard).
  const task: Task = buildInitialTask({
    taskId: input.taskId,
    title: input.title,
    ...(input.label !== undefined ? { label: input.label } : {}),
    status: input.initialStatus,
    occurredAt: input.occurredAt,
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
  workspaceId: PrefixedId<"ws">;
  createdInSession: PrefixedId<"ses">;
}): Task {
  return {
    schema_version: "0.1.0",
    task: {
      id: input.taskId,
      title: input.title,
      ...(input.label !== undefined ? { label: input.label } : {}),
      status: input.status,
      created_at: input.occurredAt,
      updated_at: input.occurredAt,
      workspace_id: input.workspaceId,
      created_in_session: input.createdInSession,
      linked_sessions: [input.createdInSession],
    },
  };
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
    targetEventBuilder: (sessionId, eventId) =>
      buildTaskStatusChangedEvent({
        eventId,
        sessionId,
        taskId: input.taskId,
        from: previousStatus,
        to: input.newStatus,
        occurredAt: input.occurredAt,
      }),
  });

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
      eventId: adHoc.targetEventId,
      sessionId: adHoc.sessionId,
      phase: "overwrite",
      cause: error,
    });
  }
  return {
    taskId: input.taskId,
    eventId: adHoc.targetEventId,
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
      targetEventBuilder: (sessionId, eventId) =>
        buildTaskReconciledEvent({
          eventId,
          sessionId,
          taskId: input.taskId,
          removedCreatedInSession: brokenCreatedInSession,
          createdInSessionReplacement: brokenCreatedInSession !== null ? sessionId : null,
          removedLinkedSessions: brokenLinkedSessions,
          occurredAt: input.occurredAt,
        }),
    });
  } catch (error: unknown) {
    if (error instanceof FailedToFinalizeError) {
      throw new TaskWriteAfterEventError({
        taskId: input.taskId,
        eventId: error.targetEventId,
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

  const postSnapshot = await computeTaskMdSnapshot(paths, input.taskId);
  if (postSnapshot.mtimeMs !== preSnapshot.mtimeMs || postSnapshot.hash !== preSnapshot.hash) {
    throw new TaskWriteAfterEventError({
      taskId: input.taskId,
      eventId: adHoc.targetEventId,
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
      eventId: adHoc.targetEventId,
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
      eventId: adHoc.targetEventId,
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
