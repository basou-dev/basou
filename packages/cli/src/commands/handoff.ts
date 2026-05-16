import {
  assertBasouRootSafe,
  basouPaths,
  findErrorCode,
  readMarkdownFile,
  renderHandoff,
  renderWithMarkers,
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

export type HandoffGenerateOptions = { verbose?: boolean };

export type HandoffContext = {
  /** Defaults to `process.cwd()`. Injectable for tests. */
  cwd?: string;
  /** Defaults to `() => new Date()`. Injectable for tests. */
  nowProvider?: () => Date;
};

/**
 * Wire `basou handoff generate` onto `program`. The `handoff` group is
 * registered up front so future subcommands (e.g. `show`) can slot under
 * the same group without breaking the CLI surface.
 */
export function registerHandoffCommand(program: Command): void {
  const handoff = program.command("handoff").description("Generate or inspect .basou/handoff.md");

  handoff
    .command("generate")
    .description("Regenerate .basou/handoff.md from current session state")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: HandoffGenerateOptions) => {
      await runHandoffGenerate(opts);
    });
}

/**
 * Programmatic entry that owns `process.exitCode`. Tests that only care
 * about the happy path or a thrown error should prefer {@link doRunHandoffGenerate}.
 */
export async function runHandoffGenerate(
  options: HandoffGenerateOptions,
  ctx: HandoffContext = {},
): Promise<void> {
  try {
    await doRunHandoffGenerate(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Pure runner for `handoff generate`. Throws on any failure with a pathless
 * message; native errors are attached as `cause` for verbose surfacing.
 */
export async function doRunHandoffGenerate(
  options: HandoffGenerateOptions,
  ctx: HandoffContext,
): Promise<void> {
  void options;
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForHandoff(cwd);
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  const nowIso = (ctx.nowProvider?.() ?? new Date()).toISOString();
  const result = await renderHandoff({
    paths,
    nowIso,
    onWarning: (w, sid) => printReplayWarning(w, sid),
    onSessionSkip: (sid, reason) => printSessionSkip(sid, reason),
    onTaskSkip: (taskId, reason) => printTaskSkip(taskId, reason),
  });

  const existing = await readMarkdownFile(paths.files.handoff);
  const finalBody = renderWithMarkers(existing, result.body, "handoff.md");
  await writeMarkdownFile(paths.files.handoff, finalBody);

  console.log(
    `Generated .basou/handoff.md (sessions: ${result.sessionCount}, tasks: ${result.taskCount}, decisions: ${result.decisionCount}, pending approvals: ${result.pendingApprovalsCount})`,
  );
}

async function resolveRepositoryRootForHandoff(cwd: string): Promise<string> {
  try {
    return await resolveRepositoryRoot(cwd);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Not a git repository") {
      throw new Error(
        "Not a git repository. Run 'git init' first, then re-run 'basou handoff generate'.",
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
