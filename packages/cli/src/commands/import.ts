import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assertBasouRootSafe,
  basouPaths,
  type ClaudeTranscriptRecord,
  claudeTranscriptToImportPayload,
  findErrorCode,
  type ImportSessionResult,
  importSessionFromJson,
  readManifest,
  resolveRepositoryRoot,
  SessionImportPayloadSchema,
} from "@basou/core";
import type { Command } from "commander";
import { isVerbose, renderCliError } from "../lib/error-render.js";

const SES_PREFIX = "ses_";
const SHORT_ID_LEN = 6;

export type ImportClaudeCodeOptions = {
  project?: string;
  session?: string;
  all?: boolean;
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
};

export type ImportContext = {
  /** Defaults to `process.cwd()`. Injectable for tests. */
  cwd?: string;
  /**
   * Root that holds per-project transcript directories. Defaults to
   * `~/.claude/projects`. Injectable for tests so no real home dir is touched.
   */
  claudeProjectsDir?: string;
};

/**
 * Wire `basou import claude-code` onto `program`. The `import` group mirrors
 * the `session` group layout so future adapters (`import codex`, ...) slot in
 * without changing the visible surface.
 */
export function registerImportCommand(program: Command): void {
  const importCmd = program
    .command("import")
    .description("Import provenance from an external AI tool's native logs");

  importCmd
    .command("claude-code")
    .description("Derive Basou sessions from Claude Code native transcripts (~/.claude/projects)")
    .option(
      "--project <path>",
      "Source project path whose transcripts to import (defaults to the current repository root)",
    )
    .option("--session <id>", "Import a single transcript by its Claude session id")
    .option("--all", "Import every transcript found for the project")
    .option("--dry-run", "Validate and preview only; do not write to disk")
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (options: ImportClaudeCodeOptions) => {
      await runImportClaudeCode(options);
    });
}

/**
 * Programmatic entry for `basou import claude-code`. Owns process exit state;
 * tests should prefer {@link doRunImportClaudeCode}.
 */
export async function runImportClaudeCode(
  options: ImportClaudeCodeOptions,
  ctx: ImportContext = {},
): Promise<void> {
  try {
    await doRunImportClaudeCode(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

export async function doRunImportClaudeCode(
  options: ImportClaudeCodeOptions,
  ctx: ImportContext,
): Promise<void> {
  if (options.session === undefined && options.all !== true) {
    throw new Error("Specify --session <id> or --all");
  }

  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForImport(cwd);
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);
  const manifest = await readManifest(paths);

  const projectPath = options.project ?? repositoryRoot;
  const projectsRoot = ctx.claudeProjectsDir ?? join(homedir(), ".claude", "projects");
  const transcriptDir = join(projectsRoot, encodeProjectDir(projectPath));

  const files = await selectTranscriptFiles(transcriptDir, options);

  const results: ImportSessionResult[] = [];
  let skipped = 0;
  let sanitizedPaths = 0;
  for (const file of files) {
    const records = await readTranscript(file);
    const payload = claudeTranscriptToImportPayload(records, {
      workspaceId: manifest.workspace.id,
    });
    if (payload === null) {
      skipped++;
      continue;
    }

    const parsed = SessionImportPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error("Invalid import payload", { cause: parsed.error });
    }
    if (parsed.data.schema_version !== "0.1.0") {
      throw new Error(`Unsupported import schema_version: ${parsed.data.schema_version}`);
    }

    const result = await importSessionFromJson(paths, manifest, parsed.data, {
      dryRun: options.dryRun === true,
    });
    results.push(result);
    sanitizedPaths +=
      result.pathSanitizeReport.relatedFiles +
      (result.pathSanitizeReport.workingDirectoryRewritten ? 1 : 0);
  }

  if (sanitizedPaths > 0) {
    console.error(`Imported sessions: ${sanitizedPaths} path(s) sanitized`);
  }

  printImportResult(options, results, skipped);
}

/**
 * Encode an absolute project path into Claude Code's per-project directory
 * name. Claude Code replaces path separators with `-`, so
 * `/Users/x/projects/foo` becomes `-Users-x-projects-foo`. Best-effort for
 * the common case; paths with characters the vendor encodes differently may
 * need an explicit `--project`-derived directory in a later revision.
 */
function encodeProjectDir(projectPath: string): string {
  return projectPath.replaceAll("/", "-");
}

async function selectTranscriptFiles(
  transcriptDir: string,
  options: ImportClaudeCodeOptions,
): Promise<string[]> {
  if (options.session !== undefined) {
    return [join(transcriptDir, `${options.session}.jsonl`)];
  }
  let entries: string[];
  try {
    entries = await readdir(transcriptDir);
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) {
      throw new Error("Claude transcript directory not found for project", { cause: error });
    }
    throw new Error("Failed to read Claude transcript directory", { cause: error });
  }
  return entries
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => join(transcriptDir, name));
}

async function readTranscript(file: string): Promise<ClaudeTranscriptRecord[]> {
  let body: string;
  try {
    body = await readFile(file, "utf8");
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) {
      throw new Error("Transcript not found", { cause: error });
    }
    if (findErrorCode(error, "EISDIR")) {
      throw new Error("Transcript path is not a file", { cause: error });
    }
    throw new Error("Failed to read transcript", { cause: error });
  }

  const records: ClaudeTranscriptRecord[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        records.push(parsed as ClaudeTranscriptRecord);
      }
    } catch {
      // A malformed line is skipped rather than failing the whole transcript;
      // partial native logs should still yield best-effort provenance.
    }
  }
  return records;
}

function printImportResult(
  options: ImportClaudeCodeOptions,
  results: ImportSessionResult[],
  skipped: number,
): void {
  const isDry = options.dryRun === true;
  const eventTotal = results.reduce((sum, r) => sum + r.eventCount, 0);

  if (options.json === true) {
    console.log(
      JSON.stringify({
        imported: results.map((r) => ({
          session_id: r.sessionId,
          event_count: r.eventCount,
          status: r.finalStatus,
          source: { kind: r.finalSourceKind, version: "0.1.0" },
        })),
        imported_count: results.length,
        skipped_count: skipped,
        event_total: eventTotal,
        dry_run: isDry,
      }),
    );
    return;
  }

  if (results.length === 0) {
    console.log(
      skipped > 0
        ? `No sessions imported (${skipped} transcript(s) had no importable actions)`
        : "No transcripts found to import",
    );
    return;
  }

  const skippedSuffix = skipped > 0 ? `; skipped ${skipped} with no actions` : "";
  if (isDry) {
    console.log(
      `Dry run: would import ${results.length} session(s) (${eventTotal} events)${skippedSuffix}`,
    );
    return;
  }

  const single =
    results.length === 1 && results[0] !== undefined ? ` (${shortId(results[0].sessionId)})` : "";
  console.log(
    `Imported ${results.length} session(s)${single} (${eventTotal} events)${skippedSuffix}`,
  );
}

function shortId(id: string): string {
  if (id.startsWith(SES_PREFIX)) {
    return id.slice(SES_PREFIX.length, SES_PREFIX.length + SHORT_ID_LEN);
  }
  return id.slice(0, SHORT_ID_LEN);
}

async function resolveRepositoryRootForImport(cwd: string): Promise<string> {
  try {
    return await resolveRepositoryRoot(cwd);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Not a git repository") {
      throw new Error("Not a git repository. Run 'git init' first, then re-run 'basou import'.", {
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
