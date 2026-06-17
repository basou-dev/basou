import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  type BasouPaths,
  computeWorkStats,
  enumerateApprovals,
  findErrorCode,
  isLazyExpired,
  loadApproval,
  loadSessionEntries,
  loadTaskEntries,
  type Manifest,
  readAllEvents,
  readManifest,
  readMarkdownFile,
  readSessionYaml,
  readTaskFile,
  renderDecisions,
  renderHandoff,
  summarizeOrientation,
} from "@basou/core";
import type { ImportContext } from "../commands/import.js";
import {
  importClaudeCode,
  importCodex,
  type RefreshActionOptions,
  refreshAll,
  regenerateDecisions,
  regenerateHandoff,
} from "./provenance-actions.js";
import { VIEW_HTML } from "./view-ui.js";

/**
 * One workspace the server can serve. In single mode there is exactly one; in
 * portfolio mode there are several, each its own `.basou/` (a separate repo).
 * `key` is a stable, URL-safe identifier used in `/api/ws/:key/*` routes — it is
 * only ever an equality lookup against this registry, never joined into a path.
 */
export type WorkspaceEntry = {
  key: string;
  label: string;
  paths: BasouPaths;
  repoRoot: string;
  importCtx: ImportContext;
  /** False when the path has no readable `.basou/manifest` (shown as a degraded card). */
  initialized: boolean;
  /**
   * Set when the manifest is present but unreadable/invalid (parse / permission
   * error) rather than simply absent — lets a degraded card distinguish
   * "unreadable" from "never initialized". Pathless.
   */
  manifestError?: string;
};

/** Everything the request handlers need; resolved once when the server starts. */
export type ViewServerDeps = {
  /** At least one entry. Flat `/api/*` routes always target `workspaces[0]`. */
  workspaces: WorkspaceEntry[];
  /** How the server was started; drives the UI landing (single detail vs portfolio cards). */
  mode: "single" | "portfolio";
  nowProvider: () => Date;
};

/** A running view server, with the means to stop it. */
export type ViewServerHandle = {
  url: string;
  port: number;
  close: () => Promise<void>;
};

/** A handler-level failure that maps to a specific HTTP status (vs a 500). */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY_BYTES = 64 * 1024;
const API_PREFIX = "/api/";
const WS_PREFIX = "/api/ws/";

/**
 * Start a localhost-only provenance viewer. Binds 127.0.0.1, serves a single
 * inline HTML page at `/` and a small JSON API under `/api/*`. Resolves once
 * listening (rejects on a bind error such as EADDRINUSE).
 */
export function startViewServer(opts: {
  port: number;
  host?: string;
  deps: ViewServerDeps;
}): Promise<ViewServerHandle> {
  const { port, host = "127.0.0.1", deps } = opts;
  // Mutating POSTs swap process-global console (import capture); serialize them
  // ACROSS all workspaces so concurrent requests never interleave their capture.
  let actionQueue: Promise<unknown> = Promise.resolve();
  const runExclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = actionQueue.then(fn, fn);
    actionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  let boundPort = port;
  const getPort = (): number => boundPort;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handleRequest(req, res, deps, getPort, runExclusive).catch((error: unknown) => {
        sendError(res, error instanceof HttpError ? error.status : 500, pathlessMessage(error));
      });
    });
    server.on("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      boundPort = isAddressInfo(address) ? address.port : port;
      server.off("error", reject);
      resolve({
        url: `http://${host}:${boundPort}`,
        port: boundPort,
        close: () => closeServer(server),
      });
    });
  });
}

function isAddressInfo(value: string | AddressInfo | null): value is AddressInfo {
  return value !== null && typeof value === "object";
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // Force-terminate any in-flight connection (e.g. a client holding a POST
    // body open) so close() resolves promptly instead of hanging shutdown.
    server.closeAllConnections();
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ViewServerDeps,
  getPort: () => number,
  runExclusive: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (!hostAllowed(req, getPort())) {
    sendError(res, 403, "Forbidden: host not allowed");
    return;
  }

  if (method === "GET") {
    await handleGet(res, pathname, deps);
    return;
  }
  if (method === "POST") {
    if (!originAllowed(req, getPort())) {
      sendError(res, 403, "Forbidden: cross-origin request");
      return;
    }
    const body = await readBody(req);
    await handlePost(res, pathname, body, deps, runExclusive);
    return;
  }
  sendError(res, 405, "Method not allowed");
}

async function handleGet(
  res: ServerResponse,
  pathname: string,
  deps: ViewServerDeps,
): Promise<void> {
  if (pathname === "/") {
    sendHtml(res, VIEW_HTML);
    return;
  }
  if (pathname === "/api/portfolio") {
    sendJson(res, 200, await portfolio(deps));
    return;
  }
  const scoped = matchWsRoute(pathname);
  if (scoped !== null) {
    const ws = findWorkspace(deps, scoped.key);
    if (ws === null) {
      sendError(res, 404, "Unknown workspace");
      return;
    }
    if (!(await handleWorkspaceGet(res, scoped.sub, ws, deps.nowProvider))) {
      sendError(res, 404, "Not found");
    }
    return;
  }
  if (pathname.startsWith(API_PREFIX)) {
    const sub = pathname.slice(API_PREFIX.length);
    if (!(await handleWorkspaceGet(res, sub, primaryWorkspace(deps), deps.nowProvider))) {
      sendError(res, 404, "Not found");
    }
    return;
  }
  sendError(res, 404, "Not found");
}

async function handlePost(
  res: ServerResponse,
  pathname: string,
  body: Record<string, unknown>,
  deps: ViewServerDeps,
  runExclusive: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<void> {
  const scoped = matchWsRoute(pathname);
  if (scoped !== null) {
    const ws = findWorkspace(deps, scoped.key);
    if (ws === null) {
      sendError(res, 404, "Unknown workspace");
      return;
    }
    if (!(await handleWorkspacePost(res, scoped.sub, ws, body, deps, runExclusive))) {
      sendError(res, 404, "Not found");
    }
    return;
  }
  if (pathname.startsWith(API_PREFIX)) {
    const sub = pathname.slice(API_PREFIX.length);
    if (!(await handleWorkspacePost(res, sub, primaryWorkspace(deps), body, deps, runExclusive))) {
      sendError(res, 404, "Not found");
    }
    return;
  }
  sendError(res, 404, "Not found");
}

/** GET routes scoped to one workspace. Returns false if `sub` matched nothing. */
async function handleWorkspaceGet(
  res: ServerResponse,
  sub: string,
  ws: WorkspaceEntry,
  nowProvider: () => Date,
): Promise<boolean> {
  if (sub === "overview") {
    sendJson(res, 200, await overview(ws, nowProvider));
    return true;
  }
  if (sub === "sessions") {
    sendJson(res, 200, await sessionsList(ws, nowProvider));
    return true;
  }
  const sessionId = matchId(sub, "sessions/");
  if (sessionId !== null) {
    sendJson(res, 200, await sessionDetail(ws, sessionId));
    return true;
  }
  if (sub === "tasks") {
    sendJson(res, 200, await tasksList(ws));
    return true;
  }
  const taskId = matchId(sub, "tasks/");
  if (taskId !== null) {
    sendJson(res, 200, await taskDetail(ws, taskId));
    return true;
  }
  if (sub === "decisions") {
    sendJson(res, 200, await decisionsView(ws, nowProvider));
    return true;
  }
  if (sub === "approvals") {
    sendJson(res, 200, await approvalsView(ws, nowProvider));
    return true;
  }
  if (sub === "handoff") {
    sendJson(res, 200, await handoffView(ws, nowProvider));
    return true;
  }
  if (sub === "stats") {
    sendJson(res, 200, await computeWorkStats({ paths: ws.paths, now: nowProvider() }));
    return true;
  }
  return false;
}

/** POST routes scoped to one workspace. Returns false if `sub` matched nothing. */
async function handleWorkspacePost(
  res: ServerResponse,
  sub: string,
  ws: WorkspaceEntry,
  body: Record<string, unknown>,
  deps: ViewServerDeps,
  runExclusive: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<boolean> {
  const nowIso = deps.nowProvider().toISOString();
  const actionOptions = readActionOptions(body);

  if (sub === "refresh") {
    const result = await runExclusive(() =>
      refreshAll({ options: actionOptions, ctx: ws.importCtx, paths: ws.paths, nowIso }),
    );
    sendJson(res, 200, result);
    return true;
  }
  if (sub === "import/claude-code") {
    sendJson(res, 200, await runExclusive(() => importClaudeCode(actionOptions, ws.importCtx)));
    return true;
  }
  if (sub === "import/codex") {
    sendJson(res, 200, await runExclusive(() => importCodex(actionOptions, ws.importCtx)));
    return true;
  }
  if (sub === "handoff/generate") {
    sendJson(res, 200, await runExclusive(() => regenerateHandoff(ws.paths, nowIso)));
    return true;
  }
  if (sub === "decisions/generate") {
    sendJson(res, 200, await runExclusive(() => regenerateDecisions(ws.paths, nowIso)));
    return true;
  }
  return false;
}

// --- workspace registry helpers -------------------------------------------

function primaryWorkspace(deps: ViewServerDeps): WorkspaceEntry {
  const first = deps.workspaces[0];
  if (first === undefined) throw new HttpError(500, "No workspace configured");
  return first;
}

function findWorkspace(deps: ViewServerDeps, key: string): WorkspaceEntry | null {
  return deps.workspaces.find((w) => w.key === key) ?? null;
}

/** Parse `/api/ws/<key>/<sub...>`. `key` is decoded and used only for equality lookup. */
function matchWsRoute(pathname: string): { key: string; sub: string } | null {
  if (!pathname.startsWith(WS_PREFIX)) return null;
  const rest = pathname.slice(WS_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const sub = rest.slice(slash + 1);
  if (sub.length === 0) return null;
  let key: string;
  try {
    key = decodeURIComponent(rest.slice(0, slash));
  } catch {
    return null;
  }
  if (key.length === 0 || key.includes("/") || key.includes("\0")) return null;
  return { key, sub };
}

// --- handlers -------------------------------------------------------------

/**
 * Aggregate the per-workspace "current position" for the portfolio landing.
 * Read-only: it runs NO import, so a stale capture is shown as stale (run a
 * refresh to re-import). Each card carries STRUCTURED FACTS only (latest
 * session/decision, in-flight count, pending-approval risk, suspect count,
 * capture freshness) — never work-stats or per-agent productivity metrics. One
 * workspace failing to read degrades only its own card, not the whole response.
 */
async function portfolio(deps: ViewServerDeps): Promise<Record<string, unknown>> {
  const nowIso = deps.nowProvider().toISOString();
  const workspaces = await Promise.all(deps.workspaces.map((ws) => portfolioCard(ws, nowIso)));
  return { mode: deps.mode, generatedAt: nowIso, workspaces };
}

async function portfolioCard(ws: WorkspaceEntry, nowIso: string): Promise<Record<string, unknown>> {
  const base = { key: ws.key, label: ws.label, repoRoot: ws.repoRoot };
  if (!ws.initialized) {
    return ws.manifestError !== undefined
      ? { ...base, initialized: false, error: ws.manifestError }
      : { ...base, initialized: false };
  }
  try {
    const s = await summarizeOrientation({ paths: ws.paths, nowIso });
    return {
      ...base,
      initialized: true,
      sessionCount: s.sessionCount,
      suspectCount: s.suspects.length,
      inFlightCount: s.inFlightTasks.length,
      pendingApprovals: s.pendingApprovals.map((a) => ({
        risk: a.risk,
        kind: a.kind,
        expired: a.expired,
      })),
      latestDecision: s.latestDecision !== null ? { title: s.latestDecision.title } : null,
      latestSession:
        s.latestSession !== null
          ? { label: s.latestSession.label, status: s.latestSession.status }
          : null,
      freshness: { newestStartedAt: s.freshness.newestStartedAt, bySource: s.freshness.bySource },
    };
  } catch (error: unknown) {
    return { ...base, initialized: true, error: pathlessMessage(error) };
  }
}

async function overview(
  ws: WorkspaceEntry,
  nowProvider: () => Date,
): Promise<Record<string, unknown>> {
  let manifest: Manifest;
  try {
    manifest = await readManifest(ws.paths);
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) {
      return { initialized: false, repoRoot: ws.repoRoot };
    }
    throw error;
  }
  const nowIso = nowProvider().toISOString();
  const handoff = await renderHandoff({ paths: ws.paths, nowIso });
  const approvals = await enumerateApprovals(ws.paths);
  return {
    initialized: true,
    repoRoot: ws.repoRoot,
    workspace: {
      id: manifest.workspace.id,
      name: manifest.workspace.name,
      basouVersion: manifest.basou_version,
    },
    counts: {
      sessions: handoff.sessionCount,
      suspectSessions: handoff.suspectCount,
      tasks: handoff.taskCount,
      pendingTasks: handoff.pendingTaskCount,
      decisions: handoff.decisionCount,
      approvalsPending: approvals.pending.length,
      approvalsResolved: approvals.resolved.length,
    },
    generatedAt: nowIso,
  };
}

async function sessionsList(
  ws: WorkspaceEntry,
  nowProvider: () => Date,
): Promise<Record<string, unknown>> {
  const entries = await loadSessionEntries(ws.paths, { now: nowProvider() });
  // loadSessionEntries returns oldest-first; show newest-first.
  const sessions = entries
    .map((entry) => ({
      sessionId: entry.sessionId,
      label: entry.session.session.label ?? null,
      status: entry.session.session.status,
      sourceKind: entry.session.session.source.kind,
      startedAt: entry.session.session.started_at,
      endedAt: entry.session.session.ended_at ?? null,
      suspect: entry.suspect,
      suspectReason: entry.suspectReason,
      taskId: entry.session.session.task_id ?? null,
      relatedFilesCount: entry.session.session.related_files.length,
    }))
    .reverse();
  return { sessions };
}

async function sessionDetail(
  ws: WorkspaceEntry,
  sessionId: string,
): Promise<Record<string, unknown>> {
  let session: Awaited<ReturnType<typeof readSessionYaml>>;
  try {
    session = await readSessionYaml(ws.paths, sessionId);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "YAML file not found") {
      throw new HttpError(404, "Session not found");
    }
    throw error;
  }
  // An unreadable events.jsonl must not 500 the detail view; surface the
  // session with an empty, flagged-degraded timeline (mirrors the list path).
  try {
    const events = await readAllEvents(join(ws.paths.sessions, sessionId));
    return { session, events };
  } catch {
    return { session, events: [], degraded: true };
  }
}

async function tasksList(ws: WorkspaceEntry): Promise<Record<string, unknown>> {
  const entries = await loadTaskEntries(ws.paths);
  return { tasks: entries.map((entry) => entry.task).reverse() };
}

async function taskDetail(ws: WorkspaceEntry, taskId: string): Promise<Record<string, unknown>> {
  try {
    const doc = await readTaskFile(ws.paths, taskId);
    return { task: doc.task, body: doc.body };
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Task file not found") {
      throw new HttpError(404, "Task not found");
    }
    throw error;
  }
}

async function decisionsView(
  ws: WorkspaceEntry,
  nowProvider: () => Date,
): Promise<Record<string, unknown>> {
  // Prefer the on-disk decisions.md so hand-edited content (outside the
  // generated markers) is shown, mirroring the handoff view; fall back to a
  // fresh render when the file does not exist yet.
  const fromDisk = await readMarkdownFile(ws.paths.files.decisions);
  if (fromDisk !== null) {
    return { body: fromDisk, fromDisk: true };
  }
  const nowIso = nowProvider().toISOString();
  const result = await renderDecisions({ paths: ws.paths, nowIso });
  return { body: result.body, decisionCount: result.decisionCount, fromDisk: false };
}

async function approvalsView(
  ws: WorkspaceEntry,
  nowProvider: () => Date,
): Promise<Record<string, unknown>> {
  const now = nowProvider();
  const ids = await enumerateApprovals(ws.paths);
  const toViews = async (list: string[]): Promise<Array<Record<string, unknown>>> => {
    const views: Array<Record<string, unknown>> = [];
    for (const id of list) {
      const loaded = await loadApproval(ws.paths, id);
      if (loaded === null) continue;
      views.push({ id, expired: isLazyExpired(loaded.approval, now), approval: loaded.approval });
    }
    return views;
  };
  return { pending: await toViews(ids.pending), resolved: await toViews(ids.resolved) };
}

async function handoffView(
  ws: WorkspaceEntry,
  nowProvider: () => Date,
): Promise<Record<string, unknown>> {
  const fromDisk = await readMarkdownFile(ws.paths.files.handoff);
  if (fromDisk !== null) {
    return { body: fromDisk, fromDisk: true };
  }
  const nowIso = nowProvider().toISOString();
  const result = await renderHandoff({ paths: ws.paths, nowIso });
  return { body: result.body, fromDisk: false };
}

// --- request helpers ------------------------------------------------------

function readActionOptions(body: Record<string, unknown>): RefreshActionOptions {
  const options: RefreshActionOptions = {};
  // Accept `project` as a single string (the UI sends one) or an array of
  // strings (multi-root callers); normalize to a non-empty string[].
  const project = normalizeProject(body.project);
  if (project.length > 0) options.project = project;
  if (body.force === true) options.force = true;
  if (body.dryRun === true) options.dryRun = true;
  return options;
}

/** Coerce a request body `project` field into a list of non-empty path strings. */
function normalizeProject(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  return raw.filter((p): p is string => typeof p === "string" && p.length > 0);
}

function hostAllowed(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function originAllowed(req: IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true; // non-browser client (curl, tests)
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to the shared 400 below
  }
  throw new HttpError(400, "Invalid JSON body");
}

function matchId(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const encoded = pathname.slice(prefix.length);
  if (encoded.length === 0 || encoded.includes("/")) return null;
  let id: string;
  try {
    id = decodeURIComponent(encoded);
  } catch {
    return null; // malformed percent-escape
  }
  // Reject anything that could escape the storage root once decoded: a path
  // separator (incl. the percent-encoded `%2f` that slips past the check
  // above) or a `.`/`..` segment. Ids are otherwise opaque to this layer.
  if (
    id.length === 0 ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0") ||
    id === "." ||
    id === ".."
  ) {
    return null;
  }
  return id;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(res, status, { error: message });
}

/**
 * A pathless, audience-safe message: the Error's own message is already
 * pathless by the codebase's convention; native fs errors are wrapped before
 * they reach here. Falls back to a generic string for non-Error throws.
 */
function pathlessMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Internal error";
}
