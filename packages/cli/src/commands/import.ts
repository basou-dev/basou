import { createReadStream, type Dirent } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import {
  assertBasouRootSafe,
  type BasouPaths,
  basouPaths,
  type ClaudeTranscriptRecord,
  type CodexRolloutRecord,
  claudeTranscriptToImportPayload,
  codexRolloutToImportPayload,
  enumerateSessionDirs,
  findErrorCode,
  type ImportSessionResult,
  importSessionFromJson,
  type Manifest,
  readManifest,
  readSessionYaml,
  resolveRepositoryRoot,
  type Session,
  type SessionImportPayload,
  SessionImportPayloadSchema,
} from "@basou/core";
import type { Command } from "commander";
import { isVerbose, renderCliError } from "../lib/error-render.js";

const SES_PREFIX = "ses_";
const SHORT_ID_LEN = 6;

/** Options shared by every `basou import <adapter>` subcommand. */
export type ImportOptions = {
  project?: string;
  session?: string;
  all?: boolean;
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
};

export type ImportClaudeCodeOptions = ImportOptions;
export type ImportCodexOptions = ImportOptions;

export type ImportContext = {
  /** Defaults to `process.cwd()`. Injectable for tests. */
  cwd?: string;
  /**
   * Root that holds per-project Claude transcript directories. Defaults to
   * `~/.claude/projects`. Injectable for tests so no real home dir is touched.
   */
  claudeProjectsDir?: string;
  /**
   * Root that holds Codex rollout logs (`<year>/<month>/<day>/rollout-*.jsonl`).
   * Defaults to `~/.codex/sessions`. Injectable for tests.
   */
  codexSessionsDir?: string;
};

/**
 * A single source session ready to be derived and imported. The dedup key
 * (`externalId`) is known up front from discovery; `toPayload` reads and
 * transforms the source log lazily, so a session that is skipped (already
 * imported) is never read.
 */
type ImportCandidate = {
  externalId: string;
  toPayload: () => Promise<SessionImportPayload | null>;
};

/**
 * Wire the `basou import` command group onto `program`. Each adapter
 * (`claude-code`, `codex`, ...) is a subcommand sharing the same flags, so
 * future adapters slot in without changing the visible surface.
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

  importCmd
    .command("codex")
    .description("Derive Basou sessions from OpenAI Codex native rollout logs (~/.codex/sessions)")
    .option(
      "--project <path>",
      "Source project path whose rollouts to import (defaults to the current repository root)",
    )
    .option("--session <id>", "Import a single rollout by its Codex session id")
    .option("--all", "Import every rollout found for the project")
    .option(
      "--force",
      "Re-import sessions already imported: delete and replace them instead of skipping",
    )
    .option("--dry-run", "Validate and preview only; do not write to disk")
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (options: ImportCodexOptions) => {
      await runImportCodex(options);
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

/**
 * Programmatic entry for `basou import codex`. Owns process exit state;
 * tests should prefer {@link doRunImportCodex}.
 */
export async function runImportCodex(
  options: ImportCodexOptions,
  ctx: ImportContext = {},
): Promise<void> {
  try {
    await doRunImportCodex(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

export async function doRunImportClaudeCode(
  options: ImportClaudeCodeOptions,
  ctx: ImportContext,
): Promise<void> {
  assertSelector(options);
  const { repositoryRoot, paths, manifest } = await resolveImportTarget(ctx);

  const projectPath = options.project ?? repositoryRoot;
  const projectsRoot = ctx.claudeProjectsDir ?? join(homedir(), ".claude", "projects");
  const transcriptDir = join(projectsRoot, encodeProjectDir(projectPath));

  const files = await selectTranscriptFiles(transcriptDir, options);
  const candidates: ImportCandidate[] = files.map((file) => {
    // The transcript filename is the Claude session id; it is both the dedup
    // key and the source external_id.
    const externalId = basename(file, ".jsonl");
    return {
      externalId,
      toPayload: async () =>
        claudeTranscriptToImportPayload(await readJsonlRecords(file), {
          workspaceId: manifest.workspace.id,
          externalId,
        }),
    };
  });

  await importDerivedSessions(paths, manifest, options, candidates);
}

export async function doRunImportCodex(
  options: ImportCodexOptions,
  ctx: ImportContext,
): Promise<void> {
  assertSelector(options);
  const { repositoryRoot, paths, manifest } = await resolveImportTarget(ctx);

  const projectPath = options.project ?? repositoryRoot;
  const sessionsRoot = ctx.codexSessionsDir ?? join(homedir(), ".codex", "sessions");

  const rollouts = await discoverCodexRollouts(sessionsRoot, projectPath, options);
  const candidates: ImportCandidate[] = rollouts.map(({ file, externalId }) => ({
    externalId,
    toPayload: async () =>
      codexRolloutToImportPayload((await readJsonlRecords(file)) as CodexRolloutRecord[], {
        workspaceId: manifest.workspace.id,
        externalId,
      }),
  }));

  await importDerivedSessions(paths, manifest, options, candidates);
}

function assertSelector(options: ImportOptions): void {
  if (options.session === undefined && options.all !== true) {
    throw new Error("Specify --session <id> or --all");
  }
}

async function resolveImportTarget(
  ctx: ImportContext,
): Promise<{ repositoryRoot: string; paths: BasouPaths; manifest: Manifest }> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveRepositoryRootForImport(cwd);
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);
  const manifest = await readManifest(paths);
  return { repositoryRoot, paths, manifest };
}

/**
 * The vendor-neutral import core: dedup, derive, validate, and write each
 * candidate, then report. Every `basou import <adapter>` funnels its
 * discovered candidates through here, so dedup / `--force` / `--dry-run`
 * semantics stay identical across adapters.
 */
async function importDerivedSessions(
  paths: BasouPaths,
  manifest: Manifest,
  options: ImportOptions,
  candidates: ReadonlyArray<ImportCandidate>,
): Promise<void> {
  const existingByExternalId = await loadExistingByExternalId(paths);
  // Session ids imported earlier in THIS run, so two source files that map to
  // one session id never double-import within a single invocation.
  const seenThisRun = new Set<string>();

  const results: ImportSessionResult[] = [];
  let skippedNoAction = 0;
  let skippedExisting = 0;
  let replaced = 0;
  let sanitizedPaths = 0;
  for (const { externalId, toPayload } of candidates) {
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

    const payload = await toPayload();
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

/**
 * Discover the Codex rollouts that belong to `projectPath`. Codex stores
 * rollouts under date directories (not per-project like Claude), so the whole
 * tree is walked and each rollout's `session_meta.cwd` is matched against the
 * project. The exact-match is also the safety boundary: only sessions started
 * in the requested project are ever imported. `--session` narrows to a single
 * rollout by its Codex session id within that project.
 */
async function discoverCodexRollouts(
  sessionsRoot: string,
  projectPath: string,
  options: ImportCodexOptions,
): Promise<Array<{ file: string; externalId: string }>> {
  const files = await findRolloutFiles(sessionsRoot);
  const matched: Array<{ file: string; externalId: string }> = [];
  for (const file of files) {
    const meta = await readRolloutMeta(file);
    if (meta === undefined) continue;
    if (meta.cwd !== projectPath) continue;
    if (options.session !== undefined && meta.id !== options.session) continue;
    matched.push({ file, externalId: meta.id });
  }
  return matched;
}

/** Recursively collect every `rollout-*.jsonl` under the Codex sessions root. */
async function findRolloutFiles(sessionsRoot: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, isRoot: boolean): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error: unknown) {
      if (findErrorCode(error, "ENOENT")) {
        if (isRoot) {
          throw new Error("Codex sessions directory not found", { cause: error });
        }
        return; // a subdir vanished mid-walk; ignore
      }
      throw new Error("Failed to read Codex sessions directory", { cause: error });
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, false);
      } else if (
        entry.isFile() &&
        entry.name.startsWith("rollout-") &&
        entry.name.endsWith(".jsonl")
      ) {
        found.push(full);
      }
    }
  };
  await walk(sessionsRoot, true);
  return found.sort();
}

/**
 * Read just the `session_meta` (first record) of a rollout to learn its
 * project cwd and session id, without parsing the whole — usually large — log.
 * Returns `undefined` for any file whose first record is not a usable
 * `session_meta`, so the caller can skip it.
 */
async function readRolloutMeta(file: string): Promise<{ id: string; cwd: string } | undefined> {
  const firstLine = await readFirstLine(file);
  if (firstLine === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return undefined;
  }
  if (!isObject(parsed) || parsed.type !== "session_meta") return undefined;
  const payload = isObject(parsed.payload) ? parsed.payload : undefined;
  if (payload === undefined) return undefined;
  const id = payload.id;
  const cwd = payload.cwd;
  if (typeof id !== "string" || id.length === 0) return undefined;
  if (typeof cwd !== "string" || cwd.length === 0) return undefined;
  return { id, cwd };
}

/** Read the first non-empty line of a file, streaming so large files are cheap. */
async function readFirstLine(file: string): Promise<string | undefined> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length > 0) return trimmed;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Read a JSONL native log into an array of records. A malformed line is
 * skipped rather than failing the whole file, so partial native logs still
 * yield best-effort provenance.
 */
async function readJsonlRecords(file: string): Promise<ClaudeTranscriptRecord[]> {
  let body: string;
  try {
    body = await readFile(file, "utf8");
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) {
      throw new Error("Source log not found", { cause: error });
    }
    if (findErrorCode(error, "EISDIR")) {
      throw new Error("Source log path is not a file", { cause: error });
    }
    throw new Error("Failed to read source log", { cause: error });
  }

  const records: ClaudeTranscriptRecord[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isObject(parsed)) {
        records.push(parsed);
      }
    } catch {
      // A malformed line is skipped rather than failing the whole file.
    }
  }
  return records;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printImportResult(
  options: ImportOptions,
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
