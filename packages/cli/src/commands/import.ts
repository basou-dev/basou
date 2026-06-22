import { createReadStream, type Dirent } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  assertBasouRootSafe,
  type BasouPaths,
  basouPaths,
  CLAUDE_IMPORT_SOURCE,
  type ClaudeTranscriptRecord,
  CODEX_IMPORT_SOURCE,
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
  reimportPreservingId,
  resolveRepositoryRoot,
  type Session,
  type SessionImportPayload,
  SessionImportPayloadSchema,
  type SessionSourceKind,
} from "@basou/core";
import type { Command } from "commander";
import { isVerbose, renderCliError } from "../lib/error-render.js";

const SES_PREFIX = "ses_";
const SHORT_ID_LEN = 6;

/** Options shared by every `basou import <adapter>` subcommand. */
export type ImportOptions = {
  /**
   * Source project roots whose native logs to import. Repeatable on the CLI;
   * empty means "fall back to the manifest's `import.source_roots`, then the
   * repository root". Each entry may be absolute or relative to the cwd.
   */
  project?: string[];
  session?: string;
  all?: boolean;
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
  verbose?: boolean;
};

/** Commander collector: accumulate a repeatable option into an array. */
function collectPath(value: string, previous: string[]): string[] {
  return [...previous, value];
}

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
  /**
   * Absolute path of the source native log. The orchestrator stats this (a
   * cheap, parse-free probe) to decide whether an already-imported source
   * changed, before paying to read + derive it.
   */
  sourcePath: string;
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
      "Source project path whose transcripts to import (repeatable; defaults to the manifest source roots, then the repository root)",
      collectPath,
      [],
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
      "Source project path whose rollouts to import (repeatable; defaults to the manifest source roots, then the repository root)",
      collectPath,
      [],
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

/**
 * Resolve the absolute source roots to import from, applying precedence:
 * explicit `--project` flags first (resolved against the cwd), else the
 * manifest's `import.source_roots` (resolved against the repo root), else the
 * repository root alone. The result is de-duplicated, so a root listed twice
 * (or equal to the repo root) is scanned once.
 */
function resolveSourceRoots(args: {
  projectFlags: string[];
  manifest: Manifest;
  repoRoot: string;
  cwd: string;
}): string[] {
  const { projectFlags, manifest, repoRoot, cwd } = args;
  let resolved: string[];
  if (projectFlags.length > 0) {
    resolved = projectFlags.map((p) => resolve(cwd, p));
  } else {
    const roots = manifest.import?.source_roots;
    resolved =
      roots !== undefined && roots.length > 0 ? roots.map((r) => resolve(repoRoot, r)) : [repoRoot];
  }
  return [...new Set(resolved)];
}

export async function doRunImportClaudeCode(
  options: ImportClaudeCodeOptions,
  ctx: ImportContext,
): Promise<void> {
  assertSelector(options);
  const { repositoryRoot, paths, manifest } = await resolveImportTarget(ctx);

  const projectPaths = resolveSourceRoots({
    projectFlags: options.project ?? [],
    manifest,
    repoRoot: repositoryRoot,
    cwd: ctx.cwd ?? process.cwd(),
  });
  const projectsRoot = ctx.claudeProjectsDir ?? join(homedir(), ".claude", "projects");

  const files = await selectTranscriptFiles(projectsRoot, projectPaths, options);
  // Claude Code's per-project directory name is lossy (every non-alphanumeric
  // char -> "-"), so distinct project paths can collide into one directory.
  // Attribute each transcript by its OWN recorded cwd and skip any that does not
  // belong to a requested project — mirroring the Codex adapter's cwd guard —
  // so a colliding sibling project's transcripts are not imported under this one.
  // (Equality matches the Codex adapter: the recorded cwd must equal a resolved
  // source root verbatim.)
  const projectSet = new Set(projectPaths);
  const candidates: ImportCandidate[] = files.map((file) => {
    // The transcript filename is the Claude session id; it is both the dedup
    // key and the source external_id.
    const externalId = basename(file, ".jsonl");
    return {
      externalId,
      sourcePath: file,
      toPayload: async () => {
        const { records, sizeBytes } = await readJsonlRecords(file);
        const cwd = firstTranscriptCwd(records);
        if (cwd === undefined || !projectSet.has(cwd)) return null;
        return claudeTranscriptToImportPayload(records, {
          workspaceId: manifest.workspace.id,
          externalId,
          sourceSizeBytes: sizeBytes,
        });
      },
    };
  });

  await importDerivedSessions(paths, manifest, options, CLAUDE_IMPORT_SOURCE, candidates);
}

export async function doRunImportCodex(
  options: ImportCodexOptions,
  ctx: ImportContext,
): Promise<void> {
  assertSelector(options);
  const { repositoryRoot, paths, manifest } = await resolveImportTarget(ctx);

  const projectPaths = resolveSourceRoots({
    projectFlags: options.project ?? [],
    manifest,
    repoRoot: repositoryRoot,
    cwd: ctx.cwd ?? process.cwd(),
  });
  const sessionsRoot = ctx.codexSessionsDir ?? join(homedir(), ".codex", "sessions");

  const rollouts = await discoverCodexRollouts(sessionsRoot, projectPaths, options);
  const candidates: ImportCandidate[] = rollouts.map(({ file, externalId }) => ({
    externalId,
    sourcePath: file,
    toPayload: async () => {
      const { records, sizeBytes } = await readJsonlRecords(file);
      return codexRolloutToImportPayload(records as CodexRolloutRecord[], {
        workspaceId: manifest.workspace.id,
        externalId,
        sourceSizeBytes: sizeBytes,
      });
    },
  }));

  await importDerivedSessions(paths, manifest, options, CODEX_IMPORT_SOURCE, candidates);
}

function assertSelector(options: ImportOptions): void {
  if (options.session !== undefined && options.all === true) {
    throw new Error("Specify either --session <id> or --all, not both");
  }
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
 * semantics stay identical across adapters. Dedup is scoped to `sourceKind`
 * so one adapter never matches (or, under `--force`, deletes) another
 * adapter's session that happens to share an id string.
 */
async function importDerivedSessions(
  paths: BasouPaths,
  manifest: Manifest,
  options: ImportOptions,
  sourceKind: SessionSourceKind,
  candidates: ReadonlyArray<ImportCandidate>,
): Promise<void> {
  const existingByExternalId = await loadExistingByExternalId(paths, sourceKind);
  // Session ids imported earlier in THIS run, so two source files that map to
  // one session id never double-import within a single invocation.
  const seenThisRun = new Set<string>();

  const results: ImportSessionResult[] = [];
  const counts: ImportCounts = {
    skippedNoAction: 0,
    skippedExisting: 0,
    replaced: 0,
    reimported: 0,
    skippedLegacy: 0,
    skippedDecreased: 0,
    skippedDuplicate: 0,
    skippedUnverifiable: 0,
  };
  let sanitizedPaths = 0;

  // Parse + version-gate a derived payload before it touches disk. Returns null
  // when the source carried no provenance worth importing (the caller skips).
  const validate = (payload: SessionImportPayload | null): SessionImportPayload | null => {
    if (payload === null) return null;
    const parsed = SessionImportPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error("Invalid import payload", { cause: parsed.error });
    }
    if (parsed.data.schema_version !== "0.1.0") {
      throw new Error(`Unsupported import schema_version: ${parsed.data.schema_version}`);
    }
    return parsed.data;
  };

  for (const { externalId, sourcePath, toPayload } of candidates) {
    if (seenThisRun.has(externalId)) {
      counts.skippedExisting++;
      continue;
    }
    const priors = existingByExternalId.get(externalId) ?? [];

    // Already imported in a prior run. Default is to skip (idempotent), but a
    // source whose native log GREW is re-imported in place, and --force
    // deletes + replaces regardless.
    if (priors.length > 0 && options.force !== true) {
      const prior = await classifyReimport(priors, sourcePath, externalId, counts);
      if (prior === null) continue; // skip recorded by classifyReimport
      const payload = validate(await toPayload());
      if (payload === null) {
        counts.skippedNoAction++;
        continue;
      }
      // Re-confirm growth against the size ACTUALLY read (the decision above used
      // a cheap pre-read stat): if the source was truncated / rotated between the
      // stat and the read, the smaller buffer must not be re-imported as a grow.
      const readSize = payload.session.source.source_size_bytes;
      if (
        prior.sourceSizeBytes !== undefined &&
        readSize !== undefined &&
        readSize <= prior.sourceSizeBytes
      ) {
        console.error(
          `Import: ${externalId} source changed during read (now ${readSize} <= ${prior.sourceSizeBytes} bytes); re-import skipped`,
        );
        counts.skippedDecreased++;
        continue;
      }
      const outcome = await reimportPreservingId(paths, manifest, prior.sessionId, payload, {
        dryRun: options.dryRun === true,
      });
      if (outcome.status === "skipped") {
        const detail =
          outcome.reason === "prior_events_unreadable"
            ? "prior events.jsonl has unreadable lines"
            : outcome.reason === "prior_chain_broken"
              ? "prior events.jsonl failed hash-chain verification (run 'basou verify')"
              : "source changed in a non-append way (derived events would be dropped)";
        console.error(`Import: ${externalId} ${detail}; re-import skipped`);
        // The source GREW but a safe in-place re-import was refused: this is NOT
        // a benign no-op. Track it separately so freshness probes can flag that
        // captured state is provably behind (vs `skippedNoAction`, which is a
        // source with simply nothing to derive).
        counts.skippedUnverifiable++;
        continue;
      }
      counts.reimported++;
      seenThisRun.add(externalId);
      continue;
    }

    const payload = validate(await toPayload());
    if (payload === null) {
      counts.skippedNoAction++;
      continue;
    }

    // --force replace: delete the prior session(s) for this external id, but
    // only once the fresh payload is known good, so a failed re-derivation
    // never destroys the existing import. Skipped under --dry-run.
    if (priors.length > 0 && options.force === true) {
      if (options.dryRun !== true) {
        for (const { sessionId } of priors) {
          await rm(join(paths.sessions, sessionId), { recursive: true, force: true });
        }
      }
      counts.replaced++;
    }

    const result = await importSessionFromJson(paths, manifest, payload, {
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

  printImportResult(options, results, counts);
}

/** Mutable tally of every import disposition, surfaced by {@link printImportResult}. */
type ImportCounts = {
  skippedNoAction: number;
  /** Already imported and unchanged (or a duplicate-within-this-run). */
  skippedExisting: number;
  /** Deleted + replaced under --force. */
  replaced: number;
  /** Re-imported in place because the source grew. */
  reimported: number;
  /** Already imported but with no recorded size (pre-size-tracking import); not re-imported. */
  skippedLegacy: number;
  /** Source shrank since import (truncated / rotated); needs --force to replace. */
  skippedDecreased: number;
  /** More than one prior session for one external id (anomalous); needs --force. */
  skippedDuplicate: number;
  /**
   * Source grew but a safe in-place re-import was refused — a broken prior hash
   * chain, unreadable prior events, or a non-append change that would drop
   * derived ids. Captured state is provably behind; needs `basou verify` then a
   * `--force` re-import. Distinct from {@link skippedNoAction} (nothing to derive).
   */
  skippedUnverifiable: number;
};

/**
 * Decide whether an already-imported external id should be re-imported in place
 * because its source grew. Returns the single prior import to re-import into, or
 * `null` (recording the right skip count) when it must be left alone:
 * unchanged / shrank / legacy (no recorded size) / anomalously duplicated. The
 * size probe is a parse-free `stat`, so unchanged sources are dismissed cheaply.
 */
async function classifyReimport(
  priors: PriorImport[],
  sourcePath: string,
  externalId: string,
  counts: ImportCounts,
): Promise<PriorImport | null> {
  if (priors.length > 1) {
    // Anomalous: a scoped re-import cannot pick which id to preserve, and
    // delete+recreate would orphan any linked_events. Leave it to --force.
    console.error(
      `Import: ${externalId} has ${priors.length} prior sessions; re-import skipped (use --force)`,
    );
    counts.skippedDuplicate++;
    return null;
  }
  const prior = priors[0];
  if (prior === undefined) {
    counts.skippedExisting++;
    return null;
  }
  const currentSize = await statSize(sourcePath);
  if (currentSize === undefined) {
    // Source vanished between discovery and now; nothing to re-import.
    counts.skippedExisting++;
    return null;
  }
  if (prior.sourceSizeBytes === undefined) {
    // Legacy import (no recorded size baseline): never auto-re-import; the size
    // populates on the next --force / fresh import.
    counts.skippedLegacy++;
    return null;
  }
  if (currentSize === prior.sourceSizeBytes) {
    counts.skippedExisting++; // unchanged
    return null;
  }
  if (currentSize < prior.sourceSizeBytes) {
    // Truncated / rotated: do NOT auto-replace derived provenance; --force only.
    console.error(
      `Import: ${externalId} source shrank (${currentSize} < ${prior.sourceSizeBytes} bytes); re-import skipped (use --force to replace)`,
    );
    counts.skippedDecreased++;
    return null;
  }
  return prior; // grew => re-import preserving id
}

/**
 * Encode an absolute project path into Claude Code's per-project directory
 * name. Claude Code replaces every NON-alphanumeric character with `-`, not
 * just the path separator, so `/Users/x/projects/foo_bar` becomes
 * `-Users-x-projects-foo-bar` (note `_` -> `-`, `.` -> `-`, etc.). Encoding
 * only `/` missed any project whose path contained `_`/`.`/space — its
 * transcripts were under a `-`-encoded directory while we looked for an
 * underscore-preserving one, so the whole project was silently skipped as
 * "no source logs". Matching the full rule keeps those projects discoverable.
 */
function encodeProjectDir(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * The cwd a Claude transcript was recorded in — the first record that carries
 * one. Used to attribute a transcript to the project it belongs to when a lossy
 * directory-name collision colocates more than one project's transcripts.
 */
function firstTranscriptCwd(records: ReadonlyArray<ClaudeTranscriptRecord>): string | undefined {
  for (const record of records) {
    const cwd = record.cwd;
    if (typeof cwd === "string" && cwd.length > 0) return cwd;
  }
  return undefined;
}

/**
 * Map of source external_id -> Basou session id(s) already present in the
 * workspace for the given `sourceKind`, so a re-import can skip (default) or,
 * under --force, delete and replace the existing session. Scoping to one
 * source kind keeps each adapter's id namespace separate: a Codex import must
 * never dedup against, or delete, a Claude-derived session that happens to
 * share an id string. Recognises both the structured `source.external_id`
 * (current imports) and the `claude-code import <id>` label form (sessions
 * imported before external_id existed), so existing dogfood imports are
 * matched either way. Unreadable sessions are skipped.
 */
/**
 * A prior Basou session for an external id, with the source byte size recorded
 * at its last import (absent for legacy imports made before the field existed).
 * The size lets a re-import detect that an append-only source GREW.
 */
type PriorImport = { sessionId: string; sourceSizeBytes?: number };

async function loadExistingByExternalId(
  paths: BasouPaths,
  sourceKind: SessionSourceKind,
): Promise<Map<string, PriorImport[]>> {
  const byExternalId = new Map<string, PriorImport[]>();
  const add = (externalId: string, prior: PriorImport): void => {
    const list = byExternalId.get(externalId);
    if (list === undefined) byExternalId.set(externalId, [prior]);
    else list.push(prior);
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
    if (session.session.source.kind !== sourceKind) continue;
    const sourceSizeBytes = session.session.source.source_size_bytes;
    // Build once; omit the size key entirely when absent (legacy import) so the
    // optional property stays absent rather than explicitly undefined.
    const prior: PriorImport =
      sourceSizeBytes !== undefined ? { sessionId, sourceSizeBytes } : { sessionId };
    const ext = session.session.source.external_id;
    if (typeof ext === "string" && ext.length > 0) {
      add(ext, prior);
      continue;
    }
    const label = session.session.label;
    const match = typeof label === "string" ? label.match(/^claude-code import (\S+)$/) : null;
    if (match?.[1] !== undefined) add(match[1], prior);
  }
  return byExternalId;
}

/**
 * Select the Claude transcript files to import across one or more source roots.
 * Each root maps to a per-project transcript directory under `projectsRoot`.
 * With `--session`, every root is probed and only existing matches are returned
 * (an error is raised only if no root holds that transcript). With `--all`, the
 * `.jsonl` files of every root are unioned; a root whose directory is absent
 * contributes nothing. The missing-directory error is raised only when NO root
 * has a transcript directory, so refresh classifies "nothing anywhere" as a
 * skip rather than a failure.
 */
async function selectTranscriptFiles(
  projectsRoot: string,
  projectPaths: string[],
  options: ImportClaudeCodeOptions,
): Promise<string[]> {
  if (options.session !== undefined) {
    const matches: string[] = [];
    for (const projectPath of projectPaths) {
      const file = join(projectsRoot, encodeProjectDir(projectPath), `${options.session}.jsonl`);
      if (await pathExists(file)) matches.push(file);
    }
    if (matches.length === 0) {
      throw new Error("Claude transcript not found for session id in project");
    }
    return [...new Set(matches)];
  }
  const files: string[] = [];
  let anyDirFound = false;
  for (const projectPath of projectPaths) {
    const transcriptDir = join(projectsRoot, encodeProjectDir(projectPath));
    let entries: string[];
    try {
      entries = await readdir(transcriptDir);
    } catch (error: unknown) {
      if (findErrorCode(error, "ENOENT")) continue; // this root has no transcripts; try the next
      throw new Error("Failed to read Claude transcript directory", { cause: error });
    }
    anyDirFound = true;
    for (const name of entries) {
      if (name.endsWith(".jsonl")) files.push(join(transcriptDir, name));
    }
  }
  if (!anyDirFound) {
    throw new Error("Claude transcript directory not found for project");
  }
  return [...new Set(files)].sort();
}

/** Whether `file` exists (ENOENT => false; any other error propagates). */
async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

/** The file's byte size, or undefined if it vanished (ENOENT); other errors propagate. */
async function statSize(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).size;
  } catch (error: unknown) {
    if (findErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

/**
 * Discover the Codex rollouts that belong to any of `projectPaths`. Codex
 * stores rollouts under date directories (not per-project like Claude), so the
 * whole tree is walked once and each rollout's `session_meta.cwd` is matched
 * against the set of requested roots. The exact-match is also the safety
 * boundary: only sessions started in a requested root are ever imported.
 * `--session` narrows to a single rollout by its Codex session id within those
 * roots; a session id that matches no rollout is an error, mirroring how the
 * Claude path fails on a missing `--session` transcript rather than reporting a
 * silent success.
 */
async function discoverCodexRollouts(
  sessionsRoot: string,
  projectPaths: string[],
  options: ImportCodexOptions,
): Promise<Array<{ file: string; externalId: string }>> {
  const projectSet = new Set(projectPaths);
  const files = await findRolloutFiles(sessionsRoot);
  const matched: Array<{ file: string; externalId: string }> = [];
  for (const file of files) {
    const meta = await readRolloutMeta(file);
    if (meta === undefined) continue;
    if (!projectSet.has(meta.cwd)) continue;
    if (options.session !== undefined && meta.id !== options.session) continue;
    matched.push({ file, externalId: meta.id });
  }
  if (options.session !== undefined && matched.length === 0) {
    throw new Error("Codex rollout not found for session id in project");
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
 * Read a JSONL native log into an array of records, plus the file's exact byte
 * size. A malformed line is skipped rather than failing the whole file, so
 * partial native logs still yield best-effort provenance. The byte size is read
 * from the SAME buffer that produced the records (an immutable snapshot), so the
 * size persisted as `source.source_size_bytes` always matches the imported
 * content even if the file is being appended to concurrently.
 */
async function readJsonlRecords(
  file: string,
): Promise<{ records: ClaudeTranscriptRecord[]; sizeBytes: number }> {
  let buffer: Buffer;
  try {
    buffer = await readFile(file);
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
  for (const line of buffer.toString("utf8").split("\n")) {
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
  return { records, sizeBytes: buffer.length };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printImportResult(
  options: ImportOptions,
  results: ImportSessionResult[],
  counts: ImportCounts,
): void {
  const isDry = options.dryRun === true;
  const eventTotal = results.reduce((sum, r) => sum + r.eventCount, 0);
  const {
    skippedNoAction,
    skippedExisting,
    replaced,
    reimported,
    skippedLegacy,
    skippedDecreased,
    skippedDuplicate,
    skippedUnverifiable,
  } = counts;

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
        reimported_count: reimported,
        skipped_no_action: skippedNoAction,
        skipped_already_imported: skippedExisting,
        skipped_legacy_untracked: skippedLegacy,
        skipped_decreased: skippedDecreased,
        skipped_duplicate: skippedDuplicate,
        skipped_unverifiable: skippedUnverifiable,
        event_total: eventTotal,
        dry_run: isDry,
      }),
    );
    return;
  }

  const skipParts: string[] = [];
  if (skippedNoAction > 0) skipParts.push(`${skippedNoAction} with no actions`);
  if (skippedExisting > 0) skipParts.push(`${skippedExisting} already imported`);
  if (skippedLegacy > 0) skipParts.push(`${skippedLegacy} legacy (untracked size)`);
  if (skippedDecreased > 0) skipParts.push(`${skippedDecreased} shrank`);
  if (skippedDuplicate > 0) skipParts.push(`${skippedDuplicate} duplicated`);
  if (skippedUnverifiable > 0)
    skipParts.push(`${skippedUnverifiable} unverifiable (run 'basou verify')`);
  const skipSuffix = skipParts.length > 0 ? `; skipped ${skipParts.join(", ")}` : "";
  const eventsPart =
    replaced > 0 ? `${eventTotal} events, ${replaced} replaced` : `${eventTotal} events`;

  if (isDry) {
    const parts: string[] = [];
    if (results.length > 0) parts.push(`import ${results.length} session(s) (${eventsPart})`);
    if (reimported > 0) parts.push(`re-import ${reimported} changed session(s)`);
    const head = parts.length > 0 ? `Dry run: would ${parts.join(", ")}` : "Dry run: no changes";
    console.log(`${head}${skipSuffix}`);
    return;
  }

  if (results.length === 0 && reimported === 0) {
    console.log(
      skipParts.length > 0
        ? `No new sessions imported (skipped ${skipParts.join(", ")})`
        : "No transcripts found to import",
    );
    return;
  }

  const segments: string[] = [];
  if (results.length > 0) {
    const single =
      results.length === 1 && results[0] !== undefined ? ` (${shortId(results[0].sessionId)})` : "";
    segments.push(`Imported ${results.length} session(s)${single} (${eventsPart})`);
  }
  if (reimported > 0) {
    segments.push(
      `${results.length > 0 ? "re-imported" : "Re-imported"} ${reimported} changed session(s)`,
    );
  }
  console.log(`${segments.join(", ")}${skipSuffix}`);
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
