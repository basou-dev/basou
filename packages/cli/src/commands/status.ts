import {
  type Manifest,
  type StatusSnapshot,
  assertBasouRootSafe,
  basouPaths,
  buildStatusSnapshot,
  findErrorCode,
  readManifest,
  resolveRepositoryRoot,
  writeStatus,
} from "@basou/core";
import type { Command } from "commander";
import { isVerbose, renderCliError } from "../lib/error-render.js";

export type StatusOptions = {
  json?: boolean;
  verbose?: boolean;
};

export type StatusContext = {
  /** Defaults to `process.cwd()`. Injectable for tests. */
  cwd?: string;
};

/**
 * Register `basou status` on a commander program. The command outputs a
 * human-readable summary by default, or a JSON document when `--json` is
 * given. In both modes `.basou/status.json` is rewritten as a side effect.
 */
export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show the current Basou workspace status")
    .option("--json", "Output the snapshot as JSON to stdout")
    .option("-v, --verbose", "Show error causes")
    .action(async (options: StatusOptions) => {
      await runStatus(options);
    });
}

/**
 * Programmatic entry that mutates process state (`exitCode`, stderr).
 * Exported for tests, but tests should prefer {@link doRunStatus} when they
 * only need to assert on success behaviour or thrown errors.
 */
export async function runStatus(options: StatusOptions, ctx: StatusContext = {}): Promise<void> {
  try {
    await doRunStatus(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Pure runner: resolves inputs, performs the status snapshot, writes
 * `status.json`, and prints output. On any failure throws an Error whose
 * `message` is pathless; native fs / parse errors are attached as `cause`.
 * Exported for tests so they can assert on thrown errors without touching
 * `process.exitCode`.
 */
export async function doRunStatus(options: StatusOptions, ctx: StatusContext): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForStatus(cwd);
  const paths = basouPaths(repositoryRoot);

  // Pre-condition: refuse to operate on a swapped/non-directory .basou root
  // before we ever touch a file. Treat ENOENT (root absent) the same way as
  // a missing manifest below — both mean "workspace not initialized".
  try {
    await assertBasouRootSafe(paths.root);
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) {
      throw new Error("Workspace not initialized. Run 'basou init' first.");
    }
    throw error;
  }

  let manifest: Manifest;
  try {
    manifest = await readManifest(paths);
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) {
      throw new Error("Workspace not initialized. Run 'basou init' first.");
    }
    // ZodError's `message` echoes invalid input values verbatim, which can
    // include path-like strings if a user-edited manifest contains them.
    // Wrap in a fixed pathless message and surface only the cause's
    // constructor name in verbose mode via the shared renderCliError helper.
    throw new Error("Failed to read workspace manifest", { cause: error });
  }

  const snapshot = await buildStatusSnapshot({ manifest, paths });
  await writeStatus(paths, snapshot);

  if (options.json === true) {
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    renderTextStatus(snapshot);
  }
}

function renderTextStatus(s: StatusSnapshot): void {
  console.log(`Workspace: ${s.workspace.name} (${s.workspace.id})`);
  console.log(`Basou version: ${s.workspace.basou_version}`);
  console.log(`Generated at: ${s.generated_at}`);
  const dp = s.directories_present;
  const total = Object.keys(dp).length;
  const present = Object.values(dp).filter((v) => v === true).length;
  console.log(`Subdirectories present: ${present}/${total}`);
}

/**
 * Wrap the core git capability so the CLI surfaces the command-specific
 * "Run 'git init' first, then re-run 'basou status'." suffix while the
 * capability layer remains command-agnostic.
 */
async function resolveRepositoryRootForStatus(cwd: string): Promise<string> {
  try {
    return await resolveRepositoryRoot(cwd);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Not a git repository") {
      throw new Error("Not a git repository. Run 'git init' first, then re-run 'basou status'.", {
        cause: error,
      });
    }
    throw error;
  }
}
