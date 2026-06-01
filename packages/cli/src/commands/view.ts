import { spawn } from "node:child_process";
import { assertBasouRootSafe, basouPaths, findErrorCode, resolveRepositoryRoot } from "@basou/core";
import { type Command, InvalidArgumentError } from "commander";
import { isVerbose, renderCliError } from "../lib/error-render.js";
import { startViewServer, type ViewServerDeps, type ViewServerHandle } from "../lib/view-server.js";

const DEFAULT_PORT = 4319;

export type ViewOptions = {
  port?: number;
  open?: boolean;
  verbose?: boolean;
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
};

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError("Port must be an integer between 1 and 65535.");
  }
  return port;
}

/**
 * Wire `basou view` onto `program`. Starts a localhost-only web UI for
 * browsing provenance and running imports / regeneration by clicking.
 */
export function registerViewCommand(program: Command): void {
  program
    .command("view")
    .description("Open a local web UI to browse provenance and run imports (localhost only)")
    .option("--port <number>", "Port to listen on (default 4319)", parsePort)
    .option("--no-open", "Do not open the browser automatically")
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
 * Pure runner: resolve the workspace, start the server, open the browser, and
 * keep running until SIGINT / SIGTERM (or an injected abort signal). The
 * server is always closed on the way out.
 */
export async function doRunView(options: ViewOptions, ctx: ViewContext): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForView(cwd);
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  const deps: ViewServerDeps = {
    paths,
    repoRoot: repositoryRoot,
    importCtx: {
      cwd: repositoryRoot,
      ...(ctx.claudeProjectsDir !== undefined ? { claudeProjectsDir: ctx.claudeProjectsDir } : {}),
      ...(ctx.codexSessionsDir !== undefined ? { codexSessionsDir: ctx.codexSessionsDir } : {}),
    },
    nowProvider: ctx.nowProvider ?? (() => new Date()),
  };

  const port = options.port ?? DEFAULT_PORT;
  const handle = await startListening(port, deps);

  console.log(`basou view running at ${handle.url}`);
  console.log(
    "Localhost only, no authentication. Do not expose this port beyond your machine. Press Ctrl+C to stop.",
  );

  if (options.open !== false) {
    openInBrowser(handle.url, ctx.openBrowser);
  }
  ctx.onListening?.(handle);

  try {
    await waitForShutdown(ctx.signal);
  } finally {
    await handle.close();
  }
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
