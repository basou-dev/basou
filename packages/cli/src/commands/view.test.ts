import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { basouPaths, createManifest, ensureBasouDirectory, writeManifest } from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewServerHandle } from "../lib/view-server.js";
import { doRunView, runView, type ViewContext } from "./view.js";

const execFileAsync = promisify(execFile);

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
const FIXED_WS_ID = "ws_01HXABCDEF1234567890ABCDEF" as const;
const FIXED_DATE = new Date("2026-05-09T03:00:00.000Z");

let tmpRepo: string | undefined;
let codexRoot: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "basou-view-test-"));
  codexRoot = await mkdtemp(join(tmpdir(), "basou-view-codex-"));
  await execFileAsync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: tmpRepo, env: ENV });
  await execFileAsync("git", ["config", "user.email", "t@e.com"], { cwd: tmpRepo, env: ENV });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: tmpRepo, env: ENV });
});

afterEach(async () => {
  for (const dir of [tmpRepo, codexRoot]) {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
  tmpRepo = undefined;
  codexRoot = undefined;
  process.exitCode = 0;
  vi.restoreAllMocks();
});

function getCodexRoot(): string {
  if (codexRoot === undefined) throw new Error("codexRoot not initialized");
  return codexRoot;
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
  const running = doRunView({ port: 0, workspace: workspacePaths }, ctx);
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
    });
  });

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
