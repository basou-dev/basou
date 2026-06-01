import { readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  assertBasouRootSafe,
  type BasouPaths,
  basouPaths,
  type ClaudeTranscriptRecord,
  claudeTranscriptToImportPayload,
  enumerateSessionDirs,
  findErrorCode,
  type ImportSessionResult,
  importSessionFromJson,
  readManifest,
  readSessionYaml,
  resolveRepositoryRoot,
  type Session,
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
  force?: boolean;
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
    .option(
      "--force",
      "Re-import sessions already imported: delete and replace them instead of skipping",
    )
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
  const existingByExternalId = await loadExistingByExternalId(paths);
  // Session ids imported earlier in THIS run, so two transcript files that map
  // to one Claude session id never double-import within a single invocation.
  const seenThisRun = new Set<string>();

  const results: ImportSessionResult[] = [];
  let skippedNoAction = 0;
  let skippedExisting = 0;
  let replaced = 0;
  let sanitizedPaths = 0;
  for (const file of files) {
    // The transcript filename is the Claude session id; dedup on it.
    const externalId = basename(file, ".jsonl");
    if (seenThisRun.has(externalId)) {
      skippedExisting++;
      continue;
    }
    // Already imported in a prior run: skip so re-imports are idempotent,
    // unless --force asks to delete and replace the existing session.
    const priorSessionIds = existingByExternalId.get(externalId) ?? [];
    if (priorSessionIds.length > 0 && options.force !== true) {
      skippedExisting++;
      continue;
    }

    const records = await readTranscript(file);
    const payload = claudeTranscriptToImportPayload(records, {
      workspaceId: manifest.workspace.id,
      externalId,
    });
    if (payload === null) {
      skippedNoAction++;
      continue;
    }

    const parsed = SessionImportPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error("Invalid import payload", { cause: parsed.error });
    }
    if (parsed.data.schema_version !== "0.1.0") {
      throw new Error(`Unsupported import schema_version: ${parsed.data.schema_version}`);
    }

    // --force replace: delete the prior session(s) for this external id, but
    // only once the fresh payload is known good, so a failed re-derivation
    // never destroys the existing import. Skipped under --dry-run.
    if (priorSessionIds.length > 0 && options.force === true) {
      if (options.dryRun !== true) {
        for (const sid of priorSessionIds) {
          await rm(join(paths.sessions, sid), { recursive: true, force: true });
        }
      }
      replaced++;
    }

    const result = await importSessionFromJson(paths, manifest, parsed.data, {
      dryRun: options.dryRun === true,
    });
    results.push(result);
    seenThisRun.add(externalId);
    sanitizedPaths +=
      result.pathSanitizeReport.relatedFiles +
      (result.pathSanitizeReport.workingDirectoryRewritten ? 1 : 0);
  }

  if (sanitizedPaths > 0) {
    console.error(`Imported sessions: ${sanitizedPaths} path(s) sanitized`);
  }

  printImportResult(options, results, { skippedNoAction, skippedExisting, replaced });
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

/**
 * Map of source external_id -> Basou session id(s) already present in the
 * workspace, so a re-import can skip (default) or, under --force, delete and
 * replace the existing session. Recognises both the structured
 * `source.external_id` (current imports) and the `claude-code import <id>`
 * label form (sessions imported before external_id existed), so existing
 * dogfood imports are matched either way. Unreadable sessions are skipped.
 */
async function loadExistingByExternalId(paths: BasouPaths): Promise<Map<string, string[]>> {
  const byExternalId = new Map<string, string[]>();
  const add = (externalId: string, sessionId: string): void => {
    const list = byExternalId.get(externalId);
    if (list === undefined) byExternalId.set(externalId, [sessionId]);
    else list.push(sessionId);
  };
  let sessionIds: string[];
  try {
    sessionIds = await enumerateSessionDirs(paths);
  } catch {
    return byExternalId;
  }
  for (const sessionId of sessionIds) {
    let session: Session;
    try {
      session = await readSessionYaml(paths, sessionId);
    } catch {
      continue;
    }
    const ext = session.session.source.external_id;
    if (typeof ext === "string" && ext.length > 0) {
      add(ext, sessionId);
      continue;
    }
    const label = session.session.label;
    const match = typeof label === "string" ? label.match(/^claude-code import (\S+)$/) : null;
    if (match?.[1] !== undefined) add(match[1], sessionId);
  }
  return byExternalId;
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
  counts: { skippedNoAction: number; skippedExisting: number; replaced: number },
): void {
  const isDry = options.dryRun === true;
  const eventTotal = results.reduce((sum, r) => sum + r.eventCount, 0);
  const { skippedNoAction, skippedExisting, replaced } = counts;

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
        replaced_count: replaced,
        skipped_no_action: skippedNoAction,
        skipped_already_imported: skippedExisting,
        event_total: eventTotal,
        dry_run: isDry,
      }),
    );
    return;
  }

  const skipParts: string[] = [];
  if (skippedNoAction > 0) skipParts.push(`${skippedNoAction} with no actions`);
  if (skippedExisting > 0) skipParts.push(`${skippedExisting} already imported`);
  const skipSuffix = skipParts.length > 0 ? `; skipped ${skipParts.join(", ")}` : "";
  const eventsPart =
    replaced > 0 ? `${eventTotal} events, ${replaced} replaced` : `${eventTotal} events`;

  if (results.length === 0) {
    console.log(
      skipParts.length > 0
        ? `No new sessions imported (skipped ${skipParts.join(", ")})`
        : "No transcripts found to import",
    );
    return;
  }

  if (isDry) {
    console.log(`Dry run: would import ${results.length} session(s) (${eventsPart})${skipSuffix}`);
    return;
  }

  const single =
    results.length === 1 && results[0] !== undefined ? ` (${shortId(results[0].sessionId)})` : "";
  console.log(`Imported ${results.length} session(s)${single} (${eventsPart})${skipSuffix}`);
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
