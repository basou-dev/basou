import {
  assertBasouRootSafe,
  basouPaths,
  type ChainVerdict,
  enumerateSessionDirs,
  findErrorCode,
  resolveRepositoryRoot,
  resolveSessionId,
  verifyEventsChain,
} from "@basou/core";
import type { Command } from "commander";
import { isVerbose, renderCliError } from "../lib/error-render.js";

export type VerifyOptions = {
  session?: string;
  all?: boolean;
  json?: boolean;
  verbose?: boolean;
};

export type VerifyContext = {
  /** Defaults to `process.cwd()`. Injectable for tests. */
  cwd?: string;
};

/** One row of `basou verify` output: a session id and its chain verdict. */
export type VerifyRow = {
  session_id: string;
  status: ChainVerdict["status"];
  event_count: number;
  reason?: ChainVerdict["reason"];
  line?: number;
};

/** Wire `basou verify` onto `program`. */
export function registerVerifyCommand(program: Command): void {
  program
    .command("verify")
    .description("Verify the tamper-evidence hash chain of sessions' event logs (read-only)")
    .option("--session <id>", "Verify a single session (unique id prefix accepted)")
    .option("--all", "Verify every session (the default when --session is omitted)")
    .option("--json", "Output the verdicts as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: VerifyOptions) => {
      await runVerify(opts);
    });
}

export async function runVerify(options: VerifyOptions, ctx: VerifyContext = {}): Promise<void> {
  try {
    await doRunVerify(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

async function doRunVerify(options: VerifyOptions, ctx: VerifyContext): Promise<void> {
  if (options.session !== undefined && options.all === true) {
    throw new Error("Specify either --session <id> or --all, not both");
  }

  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForVerify(cwd);
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  const sessionIds =
    options.session !== undefined
      ? [await resolveSessionId(paths, options.session)]
      : await enumerateSessionDirs(paths);

  const rows: VerifyRow[] = [];
  for (const sessionId of sessionIds) {
    const verdict = await verifyEventsChain(paths, sessionId);
    rows.push({
      session_id: sessionId,
      status: verdict.status,
      event_count: verdict.eventCount,
      ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
      ...(verdict.line !== undefined ? { line: verdict.line } : {}),
    });
  }

  const tamperedCount = rows.filter((r) => r.status === "tampered").length;

  if (options.json === true) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    for (const row of rows) {
      console.log(`${row.session_id}  ${renderVerdict(row)}`);
    }
    const tally = (status: VerifyRow["status"]): number =>
      rows.filter((r) => r.status === status).length;
    console.log(
      `Sessions: ${rows.length} total — ${tally("verified")} verified, ` +
        `${tally("unchained")} unchained, ${tally("empty")} empty, ` +
        `${tally("incomplete")} incomplete, ${tally("in_progress")} in_progress, ` +
        `${tamperedCount} tampered`,
    );
  }

  // Only a real integrity break fails the command; unchained / empty /
  // incomplete / in_progress are informational states.
  if (tamperedCount > 0) {
    process.exitCode = 1;
  }
}

function renderVerdict(row: VerifyRow): string {
  switch (row.status) {
    case "verified":
      return `verified (${row.event_count} events)`;
    case "tampered":
      return row.line !== undefined
        ? `TAMPERED (${row.reason} at line ${row.line})`
        : `TAMPERED (${row.reason})`;
    case "incomplete":
      return "incomplete (session.yaml missing; re-import to repair)";
    case "in_progress":
      return `in_progress (${row.event_count} events; live session, anchor written at finalize)`;
    case "unchained":
      return "unchained (session created before event-log chaining)";
    case "empty":
      return "empty";
  }
}

async function resolveRepositoryRootForVerify(cwd: string): Promise<string> {
  try {
    return await resolveRepositoryRoot(cwd);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Not a git repository") {
      throw new Error("Not a git repository. Run 'git init' first, then re-run 'basou verify'.", {
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
