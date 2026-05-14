import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Event,
  FailedToFinalizeError,
  type PrefixedId,
  type SessionEntry,
  type SessionStatus,
  type TaskDocument,
  type TaskStatus,
  TaskStatusSchema,
  TaskWriteAfterEventError,
  assertBasouRootSafe,
  basouPaths,
  createTaskWithEvent,
  findErrorCode,
  loadSessionEntries,
  loadTaskEntries,
  prefixedUlid,
  readManifest,
  readTaskFile,
  replayEvents,
  resolveRepositoryRoot,
  resolveSessionId,
  resolveTaskId,
  updateTaskStatusWithEvent,
} from "@basou/core";
import { type Command, InvalidArgumentError } from "commander";

const SES_PREFIX = "ses_";
const TASK_PREFIX = "task_";
const SHORT_ID_LEN = 6;
const CAUSE_CHAIN_MAX_DEPTH = 4;
const STATUS_VALUES = TaskStatusSchema.options;

// ============================================================================
// Public registration
// ============================================================================

export type TaskNewOptions = {
  title: string;
  label?: string;
  status?: "planned" | "in_progress";
  session?: string;
  description?: string;
  fromFile?: string;
  json?: boolean;
  verbose?: boolean;
};

export type TaskListOptions = {
  status?: TaskStatus;
  json?: boolean;
  verbose?: boolean;
};

export type TaskShowOptions = {
  json?: boolean;
  events?: boolean;
  last?: number;
  verbose?: boolean;
};

export type TaskStatusOptions = {
  session?: string;
  json?: boolean;
  verbose?: boolean;
};

export type TaskContext = {
  /** Defaults to `process.cwd()`. Injectable for tests. */
  cwd?: string;
  /** Defaults to `() => new Date()`. Injectable for tests. */
  nowProvider?: () => Date;
};

export function registerTaskCommand(program: Command): void {
  const task = program
    .command("task")
    .description("Manage Basou tasks (purpose units that span sessions)");

  task
    .command("new")
    .description("Create a new task and fire a task_created event")
    .requiredOption("--title <text>", "Task title", parseTitle)
    .option("--label <text>", "Optional label for the task", parseLabel)
    .option(
      "--status <status>",
      "Initial status (planned | in_progress, default planned)",
      parseInitialTaskStatus,
    )
    .option("--session <session_id>", "Attach to existing session; otherwise ad-hoc")
    .option("--description <text>", "Task description body (inline)", parseDescriptionOption)
    .option("--from-file <path>", "Read description body from a file")
    .option("--json", "Output as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (options: TaskNewOptions) => {
      await runTaskNew(options);
    });

  task
    .command("list")
    .description("List tasks in the current workspace (newest first)")
    .option(
      "--status <status>",
      `Filter by task status (one of: ${STATUS_VALUES.join(", ")})`,
      parseTaskStatusFilter,
    )
    .option("--json", "Output the list as a JSON array")
    .option("-v, --verbose", "Show error causes")
    .action(async (options: TaskListOptions) => {
      await runTaskList(options);
    });

  task
    .command("show <task_id>")
    .description("Show a task with its metadata, linked sessions, and events")
    .option("--json", "Output as JSON")
    .option("--events", "Show all related events instead of trailing few")
    .option("--last <n>", "Number of trailing events to display (default: 5)", parsePositiveInt)
    .option("-v, --verbose", "Show error causes")
    .action(async (id: string, options: TaskShowOptions) => {
      await runTaskShow(id, options);
    });

  task
    .command("status <task_id> <new_status>")
    .description("Change task status and fire a task_status_changed event")
    .option("--session <session_id>", "Attach to existing session; otherwise ad-hoc")
    .option("--json", "Output as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (taskIdInput: string, newStatusInput: string, options: TaskStatusOptions) => {
      await runTaskStatus(taskIdInput, newStatusInput, options);
    });
}

// ============================================================================
// task new
// ============================================================================

export async function runTaskNew(options: TaskNewOptions, ctx: TaskContext = {}): Promise<void> {
  try {
    await doRunTaskNew(options, ctx);
  } catch (error: unknown) {
    renderTaskError(error, isVerbose(options));
    process.exitCode = 1;
  }
}

export async function doRunTaskNew(options: TaskNewOptions, ctx: TaskContext): Promise<void> {
  if (options.description !== undefined && options.fromFile !== undefined) {
    throw new Error("--description and --from-file are mutually exclusive");
  }
  if (options.fromFile === "-") {
    throw new Error("--from-file - (stdin) is not supported in v0.1");
  }

  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForTask(cwd, "new");
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  const description =
    options.description !== undefined
      ? options.description
      : options.fromFile !== undefined
        ? await readDescriptionFile(options.fromFile)
        : "";

  const now = ctx.nowProvider !== undefined ? ctx.nowProvider() : new Date();
  const occurredAt = now.toISOString();
  const taskId = prefixedUlid("task");
  const initialStatus = options.status ?? "planned";

  if (options.session !== undefined) {
    const sessionId = (await resolveSessionId(paths, options.session)) as PrefixedId<"ses">;
    const result = await createTaskWithEvent({
      mode: "attach",
      paths,
      occurredAt,
      sessionId,
      taskId,
      title: options.title,
      ...(options.label !== undefined ? { label: options.label } : {}),
      initialStatus,
      description,
    });
    printTaskNewResult(options, {
      mode: "attached",
      taskId: result.taskId,
      eventId: result.eventId,
      sessionId: result.sessionId,
      sessionStatus: result.sessionStatus,
      title: options.title,
      ...(options.label !== undefined ? { label: options.label } : {}),
      status: initialStatus,
      descriptionLength: description.length,
    });
    return;
  }

  const manifest = await readManifest(paths);
  const result = await createTaskWithEvent({
    mode: "ad-hoc",
    paths,
    manifest,
    occurredAt,
    taskId,
    title: options.title,
    ...(options.label !== undefined ? { label: options.label } : {}),
    initialStatus,
    description,
    workingDirectory: repositoryRoot,
  });
  printTaskNewResult(options, {
    mode: "ad-hoc",
    taskId: result.taskId,
    eventId: result.eventId,
    sessionId: result.sessionId,
    sessionStatus: result.sessionStatus,
    title: options.title,
    ...(options.label !== undefined ? { label: options.label } : {}),
    status: initialStatus,
    descriptionLength: description.length,
  });
}

type TaskNewPrint = {
  mode: "ad-hoc" | "attached";
  taskId: string;
  eventId: string;
  sessionId: string;
  sessionStatus: SessionStatus;
  title: string;
  label?: string;
  status: TaskStatus;
  descriptionLength: number;
};

function printTaskNewResult(options: TaskNewOptions, result: TaskNewPrint): void {
  if (options.json === true) {
    console.log(
      JSON.stringify({
        task_id: result.taskId,
        event_id: result.eventId,
        session_id: result.sessionId,
        session_status: result.sessionStatus,
        mode: result.mode,
        title: result.title,
        label: result.label ?? null,
        status: result.status,
        description_length: result.descriptionLength,
      }),
    );
    return;
  }
  const shortSes = shortSessionId(result.sessionId);
  const created =
    result.mode === "ad-hoc"
      ? `Created ${result.taskId} in ad-hoc session ${shortSes}`
      : `Created ${result.taskId} in session ${shortSes} (${result.sessionStatus})`;
  console.log(created);
  console.log(`  Title:  ${result.title}`);
  console.log(`  Status: ${result.status}`);
  console.log(`  Label:  ${result.label ?? "(none)"}`);
}

// ============================================================================
// task list
// ============================================================================

export async function runTaskList(options: TaskListOptions, ctx: TaskContext = {}): Promise<void> {
  try {
    await doRunTaskList(options, ctx);
  } catch (error: unknown) {
    renderTaskError(error, isVerbose(options));
    process.exitCode = 1;
  }
}

export async function doRunTaskList(options: TaskListOptions, ctx: TaskContext): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForTask(cwd, "list");
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  const entries = await loadTaskEntries(paths, {
    onSkip: (id, reason) => printTaskListSkip(id, reason),
  });
  // loadTaskEntries returns asc by created_at; reverse for newest-first display.
  const ordered = [...entries].sort(
    (a, b) => Date.parse(b.task.task.created_at) - Date.parse(a.task.task.created_at),
  );
  const filtered =
    options.status !== undefined
      ? ordered.filter((t) => t.task.task.status === options.status)
      : ordered;

  if (filtered.length === 0) {
    if (options.json === true) {
      console.log("[]");
    } else {
      console.log("No tasks found.");
    }
    return;
  }

  if (options.json === true) {
    console.log(
      JSON.stringify(
        filtered.map((t) => ({
          task_id: t.task.task.id,
          title: t.task.task.title,
          label: t.task.task.label ?? null,
          status: t.task.task.status,
          created_at: t.task.task.created_at,
          updated_at: t.task.task.updated_at,
          linked_session_count: t.task.task.linked_sessions.length,
        })),
        null,
        2,
      ),
    );
    return;
  }
  printTaskListText(filtered);
}

function printTaskListText(entries: ReadonlyArray<TaskDocument>): void {
  const rows = entries.map((t) => ({
    sid: shortTaskId(t.task.task.id),
    status: t.task.task.status,
    createdAt: t.task.task.created_at,
    label: t.task.task.label ?? "(none)",
    title: t.task.task.title,
    linkedCount: String(t.task.task.linked_sessions.length),
  }));
  const widths = {
    sid: maxLen(
      rows.map((r) => r.sid),
      "SHORT_ID".length,
    ),
    status: maxLen(
      rows.map((r) => r.status),
      "STATUS".length,
    ),
    createdAt: maxLen(
      rows.map((r) => r.createdAt),
      "CREATED_AT".length,
    ),
    linkedCount: maxLen(
      rows.map((r) => r.linkedCount),
      "LINKS".length,
    ),
    label: maxLen(
      rows.map((r) => r.label),
      "LABEL".length,
    ),
  };
  console.log(
    `${pad("SHORT_ID", widths.sid)}  ${pad("STATUS", widths.status)}  ${pad("CREATED_AT", widths.createdAt)}  ${pad("LINKS", widths.linkedCount)}  ${pad("LABEL", widths.label)}  TITLE`,
  );
  for (const r of rows) {
    console.log(
      `${pad(r.sid, widths.sid)}  ${pad(r.status, widths.status)}  ${pad(r.createdAt, widths.createdAt)}  ${pad(r.linkedCount, widths.linkedCount)}  ${pad(r.label, widths.label)}  ${r.title}`,
    );
  }
}

function printTaskListSkip(taskId: string, reason: string): void {
  const sid = shortTaskId(taskId);
  console.error(`Skipped ${sid}: ${reason}`);
}

// ============================================================================
// task show
// ============================================================================

export async function runTaskShow(
  idInput: string,
  options: TaskShowOptions,
  ctx: TaskContext = {},
): Promise<void> {
  try {
    await doRunTaskShow(idInput, options, ctx);
  } catch (error: unknown) {
    renderTaskError(error, isVerbose(options));
    process.exitCode = 1;
  }
}

export async function doRunTaskShow(
  idInput: string,
  options: TaskShowOptions,
  ctx: TaskContext,
): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForTask(cwd, "show");
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  const taskId = await resolveTaskId(paths, idInput);
  const doc = await readTaskFile(paths, taskId);

  // Collect events related to this task by replaying every session's
  // events.jsonl and filtering by task_id. Could be optimised via index.json
  // in v0.2 (Step 17 申し送り #54), v0.1 accepts the linear scan.
  const sessions = await loadSessionEntries(paths, { now: new Date() });
  const events: Event[] = [];
  const linkedSessionIds = new Set<string>(doc.task.task.linked_sessions);
  for (const s of sessions) {
    const sessionDir = join(paths.sessions, s.sessionId);
    try {
      for await (const ev of replayEvents(sessionDir)) {
        if (
          (ev.type === "task_created" || ev.type === "task_status_changed") &&
          ev.task_id === taskId
        ) {
          events.push(ev);
          linkedSessionIds.add(s.sessionId);
        }
      }
    } catch {
      // Surface as a list skip on the session_yaml_unreadable channel later
      // if needed; for `task show` we silently drop unreadable events.jsonl
      // and continue so the task metadata still renders.
    }
  }
  events.sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));

  if (options.json === true) {
    console.log(
      JSON.stringify(
        {
          task: doc.task.task,
          body: doc.body,
          linked_sessions: [...linkedSessionIds],
          events,
        },
        null,
        2,
      ),
    );
    return;
  }

  printTaskShowText(doc, [...linkedSessionIds], events, sessions, options);
}

function printTaskShowText(
  doc: TaskDocument,
  linkedSessions: string[],
  events: ReadonlyArray<Event>,
  sessionEntries: ReadonlyArray<SessionEntry>,
  options: TaskShowOptions,
): void {
  const t = doc.task.task;
  console.log(`Task: ${t.id}`);
  console.log(`  Title:       ${t.title}`);
  console.log(`  Status:      ${t.status}`);
  console.log(`  Label:       ${t.label ?? "(none)"}`);
  console.log(`  Created at:  ${t.created_at}`);
  console.log(`  Updated at:  ${t.updated_at}`);
  console.log(`  Workspace:   ${t.workspace_id}`);
  console.log("");
  console.log(`Linked sessions (${linkedSessions.length}):`);
  const sessionStatusMap = new Map<string, string>(
    sessionEntries.map((s) => [s.sessionId, s.session.session.status]),
  );
  for (const sid of linkedSessions) {
    const status = sessionStatusMap.get(sid) ?? "unknown";
    console.log(`  ${sid}  (${status})`);
  }
  console.log("");
  console.log("Description:");
  if (doc.body.length === 0) {
    console.log("(no description)");
  } else {
    console.log(doc.body);
  }
  console.log("");
  console.log(`Events: ${events.length} total`);
  if (events.length === 0) return;
  const showAll = options.events === true && options.last === undefined;
  const last = options.last ?? 5;
  const slice = showAll ? events : events.slice(-last);
  const heading = showAll ? "All events:" : `Last ${slice.length} events:`;
  console.log("");
  console.log(heading);
  for (const ev of slice) {
    console.log(`  ${formatTaskEvent(ev)}`);
  }
}

function formatTaskEvent(ev: Event): string {
  if (ev.type === "task_created") {
    return `${ev.occurred_at} [${ev.source}]  task_created         ${ev.title}`;
  }
  if (ev.type === "task_status_changed") {
    return `${ev.occurred_at} [${ev.source}]  task_status_changed  ${ev.from} -> ${ev.to}`;
  }
  return `${ev.occurred_at} [${ev.source}]  ${ev.type}`;
}

// ============================================================================
// task status
// ============================================================================

export async function runTaskStatus(
  taskIdInput: string,
  newStatusInput: string,
  options: TaskStatusOptions,
  ctx: TaskContext = {},
): Promise<void> {
  try {
    await doRunTaskStatus(taskIdInput, newStatusInput, options, ctx);
  } catch (error: unknown) {
    renderTaskError(error, isVerbose(options));
    process.exitCode = 1;
  }
}

export async function doRunTaskStatus(
  taskIdInput: string,
  newStatusInput: string,
  options: TaskStatusOptions,
  ctx: TaskContext,
): Promise<void> {
  if (taskIdInput.trim().length === 0) {
    throw new Error("Task id is empty");
  }
  const newStatus = parseTaskStatusPositional(newStatusInput);

  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForTask(cwd, "status");
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  const taskId = (await resolveTaskId(paths, taskIdInput)) as PrefixedId<"task">;
  const now = ctx.nowProvider !== undefined ? ctx.nowProvider() : new Date();
  const occurredAt = now.toISOString();

  if (options.session !== undefined) {
    const sessionId = (await resolveSessionId(paths, options.session)) as PrefixedId<"ses">;
    const result = await updateTaskStatusWithEvent({
      mode: "attach",
      paths,
      occurredAt,
      sessionId,
      taskId,
      newStatus,
    });
    printTaskStatusResult(options, {
      mode: "attached",
      taskId: result.taskId,
      eventId: result.eventId,
      sessionId: result.sessionId,
      sessionStatus: result.sessionStatus,
      previousStatus: result.previousStatus,
      newStatus: result.newStatus,
    });
    return;
  }

  const manifest = await readManifest(paths);
  const result = await updateTaskStatusWithEvent({
    mode: "ad-hoc",
    paths,
    manifest,
    occurredAt,
    taskId,
    newStatus,
    workingDirectory: repositoryRoot,
  });
  printTaskStatusResult(options, {
    mode: "ad-hoc",
    taskId: result.taskId,
    eventId: result.eventId,
    sessionId: result.sessionId,
    sessionStatus: result.sessionStatus,
    previousStatus: result.previousStatus,
    newStatus: result.newStatus,
  });
}

type TaskStatusPrint = {
  mode: "ad-hoc" | "attached";
  taskId: string;
  eventId: string;
  sessionId: string;
  sessionStatus: SessionStatus;
  previousStatus: TaskStatus;
  newStatus: TaskStatus;
};

function printTaskStatusResult(options: TaskStatusOptions, result: TaskStatusPrint): void {
  if (options.json === true) {
    console.log(
      JSON.stringify({
        task_id: result.taskId,
        event_id: result.eventId,
        session_id: result.sessionId,
        session_status: result.sessionStatus,
        mode: result.mode,
        previous_status: result.previousStatus,
        new_status: result.newStatus,
      }),
    );
    return;
  }
  const sid = shortSessionId(result.sessionId);
  console.log(
    `Updated ${result.taskId} status: ${result.previousStatus} -> ${result.newStatus} (in session ${sid})`,
  );
}

// ============================================================================
// option converters
// ============================================================================

function parseTitle(raw: string): string {
  if (raw.length === 0) {
    throw new InvalidArgumentError("Title must not be empty");
  }
  return raw;
}

function parseLabel(raw: string): string {
  if (raw.length === 0) {
    throw new InvalidArgumentError("Label must not be empty");
  }
  return raw;
}

function parseInitialTaskStatus(raw: string): "planned" | "in_progress" {
  if (raw !== "planned" && raw !== "in_progress") {
    throw new InvalidArgumentError("Initial task status must be 'planned' or 'in_progress'");
  }
  return raw;
}

function parseTaskStatusFilter(raw: string): TaskStatus {
  const result = TaskStatusSchema.safeParse(raw);
  if (!result.success) {
    throw new InvalidArgumentError(
      `Invalid task status: ${raw}. Valid values: ${STATUS_VALUES.join(", ")}`,
    );
  }
  return result.data;
}

function parseTaskStatusPositional(raw: string): TaskStatus {
  const result = TaskStatusSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid task status: ${raw}. Valid values: ${STATUS_VALUES.join(", ")}`);
  }
  return result.data;
}

function parseDescriptionOption(raw: string): string {
  if (raw.length === 0) {
    throw new InvalidArgumentError("Description must not be empty");
  }
  return raw;
}

function parsePositiveInt(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || raw.trim() !== String(n)) {
    throw new InvalidArgumentError(`Invalid number: ${raw}`);
  }
  return n;
}

// ============================================================================
// IO helpers
// ============================================================================

async function readDescriptionFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) {
      throw new Error("Description source not found", { cause: error });
    }
    if (findErrorCode(error, "EISDIR")) {
      throw new Error("Description source is not a file", { cause: error });
    }
    throw new Error("Failed to read description source", { cause: error });
  }
}

async function resolveRepositoryRootForTask(
  cwd: string,
  subcmd: "new" | "list" | "show" | "status",
): Promise<string> {
  try {
    return await resolveRepositoryRoot(cwd);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Not a git repository") {
      throw new Error(
        `Not a git repository. Run 'git init' first, then re-run 'basou task ${subcmd}'.`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function assertWorkspaceInitialized(basouRoot: string): Promise<void> {
  try {
    await assertBasouRootSafe(basouRoot);
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) {
      throw new Error("Workspace not initialized. Run 'basou init' first.");
    }
    throw error;
  }
}

function isVerbose(options: { verbose?: boolean }): boolean {
  return options.verbose === true || process.env.BASOU_DEBUG === "1";
}

function renderTaskError(error: unknown, verbose: boolean): void {
  if (!(error instanceof Error)) {
    console.error(String(error));
    return;
  }
  console.error(error.message);

  if (error instanceof TaskWriteAfterEventError) {
    const sid = shortSessionId(error.sessionId);
    const tid = shortTaskId(error.taskId);
    console.error(
      `Recorded ${error.eventId} in session ${sid}; task ${tid} file is in unsafe state; do not rerun`,
    );
    const phaseLabel = error.phase === "create" ? "creation" : "update";
    console.error(
      `Warning: task.md ${phaseLabel} failed; events.jsonl is consistent; reconcile via v0.2 \`basou task reconcile\` (未実装)`,
    );
  }

  if (error instanceof FailedToFinalizeError) {
    const sid = shortSessionId(error.sessionId);
    console.error(`Recorded ${error.decisionEventId} in session ${sid}; do not rerun`);
    console.error("Warning: session.yaml status update failed; events.jsonl is consistent");
  }

  if (verbose) {
    const label = extractCauseLabel(error);
    if (label !== undefined) {
      console.error(`Caused by: ${label}`);
    }
  }
}

function extractCauseLabel(error: Error): string | undefined {
  let current: unknown = error.cause;
  let constructorName: string | undefined;
  for (let depth = 0; depth < CAUSE_CHAIN_MAX_DEPTH; depth += 1) {
    if (!(current instanceof Error)) break;
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "string") return code;
    constructorName = current.constructor.name;
    current = current.cause;
  }
  return constructorName;
}

function shortSessionId(id: string): string {
  if (id.startsWith(SES_PREFIX))
    return id.slice(SES_PREFIX.length, SES_PREFIX.length + SHORT_ID_LEN);
  return id.slice(0, SHORT_ID_LEN);
}

function shortTaskId(id: string): string {
  if (id.startsWith(TASK_PREFIX))
    return id.slice(TASK_PREFIX.length, TASK_PREFIX.length + SHORT_ID_LEN);
  return id.slice(0, SHORT_ID_LEN);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function maxLen(values: readonly string[], floor: number): number {
  let max = floor;
  for (const v of values) if (v.length > max) max = v.length;
  return max;
}
