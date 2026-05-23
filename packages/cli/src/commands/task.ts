import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Event,
  type PrefixedId,
  type ReconcileFailure,
  type ReconcileResult,
  type RefreshLinkageResult,
  type SessionEntry,
  type SessionStatus,
  type TaskDocument,
  type TaskReconciledEvent,
  type TaskStatus,
  TaskStatusSchema,
  TaskWriteAfterEventError,
  archiveTask,
  assertBasouRootSafe,
  basouPaths,
  createTaskWithEvent,
  deleteTask,
  editTask,
  enumerateArchivedTaskIds,
  findErrorCode,
  loadSessionEntries,
  loadTaskEntries,
  prefixedUlid,
  readManifest,
  readTaskFile,
  readTaskFileWithArchiveFallback,
  reconcileAllTasks,
  reconcileTask,
  refreshTaskLinkedSessions,
  replayEvents,
  resolveRepositoryRoot,
  resolveSessionId,
  resolveTaskId,
  updateTaskStatusWithEvent,
} from "@basou/core";
import { type Command, InvalidArgumentError } from "commander";
import {
  type ErrorClassifier,
  failedToFinalizeClassifier,
  isVerbose,
  printReplayWarning,
  printTaskSkip,
  renderCliError,
  shortSessionId,
  shortTaskId,
} from "../lib/error-render.js";

const STATUS_VALUES = TaskStatusSchema.options;

// ============================================================================
// Public registration
// ============================================================================

export type TaskNewOptions = {
  title: string;
  label?: string;
  status?: TaskStatus;
  /**
   * ISO-8601 timestamp written into `task.md.updated_at` when status is a
   * terminal value (done / cancelled). Lets the operator backdate a
   * retroactively-recorded completed task so `task.md` reflects the
   * actual completion moment while `events.jsonl` keeps recording time.
   * Rejected (exit 1) when supplied with a non-terminal status.
   */
  completedAt?: string;
  session?: string;
  description?: string;
  fromFile?: string;
  json?: boolean;
  verbose?: boolean;
};

export type TaskListOptions = {
  status?: TaskStatus;
  includeArchived?: boolean;
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

export type TaskReconcileOptions = {
  task?: string;
  write?: boolean;
  json?: boolean;
  verbose?: boolean;
};

export type TaskRefreshLinkageOptions = {
  write?: boolean;
  json?: boolean;
  verbose?: boolean;
};

export type TaskEditOptions = {
  title?: string;
  status?: TaskStatus;
  json?: boolean;
  verbose?: boolean;
};

export type TaskDeleteOptions = {
  yes?: boolean;
  json?: boolean;
  verbose?: boolean;
};

export type TaskArchiveOptions = {
  yes?: boolean;
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
      `Initial status (one of: ${STATUS_VALUES.join(", ")}; default planned). For done/cancelled the orchestrator also emits a task_status_changed event so the audit trail records the implicit transition.`,
      parseInitialTaskStatus,
    )
    .option(
      "--completed-at <iso>",
      "ISO-8601 timestamp to record as the task's updated_at when --status is done or cancelled (rejected otherwise)",
      parseIsoTimestampOption,
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
    .option("--include-archived", "Also list tasks under .basou/tasks/archive/ (hidden by default)")
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

  task
    .command("reconcile")
    .description(
      "Dry-run audit of task session references; use --write to repair broken refs. Forward sync (events -> task.md linked_sessions) is out of scope.",
    )
    .option("--task <task_id>", "Limit to a single task (otherwise scan all)")
    .option("--write", "Apply repairs (default: dry-run)")
    .option("--json", "Output as JSON")
    .option("-v, --verbose", "Show error causes and broken session_id values")
    .action(async (options: TaskReconcileOptions) => {
      await runTaskReconcile(options);
    });

  task
    .command("refresh-linkage <task_id>")
    .description(
      "Re-derive task.md linked_sessions[] from session.yaml.task_id matches across the workspace (forward sync events -> task.md). Dry-run default; use --write to apply.",
    )
    .option("--write", "Apply the refresh (default: dry-run)")
    .option("--json", "Output as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (taskIdInput: string, options: TaskRefreshLinkageOptions) => {
      await runTaskRefreshLinkage(taskIdInput, options);
    });

  task
    .command("edit <task_id>")
    .description(
      "Update --title and/or --status on an existing task. Status changes fire a task_status_changed event; title changes update task.md only (no event).",
    )
    .option("--title <text>", "New title (must be non-empty)", parseTitle)
    .option(
      "--status <status>",
      `New status (one of: ${STATUS_VALUES.join(", ")}); routed through STATUS_TRANSITIONS so only valid edges are accepted`,
      parseInitialTaskStatus,
    )
    .option("--json", "Output as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (taskIdInput: string, options: TaskEditOptions) => {
      await runTaskEdit(taskIdInput, options);
    });

  task
    .command("delete <task_id>")
    .description(
      "Hard-delete a task.md file and fire a task_deleted event. Requires confirmation by default; use --yes to skip the prompt.",
    )
    .option("--yes", "Skip the confirmation prompt (required when stdin is not a TTY)")
    .option("--json", "Output as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (taskIdInput: string, options: TaskDeleteOptions) => {
      await runTaskDelete(taskIdInput, options);
    });

  task
    .command("archive <task_id>")
    .description(
      "Move task.md into .basou/tasks/archive/ and fire a task_archived event. Requires confirmation by default; use --yes to skip the prompt.",
    )
    .option("--yes", "Skip the confirmation prompt (required when stdin is not a TTY)")
    .option("--json", "Output as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (taskIdInput: string, options: TaskArchiveOptions) => {
      await runTaskArchive(taskIdInput, options);
    });
}

// ============================================================================
// task new
// ============================================================================

export async function runTaskNew(options: TaskNewOptions, ctx: TaskContext = {}): Promise<void> {
  try {
    await doRunTaskNew(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options), classifiers: TASK_CLASSIFIERS });
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

  const initialStatus = options.status ?? "planned";
  // `--completed-at` only makes sense paired with a terminal status. Catching
  // the mismatch up front avoids ambiguity about whether the override would
  // still be honored on a planned/in_progress task (= it wouldn't).
  if (options.completedAt !== undefined && !isTerminalStatusForCli(initialStatus)) {
    throw new Error("--completed-at requires --status done or cancelled");
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
      ...(options.completedAt !== undefined ? { completedAt: options.completedAt } : {}),
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
      occurredAt,
      ...(options.completedAt !== undefined ? { completedAt: options.completedAt } : {}),
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
    ...(options.completedAt !== undefined ? { completedAt: options.completedAt } : {}),
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
    occurredAt,
    ...(options.completedAt !== undefined ? { completedAt: options.completedAt } : {}),
    descriptionLength: description.length,
  });
}

function isTerminalStatusForCli(status: TaskStatus): boolean {
  return status === "done" || status === "cancelled";
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
  occurredAt: string;
  completedAt?: string;
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
        recorded_at: result.occurredAt,
        completed_at: result.completedAt ?? null,
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
  // For terminal initial statuses surface both the recording time (= the
  // ad-hoc session timestamp = now) and the supplied completion time so the
  // operator can tell at a glance that the audit trail (events.jsonl)
  // reflects the former while task.md.updated_at reflects the latter.
  if (result.completedAt !== undefined) {
    console.log(
      `  Status: ${result.status} (recorded at ${result.occurredAt}, completed at ${result.completedAt})`,
    );
  } else {
    console.log(`  Status: ${result.status}`);
  }
  console.log(`  Label:  ${result.label ?? "(none)"}`);
}

// ============================================================================
// task list
// ============================================================================

export async function runTaskList(options: TaskListOptions, ctx: TaskContext = {}): Promise<void> {
  try {
    await doRunTaskList(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options), classifiers: TASK_CLASSIFIERS });
    process.exitCode = 1;
  }
}

export async function doRunTaskList(options: TaskListOptions, ctx: TaskContext): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForTask(cwd, "list");
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  const entries = await loadTaskEntries(paths, {
    onSkip: (id, reason) => printTaskSkip(id, reason),
  });
  // Archive entries are read from `<paths.tasks>/archive/` directly (no
  // dedicated loader yet — call sites are rare). Marshalling them through a
  // separate scan keeps the default `task list` path fast (no extra readdir
  // when the operator does not opt in).
  const archivedEntries: { doc: TaskDocument; archived: true }[] = [];
  if (options.includeArchived === true) {
    const archivedIds = await enumerateArchivedTaskIds(paths);
    for (const id of archivedIds) {
      try {
        const { doc } = await readTaskFileWithArchiveFallback(paths, id);
        archivedEntries.push({ doc, archived: true });
      } catch {
        // Skip unreadable archive entries — keep the list output usable
        // when one file is corrupt rather than aborting the run.
      }
    }
  }
  const combined = [...entries, ...archivedEntries.map((a) => a.doc)];
  const archivedIdSet = new Set(archivedEntries.map((a) => a.doc.task.task.id));
  // loadTaskEntries returns asc by created_at; reverse for newest-first display.
  const ordered = [...combined].sort(
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
          archived: archivedIdSet.has(t.task.task.id),
        })),
        null,
        2,
      ),
    );
    return;
  }
  printTaskListText(filtered, archivedIdSet);
}

function printTaskListText(
  entries: ReadonlyArray<TaskDocument>,
  archivedIds: ReadonlySet<string>,
): void {
  const rows = entries.map((t) => ({
    sid: shortTaskId(t.task.task.id),
    status: t.task.task.status,
    createdAt: t.task.task.created_at,
    label: t.task.task.label ?? "(none)",
    // Mark archived entries with a leading [archived] tag so the operator
    // can distinguish them from live tasks when --include-archived is on.
    title: archivedIds.has(t.task.task.id) ? `[archived] ${t.task.task.title}` : t.task.task.title,
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
    renderCliError(error, { verbose: isVerbose(options), classifiers: TASK_CLASSIFIERS });
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

  const taskId = await resolveTaskId(paths, idInput, { includeArchived: true });
  const { doc, archived } = await readTaskFileWithArchiveFallback(paths, taskId);

  // Collect events related to this task by replaying every session's
  // events.jsonl and filtering by task_id. Could be optimised via an
  // index.json cache later; v0.1 accepts the linear scan.
  const sessions = await loadSessionEntries(paths, { now: new Date() });
  const events: Event[] = [];
  const linkedSessionIds = new Set<string>(doc.task.task.linked_sessions);
  // Replay warnings (malformed JSON / schema violations / partial trailing
  // lines) and unreadable events.jsonl files must reach the operator so
  // silent gaps in the events history don't go unnoticed.
  for (const s of sessions) {
    const sessionDir = join(paths.sessions, s.sessionId);
    try {
      for await (const ev of replayEvents(sessionDir, {
        onWarning: (w) => printReplayWarning(w, s.sessionId),
      })) {
        if (
          (ev.type === "task_created" ||
            ev.type === "task_status_changed" ||
            ev.type === "task_reconciled" ||
            ev.type === "task_linkage_refreshed" ||
            ev.type === "task_deleted" ||
            ev.type === "task_archived") &&
          ev.task_id === taskId
        ) {
          events.push(ev);
          linkedSessionIds.add(s.sessionId);
        }
      }
    } catch (error: unknown) {
      // I/O failure (events.jsonl unreadable). The renderer still works on
      // task.md metadata alone, but the operator must know events from this
      // session are missing from the aggregate.
      const short = shortSessionId(s.sessionId);
      const suffix = error instanceof Error ? `: ${error.message}` : "";
      console.error(`Warning: events unavailable for session ${short}${suffix}`);
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
          archived,
          events,
        },
        null,
        2,
      ),
    );
    return;
  }

  printTaskShowText(doc, [...linkedSessionIds], events, sessions, options, archived);
}

function printTaskShowText(
  doc: TaskDocument,
  linkedSessions: string[],
  events: ReadonlyArray<Event>,
  sessionEntries: ReadonlyArray<SessionEntry>,
  options: TaskShowOptions,
  archived: boolean,
): void {
  const t = doc.task.task;
  const archivedTag = archived ? " [archived]" : "";
  console.log(`Task: ${t.id}${archivedTag}`);
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
  const verbose = isVerbose(options);
  for (const ev of slice) {
    console.log(`  ${formatTaskEvent(ev)}`);
    if (verbose && ev.type === "task_reconciled") {
      for (const line of formatTaskReconciledDetails(ev)) {
        console.log(line);
      }
    }
  }
}

function formatTaskEvent(ev: Event): string {
  if (ev.type === "task_created") {
    return `${ev.occurred_at} [${ev.source}]  task_created             ${ev.title}`;
  }
  if (ev.type === "task_status_changed") {
    return `${ev.occurred_at} [${ev.source}]  task_status_changed      ${ev.from} -> ${ev.to}`;
  }
  if (ev.type === "task_reconciled") {
    const removedCount =
      (ev.removed_created_in_session !== null ? 1 : 0) + ev.removed_linked_sessions.length;
    return `${ev.occurred_at} [${ev.source}]  task_reconciled          ${removedCount} broken ref${removedCount === 1 ? "" : "s"} (use -v for details)`;
  }
  if (ev.type === "task_linkage_refreshed") {
    const added = ev.added_linked_sessions.length;
    const removed = ev.removed_linked_sessions.length;
    const finalPart = ev.final_count !== undefined ? `, final=${ev.final_count}` : "";
    return `${ev.occurred_at} [${ev.source}]  task_linkage_refreshed   +${added} / -${removed}${finalPart}`;
  }
  if (ev.type === "task_deleted") {
    return `${ev.occurred_at} [${ev.source}]  task_deleted             ${ev.title}`;
  }
  if (ev.type === "task_archived") {
    return `${ev.occurred_at} [${ev.source}]  task_archived            ${ev.title}`;
  }
  return `${ev.occurred_at} [${ev.source}]  ${ev.type}`;
}

function formatTaskReconciledDetails(ev: TaskReconciledEvent): string[] {
  const lines: string[] = [];
  if (ev.removed_created_in_session !== null) {
    lines.push(`      removed_created_in_session:    ${ev.removed_created_in_session}`);
  }
  if (ev.created_in_session_replacement !== null) {
    lines.push(`      created_in_session_replacement: ${ev.created_in_session_replacement}`);
  }
  if (ev.removed_linked_sessions.length > 0) {
    lines.push("      removed_linked_sessions:");
    for (const sid of ev.removed_linked_sessions) {
      lines.push(`        - ${sid}`);
    }
  }
  return lines;
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
    renderCliError(error, { verbose: isVerbose(options), classifiers: TASK_CLASSIFIERS });
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
// task reconcile
// ============================================================================

export async function runTaskReconcile(
  options: TaskReconcileOptions,
  ctx: TaskContext = {},
): Promise<void> {
  try {
    await doRunTaskReconcile(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options), classifiers: TASK_CLASSIFIERS });
    process.exitCode = 1;
  }
}

export async function doRunTaskReconcile(
  options: TaskReconcileOptions,
  ctx: TaskContext,
): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForTask(cwd, "reconcile");
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);
  const manifest = await readManifest(paths);
  const nowProvider = ctx.nowProvider ?? ((): Date => new Date());
  const write = options.write === true;
  const verbose = isVerbose(options);
  const json = options.json === true;

  if (options.task !== undefined) {
    const taskId = (await resolveTaskId(paths, options.task)) as PrefixedId<"task">;
    const result = await reconcileTask(paths, manifest, {
      taskId,
      occurredAt: nowProvider().toISOString(),
      workingDirectory: repositoryRoot,
      write,
      scope: "single",
    });
    if (json) {
      printReconcileJson({ dryRun: !write, scanned: 1, results: [result], failed: [] });
    } else {
      await printReconcileSingleText(result, paths, { write, verbose });
    }
    return;
  }

  const all = await reconcileAllTasks(paths, manifest, {
    occurredAt: () => nowProvider().toISOString(),
    workingDirectory: repositoryRoot,
    write,
  });
  if (json) {
    printReconcileJson({
      dryRun: !write,
      scanned: all.scanned,
      results: all.results,
      failed: all.failed,
    });
  } else {
    printReconcileAllText(all.results, all.failed, all.scanned, { write, verbose });
  }
  if (all.failed.length > 0) {
    process.exitCode = 1;
  }
}

function printReconcileJson(input: {
  dryRun: boolean;
  scanned: number;
  results: ReadonlyArray<ReconcileResult>;
  failed: ReadonlyArray<ReconcileFailure>;
}): void {
  console.log(
    JSON.stringify(
      {
        dry_run: input.dryRun,
        scanned: input.scanned,
        reconciled: input.results.map((r) => ({
          task_id: r.taskId,
          removed_created_in_session: r.brokenCreatedInSession,
          created_in_session_replacement:
            r.brokenCreatedInSession !== null && r.reconcileSession !== null
              ? r.reconcileSession.sessionId
              : null,
          removed_linked_sessions: r.brokenLinkedSessions,
          reconcile_session_id: r.reconcileSession?.sessionId ?? null,
          event_id: r.reconcileSession?.eventId ?? null,
        })),
        failed: input.failed.map((f) => ({
          task_id: f.taskId,
          error_class: f.errorClass,
          phase: f.phase,
        })),
      },
      null,
      2,
    ),
  );
}

async function printReconcileSingleText(
  result: ReconcileResult,
  paths: ReturnType<typeof basouPaths>,
  options: { write: boolean; verbose: boolean },
): Promise<void> {
  if (result.clean) {
    // For the --task path with no broken refs we report counts of reachable
    // references so the operator gets a positive audit confirmation rather
    // than a bare "ok". Re-read task.md cheaply; the core API already did
    // the integrity work so this is just for the display string.
    let createdCount = 0;
    let linkedCount = 0;
    try {
      const doc = await readTaskFile(paths, result.taskId);
      createdCount = 1;
      linkedCount = doc.task.task.linked_sessions.length;
    } catch {
      // If the file became unreadable between reconcileTask and here just
      // fall back to a less detailed message rather than crashing the run.
    }
    console.log(
      `${result.taskId}: no broken refs (${createdCount} created_in_session + ${linkedCount} linked_sessions, all reachable).`,
    );
    return;
  }
  if (options.write) {
    const sessionPart =
      result.reconcileSession !== null
        ? ` (in session ${shortSessionId(result.reconcileSession.sessionId)})`
        : "";
    console.log(`Reconciled ${result.taskId}: ${describeReconcileSummary(result)}${sessionPart}.`);
    return;
  }
  const summary = describeBrokenSummary(result, "task", options.verbose);
  console.log(`(dry-run) Would reconcile ${result.taskId}: ${summary}`);
  console.log("Note: events -> task.md forward sync is handled by `basou task refresh-linkage`.");
  console.log("Re-run with --write to apply.");
}

function printReconcileAllText(
  results: ReadonlyArray<ReconcileResult>,
  failed: ReadonlyArray<ReconcileFailure>,
  scanned: number,
  options: { write: boolean; verbose: boolean },
): void {
  if (results.length === 0 && failed.length === 0) {
    console.log(`Scanned ${scanned} tasks, no broken refs detected.`);
    return;
  }

  let totalBrokenRefs = 0;
  for (const r of results) {
    totalBrokenRefs += r.brokenLinkedSessions.length + (r.brokenCreatedInSession !== null ? 1 : 0);
  }

  if (options.write) {
    for (const r of results) {
      const sessionPart =
        r.reconcileSession !== null
          ? ` (in session ${shortSessionId(r.reconcileSession.sessionId)})`
          : "";
      console.log(`Reconciled ${r.taskId}: ${describeReconcileSummary(r)}${sessionPart}`);
    }
    for (const f of failed) {
      const phase = f.phase ?? "unknown";
      console.error(
        `Failed to reconcile ${f.taskId}: ${f.errorClass} (phase: ${phase}); see Caused by with -v`,
      );
    }
    const reconciledCount = results.length;
    const reconciledRefs = totalBrokenRefs;
    const reconciledPart = `reconciled ${reconciledCount} task${reconciledCount === 1 ? "" : "s"} (${reconciledRefs} broken ref${reconciledRefs === 1 ? "" : "s"})`;
    const failedPart =
      failed.length === 0 ? "" : `, ${failed.length} task${failed.length === 1 ? "" : "s"} failed`;
    console.log(`Scanned ${scanned} tasks, ${reconciledPart}${failedPart}.`);
    if (failed.length > 0) {
      console.error("(exit code 1)");
    }
    return;
  }

  // dry-run with broken refs
  for (const r of results) {
    const summary = describeBrokenSummary(r, "all", options.verbose);
    console.log(`(dry-run) Would reconcile ${r.taskId}: ${summary}`);
  }
  console.log(
    `Scanned ${scanned} tasks, would reconcile ${results.length} task${results.length === 1 ? "" : "s"} (${totalBrokenRefs} broken ref${totalBrokenRefs === 1 ? "" : "s"}).`,
  );
  console.log("Note: events -> task.md forward sync is handled by `basou task refresh-linkage`.");
  console.log("Re-run with --write to apply.");
}

function describeReconcileSummary(r: ReconcileResult): string {
  const linkedCount = r.brokenLinkedSessions.length;
  const parts: string[] = [];
  if (r.brokenCreatedInSession !== null) {
    parts.push("replaced created_in_session");
  }
  if (linkedCount > 0) {
    parts.push(`removed ${linkedCount} linked_sessions entr${linkedCount === 1 ? "y" : "ies"}`);
  }
  return parts.join(" + ");
}

function describeBrokenSummary(
  r: ReconcileResult,
  scope: "all" | "task",
  verbose: boolean,
): string {
  const showIds = scope === "task" || verbose;
  const parts: string[] = [];
  if (r.brokenCreatedInSession !== null) {
    parts.push(
      showIds
        ? `broken created_in_session ${formatSessionIdForDisplay(r.brokenCreatedInSession, verbose, scope)}`
        : "broken created_in_session",
    );
  }
  const linkedCount = r.brokenLinkedSessions.length;
  if (linkedCount > 0) {
    if (showIds) {
      const ids = r.brokenLinkedSessions
        .map((id) => formatSessionIdForDisplay(id, verbose, scope))
        .join(", ");
      parts.push(`${linkedCount} linked_sessions entr${linkedCount === 1 ? "y" : "ies"} [${ids}]`);
    } else {
      parts.push(`${linkedCount} linked_sessions entr${linkedCount === 1 ? "y" : "ies"}`);
    }
  }
  return parts.join(" + ");
}

function formatSessionIdForDisplay(id: string, verbose: boolean, scope: "all" | "task"): string {
  if (verbose && scope === "task") return id;
  return `ses_${shortSessionId(id)}`;
}

// ============================================================================
// task refresh-linkage
// ============================================================================

export async function runTaskRefreshLinkage(
  taskIdInput: string,
  options: TaskRefreshLinkageOptions,
  ctx: TaskContext = {},
): Promise<void> {
  try {
    await doRunTaskRefreshLinkage(taskIdInput, options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options), classifiers: TASK_CLASSIFIERS });
    process.exitCode = 1;
  }
}

export async function doRunTaskRefreshLinkage(
  taskIdInput: string,
  options: TaskRefreshLinkageOptions,
  ctx: TaskContext,
): Promise<void> {
  if (taskIdInput.trim().length === 0) {
    throw new Error("Task id is empty");
  }
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForTask(cwd, "refresh-linkage");
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);
  const manifest = await readManifest(paths);
  const taskId = (await resolveTaskId(paths, taskIdInput)) as PrefixedId<"task">;
  const nowProvider = ctx.nowProvider ?? ((): Date => new Date());
  const write = options.write === true;

  const result = await refreshTaskLinkedSessions(paths, manifest, {
    taskId,
    occurredAt: nowProvider().toISOString(),
    workingDirectory: repositoryRoot,
    write,
  });

  if (options.json === true) {
    printRefreshLinkageJson(result, { dryRun: !write });
    return;
  }
  printRefreshLinkageText(result, { dryRun: !write });
}

function printRefreshLinkageJson(result: RefreshLinkageResult, input: { dryRun: boolean }): void {
  console.log(
    JSON.stringify(
      {
        task_id: result.taskId,
        clean: result.clean,
        dry_run: input.dryRun,
        added_linked_sessions: result.addedLinkedSessions,
        removed_linked_sessions: result.removedLinkedSessions,
        final_count: result.finalCount,
        refresh_session_id: result.refreshSession?.sessionId ?? null,
        event_id: result.refreshSession?.eventId ?? null,
      },
      null,
      2,
    ),
  );
}

function printRefreshLinkageText(result: RefreshLinkageResult, input: { dryRun: boolean }): void {
  if (result.clean) {
    console.log(
      `${result.taskId}: linked_sessions already fresh (${result.finalCount} entr${result.finalCount === 1 ? "y" : "ies"}).`,
    );
    return;
  }
  const addedCount = result.addedLinkedSessions.length;
  const removedCount = result.removedLinkedSessions.length;
  const summaryParts: string[] = [];
  if (addedCount > 0) {
    summaryParts.push(`+${addedCount} added`);
  }
  if (removedCount > 0) {
    summaryParts.push(`-${removedCount} removed`);
  }
  const summary = summaryParts.join(", ");
  if (input.dryRun) {
    console.log(`(dry-run) Would refresh ${result.taskId} linked_sessions: ${summary}.`);
    console.log("Re-run with --write to apply.");
    return;
  }
  const sid =
    result.refreshSession !== null
      ? ` (in session ${shortSessionId(result.refreshSession.sessionId)})`
      : "";
  console.log(
    `Refreshed ${result.taskId} linked_sessions: ${summary}${sid}; final count ${result.finalCount}.`,
  );
}

// ============================================================================
// task edit / delete / archive
// ============================================================================

export async function runTaskEdit(
  taskIdInput: string,
  options: TaskEditOptions,
  ctx: TaskContext = {},
): Promise<void> {
  try {
    await doRunTaskEdit(taskIdInput, options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options), classifiers: TASK_CLASSIFIERS });
    process.exitCode = 1;
  }
}

export async function doRunTaskEdit(
  taskIdInput: string,
  options: TaskEditOptions,
  ctx: TaskContext,
): Promise<void> {
  if (taskIdInput.trim().length === 0) {
    throw new Error("Task id is empty");
  }
  if (options.title === undefined && options.status === undefined) {
    throw new Error("Nothing to edit: provide --title or --status");
  }
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForTask(cwd, "edit");
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);
  const manifest = await readManifest(paths);
  const taskId = (await resolveTaskId(paths, taskIdInput)) as PrefixedId<"task">;
  const now = ctx.nowProvider !== undefined ? ctx.nowProvider() : new Date();
  const occurredAt = now.toISOString();

  const result = await editTask({
    paths,
    taskId,
    occurredAt,
    manifest,
    workingDirectory: repositoryRoot,
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.status !== undefined ? { newStatus: options.status } : {}),
  });

  if (options.json === true) {
    console.log(
      JSON.stringify({
        task_id: result.taskId,
        title_updated: result.titleUpdated,
        status_updated: result.statusUpdated,
        previous_status: result.previousStatus,
        new_status: result.newStatus,
        status_change_session_id: result.statusChangeSession?.sessionId ?? null,
        status_change_event_id: result.statusChangeSession?.eventId ?? null,
      }),
    );
    return;
  }
  if (result.statusUpdated) {
    const sid =
      result.statusChangeSession !== null
        ? ` (in session ${shortSessionId(result.statusChangeSession.sessionId)})`
        : "";
    console.log(
      `Updated ${result.taskId} status: ${result.previousStatus} -> ${result.newStatus}${sid}`,
    );
  }
  if (result.titleUpdated) {
    console.log(`Updated ${result.taskId} title.`);
  }
  if (!result.statusUpdated && !result.titleUpdated) {
    // Both fields were supplied but matched the current values exactly —
    // tell the operator the task was already in the requested state.
    console.log(`No changes for ${result.taskId}.`);
  }
}

export async function runTaskDelete(
  taskIdInput: string,
  options: TaskDeleteOptions,
  ctx: TaskContext = {},
): Promise<void> {
  try {
    await doRunTaskDelete(taskIdInput, options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options), classifiers: TASK_CLASSIFIERS });
    process.exitCode = 1;
  }
}

export async function doRunTaskDelete(
  taskIdInput: string,
  options: TaskDeleteOptions,
  ctx: TaskContext,
): Promise<void> {
  if (taskIdInput.trim().length === 0) {
    throw new Error("Task id is empty");
  }
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForTask(cwd, "delete");
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);
  const manifest = await readManifest(paths);
  const taskId = (await resolveTaskId(paths, taskIdInput)) as PrefixedId<"task">;

  if (options.yes !== true) {
    await confirmDestructiveAction("delete", taskId);
  }

  const now = ctx.nowProvider !== undefined ? ctx.nowProvider() : new Date();
  const occurredAt = now.toISOString();
  const result = await deleteTask({
    paths,
    manifest,
    taskId,
    occurredAt,
    workingDirectory: repositoryRoot,
  });

  if (options.json === true) {
    console.log(
      JSON.stringify({
        task_id: result.taskId,
        title: result.title,
        session_id: result.sessionId,
        event_id: result.eventId,
      }),
    );
    return;
  }
  console.log(
    `Deleted ${result.taskId} ("${result.title}") in ad-hoc session ${shortSessionId(result.sessionId)}.`,
  );
}

export async function runTaskArchive(
  taskIdInput: string,
  options: TaskArchiveOptions,
  ctx: TaskContext = {},
): Promise<void> {
  try {
    await doRunTaskArchive(taskIdInput, options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options), classifiers: TASK_CLASSIFIERS });
    process.exitCode = 1;
  }
}

export async function doRunTaskArchive(
  taskIdInput: string,
  options: TaskArchiveOptions,
  ctx: TaskContext,
): Promise<void> {
  if (taskIdInput.trim().length === 0) {
    throw new Error("Task id is empty");
  }
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForTask(cwd, "archive");
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);
  const manifest = await readManifest(paths);
  const taskId = (await resolveTaskId(paths, taskIdInput)) as PrefixedId<"task">;

  if (options.yes !== true) {
    await confirmDestructiveAction("archive", taskId);
  }

  const now = ctx.nowProvider !== undefined ? ctx.nowProvider() : new Date();
  const occurredAt = now.toISOString();
  const result = await archiveTask({
    paths,
    manifest,
    taskId,
    occurredAt,
    workingDirectory: repositoryRoot,
  });

  if (options.json === true) {
    console.log(
      JSON.stringify({
        task_id: result.taskId,
        title: result.title,
        session_id: result.sessionId,
        event_id: result.eventId,
      }),
    );
    return;
  }
  console.log(
    `Archived ${result.taskId} ("${result.title}") in ad-hoc session ${shortSessionId(result.sessionId)}.`,
  );
}

/**
 * Read a single y/N answer from stdin when stdin is a TTY. Refuses to wait
 * for input when stdin is not a TTY (operator must pass --yes explicitly),
 * so piping `echo y | basou task delete` cannot accidentally trigger a
 * destructive action.
 */
async function confirmDestructiveAction(
  action: "delete" | "archive",
  taskId: string,
): Promise<void> {
  if (process.stdin.isTTY !== true) {
    throw new Error(`Refusing to ${action} without TTY; rerun with --yes to skip confirmation.`);
  }
  const verb = action === "delete" ? "Delete" : "Archive";
  process.stdout.write(`${verb} task \`${taskId}\`? [y/N] `);
  const answer = await readSingleLineFromStdin();
  const normalized = answer.trim().toLowerCase();
  if (normalized !== "y" && normalized !== "yes") {
    throw new Error(`${verb} aborted by user.`);
  }
}

async function readSingleLineFromStdin(): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const line = await rl.question("");
    return line;
  } finally {
    rl.close();
  }
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

function parseInitialTaskStatus(raw: string): TaskStatus {
  const result = TaskStatusSchema.safeParse(raw);
  if (!result.success) {
    throw new InvalidArgumentError(
      `Initial task status must be one of: ${STATUS_VALUES.join(", ")}`,
    );
  }
  return result.data;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseIsoTimestampOption(raw: string): string {
  // Mirror the IsoTimestampSchema accepted form: date + time + explicit
  // zone designator. We rely on Date.parse for content validation and the
  // regex above for shape so misformed inputs are rejected before we hand
  // the string to the orchestrator's downstream parsers.
  if (!ISO_DATE_RE.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new InvalidArgumentError(
      "Invalid --completed-at value; expected ISO-8601 timestamp like 2026-05-10T12:34:56+09:00",
    );
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
  subcmd:
    | "new"
    | "list"
    | "show"
    | "status"
    | "reconcile"
    | "refresh-linkage"
    | "edit"
    | "delete"
    | "archive",
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

/**
 * Task-specific classifier for {@link TaskWriteAfterEventError}. The
 * generic renderer ({@link renderCliError}) already prints the underlying
 * `error.message`; this classifier appends the two task-specific lines
 * that explain WHICH artefact is in unsafe state and the manual-repair
 * hint. Combined with {@link failedToFinalizeClassifier} from the shared
 * lib so both error classes are surfaced consistently across `task new`,
 * `task status`, `task reconcile`, etc.
 */
const taskWriteAfterEventClassifier: ErrorClassifier = {
  match: (error) => error instanceof TaskWriteAfterEventError,
  additionalLines: (error) => {
    const e = error as TaskWriteAfterEventError;
    const sid = shortSessionId(e.sessionId);
    const tid = shortTaskId(e.taskId);
    const unsafeArtefact = describeUnsafeArtefact(e.phase, tid, sid);
    const warning = describeWriteFailureWarning(e.phase);
    const hint =
      e.phase === "reconcile-concurrent"
        ? "re-run `basou task reconcile`"
        : e.phase === "linkage-refresh-concurrent"
          ? "re-run `basou task refresh-linkage`"
          : "manual repair required; see `basou task show -v` for event payload";
    return [
      `Recorded ${e.eventId} in session ${sid}; ${unsafeArtefact} is in unsafe state; do not rerun`,
      `Warning: ${warning}; events.jsonl is consistent; ${hint}`,
    ];
  },
};

const TASK_CLASSIFIERS: readonly ErrorClassifier[] = [
  taskWriteAfterEventClassifier,
  failedToFinalizeClassifier,
];

function describeUnsafeArtefact(
  phase: TaskWriteAfterEventError["phase"],
  tid: string,
  sid: string,
): string {
  switch (phase) {
    case "create":
      return `task ${tid} file`;
    case "overwrite":
      return `task ${tid} file`;
    case "link-session":
      return "session-task linkage";
    case "reconcile":
      return `task ${tid} file (reconcile incomplete)`;
    case "reconcile-finalize":
      return `reconcile session ${sid} (finalize incomplete)`;
    case "reconcile-concurrent":
      return `task ${tid} file (concurrent modification detected)`;
    case "linkage-refresh":
      return `task ${tid} file (linkage refresh incomplete)`;
    case "linkage-refresh-finalize":
      return `linkage refresh session ${sid} (finalize incomplete)`;
    case "linkage-refresh-concurrent":
      return `task ${tid} file (concurrent modification detected)`;
    case "delete":
      return `task ${tid} file (delete incomplete; file still on disk)`;
    case "archive":
      return `task ${tid} file (archive incomplete; check tasks/ and tasks/archive/)`;
  }
}

function describeWriteFailureWarning(phase: TaskWriteAfterEventError["phase"]): string {
  switch (phase) {
    case "create":
      return "task.md creation failed";
    case "overwrite":
      return "task.md update failed";
    case "link-session":
      return "session.yaml task_id update failed";
    case "reconcile":
      return "task.md reconciliation failed";
    case "reconcile-finalize":
      return "reconcile session finalize failed (session.yaml status update)";
    case "reconcile-concurrent":
      return "task.md was modified concurrently; re-run reconcile to retry";
    case "linkage-refresh":
      return "task.md linkage refresh write failed";
    case "linkage-refresh-finalize":
      return "linkage refresh session finalize failed (session.yaml status update)";
    case "linkage-refresh-concurrent":
      return "task.md was modified concurrently; re-run refresh-linkage to retry";
    case "delete":
      return "task.md unlink failed after task_deleted event committed";
    case "archive":
      return "task.md move to archive/ failed after task_archived event committed";
  }
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function maxLen(values: readonly string[], floor: number): number {
  let max = floor;
  for (const v of values) if (v.length > max) max = v.length;
  return max;
}
