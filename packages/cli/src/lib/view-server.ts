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

/** Everything the request handlers need; resolved once when the server starts. */
export type ViewServerDeps = {
  paths: BasouPaths;
  repoRoot: string;
  importCtx: ImportContext;
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
  // so concurrent requests from a reloaded tab never interleave.
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
  if (pathname === "/api/overview") {
    sendJson(res, 200, await overview(deps));
    return;
  }
  if (pathname === "/api/sessions") {
    sendJson(res, 200, await sessionsList(deps));
    return;
  }
  const sessionId = matchId(pathname, "/api/sessions/");
  if (sessionId !== null) {
    sendJson(res, 200, await sessionDetail(deps, sessionId));
    return;
  }
  if (pathname === "/api/tasks") {
    sendJson(res, 200, await tasksList(deps));
    return;
  }
  const taskId = matchId(pathname, "/api/tasks/");
  if (taskId !== null) {
    sendJson(res, 200, await taskDetail(deps, taskId));
    return;
  }
  if (pathname === "/api/decisions") {
    sendJson(res, 200, await decisionsView(deps));
    return;
  }
  if (pathname === "/api/approvals") {
    sendJson(res, 200, await approvalsView(deps));
    return;
  }
  if (pathname === "/api/handoff") {
    sendJson(res, 200, await handoffView(deps));
    return;
  }
  if (pathname === "/api/stats") {
    sendJson(res, 200, await computeWorkStats({ paths: deps.paths, now: deps.nowProvider() }));
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
  const nowIso = deps.nowProvider().toISOString();
  const actionOptions = readActionOptions(body);

  if (pathname === "/api/refresh") {
    const result = await runExclusive(() =>
      refreshAll({ options: actionOptions, ctx: deps.importCtx, paths: deps.paths, nowIso }),
    );
    sendJson(res, 200, result);
    return;
  }
  if (pathname === "/api/import/claude-code") {
    sendJson(res, 200, await runExclusive(() => importClaudeCode(actionOptions, deps.importCtx)));
    return;
  }
  if (pathname === "/api/import/codex") {
    sendJson(res, 200, await runExclusive(() => importCodex(actionOptions, deps.importCtx)));
    return;
  }
  if (pathname === "/api/handoff/generate") {
    sendJson(res, 200, await runExclusive(() => regenerateHandoff(deps.paths, nowIso)));
    return;
  }
  if (pathname === "/api/decisions/generate") {
    sendJson(res, 200, await runExclusive(() => regenerateDecisions(deps.paths, nowIso)));
    return;
  }
  sendError(res, 404, "Not found");
}

// --- handlers -------------------------------------------------------------

async function overview(deps: ViewServerDeps): Promise<Record<string, unknown>> {
  let manifest: Manifest;
  try {
    manifest = await readManifest(deps.paths);
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) {
      return { initialized: false, repoRoot: deps.repoRoot };
    }
    throw error;
  }
  const nowIso = deps.nowProvider().toISOString();
  const handoff = await renderHandoff({ paths: deps.paths, nowIso });
  const approvals = await enumerateApprovals(deps.paths);
  return {
    initialized: true,
    repoRoot: deps.repoRoot,
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

async function sessionsList(deps: ViewServerDeps): Promise<Record<string, unknown>> {
  const entries = await loadSessionEntries(deps.paths, { now: deps.nowProvider() });
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
  deps: ViewServerDeps,
  sessionId: string,
): Promise<Record<string, unknown>> {
  let session: Awaited<ReturnType<typeof readSessionYaml>>;
  try {
    session = await readSessionYaml(deps.paths, sessionId);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "YAML file not found") {
      throw new HttpError(404, "Session not found");
    }
    throw error;
  }
  // An unreadable events.jsonl must not 500 the detail view; surface the
  // session with an empty, flagged-degraded timeline (mirrors the list path).
  try {
    const events = await readAllEvents(join(deps.paths.sessions, sessionId));
    return { session, events };
  } catch {
    return { session, events: [], degraded: true };
  }
}

async function tasksList(deps: ViewServerDeps): Promise<Record<string, unknown>> {
  const entries = await loadTaskEntries(deps.paths);
  return { tasks: entries.map((entry) => entry.task).reverse() };
}

async function taskDetail(deps: ViewServerDeps, taskId: string): Promise<Record<string, unknown>> {
  try {
    const doc = await readTaskFile(deps.paths, taskId);
    return { task: doc.task, body: doc.body };
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Task file not found") {
      throw new HttpError(404, "Task not found");
    }
    throw error;
  }
}

async function decisionsView(deps: ViewServerDeps): Promise<Record<string, unknown>> {
  // Prefer the on-disk decisions.md so hand-edited content (outside the
  // generated markers) is shown, mirroring the handoff view; fall back to a
  // fresh render when the file does not exist yet.
  const fromDisk = await readMarkdownFile(deps.paths.files.decisions);
  if (fromDisk !== null) {
    return { body: fromDisk, fromDisk: true };
  }
  const nowIso = deps.nowProvider().toISOString();
  const result = await renderDecisions({ paths: deps.paths, nowIso });
  return { body: result.body, decisionCount: result.decisionCount, fromDisk: false };
}

async function approvalsView(deps: ViewServerDeps): Promise<Record<string, unknown>> {
  const now = deps.nowProvider();
  const ids = await enumerateApprovals(deps.paths);
  const toViews = async (list: string[]): Promise<Array<Record<string, unknown>>> => {
    const views: Array<Record<string, unknown>> = [];
    for (const id of list) {
      const loaded = await loadApproval(deps.paths, id);
      if (loaded === null) continue;
      views.push({ id, expired: isLazyExpired(loaded.approval, now), approval: loaded.approval });
    }
    return views;
  };
  return { pending: await toViews(ids.pending), resolved: await toViews(ids.resolved) };
}

async function handoffView(deps: ViewServerDeps): Promise<Record<string, unknown>> {
  const fromDisk = await readMarkdownFile(deps.paths.files.handoff);
  if (fromDisk !== null) {
    return { body: fromDisk, fromDisk: true };
  }
  const nowIso = deps.nowProvider().toISOString();
  const result = await renderHandoff({ paths: deps.paths, nowIso });
  return { body: result.body, fromDisk: false };
}

// --- request helpers ------------------------------------------------------

function readActionOptions(body: Record<string, unknown>): RefreshActionOptions {
  const options: RefreshActionOptions = {};
  if (typeof body.project === "string" && body.project.length > 0) options.project = body.project;
  if (body.force === true) options.force = true;
  if (body.dryRun === true) options.dryRun = true;
  return options;
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
