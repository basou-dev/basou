import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { devNull, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
  basouPaths,
  boardPageStrings,
  createManifest,
  displayPath,
  ensureBasouDirectory,
  type RepoEntry,
  writeManifest,
} from "@basou/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOARD_HTML } from "../lib/board-ui.js";
import { startViewServer, type ViewServerHandle } from "../lib/view-server.js";
import { VIEW_HTML } from "../lib/view-ui.js";
import { doRunBoardMeasure, doRunBoardRecord, measureLiveBoard } from "./board.js";
import {
  doRunView,
  registerViewCommand,
  runView,
  sharedWhileRunning,
  type ViewContext,
  type ViewOptions,
} from "./view.js";

const execFileAsync = promisify(execFile);

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const FIXED_DATE = new Date("2026-05-09T03:00:00.000Z");

let tmpRepo: string | undefined;
let codexRoot: string | undefined;
let claudeRoot: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-view-test-"));
  codexRoot = await mkdtemp(join(tmpdir(), "basou-view-codex-"));
  claudeRoot = await mkdtemp(join(tmpdir(), "basou-view-claude-"));
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: tmpRepo, env: ENV });
  await execFileAsync("git", ["config", "user.email", "t@e.com"], { cwd: tmpRepo, env: ENV });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: tmpRepo, env: ENV });
});

afterEach(async () => {
  for (const dir of [tmpRepo, codexRoot, claudeRoot]) {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
  tmpRepo = undefined;
  codexRoot = undefined;
  claudeRoot = undefined;
  process.exitCode = 0;
  vi.restoreAllMocks();
});

function getCodexRoot(): string {
  if (codexRoot === undefined) throw new Error("codexRoot not initialized");
  return codexRoot;
}

function getClaudeRoot(): string {
  if (claudeRoot === undefined) throw new Error("claudeRoot not initialized");
  return claudeRoot;
}

/**
 * The adapter roots every portfolio `--check` test must inject. The
 * capture-coverage report scans the native log trees, so without these it
 * would walk the developer's real ~/.claude and ~/.codex and its output would
 * depend on the machine it runs on.
 */
function hermeticLogRoots(): Pick<ViewContext, "claudeProjectsDir" | "codexSessionsDir"> {
  return { claudeProjectsDir: getClaudeRoot(), codexSessionsDir: getCodexRoot() };
}

async function setupInitedRepo(): Promise<string> {
  const repo = await realpath(tmpRepo as string);
  const paths = await ensureBasouDirectory(repo);
  const manifest = createManifest({
    workspaceName: "view-ws",
    now: FIXED_DATE,
    workspaceId: FIXED_WS_ID,
  });
  await writeManifest(paths, manifest);
  return repo;
}

const ARCHIVED_TASK_ID = "task_01HXABCDEF1234567890ABCDEF" as const;
const WS_ID_A = "ws_01HXABCDEF1234567890ABCDEF" as const;
const WS_ID_B = "ws_01HXABCDEF1234567890ABCDEG" as const;

/** Initialize a `.basou/` workspace at an arbitrary dir (no git), for portfolio tests. */
async function initWorkspaceAt(root: string, id: string, name: string): Promise<string> {
  const real = await realpath(root);
  const paths = await ensureBasouDirectory(real);
  await writeManifest(
    paths,
    createManifest({ workspaceName: name, now: FIXED_DATE, workspaceId: id as typeof WS_ID_A }),
  );
  return real;
}

async function writeCodexRollout(repo: string): Promise<void> {
  const dir = join(getCodexRoot(), "2026", "05", "10");
  await mkdir(dir, { recursive: true });
  const records = [
    {
      type: "session_meta",
      timestamp: "2026-05-10T00:00:00.000Z",
      payload: { id: "cx-1", cwd: repo, timestamp: "2026-05-10T00:00:00.000Z" },
    },
    {
      type: "response_item",
      timestamp: "2026-05-10T00:00:01.000Z",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "ls", workdir: repo }),
        call_id: "c1",
      },
    },
    {
      type: "response_item",
      timestamp: "2026-05-10T00:00:02.000Z",
      payload: {
        type: "function_call_output",
        call_id: "c1",
        output: "Wall time: 0.1000 seconds\nProcess exited with code 0\n",
      },
    },
  ];
  await writeFile(
    join(dir, "rollout-cx-1.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n"),
  );
}

/** Start the view server on an ephemeral port, run `body`, then shut it down. */
async function withServer(
  repo: string,
  extra: Partial<ViewContext>,
  body: (handle: ViewServerHandle) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  let handle: ViewServerHandle | undefined;
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const ctx: ViewContext = {
    cwd: repo,
    signal: controller.signal,
    openBrowser: () => {},
    codexSessionsDir: getCodexRoot(),
    onListening: (h) => {
      handle = h;
      markReady();
    },
    ...extra,
  };
  vi.spyOn(console, "log").mockImplementation(() => {});
  const running = doRunView({ port: 0 }, ctx);
  await ready;
  try {
    if (handle === undefined) throw new Error("server never listened");
    await body(handle);
  } finally {
    controller.abort();
    await running;
  }
}

/** Start the view server in portfolio mode over the given workspace paths. */
async function withPortfolioServer(
  workspacePaths: string[],
  extra: Partial<ViewContext>,
  body: (handle: ViewServerHandle) => Promise<void>,
  opts: Partial<ViewOptions> = {},
): Promise<void> {
  const controller = new AbortController();
  let handle: ViewServerHandle | undefined;
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const ctx: ViewContext = {
    cwd: workspacePaths[0] ?? tmpdir(),
    signal: controller.signal,
    openBrowser: () => {},
    codexSessionsDir: getCodexRoot(),
    onListening: (h) => {
      handle = h;
      markReady();
    },
    ...extra,
  };
  vi.spyOn(console, "log").mockImplementation(() => {});
  const running = doRunView({ port: 0, workspace: workspacePaths, ...opts }, ctx);
  await ready;
  try {
    if (handle === undefined) throw new Error("server never listened");
    await body(handle);
  } finally {
    controller.abort();
    await running;
  }
}

async function getJson(
  handle: ViewServerHandle,
  path: string,
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(handle.url + path);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function postJson(
  handle: ViewServerHandle,
  path: string,
  bodyObj: unknown,
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(handle.url + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj ?? {}),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

/** Raw request so tests can set otherwise-forbidden headers (Host / Origin) and methods. */
function raw(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path,
        headers: opts.headers ?? {},
      },
      (res) => {
        let data = "";
        res.on("data", (c) => {
          data += String(c);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

describe("basou view server", () => {
  it("serves overview JSON for an inited workspace", async () => {
    const repo = await setupInitedRepo();
    await withServer(repo, {}, async (handle) => {
      const { status, data } = await getJson(handle, "/api/overview");
      expect(status).toBe(200);
      const d = data as { initialized: boolean; repoRoot: string; counts: { sessions: number } };
      expect(d.initialized).toBe(true);
      expect(d.repoRoot).toBe(repo);
      expect(d.counts.sessions).toBe(0);
    });
  });

  it("overview lists roster repos with live-derived clickable git links (nothing stored)", async () => {
    const repo = await realpath(tmpRepo as string);
    const paths = await ensureBasouDirectory(repo);
    const manifest = {
      ...createManifest({ workspaceName: "view-ws", now: FIXED_DATE, workspaceId: FIXED_WS_ID }),
      repos: [
        { path: ".", visibility: "private" as const },
        { path: "../site", visibility: "public" as const },
        { path: "../local-only" },
      ],
    };
    await writeManifest(paths, manifest);

    // Inject a deterministic live resolver: no real git remotes needed, and it
    // proves the URL is derived at request time (never read from the manifest).
    const remoteUrlOf = async (repoRoot: string): Promise<string | undefined> => {
      if (repoRoot === repo) return "git@github.com:org/app.git";
      if (repoRoot.endsWith("/site")) return "https://gitlab.com/org/site.git";
      return undefined; // local-only repo => no link
    };

    await withServer(repo, { remoteUrlOf }, async (handle) => {
      const { status, data } = await getJson(handle, "/api/overview");
      expect(status).toBe(200);
      const { repos } = data as {
        repos: Array<{ name: string; path: string; url?: string; visibility?: string }>;
      };
      expect(repos).toEqual([
        {
          name: basename(repo),
          path: ".",
          url: "https://github.com/org/app",
          visibility: "private",
        },
        { name: "site", path: "../site", url: "https://gitlab.com/org/site", visibility: "public" },
        { name: "local-only", path: "../local-only" },
      ]);
    });
  });

  it("serves the HTML page at /", async () => {
    const repo = await setupInitedRepo();
    await withServer(repo, {}, async (handle) => {
      const res = await fetch(`${handle.url}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("basou view");
    });
  });

  it("lists sessions (empty, then after an import)", async () => {
    const repo = await setupInitedRepo();
    await writeCodexRollout(repo);
    await withServer(repo, {}, async (handle) => {
      const empty = await getJson(handle, "/api/sessions");
      expect((empty.data as { sessions: unknown[] }).sessions).toHaveLength(0);

      const imp = await postJson(handle, "/api/import/codex", {});
      expect(imp.status).toBe(200);
      expect((imp.data as { importedCount: number }).importedCount).toBe(1);

      const after = await getJson(handle, "/api/sessions");
      const sessions = (
        after.data as { sessions: Array<{ sessionId: string; sourceKind: string }> }
      ).sessions;
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.sourceKind).toBe("codex-import");

      const detail = await getJson(
        handle,
        `/api/sessions/${(sessions[0] as { sessionId: string }).sessionId}`,
      );
      const events = (detail.data as { events: Array<{ type: string }> }).events;
      expect(events.some((e) => e.type === "command_executed")).toBe(true);

      const missing = await getJson(handle, "/api/sessions/ses_doesnotexist");
      expect(missing.status).toBe(404);

      // A copy whose name is not a session id is not served as a session.
      const id = (sessions[0] as { sessionId: string }).sessionId;
      const sessionsDir = join(repo, ".basou", "sessions");
      await cp(join(sessionsDir, id), join(sessionsDir, `${id}.bak`), { recursive: true });
      const copy = await getJson(handle, `/api/sessions/${id}.bak`);
      expect(copy.status).toBe(404);
    });
  });

  // POSIX only: creating a symlink needs privileges on Windows.
  it.skipIf(process.platform === "win32")(
    "does not serve a session whose entry is a symlink or a file, and says why",
    async () => {
      const repo = await setupInitedRepo();
      await writeCodexRollout(repo);
      await withServer(repo, {}, async (handle) => {
        await postJson(handle, "/api/import/codex", {});
        const listed = await getJson(handle, "/api/sessions");
        const id = (listed.data as { sessions: Array<{ sessionId: string }> }).sessions[0]
          ?.sessionId as string;
        const sessionsDir = join(repo, ".basou", "sessions");
        await rename(join(sessionsDir, id), join(repo, "moved-session"));
        await symlink(join(repo, "moved-session"), join(sessionsDir, id));
        const detail = await getJson(handle, `/api/sessions/${id}`);
        expect(detail).toEqual({
          status: 404,
          data: {
            error: `Session ${id} is not a directory; a symlink or a file there is not followed`,
          },
        });
        // A file at the name answers the same way.
        await rm(join(sessionsDir, id));
        await writeFile(join(sessionsDir, id), "");
        expect(await getJson(handle, `/api/sessions/${id}`)).toEqual(detail);
      });
    },
  );

  it("serves work stats", async () => {
    const repo = await setupInitedRepo();
    await writeCodexRollout(repo);
    await withServer(repo, {}, async (handle) => {
      await postJson(handle, "/api/import/codex", {});
      const { status, data } = await getJson(handle, "/api/stats");
      expect(status).toBe(200);
      const d = data as { totals: { sessionCount: number }; bySource: unknown[] };
      expect(d.totals.sessionCount).toBe(1);
      expect(d.bySource).toHaveLength(1);
    });
  });

  it("regenerates handoff via POST and writes the marked-up file", async () => {
    const repo = await setupInitedRepo();
    await withServer(repo, {}, async (handle) => {
      const res = await postJson(handle, "/api/handoff/generate", {});
      expect(res.status).toBe(200);
      expect(typeof (res.data as { sessionCount: number }).sessionCount).toBe("number");
      const body = await readFile(basouPaths(repo).files.handoff, "utf8");
      expect(body).toContain("BASOU:GENERATED");
    });
  });

  it("runs the aggregate refresh", async () => {
    const repo = await setupInitedRepo();
    await writeCodexRollout(repo);
    await withServer(repo, {}, async (handle) => {
      const res = await postJson(handle, "/api/refresh", {});
      expect(res.status).toBe(200);
      const d = res.data as { codex: { status: string }; handoff: { status: string } };
      expect(d.codex.status).toBe("ran");
      expect(d.handoff.status).toBe("generated");
      await expect(access(basouPaths(repo).files.handoff)).resolves.toBeUndefined();
    });
  });

  it("rejects a foreign Host, a cross Origin, bad method, unknown path, and bad JSON", async () => {
    const repo = await setupInitedRepo();
    await withServer(repo, {}, async (handle) => {
      const badHost = await raw(handle.port, {
        path: "/api/overview",
        headers: { Host: "evil.example" },
      });
      expect(badHost.status).toBe(403);

      const badOrigin = await raw(handle.port, {
        method: "POST",
        path: "/api/handoff/generate",
        headers: {
          Host: `127.0.0.1:${handle.port}`,
          Origin: "http://evil.example",
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      expect(badOrigin.status).toBe(403);

      const badMethod = await raw(handle.port, {
        method: "PUT",
        path: "/api/overview",
        headers: { Host: `127.0.0.1:${handle.port}` },
      });
      expect(badMethod.status).toBe(405);

      const notFound = await raw(handle.port, {
        path: "/api/nope",
        headers: { Host: `127.0.0.1:${handle.port}` },
      });
      expect(notFound.status).toBe(404);

      const badJson = await raw(handle.port, {
        method: "POST",
        path: "/api/refresh",
        headers: { Host: `127.0.0.1:${handle.port}`, "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(badJson.status).toBe(400);
    });
  });

  it("blocks percent-encoded path traversal in session / task ids", async () => {
    const repo = await setupInitedRepo();
    await withServer(repo, {}, async (handle) => {
      const host = `127.0.0.1:${handle.port}`;
      // %2e%2e%2f decodes to "../"; it must not escape the storage root.
      const task = await raw(handle.port, {
        path: "/api/tasks/%2e%2e%2f%2e%2e%2fREADME",
        headers: { Host: host },
      });
      expect(task.status).toBe(404);
      const session = await raw(handle.port, {
        path: "/api/sessions/%2e%2e%2f%2e%2e%2fpackage",
        headers: { Host: host },
      });
      expect(session.status).toBe(404);
    });
  });

  it("serves decisions from the on-disk file once generated", async () => {
    const repo = await setupInitedRepo();
    await withServer(repo, {}, async (handle) => {
      await postJson(handle, "/api/decisions/generate", {});
      const res = await getJson(handle, "/api/decisions");
      expect((res.data as { fromDisk: boolean }).fromDisk).toBe(true);
    });
  });
});

describe("basou view portfolio mode", () => {
  it("aggregates multiple workspaces (no git needed) and serves ws-scoped routes", async () => {
    const rawA = await mkdtemp(join(tmpdir(), "basou-pf-a-"));
    const rawB = await mkdtemp(join(tmpdir(), "basou-pf-b-"));
    try {
      const wsA = await initWorkspaceAt(rawA, WS_ID_A, "alpha");
      const wsB = await initWorkspaceAt(rawB, WS_ID_B, "beta");
      await withPortfolioServer([wsA, wsB], {}, async (handle) => {
        const { status, data } = await getJson(handle, "/api/portfolio");
        expect(status).toBe(200);
        const d = data as {
          mode: string;
          workspaces: Array<{
            key: string;
            label: string;
            initialized: boolean;
            sessionCount: number;
          }>;
        };
        expect(d.mode).toBe("portfolio");
        expect(d.workspaces).toHaveLength(2);
        expect(d.workspaces.map((w) => w.label).sort()).toEqual(["alpha", "beta"]);
        expect(d.workspaces.every((w) => w.initialized)).toBe(true);
        expect(d.workspaces.every((w) => w.sessionCount === 0)).toBe(true);

        // ws-scoped drill-in resolves the right workspace.
        const ov = await getJson(handle, `/api/ws/${WS_ID_A}/overview`);
        expect(ov.status).toBe(200);
        const o = ov.data as { initialized: boolean; repoRoot: string };
        expect(o.initialized).toBe(true);
        expect(o.repoRoot).toBe(wsA);

        // Unknown workspace key → 404 (the key is an allowlist lookup, never a path).
        const unknown = await getJson(handle, "/api/ws/ws_doesnotexist/overview");
        expect(unknown.status).toBe(404);

        // Flat routes still target the first workspace (single-mode compatibility).
        const flat = await getJson(handle, "/api/overview");
        expect((flat.data as { repoRoot: string }).repoRoot).toBe(wsA);
      });
    } finally {
      await rm(rawA, { recursive: true, force: true });
      await rm(rawB, { recursive: true, force: true });
    }
  });

  // Lifts the real function out of the served page and runs it. Asserting the
  // /api/portfolio payload alone left this unpinned: inverting the branch, or
  // replacing the label with garbage, kept the whole suite green.
  function liftTaskFlightLabel(): (w: Record<string, unknown>) => string {
    const marker = "function taskFlightLabel(w) {";
    const start = VIEW_HTML.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = -1;
    for (let i = start + marker.length - 1; i < VIEW_HTML.length; i++) {
      const ch = VIEW_HTML[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    expect(end).toBeGreaterThan(start);
    const src = VIEW_HTML.slice(start, end);
    return new Function(`${src}; return taskFlightLabel;`)() as (
      w: Record<string, unknown>,
    ) => string;
  }

  it("the card label distinguishes all three of the in-flight zeros", () => {
    const label = liftTaskFlightLabel();
    expect(label({ inFlightCount: 0, anyTaskEverRecorded: false, unreadableTaskCount: 0 })).toBe(
      "no tasks recorded",
    );
    expect(label({ inFlightCount: 0, anyTaskEverRecorded: true, unreadableTaskCount: 0 })).toBe(
      "in-flight 0",
    );
    expect(label({ inFlightCount: 2, anyTaskEverRecorded: true, unreadableTaskCount: 0 })).toBe(
      "in-flight 2",
    );
    // A store whose task files cannot be read: the count is not 0, it is unknown.
    expect(label({ inFlightCount: 0, anyTaskEverRecorded: true, unreadableTaskCount: 1 })).toBe(
      "in-flight unknown (1 unreadable)",
    );
  });

  it("an older card payload without the new fields degrades to the plain count", () => {
    // A page served to a stale client, or a card shape that predates the fields:
    // absent must read as the old behaviour, never as "no tasks recorded".
    const label = liftTaskFlightLabel();
    expect(label({ inFlightCount: 3 })).toBe("in-flight 3");
    expect(label({ inFlightCount: 0 })).toBe("in-flight 0");
  });

  it("tells a workspace that never recorded a task from one whose tasks are all done", async () => {
    // Two different zeros. `inFlightCount` reads 0 for both, which is the same
    // defect orient and handoff already fixed -- the card carries the third
    // state so it can say which zero it is.
    const rawA = await mkdtemp(join(tmpdir(), "basou-pf-zero-a-"));
    const rawB = await mkdtemp(join(tmpdir(), "basou-pf-zero-b-"));
    try {
      const never = await initWorkspaceAt(rawA, WS_ID_A, "never");
      const allDone = await initWorkspaceAt(rawB, WS_ID_B, "all-done");
      // An archived task: nothing in flight, but a task WAS recorded here.
      const archive = join(basouPaths(allDone).tasks, "archive");
      await mkdir(archive, { recursive: true });
      await writeFile(join(archive, `${ARCHIVED_TASK_ID}.md`), "# archived\n", "utf8");

      await withPortfolioServer([never, allDone], {}, async (handle) => {
        const { data } = await getJson(handle, "/api/portfolio");
        const d = data as {
          workspaces: Array<{
            label: string;
            inFlightCount: number;
            anyTaskEverRecorded: boolean;
            unreadableTaskCount: number;
          }>;
        };
        const byLabel = new Map(d.workspaces.map((w) => [w.label, w]));
        expect(byLabel.get("never")?.inFlightCount).toBe(0);
        expect(byLabel.get("all-done")?.inFlightCount).toBe(0);
        expect(byLabel.get("never")?.anyTaskEverRecorded).toBe(false);
        expect(byLabel.get("all-done")?.anyTaskEverRecorded).toBe(true);
        expect(byLabel.get("never")?.unreadableTaskCount).toBe(0);
        expect(byLabel.get("all-done")?.unreadableTaskCount).toBe(0);
      });
    } finally {
      await rm(rawA, { recursive: true, force: true });
      await rm(rawB, { recursive: true, force: true });
    }
  });

  it("surfaces an unreadable manifest as an error on the degraded card", async () => {
    const raw = await mkdtemp(join(tmpdir(), "basou-pf-corrupt-"));
    try {
      const ws = await realpath(raw);
      const paths = await ensureBasouDirectory(ws);
      await writeFile(paths.files.manifest, "::: not yaml :::\n");
      await withPortfolioServer([ws], {}, async (handle) => {
        const { data } = await getJson(handle, "/api/portfolio");
        const d = data as { workspaces: Array<{ initialized: boolean; error?: string }> };
        expect(d.workspaces).toHaveLength(1);
        expect(d.workspaces[0]?.initialized).toBe(false);
        expect(typeof d.workspaces[0]?.error).toBe("string");
      });
    } finally {
      await rm(raw, { recursive: true, force: true });
    }
  });

  it("shows an uninitialized path as a degraded card without failing the response", async () => {
    const raw = await mkdtemp(join(tmpdir(), "basou-pf-bare-"));
    try {
      const bare = await realpath(raw);
      await withPortfolioServer([bare], {}, async (handle) => {
        const { status, data } = await getJson(handle, "/api/portfolio");
        expect(status).toBe(200);
        const d = data as { workspaces: Array<{ initialized: boolean }> };
        expect(d.workspaces).toHaveLength(1);
        expect(d.workspaces[0]?.initialized).toBe(false);
      });
    } finally {
      await rm(raw, { recursive: true, force: true });
    }
  });
});

describe("basou view safety preflight", () => {
  // A planning workspace whose source_roots point at a sibling monitored repo
  // that already has a .basou footprint (the danger the preflight must catch).
  async function setupDangerousLayout(): Promise<{ root: string; ws: string }> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "basou-pf-safety-")));
    const ws = join(root, "ws");
    const mon = join(root, "mon");
    await mkdir(join(mon, ".basou"), { recursive: true });
    const paths = await ensureBasouDirectory(ws);
    await writeManifest(
      paths,
      createManifest({ workspaceName: "ws", workspaceId: WS_ID_A, sourceRoots: ["../mon"] }),
    );
    return { root, ws };
  }

  it("--check reports danger and does not start a server", async () => {
    const { root, ws } = await setupDangerousLayout();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    let listened = false;
    try {
      await doRunView(
        { port: 0, workspace: [ws], check: true },
        {
          cwd: root,
          openBrowser: () => {},
          ...hermeticLogRoots(),
          onListening: () => {
            listened = true;
          },
        },
      );
      expect(listened).toBe(false);
      expect(process.exitCode).toBe(1);
      expect(logs.join("\n")).toContain("DANGER");
    } finally {
      process.exitCode = 0;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("--check reports capture coverage against the whole registry", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "basou-pf-coverage-")));
    await mkdir(join(root, "ws"), { recursive: true });
    await mkdir(join(root, "other"), { recursive: true });
    const ws = await initWorkspaceAt(join(root, "ws"), WS_ID_A, "ws");
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: ws, env: ENV });
    // A SECOND registered workspace, so "no registered workspace imports this"
    // is distinguishable from "not the one workspace in the fixture".
    const other = await initWorkspaceAt(join(root, "other"), WS_ID_B, "other");
    await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: other, env: ENV });
    const config = join(root, "portfolio.yaml");
    await writeFile(config, `version: 1\nworkspaces:\n  - path: ${ws}\n  - path: ${other}\n`);
    const stray = join(root, "unregistered");
    for (const [id, cwd] of [
      ["cx-ws", ws],
      ["cx-other", other],
      ["cx-out", stray],
    ]) {
      const dir = join(getCodexRoot(), "2026", "09", "07");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `rollout-${id}.jsonl`),
        `${JSON.stringify({ type: "session_meta", payload: { id, cwd } })}\n`,
      );
    }
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    try {
      await doRunView(
        { port: 0, portfolio: true, check: true },
        { cwd: root, openBrowser: () => {}, portfolioConfigPath: config, ...hermeticLogRoots() },
      );
      const out = logs.join("\n");
      // Both registered workspaces' rollouts are attributed; only the stray one
      // is a gap. A single-workspace fixture could not tell these apart.
      expect(out).toContain("Capture coverage: 1 of 3 source log(s)");
      expect(out).toContain(stray);
      expect(out).not.toContain(other);
      // Coverage is informational: only safety findings set the exit code.
      expect(process.exitCode).not.toBe(1);
    } finally {
      process.exitCode = 0;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("--check omits capture coverage for ad-hoc --workspace paths", async () => {
    // `--workspace` REPLACES the registry, so a registry-wide claim would be
    // false there: every other registered workspace's logs would be reported as
    // imported by nothing.
    const root = await realpath(await mkdtemp(join(tmpdir(), "basou-pf-adhoc-")));
    await mkdir(join(root, "ws"), { recursive: true });
    const ws = await initWorkspaceAt(join(root, "ws"), WS_ID_A, "ws");
    const dir = join(getCodexRoot(), "2026", "09", "07");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "rollout-cx-out.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { id: "cx-out", cwd: "/elsewhere" } })}\n`,
    );
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    try {
      await doRunView(
        { port: 0, workspace: [ws], check: true },
        { cwd: root, openBrowser: () => {}, ...hermeticLogRoots() },
      );
      expect(logs.join("\n")).toContain("Portfolio safety:");
      expect(logs.join("\n")).not.toContain("Capture coverage");
    } finally {
      process.exitCode = 0;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("--check omits capture coverage in single-workspace mode", async () => {
    const repo = await setupInitedRepo();
    const dir = join(getCodexRoot(), "2026", "09", "07");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "rollout-cx-out.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { id: "cx-out", cwd: "/elsewhere" } })}\n`,
    );
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    try {
      await doRunView(
        { port: 0, check: true },
        { cwd: repo, openBrowser: () => {}, ...hermeticLogRoots() },
      );
      expect(logs.join("\n")).toContain("Portfolio safety:");
      expect(logs.join("\n")).not.toContain("Capture coverage");
    } finally {
      process.exitCode = 0;
    }
  });

  it("aborts portfolio start when the preflight finds danger", async () => {
    const { root, ws } = await setupDangerousLayout();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(
        doRunView({ port: 0, workspace: [ws] }, { cwd: root, openBrowser: () => {} }),
      ).rejects.toThrow(/safety preflight failed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("--skip-safety-check overrides the gate and starts the server", async () => {
    const { root, ws } = await setupDangerousLayout();
    try {
      await withPortfolioServer(
        [ws],
        {},
        async (handle) => {
          const { status } = await getJson(handle, "/api/portfolio");
          expect(status).toBe(200);
        },
        { skipSafetyCheck: true },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts the server despite a redundant entry (non-blocking) and warns on stderr", async () => {
    // A master and its own workspace view both registered: `redundant`, but not
    // a write risk, so the preflight must NOT gate the start (only footprint /
    // overlap do). Contrast with the danger test above, which refuses to launch.
    const root = await realpath(await mkdtemp(join(tmpdir(), "basou-pf-redundant-")));
    const master = join(root, "proj-planning");
    const view = join(root, "proj-workspace");
    await mkdir(view, { recursive: true }); // the throwaway view dir (no .basou)
    const paths = await ensureBasouDirectory(master);
    const manifest = createManifest({ workspaceName: "proj", workspaceId: WS_ID_A });
    manifest.workspace.view = "../proj-workspace";
    await writeManifest(paths, manifest);
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errs.push(a.map(String).join(" "));
    });
    try {
      await withPortfolioServer([master, view], {}, async (handle) => {
        const { status } = await getJson(handle, "/api/portfolio");
        expect(status).toBe(200); // the server DID start — redundant does not gate
      });
      expect(errs.join("\n")).toContain("non-blocking finding(s)");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("basou view (CLI wrapper)", () => {
  it("exits 1 with a pathless hint on an uninitialized workspace", async () => {
    const repo = await realpath(tmpRepo as string);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runView({ port: 0 }, { cwd: repo, openBrowser: () => {} });
    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.flat().join(" ")).toContain("Workspace not initialized");
  });

  it("exits 1 outside a git repository", async () => {
    const nonRepo = await realpath(await mkdtemp(join(tmpdir(), "basou-view-nongit-")));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runView({ port: 0 }, { cwd: nonRepo, openBrowser: () => {} });
      expect(process.exitCode).toBe(1);
      expect(errSpy.mock.calls.flat().join(" ")).toContain("Not a git repository");
    } finally {
      await rm(nonRepo, { recursive: true, force: true });
    }
  });
});

describe("the view page shows a recorded file name with its control characters escaped", () => {
  /** Lift a named function out of the served page (same approach as the card-label tests). */
  function lift(name: string): string {
    const marker = `function ${name}(`;
    const start = VIEW_HTML.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = -1;
    for (let i = VIEW_HTML.indexOf("{", start); i < VIEW_HTML.length; i++) {
      const ch = VIEW_HTML[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    expect(end).toBeGreaterThan(start);
    return VIEW_HTML.slice(start, end);
  }

  const ch = (code: number) => String.fromCharCode(code);
  const INPUTS = [
    "plain/path.ts",
    "new\n\n## Forged section\ntext\u001b[2J.txt",
    "tab\there\r.txt",
    `bidi${ch(0x202e)}gnp.exe`,
    `sep${ch(0x2028)}x${ch(0x2029)}y`,
    `c1${ch(0x9b)}${ch(0x9d)}${ch(0x85)}`,
    `edge${ch(0x1f)}${ch(0x20)}${ch(0x7e)}${ch(0x7f)}${ch(0xa0)}`,
    '\u65e5\u672c\u8a9e "q" back\\slash.md',
    "emoji \ud83d\ude00 ok",
  ];

  it("showPath agrees with @basou/core's displayPath on every input", () => {
    const showPath = new Function(`${lift("showPath")}; return showPath;`)() as (
      p: string,
    ) => string;
    for (const input of INPUTS) expect(showPath(input)).toBe(displayPath(input));
  });

  it("the timeline's file_changed line uses it", () => {
    const summary = new Function(
      `${lift("showPath")}; ${lift("eventSummary")}; return eventSummary;`,
    )() as (ev: Record<string, unknown>) => string;
    expect(summary({ type: "file_changed", path: "a\nb\u001b.txt", change_type: "added" })).toBe(
      "a\\nb\\x1b.txt [added]",
    );
  });
});

describe("basou view: the board page", () => {
  const [A_REC, B_REC, C_REC] = [
    "00000000010000000000000000",
    "00000000020000000000000000",
    "00000000030000000000000000",
  ];
  const STAGES = Object.fromEntries(
    ["01", "02", "03", "04", "05", "06"].map((id) => [id, { meaning: `stage ${id}` }]),
  );

  async function workspaceWith(repos?: RepoEntry[]): Promise<string> {
    const repo = await realpath(tmpRepo as string);
    const paths = await ensureBasouDirectory(repo);
    const manifest = createManifest({
      workspaceName: "view-ws",
      now: FIXED_DATE,
      workspaceId: FIXED_WS_ID,
    });
    await writeManifest(paths, repos === undefined ? manifest : { ...manifest, repos });
    return repo;
  }

  // Declare a board in the workspace, measure it and record a judgement of it.
  async function recorded(repo: string): Promise<string> {
    await mkdir(join(repo, "board"), { recursive: true });
    await writeFile(
      join(repo, "board", "board.yaml"),
      JSON.stringify({
        board_version: 1,
        title: "Board",
        stages: STAGES,
        lanes: [{ id: "core", name: "Core" }],
        axis: { version: 1, review_due_days: 60 },
        effort: { start: "2026-04-28", time_zone: "UTC" },
      }),
    );
    const ctx = {
      cwd: repo,
      nowProvider: () => FIXED_DATE,
      portfolioConfigPath: join(repo, ".portfolio.yaml"),
      claudeProjectsDir: getClaudeRoot(),
      codexSessionsDir: getCodexRoot(),
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const measured = await doRunBoardMeasure({ json: true }, ctx);
    const result = await doRunBoardRecord(
      {},
      {
        ...ctx,
        readInput: async () =>
          JSON.stringify({
            measure_digest: measured.digest,
            observed: { site: { value: null, observed_at: "2026-05-09", source: "s", error: "x" } },
            cells: ["01", "02", "03", "04", "05", "06"].map((stage) => ({
              lane: "core",
              stage,
              state: stage === "01" ? "done" : "none",
            })),
            prose: { summary: "Fine `here`." },
            judged_by: { model: "Claude Opus 5.5", self_reported: true },
          }),
      },
    );
    vi.restoreAllMocks();
    return (
      (result.record ?? "")
        .split("/")
        .at(-1)
        ?.replace(/\.json$/, "") ?? ""
    );
  }

  async function withView(
    repo: string,
    options: Partial<ViewOptions>,
    body: (handle: ViewServerHandle) => Promise<void>,
  ): Promise<void> {
    const controller = new AbortController();
    let handle: ViewServerHandle | undefined;
    let markReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const running = doRunView(
      { port: 0, ...options },
      {
        cwd: repo,
        signal: controller.signal,
        openBrowser: () => {},
        // The live board runs the dry run of an import: never over this host's logs.
        claudeProjectsDir: getClaudeRoot(),
        codexSessionsDir: getCodexRoot(),
        onListening: (h) => {
          handle = h;
          markReady();
        },
      },
    );
    await ready;
    try {
      if (handle === undefined) throw new Error("server never listened");
      await body(handle);
    } finally {
      controller.abort();
      await running;
    }
  }

  it("serves the page, and the records with the strings of the anchor's language", async () => {
    const repo = await workspaceWith([{ path: ".", visibility: "private", language: "ja" }]);
    const id = await recorded(repo);
    await withView(repo, {}, async (h) => {
      const page = await fetch(`${h.url}/board`);
      expect(page.status).toBe(200);
      expect(await page.text()).toBe(BOARD_HTML);
      const latest = await getJson(h, "/api/board");
      expect(latest.status).toBe(200);
      // The table of the anchor's language, not the English one.
      expect((latest.data as { strings: unknown }).strings).not.toEqual(boardPageStrings("en"));
      expect(latest.data).toMatchObject({
        language: "ja",
        strings: boardPageStrings("ja"),
        page: {
          status: "ok",
          id,
          older: null,
          newer: null,
          board: {
            heading: { title: "Board", model: "Claude Opus 5.5" },
            summary: {
              text: "Fine `here`.",
              observed: [{ name: "site", value: null, previous: { status: "none" } }],
            },
          },
        },
      });
      const scoped = await getJson(h, `/api/ws/${FIXED_WS_ID}/board/${id}`);
      expect(scoped.data).toMatchObject({ page: { status: "ok", id } });
      expect((await getJson(h, "/api/board/00000000010000000000000000")).data).toMatchObject({
        page: { status: "unavailable", why: "not_found" },
      });
      expect((await getJson(h, "/api/board/..%2F..%2Fx")).status).toBe(404);
    });
  });

  it("says why there is no board to show", async () => {
    const repo = await workspaceWith();
    await withView(repo, {}, async (h) => {
      expect((await getJson(h, "/api/board")).data).toMatchObject({
        language: "en",
        strings: boardPageStrings("en"),
        page: { status: "unavailable", why: "no_board" },
      });
    });
  });

  it("has no record to draw before the first one is written", async () => {
    const repo = await workspaceWith([{ path: ".", visibility: "private" }]);
    await withView(repo, {}, async (h) => {
      expect((await getJson(h, "/api/board")).data).toMatchObject({
        page: { status: "unavailable", why: "no_records", records: [] },
      });
    });
  });

  it("is not served in portfolio mode", async () => {
    const repo = await initWorkspaceAt(tmpRepo as string, WS_ID_A, "a");
    await withPortfolioServer([repo], {}, async (h) => {
      expect((await fetch(`${h.url}/board`)).status).toBe(404);
      expect((await getJson(h, `/api/ws/${WS_ID_A}/board`)).status).toBe(404);
      expect((await getJson(h, `/api/ws/${WS_ID_A}/board/live`)).status).toBe(404);
    });
  });

  it("serves the measurement on the spot in single mode only, whatever it is given", async () => {
    const root = await initWorkspaceAt(tmpRepo as string, WS_ID_A, "a");
    let measured = 0;
    const entry = {
      key: WS_ID_A,
      label: "a",
      paths: basouPaths(root),
      repoRoot: root,
      importCtx: { cwd: root },
      initialized: true,
    };
    const boardLive = () => {
      measured++;
      return measureLiveBoard(root, {
        claudeProjectsDir: getClaudeRoot(),
        codexSessionsDir: getCodexRoot(),
      });
    };
    for (const mode of ["portfolio", "single"] as const) {
      const h = await startViewServer({
        port: 0,
        deps: { workspaces: [entry], mode, nowProvider: () => FIXED_DATE, boardLive },
      });
      try {
        const status = (await getJson(h, `/api/ws/${WS_ID_A}/board/live`)).status;
        expect([mode, status]).toEqual([mode, mode === "single" ? 200 : 404]);
      } finally {
        await h.close();
      }
    }
    expect(measured).toBe(1);
  });

  it("shares one measurement among the requests made while it runs", async () => {
    let runs = 0;
    let finish: (value: number) => void = () => {};
    const shared = sharedWhileRunning(() => {
      runs++;
      return new Promise<number>((resolve) => {
        finish = resolve;
      });
    });
    const first = shared();
    const second = shared();
    expect(second).toBe(first);
    finish(1);
    expect(await first).toBe(1);
    // A call after it settled runs again.
    const third = shared();
    expect(third).not.toBe(first);
    finish(2);
    expect(await third).toBe(2);
    expect(runs).toBe(2);
  });

  it("measures the workspace on the spot when there is no board, whatever its visibility", async () => {
    const repo = await workspaceWith();
    await withView(repo, {}, async (h) => {
      const live = await getJson(h, "/api/board/live");
      expect(live.status).toBe(200);
      expect(live.data).toMatchObject({
        language: "en",
        strings: boardPageStrings("en"),
        live: {
          heading: { title: "view-ws", measured_at: expect.any(String) },
          effort: { milestones: [] },
          // The manifest declares no repos: the workspace's own repo.
          repos: [{ path: "." }],
          trail: { decisions_all: 0, tracks_open: [] },
          footnotes: { measured_with: { basou: expect.any(String) } },
        },
      });
      const data = live.data as Record<string, unknown>;
      expect(data).not.toHaveProperty("page");
      for (const key of ["matrix", "lanes", "turns", "composition", "summary"]) {
        expect(data.live).not.toHaveProperty(key);
      }
      const scoped = await getJson(h, `/api/ws/${FIXED_WS_ID}/board/live`);
      expect(scoped.status).toBe(200);
      expect(scoped.data).toMatchObject({ live: { heading: { title: "view-ws" } } });
    });
  });

  it("measures beside the records, in the anchor's language, and takes live for no record", async () => {
    const repo = await workspaceWith([{ path: ".", visibility: "private", language: "ja" }]);
    const id = await recorded(repo);
    await withView(repo, {}, async (h) => {
      expect((await getJson(h, "/api/board/live")).data).toMatchObject({
        language: "ja",
        strings: boardPageStrings("ja"),
        live: { heading: { title: "view-ws" }, repos: [{ path: "." }] },
      });
      expect((await getJson(h, "/api/board")).data).toMatchObject({ page: { status: "ok", id } });
      expect((await getJson(h, `/api/board/${id}`)).data).toMatchObject({ page: { id } });
      // Nothing was written beside the records.
      const records = await readdir(join(repo, "board", "records"));
      expect(records).toEqual([`${id}.json`]);
    });
  });

  it("takes no flag to point at a board: the command is guaranteed and the board is not", () => {
    const program = new Command();
    registerViewCommand(program);
    const view = program.commands.find((c) => c.name() === "view");
    expect(view?.options.map((o) => o.long)).toContain("--port");
    expect(view?.options.map((o) => o.long)).not.toContain("--board");
  });

  it("links to the page from the single-mode header, and only there", () => {
    expect(VIEW_HTML).toContain('<a id="board-link" href="/board" style="display:none">Board</a>');
    const shows = "$('board-link').style.display = '';";
    expect(liftFrom(VIEW_HTML, "enterSingle")).toContain(shows);
    expect(liftFrom(VIEW_HTML, "openWorkspace")).not.toContain("board-link");
    expect(VIEW_HTML.split(shows)).toHaveLength(2);
  });

  /** Lift a named function out of a page. */
  function liftFrom(html: string, name: string): string {
    const marker = `function ${name}(`;
    const start = html.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = html.indexOf("{", start); i < html.length; i++) {
      const ch = html[i];
      if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) return html.slice(start, i + 1);
    }
    throw new Error(`no end of ${name}`);
  }
  const lift = (name: string) => liftFrom(BOARD_HTML, name);
  /** Lift a top-level `var` of the board page, as the page declares it. */
  function liftVar(name: string): string {
    const start = BOARD_HTML.indexOf(`var ${name} = `);
    expect(start).toBeGreaterThan(-1);
    return BOARD_HTML.slice(start, BOARD_HTML.indexOf(";\n", start) + 1);
  }

  // Just enough of a DOM for the page's drawing functions.
  class Node {
    children: Node[] = [];
    attrs: Record<string, string> = {};
    className = "";
    textContent = "";
    selected = false;
    disabled = false;
    style: Record<string, string> = {};
    constructor(readonly tag: string) {}
    appendChild(child: Node): Node {
      this.children.push(child);
      return child;
    }
    get firstChild(): Node | null {
      return this.children[0] ?? null;
    }
    removeChild(child: Node): void {
      this.children = this.children.filter((c) => c !== child);
    }
    setAttribute(key: string, value: unknown): void {
      this.attrs[key] = String(value);
    }
    addEventListener(): void {}
    text(): string {
      return this.textContent + this.children.map((c) => c.text()).join("");
    }
    find(pick: (node: Node) => boolean): Node[] {
      return [...(pick(this) ? [this] : []), ...this.children.flatMap((c) => c.find(pick))];
    }
  }
  function drawing(names: string[]) {
    const byId: Record<string, Node> = {};
    const document = {
      createElement: (tag: string) => new Node(tag),
      createElementNS: (_ns: string, tag: string) => new Node(tag),
      createTextNode: (text: string) => Object.assign(new Node("#text"), { textContent: text }),
      getElementById: (id: string) => {
        byId[id] ??= new Node("div");
        return byId[id];
      },
    };
    const helpers = [
      "$",
      "clear",
      "el",
      "fill",
      "codeSpans",
      "prose",
      "reported",
      "num",
      "hm",
      "when",
      "shown",
      "stateName",
      "section",
      "svg",
      "hourStep",
      "monthTicks",
      "plotWidth",
      "dayX",
      "hours",
      "yAxis",
      "xAxis",
      "dayIndex",
      "labelWidth",
      "placeLabels",
      "timelineChart",
      "dailyChart",
      "cumulativeChart",
      "weeksTable",
    ];
    const source = [
      liftVar("SVGNS"),
      liftVar("CHART"),
      ...[...helpers, ...names.filter((n) => !helpers.includes(n))].map(lift),
    ].join("\n");
    const fns = new Function("document", "S", "lang", `${source}; return { ${names.join(", ")} };`)(
      document,
      boardPageStrings("en"),
      "en",
    ) as Record<string, (...args: unknown[]) => Node>;
    const call = (name: string, ...args: unknown[]): Node => {
      const fn = fns[name];
      if (fn === undefined) throw new Error(`no ${name}`);
      return fn(...args);
    };
    return { call, byId };
  }

  it("draws a page it cannot draw around the record asked for", () => {
    const { call, byId } = drawing(["records", "recordLinks"]);
    const records = [A_REC, B_REC, C_REC].map((id, i) => ({
      id,
      at: `2026-10-0${i + 1}T00:00:00.000Z`,
    }));
    call("records", {
      page: {
        status: "unavailable",
        why: "not_json",
        records,
        id: B_REC,
        older: A_REC,
        newer: C_REC,
      },
    });
    const nav = byId.records as Node;
    expect(nav.find((n) => n.tag === "a").map((a) => a.attrs.href)).toEqual([
      `/board?record=${A_REC}`,
      `/board?record=${C_REC}`,
      "/board",
      "/board?live=1",
    ]);
    const chosen = nav.find((n) => n.tag === "option" && n.selected);
    expect(chosen.map((o) => o.attrs.value)).toEqual([B_REC]);
    call("records", {
      page: {
        status: "unavailable",
        why: "not_found",
        records,
        id: "NOPE",
        older: null,
        newer: null,
      },
    });
    const none = nav.find((n) => n.tag === "option" && n.selected);
    expect(none.map((o) => [o.attrs.value, o.disabled])).toEqual([["", true]]);
  });

  it("marks a lane's marks as reported, and leaves out of the period what was not measured", () => {
    const { call } = drawing(["lanes", "effort", "footnotes"]);
    const lane = (flags: Record<string, boolean>) => ({
      id: "core",
      name: "Core",
      now: null,
      attention: [],
      prose: null,
      measures: [],
      flags: { live: false, blocked: false, unverified: false, ...flags },
    });
    const heads = (flags: Record<string, boolean>) =>
      call("lanes", { lanes: [lane(flags)] }).find((n) => n.tag === "h3");
    expect(heads({ blocked: true })[0]?.find((n) => n.className === "reported")).toHaveLength(1);
    expect(heads({})[0]?.find((n) => n.className === "reported")).toHaveLength(0);
    const effort = call("effort", {
      effort: {
        start: "2026-04-28",
        time_zone: null,
        elapsed_days: null,
        active_ms: { union: null, claude: null, codex: null },
        output_tokens: null,
        sessions_without_tokens: null,
        commits: null,
        milestones: [],
        active_days: null,
        daily: null,
        weeks: null,
      },
    }) as Node;
    const tiles = effort
      .find((n) => n.className === "tile")
      .map((t) => t.children.map((c) => c.text()));
    expect(tiles[0]).toEqual(["Elapsed", "not measured", "from 2026-04-28"]);
    expect(effort.text()).toContain(boardPageStrings("en").effort.noDays);
    expect(effort.find((n) => n.tag === "svg")).toHaveLength(0);
    const foot = call("footnotes", {
      footnotes: {
        notes: [],
        axis: { version: 1, review_needed: null, last_review: null, last_review_known: false },
        model: "m",
        not_found: [],
        measured_with: { basou: "0", build: null },
      },
    }) as Node;
    expect(foot.text()).toContain(boardPageStrings("en").footnotes.reviewUnknown);
    expect(foot.text()).not.toContain(boardPageStrings("en").footnotes.noReview);
  });

  it("draws the days of the effort: Claude's time, the rest above it, the running total and the weeks", () => {
    const { call } = drawing(["effort"]);
    const day = (
      date: string,
      union: number | null,
      claude: number | null,
      cumulative: number | null,
    ) => ({
      date,
      union,
      claude,
      not_claude: union === null || claude === null ? null : union - claude,
      cumulative,
      commits: 1,
    });
    const H = 3_600_000;
    const effort = call("effort", {
      effort: {
        start: "2026-04-30",
        time_zone: "UTC",
        elapsed_days: 4,
        active_ms: { union: 6 * H, claude: 4 * H, codex: 3 * H },
        output_tokens: 1000,
        sessions_without_tokens: 0,
        commits: [{ repo: ".", count: 3 }],
        milestones: [
          { date: "2026-05-01", label: "Started", ref: "abc" },
          // Outside the days drawn: listed, not charted.
          { date: "2026-04-01", label: "Before", ref: "x" },
        ],
        active_days: 2,
        period_days: 4,
        daily: [
          day("2026-04-30", 2 * H, 2 * H, 2 * H),
          day("2026-05-01", 4 * H, 2 * H, 6 * H),
          day("2026-05-02", null, null, null),
          day("2026-05-03", 0, 0, null),
        ],
        weeks: [
          {
            week: "2026-04-27",
            union: 6 * H,
            claude: 4 * H,
            codex: 3 * H,
            active_days: 2,
            commits: 4,
          },
        ],
      },
    });
    const tiles = effort
      .find((n) => n.className === "tile")
      .map((t) => t.children.map((c) => c.text()));
    expect(tiles.map((t) => t[0])).toEqual([
      "Elapsed",
      "Active",
      "Claude",
      "Codex",
      "Per day",
      "Output tokens",
    ]);
    expect(tiles[4]).toEqual(["Per day", "1h 30m", "3h 00m a day worked"]);
    const charts = effort.find((n) => n.tag === "svg");
    expect(charts).toHaveLength(3);
    const [timeline, daily, total] = charts as [Node, Node, Node];
    // One dot on the line for the milestone within the days, and its label.
    expect(timeline.find((n) => n.attrs.class === "dot")).toHaveLength(1);
    expect(timeline.text()).toContain("Started");
    expect(timeline.text()).not.toContain("Before");
    expect(effort.text()).toContain("Before");
    // Bars only where there was time: Claude on both days, the rest on the second, above Claude.
    const bars = (cls: string) => daily.find((n) => n.tag === "rect" && n.attrs.class === cls);
    expect(bars("claude")).toHaveLength(2);
    expect(bars("other")).toHaveLength(1);
    const [claude2, other2] = [bars("claude")[1] as Node, bars("other")[0] as Node];
    // The top of the stack is the day's total; the gap comes out of the upper bar.
    const at = (n: Node, key: string) => Number(n.attrs[key]);
    expect(at(other2, "y") + at(other2, "height")).toBeLessThan(at(claude2, "y"));
    expect(at(claude2, "y") - at(other2, "y")).toBeCloseTo(at(claude2, "height"), 5);
    expect(daily.find((n) => n.attrs.class === "hit").map((r) => r.text())[1]).toBe(
      "2026-05-01: active 4h 00m (Claude 2h 00m, not Claude 2h 00m), commits 1",
    );
    // The running total stops at the first day not measured.
    const line = total.find((n) => n.tag === "path")[0] as Node;
    expect(line.attrs.d?.trim().split(" L").length).toBe(2);
    expect(total.find((n) => n.attrs.class === "ms")).toHaveLength(1);
    const weekRows = effort.find((n) => n.tag === "tr").map((r) => r.children.map((c) => c.text()));
    expect(weekRows[1]).toEqual(["week of 2026-04-27", "6h 00m", "4h 00m", "3h 00m", "2", "4"]);
    // With no Codex session at all, its column says so rather than not measured.
    const solo = call("effort", {
      effort: {
        start: "2026-04-30",
        time_zone: "UTC",
        elapsed_days: 0,
        active_ms: { union: 2 * H, claude: 2 * H, codex: null },
        output_tokens: 0,
        sessions_without_tokens: 0,
        commits: [],
        milestones: [],
        active_days: 1,
        period_days: 1,
        daily: [day("2026-04-30", 2 * H, 2 * H, 2 * H)],
        weeks: [
          {
            week: "2026-04-27",
            union: 2 * H,
            claude: 2 * H,
            codex: null,
            active_days: 1,
            commits: 1,
          },
        ],
      },
    });
    const soloRows = solo.find((n) => n.tag === "tr").map((r) => r.children.map((c) => c.text()));
    expect(soloRows[1]?.[3]).toBe("-");
    // On the first day, the day so far is the day.
    const soloTiles = solo
      .find((n) => n.className === "tile")
      .map((t) => t.children.map((c) => c.text()));
    expect(soloTiles[4]).toEqual(["Per day", "2h 00m", "2h 00m a day worked"]);
  });

  it("labels the months under a chart without crowding, and the milestones inside it without overlap", () => {
    const document = {
      createElementNS: (_ns: string, tag: string) => new Node(tag),
    };
    const fns = new Function(
      "document",
      [
        liftVar("SVGNS"),
        liftVar("CHART"),
        ...["svg", "monthTicks", "plotWidth", "dayX", "xAxis", "labelWidth", "placeLabels"].map(
          lift,
        ),
        "return { xAxis: xAxis, placeLabels: placeLabels, labelWidth: labelWidth, CHART: CHART };",
      ].join("\n"),
    )(document) as {
      xAxis: (days: { date: string }[], base: number) => Node[];
      placeLabels: (
        items: { x: number; text: string }[],
        rows: number,
        centred: boolean,
      ) => { x: number; row: number; text: string }[];
      labelWidth: (text: string) => number;
      CHART: { w: number; left: number; right: number };
    };
    // A wide character is reckoned as wide as two narrow ones, near enough.
    expect(fns.labelWidth("ab")).toBeCloseTo(12.4, 5);
    expect(fns.labelWidth("\u5b9f\u88c5")).toBeCloseTo(22, 5);
    const days = Array.from({ length: 160 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 3, 28 + i)).toISOString().slice(0, 10),
    }));
    // The start and 5/1, three days on, are too close: 5/1 is left out.
    expect(fns.xAxis(days, 100).map((n) => n.textContent)).toEqual([
      "4/28",
      "6/1",
      "7/1",
      "8/1",
      "9/1",
      "10/1",
    ]);
    const { w, left, right } = fns.CHART;
    const long = "a milestone with a rather long label";
    // At either edge a label is kept inside the chart, centred or beside its mark.
    for (const centred of [true, false]) {
      const [atRight, atLeft] = fns.placeLabels(
        [
          { x: w - right - 2, text: long },
          { x: left + 2, text: long },
        ],
        4,
        centred,
      );
      expect(atRight?.x).toBeGreaterThanOrEqual(left);
      expect((atRight?.x ?? 0) + long.length * 6.2).toBeLessThanOrEqual(w - right + 1e-9);
      expect(atLeft?.x).toBeGreaterThanOrEqual(left);
    }
    // Two marks close together take two rows; one far off goes back to the first.
    const placed = fns.placeLabels(
      [
        { x: 200, text: long },
        { x: 210, text: long },
        { x: 650, text: "far" },
      ],
      4,
      false,
    );
    expect(placed.map((p) => p.row)).toEqual([0, 1, 0]);
  });

  // A board measured on the spot, as the live route lays it out.
  const LIVE = {
    heading: {
      title: "Board",
      measured_at: "2026-10-05T03:00:00.000Z",
      complete: false,
      not_found: 1,
    },
    effort: {
      start: "2026-10-04",
      time_zone: "UTC",
      elapsed_days: 1,
      active_ms: { union: 3_600_000, claude: 3_600_000, codex: null },
      output_tokens: 10,
      sessions_without_tokens: 0,
      commits: [{ repo: ".", count: 2 }],
      milestones: [],
      active_days: 1,
      period_days: 2,
      daily: [
        {
          date: "2026-10-04",
          union: 3_600_000,
          claude: 3_600_000,
          not_claude: 0,
          cumulative: 3_600_000,
          commits: 2,
        },
        {
          date: "2026-10-05",
          union: 0,
          claude: 0,
          not_claude: 0,
          cumulative: 3_600_000,
          commits: 0,
        },
      ],
      weeks: [
        {
          week: "2026-09-28",
          union: 3_600_000,
          claude: 3_600_000,
          codex: null,
          active_days: 1,
          commits: 2,
        },
      ],
    },
    repos: [
      {
        path: ".",
        name: "app",
        head: "0123456789abcdef0123456789abcdef01234567",
        branch: null,
        last_commit: null,
        commits: 2,
        uncommitted: 1,
        behind_main: null,
      },
    ],
    trail: {
      decisions_all: 3,
      decisions_live: 2,
      tracks_open: [{ id: "decision_01HXABCDEF1234567890ABCDEF", title: "<b>open</b>" }],
    },
    integrity: { by_status: { verified: 1 }, not_verified: 0, sessions: 1 },
    review_gaps: { by_verdict: { omission: 4 }, gaps: 4 },
    freshness: { newest_session_at: null, unimported: { new: 1, updated: 0, unverifiable: 0 } },
    components: [{ key: "app", kinds: ["ci", "manifest"] }],
    footnotes: {
      not_found: [
        { at: "freshness.newest_session_at", reason: "a session.yaml could not be read" },
      ],
      measured_with: { basou: "0.0.0-test", build: null },
    },
  };

  it("draws a board measured on the spot: what basou measured, nothing judged", () => {
    const names = [
      "missingIn",
      "liveTile",
      "liveHeading",
      "liveRepos",
      "liveTrail",
      "liveComponents",
      "liveFootnotes",
      "effort",
    ];
    const { call } = drawing(names);
    const S = boardPageStrings("en");
    const heading = call("liveHeading", LIVE, null);
    expect(heading.text()).toContain("Board");
    expect(heading.text()).toContain("Measured ");
    expect(heading.text()).toContain("1 could not be measured");
    expect(heading.find((n) => n.tag === "button").map((b) => b.textContent)).toEqual([
      S.live.remeasure,
    ]);

    const repos = call("liveRepos", LIVE);
    const cells = repos.find((n) => n.tag === "td").map((c) => c.textContent);
    // Nulls that mean so: a detached HEAD, no origin/main, a last commit unread.
    expect(cells).toEqual(["app", "-", "0123456", "-", "2", "1", "-"]);
    // Nulls the measurement could not measure are said to be.
    const unmeasured = {
      ...LIVE,
      repos: [
        LIVE.repos[0],
        {
          ...LIVE.repos[0],
          path: "../gone",
          name: null,
          head: null,
          commits: null,
          uncommitted: null,
        },
      ],
      footnotes: {
        ...LIVE.footnotes,
        not_found: [
          ...LIVE.footnotes.not_found,
          { at: "repos[.].branch", reason: "x" },
          { at: "repos[../gone]", reason: "not a git repository" },
        ],
      },
    };
    const rows = call("liveRepos", unmeasured)
      .find((n) => n.tag === "tr")
      .slice(1)
      .map((row) => row.find((n) => n.tag === "td").map((c) => c.textContent));
    expect(rows).toEqual([
      ["app", "not measured", "0123456", "-", "2", "1", "-"],
      [
        "../gone",
        "not measured",
        "not measured",
        "not measured",
        "not measured",
        "not measured",
        "not measured",
      ],
    ]);

    const trail = call("liveTrail", LIVE);
    // The newest session was not measured: not "no session".
    expect(trail.text()).toContain(S.tiles.notMeasured);
    expect(trail.text()).not.toContain(S.live.noSession);
    expect(trail.text()).toContain("not imported: 1 new, 0 updated, 0 unverifiable");
    expect(trail.text()).toContain("Sessions by basou verify status: verified 1");
    expect(trail.text()).toContain("Units of work by basou review-gaps verdict: omission 4");
    const unknown = call("liveTrail", {
      ...LIVE,
      integrity: { by_status: null, not_verified: null, sessions: null },
      review_gaps: { by_verdict: null, gaps: null },
      freshness: { newest_session_at: null, unimported: null },
    });
    expect(unknown.text()).toContain(S.live.unimportedNotMeasured);
    expect(unknown.text()).toContain("Sessions by basou verify status: not measured");
    expect(unknown.text()).toContain("Units of work by basou review-gaps verdict: not measured");
    // A track's title is text, never markup.
    expect(trail.find((n) => n.tag === "b")).toEqual([]);
    expect(trail.text()).toContain("<b>open</b>");

    const components = call("liveComponents", LIVE);
    expect(components.find((n) => n.tag === "code").map((c) => c.textContent)).toEqual(["app"]);
    expect(components.text()).toContain("ci, manifest");

    const noBoard = call("liveFootnotes", LIVE, "no_board");
    for (const s of [S.live.note, S.live.judged, S.unavailable.noBoard, S.footnotes.notMeasured]) {
      expect(noBoard.text()).toContain(s);
    }
    expect(noBoard.text()).toContain(
      "freshness.newest_session_at: a session.yaml could not be read",
    );
    expect(call("liveFootnotes", LIVE, null).text()).not.toContain(S.unavailable.noBoard);

    // The period and effort are drawn as a record's are.
    expect(call("effort", LIVE).find((n) => n.tag === "figure").length).toBeGreaterThan(0);
  });

  // Run the page's script as a browser would, with a fake DOM and a fake fetch
  // that answers each URL from `responses`.
  async function runPage(search: string, responses: Record<string, unknown>) {
    const script = BOARD_HTML.slice(
      BOARD_HTML.indexOf("<script>") + "<script>".length,
      BOARD_HTML.indexOf("</script>"),
    );
    const byId: Record<string, Node> = {};
    const fetched: string[] = [];
    const document = {
      createElement: (tag: string) => new Node(tag),
      createElementNS: (_ns: string, tag: string) => new Node(tag),
      createTextNode: (text: string) => Object.assign(new Node("#text"), { textContent: text }),
      getElementById: (id: string) => {
        byId[id] ??= new Node("div");
        return byId[id];
      },
      documentElement: { lang: "" },
      title: "",
    };
    const fetch = async (url: string) => {
      fetched.push(url);
      const body = responses[url];
      return {
        ok: body !== undefined,
        status: body === undefined ? 404 : 200,
        json: async () => body ?? { error: "Not found" },
      };
    };
    new Function("document", "location", "fetch", script)(document, { search }, fetch);
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    // A page that never drew has no navigation at all.
    const links = (byId.records?.find((n) => n.tag === "a") ?? []).map((a) => a.attrs.href);
    return { fetched, byId, links, document };
  }

  const STRINGS = { language: "en", strings: boardPageStrings("en") };
  const NO_RECORDS = {
    ...STRINGS,
    page: { status: "unavailable", why: "no_records", records: [] },
  };
  const LIVE_BODY = { ...STRINGS, live: LIVE };

  it("measures on the spot when there is no board or no record to draw", async () => {
    for (const why of ["no_board", "no_records"]) {
      const page = await runPage("", {
        "/api/board": { ...STRINGS, page: { status: "unavailable", why, records: [] } },
        "/api/board/live": LIVE_BODY,
      });
      expect(page.fetched).toEqual(["/api/board", "/api/board/live"]);
      const board = page.byId.board as Node;
      expect(board.find((n) => n.tag === "h1").map((h) => h.textContent)).toEqual(["Board"]);
      expect(board.text().includes(boardPageStrings("en").unavailable.noBoard)).toBe(
        why === "no_board",
      );
      // Not asked for: there is no record to lead back to.
      expect(page.links).toEqual([]);
      expect((page.byId.status as Node).textContent).toBe("");
    }
  });

  it("says why a record cannot be drawn, and links to the measurement on the spot", async () => {
    const page = await runPage("", {
      "/api/board": {
        ...STRINGS,
        page: { status: "unavailable", why: "records_unreadable", records: [] },
      },
      "/api/board/live": LIVE_BODY,
    });
    expect(page.fetched).toEqual(["/api/board"]);
    expect((page.byId.status as Node).textContent).toBe(
      boardPageStrings("en").unavailable.recordsUnreadable,
    );
    expect(page.links).toEqual(["/board?live=1"]);
  });

  it("measures when asked with ?live=1, leading back to the records only when there are some", async () => {
    const alone = await runPage("?live=1", {
      "/api/board/live": LIVE_BODY,
      "/api/board": NO_RECORDS,
    });
    expect(alone.fetched).toEqual(["/api/board/live", "/api/board"]);
    expect((alone.byId.board as Node).find((n) => n.tag === "h1").length).toBe(1);
    expect(alone.links).toEqual([]);
    const withRecords = await runPage("?live=1", {
      "/api/board/live": LIVE_BODY,
      "/api/board": {
        ...STRINGS,
        page: {
          status: "unavailable",
          why: "not_json",
          records: [{ id: A_REC, at: "2026-10-01T00:00:00.000Z" }],
        },
      },
    });
    expect(withRecords.links).toEqual(["/board"]);
    // A measurement that fails says so.
    const failed = await runPage("?live=1", {});
    expect(failed.fetched).toEqual(["/api/board/live"]);
    expect((failed.byId.status as Node).textContent).toBe("Not found");
  });

  it("builds prose of text nodes, with only a span between backticks as a code element", () => {
    const document = {
      createElement: (tag: string) => new Node(tag),
      createTextNode: (text: string) => Object.assign(new Node("#text"), { textContent: text }),
    };
    const prose = new Function(
      "document",
      `${lift("el")}; ${lift("codeSpans")}; ${lift("prose")}; return prose;`,
    )(document) as (text: string) => Node;
    const node = prose("a `<b>x</b>` <i>c</i> ``");
    expect(node.children.map((c) => [c.tag, c.textContent])).toEqual([
      ["#text", "a "],
      ["code", "<b>x</b>"],
      ["#text", " <i>c</i> ``"],
    ]);
  });

  it("puts text in without markup, a span between backticks as code and nothing else", () => {
    expect(BOARD_HTML).not.toContain("innerHTML");
    const codeSpans = new Function(`${lift("codeSpans")}; return codeSpans;`)() as (
      text: string,
    ) => { code: boolean; text: string }[];
    expect(codeSpans("run `basou board` now")).toEqual([
      { code: false, text: "run " },
      { code: true, text: "basou board" },
      { code: false, text: " now" },
    ]);
    expect(codeSpans("a `b` c `d")).toEqual([
      { code: false, text: "a " },
      { code: true, text: "b" },
      { code: false, text: " c `d" },
    ]);
    expect(codeSpans("`<b>x</b>`")).toEqual([{ code: true, text: "<b>x</b>" }]);
    expect(codeSpans("`")).toEqual([{ code: false, text: "`" }]);
    const fill = new Function(`${lift("fill")}; return fill;`)() as (
      template: string,
      values: Record<string, unknown>,
    ) => string;
    expect(fill("{n} of {n} and {m}", { n: 2 })).toBe("2 of 2 and {m}");
    // What a value holds is never filled in itself.
    expect(fill("{a} then {b}", { a: "{b}", b: "x" })).toBe("{b} then x");
    expect(codeSpans("x `` y")).toEqual([{ code: false, text: "x `` y" }]);
    const hourStep = new Function(`${lift("hourStep")}; return hourStep;`)() as (
      h: number,
    ) => number;
    expect([1, 5, 6, 26, 384, 2600, 9000].map(hourStep)).toEqual([1, 1, 2, 10, 100, 1000, 2000]);
    const num = new Function("S", `${lift("num")}; return num;`)(boardPageStrings("en")) as (
      n: unknown,
    ) => string;
    expect([num(0.333333), num(1234567), num(null), num("12")]).toEqual([
      "0.3333",
      "1,234,567",
      "not measured",
      "12",
    ]);
  });
});

describe("basou view from a workspace view", () => {
  it("resolves a git-untracked view to the repo it links", async () => {
    const repo = await setupInitedRepo();
    const view = await mkdtemp(join(tmpdir(), "basou-view-view-"));
    try {
      await symlink(repo, join(view, "fixture-planning"));
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      await withServer(view, {}, async (handle) => {
        const { status, data } = await getJson(handle, "/api/overview");
        expect(status).toBe(200);
        expect((data as { repoRoot: string }).repoRoot).toBe(repo);
      });
      expect(err.mock.calls.flat().join(" ")).toContain("Resolved workspace view to");
    } finally {
      await rm(view, { recursive: true, force: true });
    }
  });
});

describe("basou view --workspace: an uninitialized card", () => {
  it("refuses a refresh or an import, writing nothing where its import resolves", async () => {
    // A workspace view registered beside the repo it links: its card has no
    // store, while an import run in it resolves to the linked repo.
    const planning = await setupInitedRepo();
    const view = await realpath(await mkdtemp(join(tmpdir(), "basou-pf-view-card-")));
    try {
      await symlink(planning, join(view, "fixture-planning"));
      vi.spyOn(console, "error").mockImplementation(() => {});
      await withPortfolioServer([view, planning], hermeticLogRoots(), async (handle) => {
        const { data } = await getJson(handle, "/api/portfolio");
        const cards = (data as { workspaces: Array<{ key: string; initialized: boolean }> })
          .workspaces;
        const card = cards.find((w) => !w.initialized);
        if (card === undefined) throw new Error("expected an uninitialized card");
        for (const sub of ["refresh", "import/claude-code", "import/codex"]) {
          const r = await postJson(handle, `/api/ws/${encodeURIComponent(card.key)}/${sub}`, {});
          expect(r.status).toBe(500);
          expect(r.data).toEqual({ error: "Workspace not initialized. Run 'basou init' first." });
        }
      });
      expect(await readdir(basouPaths(planning).sessions)).toEqual([]);
      expect(await readdir(view)).toEqual(["fixture-planning"]);
    } finally {
      await rm(view, { recursive: true, force: true });
    }
  });
});
