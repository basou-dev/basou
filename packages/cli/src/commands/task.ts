import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Event,
  FailedToFinalizeError,
  type PrefixedId,
  type ReconcileFailure,
  type ReconcileResult,
  type ReplayWarning,
  type SessionEntry,
  type SessionStatus,
  type TaskDocument,
  type TaskReconciledEvent,
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
  reconcileAllTasks,
  reconcileTask,
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

export type TaskReconcileOptions = {
  task?: string;
  write?: boolean;
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
  // Codex Y3t-3-M2: replay warnings (malformed JSON / schema violations /
  // partial trailing lines) and unreadable events.jsonl files must reach
  // the operator so silent gaps in the events history don't go unnoticed.
  for (const s of sessions) {
    const sessionDir = join(paths.sessions, s.sessionId);
    try {
      for await (const ev of replayEvents(sessionDir, {
        onWarning: (w) => printReplayWarning(w, s.sessionId),
      })) {
        if (
          (ev.type === "task_created" ||
            ev.type === "task_status_changed" ||
            ev.type === "task_reconciled") &&
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
    return `${ev.occurred_at} [${ev.source}]  task_created         ${ev.title}`;
  }
  if (ev.type === "task_status_changed") {
    return `${ev.occurred_at} [${ev.source}]  task_status_changed  ${ev.from} -> ${ev.to}`;
  }
  if (ev.type === "task_reconciled") {
    const removedCount =
      (ev.removed_created_in_session !== null ? 1 : 0) + ev.removed_linked_sessions.length;
    return `${ev.occurred_at} [${ev.source}]  task_reconciled      ${removedCount} broken ref${removedCount === 1 ? "" : "s"} (use -v for details)`;
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
// task reconcile (Step 19)
// ============================================================================

export async function runTaskReconcile(
  options: TaskReconcileOptions,
  ctx: TaskContext = {},
): Promise<void> {
  try {
    await doRunTaskReconcile(options, ctx);
  } catch (error: unknown) {
    renderTaskError(error, isVerbose(options));
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
    });
    if (json) {
      printReconcileJson({ dryRun: !write, scanned: 1, results: [result], failed: [] });
    } else {
      printReconcileSingleText(result, paths, { write, verbose });
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
  console.log("Note: events -> task.md forward sync is out of scope; see Y-3z / Step 22.");
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
  console.log("Note: events -> task.md forward sync is out of scope; see Y-3z / Step 22.");
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
  return `${SES_PREFIX}${shortSessionId(id)}`;
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
  subcmd: "new" | "list" | "show" | "status" | "reconcile",
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
    const unsafeArtefact = describeUnsafeArtefact(error.phase, tid, sid);
    console.error(
      `Recorded ${error.eventId} in session ${sid}; ${unsafeArtefact} is in unsafe state; do not rerun`,
    );
    const warning = describeWriteFailureWarning(error.phase);
    const hint =
      error.phase === "reconcile-concurrent"
        ? "re-run `basou task reconcile`"
        : "manual repair required; see `basou task show -v` for event payload";
    console.error(`Warning: ${warning}; events.jsonl is consistent; ${hint}`);
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

function printReplayWarning(warning: ReplayWarning, sessionId: string): void {
  const short = shortSessionId(sessionId);
  switch (warning.kind) {
    case "partial_trailing_line":
      console.error(`Warning: ignored partial trailing line in ${short}/events.jsonl`);
      break;
    case "malformed_json":
      console.error(
        `Warning: skipped malformed JSON at line ${warning.line} in ${short}/events.jsonl`,
      );
      break;
    case "schema_violation":
      console.error(
        `Warning: skipped invalid event at line ${warning.line} in ${short}/events.jsonl`,
      );
      break;
  }
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
