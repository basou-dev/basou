import {
  assertBasouRootSafe,
  basouPaths,
  findErrorCode,
  renderOrientation,
  resolveRepositoryRoot,
  writeMarkdownFile,
} from "@basou/core";
import type { Command } from "commander";
import {
  isVerbose,
  printReplayWarning,
  printSessionSkip,
  printTaskSkip,
  renderCliError,
} from "../lib/error-render.js";

export type OrientOptions = { verbose?: boolean; quiet?: boolean };

export type OrientContext = {
  /** Defaults to `process.cwd()`. Injectable for tests. */
  cwd?: string;
  /** Defaults to `() => new Date()`. Injectable for tests. */
  nowProvider?: () => Date;
};

/**
 * Wire `basou orient` onto `program`. A read-first "where am I" command: it
 * renders the current position, writes `.basou/orientation.md`, and prints the
 * body to stdout by default. It runs NO import — the freshness section reflects
 * already-captured state, so a stale capture is visible (use `basou refresh` to
 * re-import).
 */
export function registerOrientCommand(program: Command): void {
  program
    .command("orient")
    .description("Show the workspace's current position (also writes .basou/orientation.md)")
    .option("-q, --quiet", "Write the file without printing the body")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: OrientOptions) => {
      await runOrient(opts);
    });
}

/**
 * Programmatic entry that owns `process.exitCode`. Tests that only care about
 * the happy path or a thrown error should prefer {@link doRunOrient}.
 */
export async function runOrient(options: OrientOptions, ctx: OrientContext = {}): Promise<void> {
  try {
    await doRunOrient(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Pure runner for `orient`. Throws on any failure with a pathless message;
 * native errors are attached as `cause` for verbose surfacing.
 */
export async function doRunOrient(options: OrientOptions, ctx: OrientContext): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForOrient(cwd);
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  const nowIso = (ctx.nowProvider?.() ?? new Date()).toISOString();
  const result = await renderOrientation({
    paths,
    nowIso,
    onWarning: (w, sid) => printReplayWarning(w, sid),
    onSessionSkip: (sid, reason) => printSessionSkip(sid, reason),
    onTaskSkip: (taskId, reason) => printTaskSkip(taskId, reason),
  });

  // orientation.md is a transient, gitignored snapshot: overwrite the whole
  // file (no GENERATED markers — there is no hand-edited region to preserve).
  await writeMarkdownFile(paths.files.orientation, `${result.body}\n`);

  if (options.quiet === true) {
    console.log(
      `Generated .basou/orientation.md (sessions: ${result.sessionCount}, in-flight tasks: ${result.inFlightTaskCount}, pending approvals: ${result.pendingApprovalsCount}, suspect: ${result.suspectCount})`,
    );
  } else {
    console.log(result.body);
  }
}

async function resolveRepositoryRootForOrient(cwd: string): Promise<string> {
  try {
    return await resolveRepositoryRoot(cwd);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Not a git repository") {
      throw new Error("Not a git repository. Run 'git init' first, then re-run 'basou orient'.", {
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
