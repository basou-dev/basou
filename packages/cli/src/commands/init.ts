import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { createManifest, ensureBasouDirectory, writeManifest } from "@basou/core";
import type { Command } from "commander";

const execFileAsync = promisify(execFile);

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
  const repositoryRoot = await resolveGitRepositoryRoot(cwd);
  const workspaceName = options.name ?? basename(repositoryRoot);

  // --repo-url > git config --local remote.origin.url > omit
  // --repo-url "" => explicit null
  let repositoryUrl: string | null | undefined;
  if (options.repoUrl !== undefined) {
    repositoryUrl = options.repoUrl === "" ? null : options.repoUrl;
  } else {
    repositoryUrl = await tryGitRemoteUrl(repositoryRoot);
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
  console.log(`Initialized Basou workspace: ${manifest.workspace.id}`);
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

async function resolveGitRepositoryRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
    const root = stdout.trimEnd();
    if (root.length === 0) throw new Error("git rev-parse returned empty output");
    return root;
  } catch (error: unknown) {
    // Distinguish a missing `git` binary from "not a git repository" so the
    // user is not misled into running `git init` when git itself is absent.
    if (hasErrorCode(error) && error.code === "ENOENT") {
      throw new Error("Git executable not found in PATH. Install git first.", { cause: error });
    }
    throw new Error("Not a git repository. Run 'git init' first, then re-run 'basou init'.", {
      cause: error,
    });
  }
}

function hasErrorCode(error: unknown): error is Error & { code: string } {
  if (!(error instanceof Error)) return false;
  return typeof (error as unknown as Record<string, unknown>).code === "string";
}

async function tryGitRemoteUrl(repositoryRoot: string): Promise<string | undefined> {
  try {
    // `--local` constrains lookup to the repository config so global/system
    // remotes do not leak in. The repository_url MUST reflect this repo,
    // not whatever the developer set globally.
    const { stdout } = await execFileAsync(
      "git",
      ["config", "--local", "--get", "remote.origin.url"],
      { cwd: repositoryRoot },
    );
    const url = stdout.trimEnd();
    return url.length > 0 ? url : undefined;
  } catch {
    return undefined;
  }
}
