import { basename, relative, resolve } from "node:path";
import {
  appendBasouGitignore,
  createManifest,
  ensureBasouDirectory,
  resolveRepositoryRoot,
  writeManifest,
} from "@basou/core";
import type { Command } from "commander";
import { extractCauseLabel, isVerbose, renderCliError } from "../lib/error-render.js";

export type InitOptions = {
  name?: string;
  projectName?: string;
  projectDescription?: string;
  /**
   * Deprecated and ignored. `project.repository_url` was removed (the remote is
   * an observed git fact derived live, not stored). The flag is still accepted
   * for `0.x` CLI stability and is removed at `1.0`; supplying it emits a
   * deprecation warning and writes nothing.
   */
  repoUrl?: string;
  /**
   * Import source roots (repeatable). Each may be absolute or relative to the
   * invocation cwd; persisted as a path relative to the repository root under
   * `import.source_roots`, so one `.basou/` can aggregate sibling repos.
   */
  sourceRoot?: string[];
  /** Write a `.basou/` full-exclude .gitignore block instead of the default ignore+commit block. */
  localOnly?: boolean;
  force?: boolean;
  verbose?: boolean;
};

/** Commander collector: accumulate a repeatable option into an array. */
function collectValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export type InitContext = {
  /** Defaults to `process.cwd()`. Injectable for tests. */
  cwd?: string;
};

/** Register `basou init` on a commander program. */
export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize a Basou workspace at the current Git repository root")
    .option("--name <name>", "Workspace name (defaults to the repository directory name)")
    .option("--project-name <name>", "Project display name")
    .option("--project-description <description>", "Project description")
    .option(
      "--repo-url <url>",
      "Deprecated and ignored (project.repository_url was removed); accepted for 0.x CLI stability, removed at 1.0",
    )
    .option(
      "--source-root <path>",
      "Extra import source root, relative to the repo root (repeatable; aggregates sibling repos into this workspace)",
      collectValue,
      [],
    )
    .option(
      "--local-only",
      "Write a .basou/ full-exclude .gitignore block (keep the trail out of version control) instead of the default ignore+commit block",
    )
    .option("-f, --force", "Overwrite an existing manifest")
    .option("-v, --verbose", "Show error causes")
    .action(async (options: InitOptions) => {
      await runInit(options);
    });
}

/**
 * Programmatic entry that mutates process state (`exitCode`, stderr).
 * Exported for tests, but tests should prefer {@link doRunInit} so they are
 * not coupled to process global state.
 */
export async function runInit(options: InitOptions, ctx: InitContext = {}): Promise<void> {
  try {
    await doRunInit(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Pure runner: resolves inputs, calls core APIs, prints the success line.
 * On any failure throws an Error whose `message` is pathless and whose
 * `cause` MAY contain a native fs error. Exported for tests so they can
 * assert on thrown errors without touching `process.exitCode`.
 */
export async function doRunInit(options: InitOptions, ctx: InitContext): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForInit(cwd);
  const workspaceName = options.name ?? basename(repositoryRoot);

  // --repo-url is a deprecated no-op: project.repository_url was removed, so the
  // flag writes nothing. Accepted for 0.x CLI stability; warn and drop it.
  if (options.repoUrl !== undefined) {
    console.error(
      "Warning: --repo-url is deprecated and ignored (project.repository_url was removed); the flag will be removed at 1.0.",
    );
  }

  // Normalize each --source-root to a repo-root-relative path. A root that is
  // the repo root itself becomes ".". Stored relative so the committed manifest
  // carries no absolute machine paths.
  const sourceRoots = (options.sourceRoot ?? []).map((p) => {
    const rel = relative(repositoryRoot, resolve(cwd, p));
    return rel === "" ? "." : rel;
  });

  const paths = await ensureBasouDirectory(repositoryRoot);
  const manifest = createManifest({
    workspaceName,
    ...(options.projectName !== undefined ? { projectName: options.projectName } : {}),
    ...(options.projectDescription !== undefined
      ? { projectDescription: options.projectDescription }
      : {}),
    ...(sourceRoots.length > 0 ? { sourceRoots } : {}),
  });

  await writeManifest(paths, manifest, { force: options.force === true });

  // .gitignore is best-effort: init succeeds even if this step fails.
  // The "safe to run on an existing Git repo" completion contract holds
  // even when manifest writes but .gitignore cannot (e.g. permission
  // denied) -- the core feature set still works.
  try {
    await appendBasouGitignore(repositoryRoot, { localOnly: options.localOnly === true });
  } catch (error: unknown) {
    renderGitignoreWarning(error, isVerbose(options));
  }

  console.log(`Initialized Basou workspace: ${manifest.workspace.id}`);
}

/**
 * Render a non-fatal warning when `.gitignore` cannot be updated. Mirrors
 * the pathless contract enforced by {@link renderCliError} — never prints
 * `error.cause.message` because native fs errors embed the absolute path
 * in it.
 */
function renderGitignoreWarning(error: unknown, verbose: boolean): void {
  const baseMessage = error instanceof Error ? error.message : String(error);
  // The fallback hint is intentionally `dist`-only-portable: it does not
  // reference any in-repo doc path, since the CLI is published
  // independently of `docs/`.
  console.error(
    `Warning: Could not update .gitignore (${baseMessage}). Add Basou's default .gitignore block manually.`,
  );
  if (verbose && error instanceof Error) {
    const label = extractCauseLabel(error);
    if (label !== undefined) console.error(`Caused by: ${label}`);
  }
}

/**
 * Wrap the core git capability so the CLI surfaces the command-specific
 * "Run 'git init' first, then re-run 'basou init'." suffix while the
 * capability layer remains command-agnostic.
 */
async function resolveRepositoryRootForInit(cwd: string): Promise<string> {
  try {
    return await resolveRepositoryRoot(cwd);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Not a git repository") {
      throw new Error("Not a git repository. Run 'git init' first, then re-run 'basou init'.", {
        cause: error,
      });
    }
    throw error;
  }
}
