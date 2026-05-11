import {
  type ReplayWarning,
  type SessionSkipReason,
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

const SES_PREFIX = "ses_";
const SHORT_ID_LEN = 6;

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
    renderDecisionsError(error, isVerbose(options));
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

function isVerbose(options: DecisionsGenerateOptions): boolean {
  return options.verbose === true || process.env.BASOU_DEBUG === "1";
}

function renderDecisionsError(error: unknown, verbose: boolean): void {
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

function shortId(id: string): string {
  if (id.startsWith(SES_PREFIX))
    return id.slice(SES_PREFIX.length, SES_PREFIX.length + SHORT_ID_LEN);
  return id.slice(0, SHORT_ID_LEN);
}

function printReplayWarning(warning: ReplayWarning, sid: string): void {
  const short = shortId(sid);
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
}

function printSessionSkip(sid: string, reason: SessionSkipReason): void {
  const short = shortId(sid);
  if (reason === "events_jsonl_unreadable") {
    console.error(`Warning: skipped suspect check for ${short}: events.jsonl unreadable`);
  } else {
    console.error(`Skipped ${short}: ${reason}`);
  }
}
