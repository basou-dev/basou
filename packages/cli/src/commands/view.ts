import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import {
  assertBasouRootSafe,
  basouPaths,
  findErrorCode,
  readManifest,
  resolveRepositoryRoot,
} from "@basou/core";
import { type Command, InvalidArgumentError } from "commander";
import { isVerbose, renderCliError } from "../lib/error-render.js";
import { loadPortfolioConfig, type PortfolioWorkspace } from "../lib/portfolio-config.js";
import { checkPortfolioSafety, formatSafetyReport } from "../lib/portfolio-safety.js";
import {
  type RemoteUrlResolver,
  startViewServer,
  type ViewServerDeps,
  type ViewServerHandle,
  type WorkspaceEntry,
} from "../lib/view-server.js";
import type { ImportContext } from "./import.js";

const DEFAULT_PORT = 4319;

export type ViewOptions = {
  port?: number;
  open?: boolean;
  verbose?: boolean;
  /** Read `~/.basou/portfolio.yaml` and serve every listed workspace. */
  portfolio?: boolean;
  /** Ad-hoc workspace paths (repeatable); resolved against the cwd. Implies portfolio mode. */
  workspace?: string[];
  /** Run the portfolio safety preflight and exit (no server). */
  check?: boolean;
  /** Skip the portfolio safety preflight on start (not recommended). */
  skipSafetyCheck?: boolean;
};

export type ViewContext = {
  /** Defaults to `process.cwd()`. Injectable for tests. */
  cwd?: string;
  /** Defaults to `() => new Date()`. Injectable for tests. */
  nowProvider?: () => Date;
  /** Override the `~/.claude/projects` root used by imports. */
  claudeProjectsDir?: string;
  /** Override the `~/.codex/sessions` root used by imports. */
  codexSessionsDir?: string;
  /** Override how the browser is opened (tests pass a no-op). */
  openBrowser?: (url: string) => void;
  /** Resolves the keep-alive wait, so tests can stop the server without a signal. */
  signal?: AbortSignal;
  /** Called once the server is listening, with its handle (for tests). */
  onListening?: (handle: ViewServerHandle) => void;
  /** Override the portfolio config path (tests). */
  portfolioConfigPath?: string;
  /** Override the live roster remote-URL resolver (tests); defaults to core's tryRemoteUrl. */
  remoteUrlOf?: RemoteUrlResolver;
};

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError("Port must be an integer between 1 and 65535.");
  }
  return port;
}

/**
 * Commander collector: accumulate a repeatable option into an array. Commander
 * passes `undefined` as `previous` on the first occurrence (no option default),
 * so default it to `[]` rather than spreading `undefined`.
 */
function collectPath(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/**
 * Wire `basou view` onto `program`. Starts a localhost-only web UI for
 * browsing provenance and running imports / regeneration by clicking. With
 * `--portfolio` / `--workspace` it serves several workspaces side by side.
 */
export function registerViewCommand(program: Command): void {
  program
    .command("view")
    .description("Open a local web UI to browse provenance and run imports (localhost only)")
    .option("--port <number>", "Port to listen on (default 4319)", parsePort)
    .option("--no-open", "Do not open the browser automatically")
    .option(
      "--portfolio",
      "Serve every workspace listed in ~/.basou/portfolio.yaml (cross-repo orientation)",
    )
    .option(
      "--workspace <path>",
      "Workspace repo path to include (repeatable; implies portfolio mode; resolved against the cwd)",
      collectPath,
    )
    .option("--check", "Run the portfolio safety preflight and exit (no server)")
    .option("--skip-safety-check", "Skip the portfolio safety preflight on start (not recommended)")
    .option("-v, --verbose", "Show error causes")
    .action(async (options: ViewOptions) => {
      await runView(options);
    });
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunView}. */
export async function runView(options: ViewOptions, ctx: ViewContext = {}): Promise<void> {
  try {
    await doRunView(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Pure runner: resolve the workspace(s), start the server, open the browser, and
 * keep running until SIGINT / SIGTERM (or an injected abort signal). The
 * server is always closed on the way out.
 */
export async function doRunView(options: ViewOptions, ctx: ViewContext): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const workspaceFlags = options.workspace ?? [];
  const isPortfolio = workspaceFlags.length > 0 || options.portfolio === true;

  const deps = isPortfolio
    ? await buildPortfolioDeps(workspaceFlags, ctx, cwd)
    : await buildSingleDeps(ctx, cwd);

  // --check: run the read-only safety preflight and exit (no server).
  if (options.check === true) {
    const result = await checkPortfolioSafety(deps.workspaces);
    for (const line of formatSafetyReport(result)) console.log(line);
    if (result.findings.length > 0) process.exitCode = 1;
    return;
  }

  // Portfolio start auto-gates on the preflight. A footprint / overlap means a
  // monitored repo has (or would get) a `.basou/` — an irreversible write risk —
  // so the server is NOT started. An `unverifiable` item (e.g. an unreadable
  // manifest) cannot cause a write through the read-only view, so it is warned
  // about but does not block; `basou view --check` flags it strictly.
  // `--skip-safety-check` overrides the abort entirely.
  if (deps.mode === "portfolio" && options.skipSafetyCheck !== true) {
    const result = await checkPortfolioSafety(deps.workspaces);
    const blocking = result.findings.filter((f) => f.kind === "footprint" || f.kind === "overlap");
    if (blocking.length > 0) {
      for (const line of formatSafetyReport(result)) console.error(line);
      throw new Error(
        "Portfolio safety preflight failed (see findings above). Fix the monitored repos, or re-run with --skip-safety-check to override.",
      );
    }
    if (result.findings.length > 0) {
      console.error(
        `Portfolio safety: ${result.findings.length} unverifiable item(s) — the read-only view will still open; run 'basou view --check' for detail.`,
      );
    }
  }

  const port = options.port ?? DEFAULT_PORT;
  const handle = await startListening(port, deps);

  // Everything past listen runs under try/finally so a throw from the browser
  // launch or the onListening callback still closes the server.
  try {
    console.log(`basou view running at ${handle.url}`);
    if (deps.mode === "portfolio") {
      console.log(`Portfolio mode: ${deps.workspaces.length} workspace(s).`);
    }
    console.log(
      "Localhost only, no authentication. Do not expose this port beyond your machine. Press Ctrl+C to stop.",
    );

    if (options.open !== false) {
      openInBrowser(handle.url, ctx.openBrowser);
    }
    ctx.onListening?.(handle);

    await waitForShutdown(ctx.signal);
  } finally {
    await handle.close();
  }
}

/** Single-workspace mode: resolve the cwd's repo (git required) and serve it alone. */
async function buildSingleDeps(ctx: ViewContext, cwd: string): Promise<ViewServerDeps> {
  const repositoryRoot = await resolveRepositoryRootForView(cwd);
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);
  const entry = await buildWorkspaceEntry(repositoryRoot, ctx);
  return {
    workspaces: [entry],
    mode: "single",
    nowProvider: nowProviderOf(ctx),
    ...(ctx.remoteUrlOf !== undefined ? { remoteUrlOf: ctx.remoteUrlOf } : {}),
  };
}

/**
 * Portfolio mode: serve several workspaces. Sources are the explicit
 * `--workspace` flags (resolved against the cwd) or, absent those,
 * `~/.basou/portfolio.yaml`. No git check and no "initialized" assertion — a
 * missing / uninitialized path becomes a degraded card rather than an error.
 */
async function buildPortfolioDeps(
  workspaceFlags: string[],
  ctx: ViewContext,
  cwd: string,
): Promise<ViewServerDeps> {
  const specs: PortfolioWorkspace[] =
    workspaceFlags.length > 0
      ? workspaceFlags.map((p) => ({ path: resolve(cwd, p) }))
      : await loadPortfolioConfig(ctx.portfolioConfigPath);

  const entries: WorkspaceEntry[] = [];
  const seenPath = new Set<string>();
  const seenKey = new Set<string>();
  for (const spec of specs) {
    const repoRoot = resolve(spec.path);
    if (seenPath.has(repoRoot)) continue;
    seenPath.add(repoRoot);
    const entry = await buildWorkspaceEntry(repoRoot, ctx, spec.label);
    let key = entry.key;
    for (let n = 1; seenKey.has(key); n++) key = `${entry.key}-${n}`;
    seenKey.add(key);
    entries.push({ ...entry, key });
  }
  if (entries.length === 0) throw new Error("No workspaces to show.");
  return {
    workspaces: entries,
    mode: "portfolio",
    nowProvider: nowProviderOf(ctx),
    ...(ctx.remoteUrlOf !== undefined ? { remoteUrlOf: ctx.remoteUrlOf } : {}),
  };
}

/**
 * Build one workspace entry from a repo root. Reads the manifest best-effort for
 * a stable key (workspace id) and label; an unreadable manifest yields a
 * degraded entry keyed by a path hash (never the path itself, to stay pathless).
 */
async function buildWorkspaceEntry(
  repoRoot: string,
  ctx: ViewContext,
  labelOverride?: string,
): Promise<WorkspaceEntry> {
  const paths = basouPaths(repoRoot);
  const importCtx: ImportContext = {
    cwd: repoRoot,
    ...(ctx.claudeProjectsDir !== undefined ? { claudeProjectsDir: ctx.claudeProjectsDir } : {}),
    ...(ctx.codexSessionsDir !== undefined ? { codexSessionsDir: ctx.codexSessionsDir } : {}),
  };
  try {
    const manifest = await readManifest(paths);
    return {
      key: manifest.workspace.id,
      label: labelOverride ?? manifest.workspace.name,
      paths,
      repoRoot,
      importCtx,
      initialized: true,
    };
  } catch (error: unknown) {
    // "YAML file not found" (ENOENT) = never initialized; anything else (parse /
    // permission error) = present but unreadable, surfaced so the card can say so.
    const notFound = error instanceof Error && error.message === "YAML file not found";
    return {
      key: `ws-${createHash("sha1").update(repoRoot).digest("hex").slice(0, 12)}`,
      label: labelOverride ?? basename(repoRoot),
      paths,
      repoRoot,
      importCtx,
      initialized: false,
      ...(notFound ? {} : { manifestError: "manifest unreadable or invalid" }),
    };
  }
}

function nowProviderOf(ctx: ViewContext): () => Date {
  return ctx.nowProvider ?? (() => new Date());
}

async function startListening(port: number, deps: ViewServerDeps): Promise<ViewServerHandle> {
  try {
    return await startViewServer({ port, deps });
  } catch (error: unknown) {
    if (findErrorCode(error, "EADDRINUSE")) {
      throw new Error(`Port ${port} is already in use. Pass --port <n> to choose another.`, {
        cause: error,
      });
    }
    throw error;
  }
}

function openInBrowser(url: string, override?: (url: string) => void): void {
  if (override !== undefined) {
    override(url);
    return;
  }
  if (process.platform !== "darwin") return; // print-only elsewhere
  try {
    const child = spawn("open", [url], { stdio: "ignore", detached: true });
    child.on("error", () => {}); // browser launch is best-effort
    child.unref();
  } catch {
    // ignore: the URL is already printed
  }
}

/** Resolve once the process is asked to stop (signal) or the injected abort fires. */
function waitForShutdown(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const cleanup = (): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      signal?.removeEventListener("abort", onAbort);
    };
    const onSignal = (): void => {
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      cleanup();
      resolve();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    if (signal !== undefined) {
      if (signal.aborted) {
        cleanup();
        resolve();
        return;
      }
      signal.addEventListener("abort", onAbort);
    }
  });
}

async function resolveRepositoryRootForView(cwd: string): Promise<string> {
  try {
    return await resolveRepositoryRoot(cwd);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Not a git repository") {
      throw new Error("Not a git repository. Run 'git init' first, then re-run 'basou view'.", {
        cause: error,
      });
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
