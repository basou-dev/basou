import {
  assertBasouRootSafe,
  basouPaths,
  findErrorCode,
  readMarkdownFile,
  renderDecisions,
  renderWithMarkers,
  resolveRepositoryRoot,
  writeMarkdownFile,
} from "@basou/core";
import type { Command } from "commander";
import {
  isVerbose,
  printReplayWarning,
  printSessionSkip,
  renderCliError,
} from "../lib/error-render.js";

export type DecisionsGenerateOptions = { verbose?: boolean };

export type DecisionsContext = {
  cwd?: string;
  nowProvider?: () => Date;
};

/** Wire `basou decisions generate` onto `program`. Mirrors `handoff` exactly. */
export function registerDecisionsCommand(program: Command): void {
  const decisions = program
    .command("decisions")
    .description("Generate or inspect .basou/decisions.md");

  decisions
    .command("generate")
    .description("Regenerate .basou/decisions.md from recorded decision events")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: DecisionsGenerateOptions) => {
      await runDecisionsGenerate(opts);
    });
}

export async function runDecisionsGenerate(
  options: DecisionsGenerateOptions,
  ctx: DecisionsContext = {},
): Promise<void> {
  try {
    await doRunDecisionsGenerate(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

export async function doRunDecisionsGenerate(
  options: DecisionsGenerateOptions,
  ctx: DecisionsContext,
): Promise<void> {
  void options;
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForDecisions(cwd);
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  const nowIso = (ctx.nowProvider?.() ?? new Date()).toISOString();
  const result = await renderDecisions({
    paths,
    nowIso,
    onWarning: (w, sid) => printReplayWarning(w, sid),
    onSessionSkip: (sid, reason) => printSessionSkip(sid, reason),
  });

  const existing = await readMarkdownFile(paths.files.decisions);
  const finalBody = renderWithMarkers(existing, result.body, "decisions.md");
  await writeMarkdownFile(paths.files.decisions, finalBody);

  console.log(`Generated .basou/decisions.md (decisions: ${result.decisionCount})`);
}

async function resolveRepositoryRootForDecisions(cwd: string): Promise<string> {
  try {
    return await resolveRepositoryRoot(cwd);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Not a git repository") {
      throw new Error(
        "Not a git repository. Run 'git init' first, then re-run 'basou decisions generate'.",
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
