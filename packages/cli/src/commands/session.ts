import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  type BasouPaths,
  type Event,
  type ReplayWarning,
  type Session,
  SessionSchema,
  type SessionStatus,
  SessionStatusSchema,
  assertBasouRootSafe,
  basouPaths,
  findErrorCode,
  readAllEvents,
  readYamlFile,
  replayEvents,
  resolveRepositoryRoot,
} from "@basou/core";
import type { Command } from "commander";

const SES_PREFIX = "ses_";
const SHORT_ID_BASE_LEN = 6;
const SHORT_ID_MAX_LEN = 26; // ULID body length
// 24h: long enough that an active long-running session will not be flagged,
// short enough that an abandoned process is surfaced within a working day.
// Tunable via CLI option in a future step (continuation backlog #12).
const STUCK_THRESHOLD_MS = 24 * 60 * 60 * 1000;

const STATUS_VALUES = SessionStatusSchema.options;

export type SessionListOptions = {
  json?: boolean;
  status?: SessionStatus;
  verbose?: boolean;
};

export type SessionShowOptions = {
  json?: boolean;
  events?: boolean;
  last?: number;
  fullPath?: boolean;
  verbose?: boolean;
};

export type SessionContext = {
  /** Defaults to `process.cwd()`. Injectable for tests. */
  cwd?: string;
};

type SessionListRecord = {
  sessionId: string;
  session: Session;
  suspect: boolean;
  suspectReason: string | null;
};

/**
 * Wire `basou session list` and `basou session show <id>` onto `program`.
 *
 * The `session` group is registered up front so future subcommands
 * (`note`, `import`) added in later steps slot under the same group without
 * changing the externally visible CLI surface.
 */
export function registerSessionCommand(program: Command): void {
  const session = program
    .command("session")
    .description("Inspect Basou sessions stored under .basou/sessions/");

  session
    .command("list")
    .description("List sessions in the current workspace (newest first)")
    .option("--json", "Output the list as a JSON array")
    .option(
      "--status <state>",
      `Filter by session status (one of: ${STATUS_VALUES.join(", ")})`,
      parseSessionStatus,
    )
    .option("-v, --verbose", "Show error causes")
    .action(async (options: SessionListOptions) => {
      await runSessionList(options);
    });

  session
    .command("show <id>")
    .description("Show a session's metadata and recent events")
    .option("--json", "Output the session and events as JSON")
    .option("--events", "List all events instead of just the trailing few")
    .option("--last <n>", "Number of trailing events to display (default: 5)", parsePositiveInt)
    .option(
      "--full-path",
      "Show working_directory as an absolute path instead of repository-relative",
    )
    .option("-v, --verbose", "Show error causes")
    .action(async (id: string, options: SessionShowOptions) => {
      await runSessionShow(id, options);
    });
}

/**
 * Programmatic entry for `basou session list` that owns process exit state.
 * Tests targeting only the success path or the thrown error should prefer
 * {@link doRunSessionList}.
 */
export async function runSessionList(
  options: SessionListOptions,
  ctx: SessionContext = {},
): Promise<void> {
  try {
    await doRunSessionList(options, ctx);
  } catch (error: unknown) {
    renderSessionError(error, isVerbose(options));
    process.exitCode = 1;
  }
}

/**
 * Pure runner for `session list`. Throws on any failure with a pathless
 * message; native errors are attached as `cause` for verbose surfacing.
 */
export async function doRunSessionList(
  options: SessionListOptions,
  ctx: SessionContext,
): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForSession(cwd, "list");
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  const entries = await enumerateSessionDirs(paths);
  if (entries === null) {
    printNoSessions(options);
    return;
  }

  const records: SessionListRecord[] = [];
  for (const sid of entries) {
    const rec = await readSessionListRecord(paths, sid);
    if (rec !== null) records.push(rec);
  }

  // started_at desc using Date.parse to normalize across timezone offsets;
  // a lexicographic compare would swap two timestamps that point at the same
  // instant when their offsets differ.
  records.sort(
    (a, b) => Date.parse(b.session.session.started_at) - Date.parse(a.session.session.started_at),
  );

  const filtered =
    options.status !== undefined
      ? records.filter((r) => r.session.session.status === options.status)
      : records;

  if (filtered.length === 0) {
    printNoSessions(options);
    return;
  }

  if (options.json === true) {
    console.log(
      JSON.stringify(
        filtered.map((r) => ({
          ...r.session.session,
          suspect: r.suspect,
          suspect_reason: r.suspectReason,
        })),
        null,
        2,
      ),
    );
  } else {
    printSessionListText(filtered);
  }
}

/**
 * Programmatic entry for `basou session show <id>`. See {@link runSessionList}
 * for the split pattern rationale.
 */
export async function runSessionShow(
  idInput: string,
  options: SessionShowOptions,
  ctx: SessionContext = {},
): Promise<void> {
  try {
    await doRunSessionShow(idInput, options, ctx);
  } catch (error: unknown) {
    renderSessionError(error, isVerbose(options));
    process.exitCode = 1;
  }
}

export async function doRunSessionShow(
  idInput: string,
  options: SessionShowOptions,
  ctx: SessionContext,
): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForSession(cwd, "show");
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  const sessionId = await resolveSessionId(paths, idInput);

  const sessionDir = join(paths.sessions, sessionId);
  const sessionYamlPath = join(sessionDir, "session.yaml");
  let session: Session;
  try {
    const raw = await readYamlFile(sessionYamlPath);
    session = SessionSchema.parse(raw);
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) {
      throw new Error(`Session not found: ${idInput}`);
    }
    throw new Error("Failed to read session", { cause: error });
  }

  const events = await readAllEvents(sessionDir, {
    onWarning: makeWarningHandler(sessionId),
  });

  if (options.json === true) {
    console.log(JSON.stringify({ session: session.session, events }, null, 2));
    return;
  }

  printSessionShowText(session, events, options, repositoryRoot);
}

async function enumerateSessionDirs(paths: BasouPaths): Promise<string[] | null> {
  try {
    const dirents = await readdir(paths.sessions, { withFileTypes: true });
    return dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) return null; // empty workspace, no sessions yet
    throw new Error("Failed to enumerate sessions", { cause: error });
  }
}

async function readSessionListRecord(
  paths: BasouPaths,
  sid: string,
): Promise<SessionListRecord | null> {
  const sessionYamlPath = join(paths.sessions, sid, "session.yaml");
  let raw: unknown;
  try {
    raw = await readYamlFile(sessionYamlPath);
  } catch (error: unknown) {
    console.error(`Skipped ${shortId(sid)}: ${describeReadError(error)}`);
    return null;
  }
  const parse = SessionSchema.safeParse(raw);
  if (!parse.success) {
    console.error(`Skipped ${shortId(sid)}: invalid session schema`);
    return null;
  }
  const session = parse.data;

  const { suspect, suspectReason } = await classifySuspect(paths, sid, session);
  return { sessionId: sid, session, suspect, suspectReason };
}

async function classifySuspect(
  paths: BasouPaths,
  sid: string,
  session: Session,
): Promise<{ suspect: boolean; suspectReason: string | null }> {
  if (session.session.status !== "running") {
    return { suspect: false, suspectReason: null };
  }
  const sessionDir = join(paths.sessions, sid);
  let endedFound = false;
  let lastEventOccurredAt: string | null = null;
  try {
    for await (const ev of replayEvents(sessionDir, {
      onWarning: makeWarningHandler(sid),
    })) {
      lastEventOccurredAt = ev.occurred_at;
      if (ev.type === "session_ended") endedFound = true;
    }
  } catch (_error: unknown) {
    // events.jsonl I/O failure is reported via the warning hook for replays
    // we initiated above; for the suspect check itself we fall through and
    // leave the session unflagged (callers can still see the status column).
    return { suspect: false, suspectReason: null };
  }
  if (endedFound) {
    return { suspect: true, suspectReason: "events_say_ended_but_yaml_running" };
  }
  if (lastEventOccurredAt !== null) {
    const ageMs = Date.now() - Date.parse(lastEventOccurredAt);
    if (Number.isFinite(ageMs) && ageMs > STUCK_THRESHOLD_MS) {
      return { suspect: true, suspectReason: "running_no_end_event" };
    }
  }
  return { suspect: false, suspectReason: null };
}

function suspectLabel(reason: string | null): string {
  if (reason === "events_say_ended_but_yaml_running") return " ⚠ ended (yaml stale)";
  if (reason === "running_no_end_event") return " ⚠ no end event";
  return "";
}

function printSessionListText(records: SessionListRecord[]): void {
  // Grow the SHORT_ID column to the first length where every prefix is
  // unique. Without this an ambiguous prefix would copy-paste from the list
  // and fail `resolveSessionId` with "Ambiguous session id".
  const shortLen = computeUniquePrefixLen(records.map((r) => r.sessionId));
  const rows = records.map((r) => {
    const sid = sliceShort(r.sessionId, shortLen);
    const status = `${r.session.session.status}${suspectLabel(r.suspectReason)}`;
    const source = r.session.session.source.kind;
    const startedAt = r.session.session.started_at;
    const fileCount = r.session.session.related_files.length;
    const filesSuffix = fileCount > 0 ? ` (${fileCount} files)` : "";
    const label = (r.session.session.label ?? "") + filesSuffix;
    return { sid, status, source, startedAt, label };
  });

  const widths = {
    sid: maxLen(
      rows.map((r) => r.sid),
      "SHORT_ID".length,
    ),
    status: maxLen(
      rows.map((r) => r.status),
      "STATUS".length,
    ),
    source: maxLen(
      rows.map((r) => r.source),
      "SOURCE".length,
    ),
    startedAt: maxLen(
      rows.map((r) => r.startedAt),
      "STARTED_AT".length,
    ),
  };

  console.log(
    `${pad("SHORT_ID", widths.sid)}  ${pad("STATUS", widths.status)}  ${pad("SOURCE", widths.source)}  ${pad("STARTED_AT", widths.startedAt)}  LABEL`,
  );
  for (const row of rows) {
    console.log(
      `${pad(row.sid, widths.sid)}  ${pad(row.status, widths.status)}  ${pad(row.source, widths.source)}  ${pad(row.startedAt, widths.startedAt)}  ${row.label}`,
    );
  }
}

function printSessionShowText(
  session: Session,
  events: Event[],
  options: SessionShowOptions,
  repositoryRoot: string,
): void {
  const s = session.session;
  console.log(`Session: ${s.id}  (status: ${s.status})`);
  console.log(`Source:        ${s.source.kind} (v${s.source.version})`);
  console.log(`Workspace:     ${s.workspace_id}`);
  console.log(`Started at:    ${s.started_at}`);
  if (s.ended_at !== undefined) {
    console.log(`Ended at:      ${s.ended_at}`);
  }
  console.log(`Working dir:   ${formatWorkingDir(s.working_directory, repositoryRoot, options)}`);
  const invocationArgs = s.invocation.args.length > 0 ? ` ${s.invocation.args.join(" ")}` : "";
  console.log(`Invocation:    ${s.invocation.command}${invocationArgs}`);
  if (s.invocation.exit_code !== null) {
    console.log(`Exit code:     ${s.invocation.exit_code}`);
  }
  if (s.label !== undefined) {
    console.log(`Label:         ${s.label}`);
  }
  console.log(`Related files: ${formatRelatedFiles(s.related_files)}`);

  console.log("");
  console.log(`Events: ${events.length} total`);
  const counts = countByType(events);
  for (const [type, n] of counts) {
    console.log(`  ${pad(`${type}:`, 24)} ${n}`);
  }

  if (events.length === 0) return;

  const last = options.last ?? 5;
  const showAll = options.events === true && options.last === undefined;
  const slice = showAll ? events : events.slice(-last);
  const heading = showAll ? "All events:" : `Last ${slice.length} events:`;
  console.log("");
  console.log(heading);
  for (const ev of slice) {
    console.log(`  ${formatEventLine(ev)}`);
  }
}

function formatWorkingDir(
  workingDir: string,
  repositoryRoot: string,
  options: SessionShowOptions,
): string {
  if (options.fullPath === true) return workingDir;
  if (workingDir === repositoryRoot) return "<repository_root>";
  const rel = relative(repositoryRoot, workingDir);
  if (rel.length === 0 || rel === ".") return "<repository_root>";
  // A relative path that starts with `..` means the working dir is outside
  // the repo; fall back to the absolute path so the operator can see what
  // was actually recorded rather than a misleading `../` traversal.
  if (rel.startsWith("..")) return workingDir;
  return `./${rel}`;
}

function formatRelatedFiles(files: readonly string[]): string {
  if (files.length === 0) return "0 paths";
  const head = files.slice(0, 3).join(", ");
  const remaining = files.length - 3;
  if (remaining <= 0) return `${files.length} paths (${head})`;
  return `${files.length} paths (${head}, ... +${remaining} more)`;
}

function countByType(events: readonly Event[]): Array<[string, number]> {
  const map = new Map<string, number>();
  for (const ev of events) {
    map.set(ev.type, (map.get(ev.type) ?? 0) + 1);
  }
  return [...map.entries()];
}

function formatEventLine(ev: Event): string {
  return `${ev.occurred_at} [${ev.source}]  ${ev.type}  ${eventVariantSummary(ev)}`;
}

function eventVariantSummary(ev: Event): string {
  switch (ev.type) {
    case "command_executed": {
      const argsPart = ev.args.length > 0 ? ` ${ev.args.join(" ")}` : "";
      const exitPart = ev.exit_code === null ? "exit=signal" : `exit=${ev.exit_code}`;
      return `${ev.command}${argsPart} (${exitPart}, ${ev.duration_ms}ms)`;
    }
    case "git_snapshot":
      return `branch=${ev.branch} dirty=${ev.dirty}`;
    case "file_changed":
      return `${ev.change_type} ${ev.path}`;
    case "session_status_changed":
      return `${ev.from} -> ${ev.to}`;
    case "session_started":
      return "(start)";
    case "session_ended":
      return ev.exit_code !== undefined ? `exit_code=${ev.exit_code}` : "(end)";
    case "approval_requested":
      return `${ev.action.kind} risk=${ev.risk_level}`;
    case "approval_approved":
      return ev.resolver !== undefined ? `by ${ev.resolver}` : "(approved)";
    case "approval_rejected":
      return ev.resolver !== undefined ? `by ${ev.resolver}: ${ev.reason}` : ev.reason;
    case "approval_expired":
      return `approval=${ev.approval_id}`;
    case "decision_recorded":
      return ev.title;
    case "task_created":
      return ev.title;
    case "task_status_changed":
      return `${ev.from} -> ${ev.to}`;
    case "note_added":
      return ev.body.length > 80 ? `${ev.body.slice(0, 77)}...` : ev.body;
    case "adapter_output":
      return `${ev.stream} "${ev.summary}" raw_ref=${ev.raw_ref}`;
  }
}

async function resolveSessionId(paths: BasouPaths, input: string): Promise<string> {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("Session id is empty");
  }
  const normalized = trimmed.startsWith(SES_PREFIX) ? trimmed : `${SES_PREFIX}${trimmed}`;

  let entries: string[];
  try {
    const dirents = await readdir(paths.sessions, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) {
      throw new Error(`Session not found: ${input}`);
    }
    throw new Error("Failed to enumerate sessions", { cause: error });
  }

  const matches = entries.filter((e) => e.startsWith(normalized));
  if (matches.length === 0) {
    throw new Error(`Session not found: ${input}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous session id '${input}': matched ${matches.length} sessions. Disambiguate with a longer prefix.`,
    );
  }
  return matches[0] as string;
}

function makeWarningHandler(sid: string): (warning: ReplayWarning) => void {
  const short = shortId(sid);
  return (warning) => {
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
  };
}

function shortId(id: string): string {
  return sliceShort(id, SHORT_ID_BASE_LEN);
}

function sliceShort(id: string, len: number): string {
  if (id.startsWith(SES_PREFIX)) {
    return id.slice(SES_PREFIX.length, SES_PREFIX.length + len);
  }
  return id.slice(0, len);
}

/**
 * Find the smallest length where every short_id derived from `sessionIds`
 * is unique. Starts at {@link SHORT_ID_BASE_LEN} and grows by 2 chars at a
 * time (mirroring git's automatic abbreviation behaviour). Caps at the full
 * ULID body length so a pathological collision still terminates.
 */
function computeUniquePrefixLen(sessionIds: readonly string[]): number {
  if (sessionIds.length <= 1) return SHORT_ID_BASE_LEN;
  for (let len = SHORT_ID_BASE_LEN; len <= SHORT_ID_MAX_LEN; len += 2) {
    const seen = new Set<string>();
    let collided = false;
    for (const sid of sessionIds) {
      const key = sliceShort(sid, len);
      if (seen.has(key)) {
        collided = true;
        break;
      }
      seen.add(key);
    }
    if (!collided) return len;
  }
  return SHORT_ID_MAX_LEN;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function maxLen(values: readonly string[], floor: number): number {
  let max = floor;
  for (const v of values) if (v.length > max) max = v.length;
  return max;
}

async function resolveRepositoryRootForSession(
  cwd: string,
  subcmd: "list" | "show",
): Promise<string> {
  try {
    return await resolveRepositoryRoot(cwd);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Not a git repository") {
      throw new Error(
        `Not a git repository. Run 'git init' first, then re-run 'basou session ${subcmd}'.`,
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

function renderSessionError(error: unknown, verbose: boolean): void {
  if (!(error instanceof Error)) {
    console.error(String(error));
    return;
  }
  console.error(error.message);
  if (verbose && error.cause instanceof Error) {
    const code = (error.cause as Error & { code?: unknown }).code;
    const label = typeof code === "string" ? code : error.cause.constructor.name;
    console.error(`Caused by: ${label}`);
  }
}

function describeReadError(error: unknown): string {
  if (error instanceof Error) {
    if (error.message === "YAML file not found") return "session.yaml not found";
    if (error.message === "Failed to parse YAML content") return "invalid YAML";
    return error.message;
  }
  return String(error);
}

function parsePositiveInt(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || raw.trim() !== String(n)) {
    throw new Error(`Invalid number: ${raw}`);
  }
  return n;
}

function parseSessionStatus(raw: string): SessionStatus {
  const result = SessionStatusSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid session status: ${raw}. Valid values: ${STATUS_VALUES.join(", ")}`);
  }
  return result.data;
}

function printNoSessions(options: SessionListOptions): void {
  if (options.json === true) {
    console.log("[]");
  } else {
    console.log("No sessions found.");
  }
}
