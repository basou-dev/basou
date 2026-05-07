import { basename } from "node:path";
import {
  appendBasouGitignore,
  createManifest,
  ensureBasouDirectory,
  resolveRepositoryRoot,
  tryRemoteUrl,
  writeManifest,
} from "@basou/core";
import type { Command } from "commander";

export type InitOptions = {
  name?: string;
  projectName?: string;
  projectDescription?: string;
  repoUrl?: string;
  force?: boolean;
  verbose?: boolean;
};

export type InitContext = {
  /** Defaults to `process.cwd()`. Injectable for tests. */
  cwd?: string;
};

/**
 * Register `basou init` on a commander program. The `--repo-url ""` (empty
 * string) form is the documented way to set `project.repository_url` to
 * `null` explicitly; omitting `--repo-url` falls back to
 * `git config --local remote.origin.url` and finally to omission.
 */
export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize a Basou workspace at the current Git repository root")
    .option("--name <name>", "Workspace name (defaults to the repository directory name)")
    .option("--project-name <name>", "Project display name")
    .option("--project-description <description>", "Project description")
    .option(
      "--repo-url <url>",
      "Repository URL (defaults to git remote.origin.url; pass empty string for null)",
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
    renderCliError(error, options.verbose === true || process.env.BASOU_DEBUG === "1");
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

  // --repo-url > git config --local remote.origin.url > omit
  // --repo-url "" => explicit null
  let repositoryUrl: string | null | undefined;
  if (options.repoUrl !== undefined) {
    repositoryUrl = options.repoUrl === "" ? null : options.repoUrl;
  } else {
    repositoryUrl = await tryRemoteUrl(repositoryRoot);
  }

  const paths = await ensureBasouDirectory(repositoryRoot);
  const manifest = createManifest({
    workspaceName,
    ...(options.projectName !== undefined ? { projectName: options.projectName } : {}),
    ...(options.projectDescription !== undefined
      ? { projectDescription: options.projectDescription }
      : {}),
    ...(repositoryUrl !== undefined ? { repositoryUrl } : {}),
  });

  await writeManifest(paths, manifest, { force: options.force === true });

  // .gitignore は best-effort: 失敗しても init 全体は成功とみなす（A1）。
  // Y-2 §16.1「既存 Git repo で安全に実行できる」を担保するため、
  // permission denied 等で manifest だけ書けて .gitignore が書けない
  // ケースでも基本機能は使える。
  try {
    await appendBasouGitignore(repositoryRoot);
  } catch (error: unknown) {
    renderGitignoreWarning(error, options.verbose === true || process.env.BASOU_DEBUG === "1");
  }

  console.log(`Initialized Basou workspace: ${manifest.workspace.id}`);
}

/**
 * Render a non-fatal warning when `.gitignore` cannot be updated. Mirrors
 * `renderCliError`'s pathless contract — never prints `error.cause.message`
 * because native fs errors embed the absolute path in it.
 */
function renderGitignoreWarning(error: unknown, verbose: boolean): void {
  const baseMessage = error instanceof Error ? error.message : String(error);
  // The fallback hint is intentionally `dist`-only-portable: it does not
  // reference the Basou planning repo or any in-repo doc path, since the
  // CLI is published independently of `docs/`.
  console.error(
    `Warning: Could not update .gitignore (${baseMessage}). Add Basou's default .gitignore block manually.`,
  );
  if (verbose && error instanceof Error && error.cause instanceof Error) {
    console.error(`Caused by: ${describeCause(error.cause)}`);
  }
}

/**
 * Render a CLI error to stderr without leaking absolute paths. Even with
 * `verbose: true` we never print the Error object directly because Node's
 * `util.inspect` recursively expands `error.cause`, and native fs errors
 * embed absolute paths in their messages.
 *
 * In verbose mode we surface only a non-path identifier for the cause —
 * preferring its errno-style `code` (e.g. "ENOENT", "EACCES") and falling
 * back to the constructor name. The cause's `message` is intentionally NOT
 * printed because Node's native fs errors include the failed path in it.
 */
function renderCliError(error: unknown, verbose: boolean): void {
  if (error instanceof Error) {
    console.error(error.message);
    if (verbose && error.cause instanceof Error) {
      console.error(`Caused by: ${describeCause(error.cause)}`);
    }
  } else {
    console.error(String(error));
  }
}

function describeCause(cause: Error): string {
  const code = (cause as unknown as Record<string, unknown>).code;
  if (typeof code === "string" && code.length > 0) return code;
  return cause.constructor.name;
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
