import { unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  type Approval,
  type ApprovalLocation,
  ApprovalSchema,
  type ApprovalStatus,
  ApprovalStatusSchema,
  type BasouPaths,
  type Event,
  type ReplayWarning,
  appendEvent,
  assertBasouRootSafe,
  basouPaths,
  enumerateApprovals,
  findErrorCode,
  isLazyExpired,
  linkYamlFile,
  loadApproval,
  prefixedUlid,
  readYamlFile,
  replayEvents,
  resolveRepositoryRoot,
} from "@basou/core";
import type { Command } from "commander";

const APPR_PREFIX = "appr_";
const SHORT_ID_BASE_LEN = 6;
const SHORT_ID_MAX_LEN = 26; // ULID body length
const ACTION_KEY_DETAIL_MAX_LEN = 60;
const REASON_TEXT_MAX_LEN = 80;

const STATUS_VALUES = ApprovalStatusSchema.options;

export type ApprovalListOptions = {
  json?: boolean;
  status?: ApprovalStatus;
  verbose?: boolean;
};

export type ApprovalShowOptions = {
  json?: boolean;
  verbose?: boolean;
};

export type ApprovalApproveOptions = {
  note?: string;
  verbose?: boolean;
};

export type ApprovalRejectOptions = {
  reason: string;
  verbose?: boolean;
};

export type ApprovalContext = {
  /** Defaults to `process.cwd()`. Injectable for tests. */
  cwd?: string;
};

type ApprovalListRecord = {
  approval: Approval;
  location: ApprovalLocation;
  lazyExpired: boolean;
};

/**
 * Wire `basou approval list / show / approve / reject` onto `program`.
 *
 * The `approval` group is registered up front so future subcommands
 * (`cancel`, `recover`) added in later steps slot under the same group
 * without changing the externally visible CLI surface.
 */
export function registerApprovalCommand(program: Command): void {
  const approval = program
    .command("approval")
    .description("Manage Basou approval requests under .basou/approvals/");

  approval
    .command("list")
    .description("List approvals across pending and resolved (newest first)")
    .option("--json", "Output the list as a JSON array")
    .option(
      "--status <state>",
      `Filter by approval status (one of: ${STATUS_VALUES.join(", ")})`,
      parseApprovalStatus,
    )
    .option("-v, --verbose", "Show error causes")
    .action(async (options: ApprovalListOptions) => {
      await runApprovalList(options);
    });

  approval
    .command("show <id>")
    .description("Show an approval's metadata and related events")
    .option("--json", "Output the approval and events as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (id: string, options: ApprovalShowOptions) => {
      await runApprovalShow(id, options);
    });

  approval
    .command("approve <id>")
    .description("Approve a pending approval")
    .option("--note <text>", "Optional note to attach to the approval_approved event")
    .option("-v, --verbose", "Show error causes")
    .action(async (id: string, options: ApprovalApproveOptions) => {
      await runApprovalApprove(id, options);
    });

  approval
    .command("reject <id>")
    .description("Reject a pending approval")
    .requiredOption("--reason <text>", "Reason for rejection (required)")
    .option("-v, --verbose", "Show error causes")
    .action(async (id: string, options: ApprovalRejectOptions) => {
      await runApprovalReject(id, options);
    });
}

// === list ===

/**
 * Programmatic entry for `basou approval list` that owns process exit
 * state. Tests targeting only the success path or the thrown error should
 * prefer {@link doRunApprovalList}.
 */
export async function runApprovalList(
  options: ApprovalListOptions,
  ctx: ApprovalContext = {},
): Promise<void> {
  try {
    await doRunApprovalList(options, ctx);
  } catch (error: unknown) {
    renderApprovalError(error, isVerbose(options));
    process.exitCode = 1;
  }
}

/**
 * Pure runner for `approval list`. Throws on any failure with a pathless
 * message; native errors are attached as `cause` for verbose surfacing.
 */
export async function doRunApprovalList(
  options: ApprovalListOptions,
  ctx: ApprovalContext,
): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForApproval(cwd, "list");
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  const ids = await enumerateApprovals(paths);
  // A single `now` shared across every record so that two reads on the
  // same boundary instant cannot disagree (e.g. one record flagged expired
  // and another not when both straddle the same `expires_at`).
  const now = new Date();
  const records: ApprovalListRecord[] = [];

  // Resolve dedupe set: id appearing in both directories → prefer resolved
  // and surface a stderr warning about the stale pending entry.
  const resolvedSet = new Set(ids.resolved);
  for (const id of ids.pending) {
    if (resolvedSet.has(id)) {
      console.error(`Warning: stale pending entry for ${shortId(id)}; resolved version preferred`);
      continue;
    }
    const rec = await readApprovalListRecord(paths, id, "pending", now);
    if (rec !== null) records.push(rec);
  }
  for (const id of ids.resolved) {
    const rec = await readApprovalListRecord(paths, id, "resolved", now);
    if (rec !== null) records.push(rec);
  }

  records.sort((a, b) => Date.parse(b.approval.created_at) - Date.parse(a.approval.created_at));

  const filtered =
    options.status !== undefined
      ? records.filter((r) => r.approval.status === options.status)
      : records;

  if (filtered.length === 0) {
    printNoApprovals(options);
    return;
  }

  if (options.json === true) {
    console.log(
      JSON.stringify(
        filtered.map((r) => ({ ...r.approval, lazy_expired: r.lazyExpired })),
        null,
        2,
      ),
    );
  } else {
    printApprovalListText(filtered);
  }
}

async function readApprovalListRecord(
  paths: BasouPaths,
  id: string,
  location: ApprovalLocation,
  now: Date,
): Promise<ApprovalListRecord | null> {
  const filePath = join(paths.approvals[location], `${id}.yaml`);
  let raw: unknown;
  try {
    raw = await readYamlFile(filePath);
  } catch (error: unknown) {
    console.error(`Skipped ${shortId(id)}: ${describeReadError(error)}`);
    return null;
  }
  const parse = ApprovalSchema.safeParse(raw);
  if (!parse.success) {
    console.error(`Skipped ${shortId(id)}: invalid approval schema`);
    return null;
  }
  const approval = parse.data;
  return { approval, location, lazyExpired: isLazyExpired(approval, now) };
}

// === show ===

export async function runApprovalShow(
  idInput: string,
  options: ApprovalShowOptions,
  ctx: ApprovalContext = {},
): Promise<void> {
  try {
    await doRunApprovalShow(idInput, options, ctx);
  } catch (error: unknown) {
    renderApprovalError(error, isVerbose(options));
    process.exitCode = 1;
  }
}

export async function doRunApprovalShow(
  idInput: string,
  options: ApprovalShowOptions,
  ctx: ApprovalContext,
): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForApproval(cwd, "show");
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  const { id } = await resolveApprovalId(paths, idInput);
  const loaded = await loadApproval(paths, id);
  if (loaded === null) {
    throw new Error(`Approval not found: ${idInput}`);
  }

  // events.jsonl I/O failure throws "Failed to read events.jsonl" and is
  // converted to exit 1 by the wrapping try/catch — partial / malformed /
  // schema warnings stream through onWarning.
  const sessionDir = join(paths.sessions, loaded.approval.session_id);
  const relatedEvents: Event[] = [];
  for await (const ev of replayEvents(sessionDir, {
    onWarning: makeWarningHandler(loaded.approval.session_id),
  })) {
    if (isApprovalEvent(ev) && ev.approval_id === id) {
      relatedEvents.push(ev);
    }
  }

  const now = new Date();
  const lazyExpired = isLazyExpired(loaded.approval, now);

  if (options.json === true) {
    console.log(
      JSON.stringify(
        {
          approval: { ...loaded.approval, lazy_expired: lazyExpired },
          events: relatedEvents,
        },
        null,
        2,
      ),
    );
    return;
  }

  printApprovalShowText(loaded.approval, loaded.location, relatedEvents, lazyExpired);
}

// === approve / reject ===

export async function runApprovalApprove(
  idInput: string,
  options: ApprovalApproveOptions,
  ctx: ApprovalContext = {},
): Promise<void> {
  try {
    await doRunApprovalResolve(idInput, options, ctx, "approve");
  } catch (error: unknown) {
    renderApprovalError(error, isVerbose(options));
    process.exitCode = 1;
  }
}

export async function runApprovalReject(
  idInput: string,
  options: ApprovalRejectOptions,
  ctx: ApprovalContext = {},
): Promise<void> {
  try {
    await doRunApprovalResolve(idInput, options, ctx, "reject");
  } catch (error: unknown) {
    renderApprovalError(error, isVerbose(options));
    process.exitCode = 1;
  }
}

async function doRunApprovalResolve(
  idInput: string,
  options: ApprovalApproveOptions | ApprovalRejectOptions,
  ctx: ApprovalContext,
  decision: "approve" | "reject",
): Promise<void> {
  if (decision === "reject") {
    const reason = (options as ApprovalRejectOptions).reason;
    if (reason.length === 0) {
      throw new Error("--reason must not be empty");
    }
  }

  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForApproval(cwd, decision);
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  // Step D-2: resolve id (search both directories).
  const { id, location } = await resolveApprovalId(paths, idInput);

  // Step D-3: a resolved-side hit means there is nothing left to decide.
  if (location === "resolved") {
    throw new Error(`Approval already resolved: ${idInput}`);
  }

  // Step D-4: read + parse the pending YAML.
  const pendingPath = join(paths.approvals.pending, `${id}.yaml`);
  let pendingRaw: unknown;
  try {
    pendingRaw = await readYamlFile(pendingPath);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "YAML file not found") {
      throw new Error(`Approval not found: ${idInput}`);
    }
    throw new Error("Failed to read approval", { cause: error });
  }
  const approval = ApprovalSchema.parse(pendingRaw);

  // Step D-5: events.jsonl fence — if a resolution event already exists
  // for this approval, refuse to fire a second one. This guards the
  // crash-mid-orchestration window where step 8 succeeded but step 10
  // failed (events.jsonl is the source-of-truth, not the YAML mirror).
  const sessionDir = join(paths.sessions, approval.session_id);
  for await (const ev of replayEvents(sessionDir, {
    onWarning: makeWarningHandler(approval.session_id),
  })) {
    if (
      isApprovalEvent(ev) &&
      ev.approval_id === approval.id &&
      (ev.type === "approval_approved" ||
        ev.type === "approval_rejected" ||
        ev.type === "approval_expired")
    ) {
      throw new Error(`Approval already resolved (per events.jsonl): ${idInput}`);
    }
  }

  // Step D-6: lazy expire state-fence. No event is fired here; the
  // approval_expired event is reserved for a later step that owns
  // expiry-side orchestration.
  const now = new Date();
  if (isLazyExpired(approval, now)) {
    throw new Error(`Approval already expired: ${idInput}`);
  }

  // Step D-7: prepare event id + occurred_at (shared with step 9 below).
  const occurredAt = now.toISOString();
  const eventId = prefixedUlid("evt");

  // Step D-8: append the resolution event to events.jsonl. After this
  // point the trail is committed; subsequent failures must not roll back
  // the event because that would break the source-of-truth invariant.
  if (decision === "approve") {
    const note = (options as ApprovalApproveOptions).note ?? null;
    await appendEvent(sessionDir, {
      schema_version: "0.1.0",
      id: eventId,
      session_id: approval.session_id,
      occurred_at: occurredAt,
      source: "local-cli",
      type: "approval_approved",
      approval_id: approval.id,
      resolver: "local-cli",
      note,
    });
  } else {
    const reason = (options as ApprovalRejectOptions).reason;
    await appendEvent(sessionDir, {
      schema_version: "0.1.0",
      id: eventId,
      session_id: approval.session_id,
      occurred_at: occurredAt,
      source: "local-cli",
      type: "approval_rejected",
      approval_id: approval.id,
      resolver: "local-cli",
      reason,
    });
  }

  // Step D-9: build the resolved-side YAML body in memory.
  const resolvedApproval: Approval =
    decision === "approve"
      ? {
          ...approval,
          status: "approved",
          resolver: "local-cli",
          resolved_at: occurredAt,
          note: (options as ApprovalApproveOptions).note ?? null,
        }
      : {
          ...approval,
          status: "rejected",
          resolver: "local-cli",
          resolved_at: occurredAt,
          rejection_reason: (options as ApprovalRejectOptions).reason,
        };

  // Step D-10: create-only write. linkYamlFile fails fast with EEXIST if a
  // concurrent resolver already populated the resolved-side YAML — the
  // events.jsonl fence above should have caught it first, so reaching
  // EEXIST here implies a near-simultaneous race we surface explicitly.
  const resolvedPath = join(paths.approvals.resolved, `${id}.yaml`);
  try {
    await linkYamlFile(resolvedPath, resolvedApproval);
  } catch (error: unknown) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause instanceof Error && (cause as Error & { code?: unknown }).code === "EEXIST") {
      throw new Error("Approval already resolved at the same time", { cause });
    }
    throw error;
  }

  // Step D-11: best-effort unlink of the pending YAML. The trail and the
  // resolved-side YAML are already consistent at this point; a leftover
  // pending entry is reconciled by the next `approval list`'s dedupe.
  try {
    await unlink(pendingPath);
  } catch {
    console.error(
      `Warning: failed to unlink pending entry for ${shortId(id)}; events.jsonl is consistent`,
    );
  }

  // Step D-12: success message.
  const verb = decision === "approve" ? "Approved" : "Rejected";
  console.log(`${verb} approval ${shortId(id)}`);
}

// === helpers ===

async function resolveApprovalId(
  paths: BasouPaths,
  input: string,
): Promise<{ id: string; location: ApprovalLocation }> {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("Approval id is empty");
  }
  const normalized = trimmed.startsWith(APPR_PREFIX) ? trimmed : `${APPR_PREFIX}${trimmed}`;
  // Reject prefix-only input so a bare prefix cannot match an arbitrary
  // approval via `startsWith`.
  if (normalized.length <= APPR_PREFIX.length) {
    throw new Error(`Approval not found: ${input}`);
  }

  const enumeration = await enumerateApprovals(paths);

  // Aggregate by full id so a duplicate (same id in both pending and
  // resolved) collapses to one entry with location=resolved (preferred).
  const byId = new Map<string, ApprovalLocation>();
  for (const id of enumeration.pending) {
    if (id.startsWith(normalized)) byId.set(id, "pending");
  }
  for (const id of enumeration.resolved) {
    if (!id.startsWith(normalized)) continue;
    if (byId.get(id) === "pending") {
      // Same full id present on both sides: resolved wins, surface a warning.
      console.error(`Warning: stale pending entry for ${shortId(id)}; resolved version preferred`);
    }
    byId.set(id, "resolved");
  }

  if (byId.size === 0) {
    throw new Error(`Approval not found: ${input}`);
  }
  if (byId.size > 1) {
    throw new Error(
      `Ambiguous approval id '${input}': matched ${byId.size} approvals. Disambiguate with a longer prefix.`,
    );
  }
  const first = byId.entries().next().value;
  if (first === undefined) {
    throw new Error(`Approval not found: ${input}`);
  }
  const [id, location] = first;
  return { id, location };
}

function isApprovalEvent(ev: Event): ev is Event & { approval_id: string } {
  return (
    ev.type === "approval_requested" ||
    ev.type === "approval_approved" ||
    ev.type === "approval_rejected" ||
    ev.type === "approval_expired"
  );
}

function printApprovalListText(records: ApprovalListRecord[]): void {
  // Grow the SHORT_ID column on collision. The dedupe in doRunApprovalList
  // already collapsed duplicates by full id, so feeding only the unique
  // ids here is correct.
  const allIds = records.map((r) => r.approval.id);
  const shortLen = computeUniquePrefixLen(allIds);
  const rows = records.map((r) => {
    const sid = sliceShort(r.approval.id, shortLen);
    const status = r.lazyExpired ? `${r.approval.status} (expired)` : r.approval.status;
    const risk = r.approval.risk_level;
    const action = r.approval.action.kind;
    const createdAt = r.approval.created_at;
    const reason = truncate(r.approval.reason, REASON_TEXT_MAX_LEN);
    return { sid, status, risk, action, createdAt, reason };
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
    risk: maxLen(
      rows.map((r) => r.risk),
      "RISK".length,
    ),
    action: maxLen(
      rows.map((r) => r.action),
      "ACTION".length,
    ),
    createdAt: maxLen(
      rows.map((r) => r.createdAt),
      "CREATED_AT".length,
    ),
  };

  console.log(
    `${pad("SHORT_ID", widths.sid)}  ${pad("STATUS", widths.status)}  ${pad("RISK", widths.risk)}  ${pad("ACTION", widths.action)}  ${pad("CREATED_AT", widths.createdAt)}  REASON`,
  );
  for (const row of rows) {
    console.log(
      `${pad(row.sid, widths.sid)}  ${pad(row.status, widths.status)}  ${pad(row.risk, widths.risk)}  ${pad(row.action, widths.action)}  ${pad(row.createdAt, widths.createdAt)}  ${row.reason}`,
    );
  }
}

function printApprovalShowText(
  approval: Approval,
  _location: ApprovalLocation,
  events: readonly Event[],
  lazyExpired: boolean,
): void {
  console.log(`Approval: ${approval.id}  (status: ${approval.status})`);
  console.log(`Session:        ${approval.session_id}`);
  console.log(`Created at:     ${approval.created_at}`);
  console.log(`Risk level:     ${approval.risk_level}`);
  console.log(`Action:         ${formatActionLine(approval.action)}`);
  console.log(`Reason:         ${approval.reason}`);
  const expiresLabel = formatExpiresLabel(approval.expires_at, lazyExpired);
  console.log(`Expires at:     ${expiresLabel}`);
  console.log(`Resolver:       ${approval.resolver ?? "(none)"}`);
  console.log(`Resolved at:    ${approval.resolved_at ?? "(none)"}`);
  console.log(`Note:           ${approval.note ?? "(none)"}`);
  console.log(`Rejection reason: ${approval.rejection_reason ?? "(none)"}`);

  console.log("");
  console.log(`Related events: ${events.length} total`);
  for (const ev of events) {
    console.log(`  ${formatApprovalEventLine(ev)}`);
  }
}

function formatActionLine(action: { kind: string } & Record<string, unknown>): string {
  const extras: string[] = [];
  for (const [key, value] of Object.entries(action)) {
    if (key === "kind") continue;
    if (typeof value !== "string") continue;
    extras.push(`${key}="${truncate(value, ACTION_KEY_DETAIL_MAX_LEN)}"`);
    if (extras.length >= 2) break;
  }
  return extras.length === 0 ? action.kind : `${action.kind} (${extras.join(", ")})`;
}

function formatExpiresLabel(expiresAt: string | null, lazyExpired: boolean): string {
  if (expiresAt === null) return "(none)";
  return lazyExpired ? `${expiresAt} (expired)` : expiresAt;
}

function formatApprovalEventLine(ev: Event): string {
  const summary = approvalEventSummary(ev);
  return `${ev.occurred_at} [${ev.source}]  ${ev.type}  ${summary}`;
}

function approvalEventSummary(ev: Event): string {
  switch (ev.type) {
    case "approval_requested":
      return `${ev.action.kind} risk=${ev.risk_level}`;
    case "approval_approved":
      return ev.resolver !== undefined ? `by ${ev.resolver}` : "(approved)";
    case "approval_rejected":
      return ev.resolver !== undefined ? `by ${ev.resolver}: ${ev.reason}` : ev.reason;
    case "approval_expired":
      return `approval=${ev.approval_id}`;
    default:
      // Other event types are filtered out before reaching this helper.
      return "";
  }
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
  if (id.startsWith(APPR_PREFIX)) {
    return id.slice(APPR_PREFIX.length, APPR_PREFIX.length + len);
  }
  return id.slice(0, len);
}

function computeUniquePrefixLen(ids: readonly string[]): number {
  if (ids.length <= 1) return SHORT_ID_BASE_LEN;
  for (let len = SHORT_ID_BASE_LEN; len <= SHORT_ID_MAX_LEN; len += 2) {
    const seen = new Set<string>();
    let collided = false;
    for (const id of ids) {
      const key = sliceShort(id, len);
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

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

async function resolveRepositoryRootForApproval(
  cwd: string,
  subcmd: "list" | "show" | "approve" | "reject",
): Promise<string> {
  try {
    return await resolveRepositoryRoot(cwd);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Not a git repository") {
      throw new Error(
        `Not a git repository. Run 'git init' first, then re-run 'basou approval ${subcmd}'.`,
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

function renderApprovalError(error: unknown, verbose: boolean): void {
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
    if (error.message === "YAML file not found") return "approval YAML not found";
    if (error.message === "Failed to parse YAML content") return "invalid YAML";
    return error.message;
  }
  return String(error);
}

function parseApprovalStatus(raw: string): ApprovalStatus {
  const result = ApprovalStatusSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid approval status: ${raw}. Valid values: ${STATUS_VALUES.join(", ")}`);
  }
  return result.data;
}

function printNoApprovals(options: ApprovalListOptions): void {
  if (options.json === true) {
    console.log("[]");
  } else {
    console.log("No approvals found.");
  }
}
