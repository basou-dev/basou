import { createReadStream, type Dirent } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  AGENT_INFRA_DIRS,
  assertBasouRootSafe,
  assertLockStoreSafe,
  assertSessionStoreSafe,
  type BasouPaths,
  basouPaths,
  CLAUDE_IMPORT_SOURCE,
  type ClaudeTranscriptRecord,
  CODEX_IMPORT_SOURCE,
  type CodexRolloutRecord,
  classifyFilesBySourceRoot,
  claudeTranscriptOwnRecords,
  claudeTranscriptRecordUuid,
  claudeTranscriptToImportPayload,
  codexRolloutToImportPayload,
  displayPath,
  enumerateSessionEntries,
  findErrorCode,
  type ImportSessionResult,
  importSessionFromJson,
  type Manifest,
  observedFilesOf,
  readManifest,
  readSessionObservation,
  readSessionYaml,
  reimportPreservingId,
  SESSION_IMPORT_SCHEMA_VERSION,
  type Session,
  SessionFileNotAFileError,
  type SessionImportPayload,
  SessionImportPayloadSchema,
  type SessionSourceKind,
} from "@basou/core";
import type { Command } from "commander";
import { isVerbose, renderCliError } from "../lib/error-render.js";
import { warnIfObservationsRefused } from "../lib/observation-warn.js";
import { resolveBasouRootForCommand } from "../lib/repo-root.js";

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
  /**
   * When a Claude transcript's file was created, in milliseconds since the
   * epoch, which decides which of two transcripts of one conversation forked
   * the other. Defaults to the file's birth time. Injectable for tests: a file
   * system offers no way to set a birth time.
   */
  transcriptCreatedAtMs?: (file: string) => Promise<number>;
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
  /**
   * Read and derive the source. `notBefore` is the start of the session an
   * earlier import made from it: an adapter whose sources can copy records from
   * one another leaves out what is older (Claude Code); the others ignore it.
   */
  toPayload: (notBefore?: string) => Promise<DerivedSource>;
  /**
   * Whether the session an earlier import made from this source still holds
   * records the source copied from an older one, so it is re-derived even
   * though the source did not change. Absent for an adapter whose sources copy
   * nothing.
   */
  holdsCopies?: (prior: PriorImport) => boolean;
};

/** What {@link ImportCandidate.toPayload} derived. */
type DerivedSource = {
  payload: SessionImportPayload | null;
  /**
   * Records the source copied from an older one were left out of the
   * derivation, so a re-import may drop what an earlier import derived from
   * them (see `dropDerivedBefore` on `reimportPreservingId`).
   */
  leftOutCopies: boolean;
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
 *
 * Exported so the capture-coverage check derives a workspace's roots through
 * the SAME function the import guard uses: coverage claims "import would not
 * take this session log", and that claim only holds while both sides resolve
 * roots identically. Note that identical resolution needs the same INPUT too —
 * `resolveImportTarget` passes the root `resolveBasouRootForCommand` resolves
 * (the git toplevel, or the repo a workspace view or a portfolio member resolves
 * to), so a caller that passes some other spelling of the repo (a symlink, a
 * subdirectory) gets a different root set than the import it is trying to
 * mirror.
 */
export function resolveSourceRoots(args: {
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
  // Only this adapter reads observations. Said once per run, not per session
  // (a refused directory costs every session imported here its observed
  // files), and before the transcripts are looked for, so a run that finds
  // none still says it.
  await warnIfObservationsRefused(paths);

  const projectPaths = resolveSourceRoots({
    projectFlags: options.project ?? [],
    manifest,
    repoRoot: repositoryRoot,
    cwd: ctx.cwd ?? process.cwd(),
  });
  const projectsRoot = ctx.claudeProjectsDir ?? join(homedir(), ".claude", "projects");

  const files = await selectTranscriptFiles(projectsRoot, projectPaths, options);
  // Every transcript of the source roots, not only the selected ones: a
  // transcript forked from another opens with copies of its records, and which
  // records are copies is known only beside the older transcript.
  const conversations = await indexConversations(
    await listTranscriptFiles(projectsRoot, projectPaths),
    ctx.transcriptCreatedAtMs ?? birthTimeMs,
  );
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
    const { root, older } = conversations.place(file);
    return {
      externalId,
      sourcePath: file,
      // An earlier import that took the copies too began the session at the
      // conversation's first record or before it; one without them begins after
      // the last copy.
      holdsCopies: (prior) =>
        older.length > 0 &&
        root?.timestamp !== undefined &&
        Date.parse(prior.startedAt) <= Date.parse(root.timestamp),
      toPayload: async (notBefore) => {
        const { records, sizeBytes } = await readJsonlRecords(file);
        const cwd = firstTranscriptCwd(records);
        if (cwd === undefined || !projectSet.has(cwd))
          return { payload: null, leftOutCopies: false };
        // What the hooks observed through git while this session ran. Absent
        // for any session that started before the hook was installed, or
        // outside a registered workspace — the import then carries only what
        // the transcript itself could show, exactly as before.
        const observation = await readSessionObservation(paths.observations, externalId);
        const observedFiles = observation === null ? [] : observedFilesOf(observation);
        // The records an older transcript of this conversation holds are its
        // session's; this one keeps what it added after it forked.
        const own = claudeTranscriptOwnRecords(records, {
          copiedUuids: await conversations.uuidsOf(older),
          ...(notBefore !== undefined ? { notBefore } : {}),
        });
        return {
          payload: claudeTranscriptToImportPayload(own, {
            workspaceId: manifest.workspace.id,
            externalId,
            sourceSizeBytes: sizeBytes,
            ...(observedFiles.length > 0 ? { observedFiles } : {}),
          }),
          leftOutCopies: own.length < records.length,
        };
      },
    };
  });

  await importDerivedSessions(
    paths,
    manifest,
    options,
    CLAUDE_IMPORT_SOURCE,
    candidates,
    projectPaths,
    hasDeclaredBoundary(options, manifest),
  );
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
      return {
        payload: codexRolloutToImportPayload(records as CodexRolloutRecord[], {
          workspaceId: manifest.workspace.id,
          externalId,
          sourceSizeBytes: sizeBytes,
        }),
        leftOutCopies: false,
      };
    },
  }));

  await importDerivedSessions(
    paths,
    manifest,
    options,
    CODEX_IMPORT_SOURCE,
    candidates,
    projectPaths,
    hasDeclaredBoundary(options, manifest),
  );
}

/**
 * Whether the operator declared a project boundary worth checking edits
 * against: explicit `--project` flags, or a manifest `import.source_roots`
 * list. Neither ⇒ a solo project, where every edit under the repo root is
 * in-bounds and the cross-project warning would be noise.
 */
function hasDeclaredBoundary(options: ImportOptions, manifest: Manifest): boolean {
  return (options.project?.length ?? 0) > 0 || (manifest.import?.source_roots?.length ?? 0) > 0;
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
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "import");
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
  projectPaths: ReadonlyArray<string>,
  boundaryDeclared: boolean,
): Promise<void> {
  // A `.basou/sessions` that is a symlink stops the import before anything is
  // read from it, `--dry-run` included. A re-import takes a session lock, so a
  // `.basou/locks` that is one stops it too, before any session is imported
  // (a dry run takes no lock and is not stopped).
  await assertSessionStoreSafe(paths);
  if (options.dryRun !== true) await assertLockStoreSafe(paths);
  const {
    byExternalId: existingByExternalId,
    notDirectories,
    yamlNotFiles,
  } = await loadExistingByExternalId(paths, sourceKind);
  // An entry named as a session that is not a directory is not followed, nor
  // is a session.yaml that is not a regular file, so an earlier import either
  // holds is not seen. Said once, when a session is about to be imported as
  // new.
  let notDirectoriesWarned = false;
  // Session ids imported earlier in THIS run, so two source files that map to
  // one session id never double-import within a single invocation.
  const seenThisRun = new Set<string>();

  // Cross-project boundary check: a session attributed to this project (by its
  // cwd) can still have edited files OUTSIDE the declared source roots. Flag
  // those so a resuming agent does not mistake another repo's work for this
  // project's. Gated to a DECLARED boundary — explicit `--project` flags or a
  // manifest `import.source_roots` list; a solo project (neither) has no
  // boundary to cross. `projectPaths` are already absolute, so they double as
  // the resolved source roots.
  const crossProjectCheck = boundaryDeclared;
  const crossProject: { externalId: string; outOfRoot: string[] }[] = [];
  const noteCrossProject = async (
    externalId: string,
    payload: SessionImportPayload,
  ): Promise<void> => {
    if (!crossProjectCheck) return;
    try {
      const scope = await classifyFilesBySourceRoot({
        files: payload.session.related_files ?? [],
        workingDirectory: payload.session.working_directory,
        sourceRoots: projectPaths,
        masterRoot: dirname(paths.root),
        extraInRoot: AGENT_INFRA_DIRS,
      });
      if (scope.outOfRoot.length > 0) crossProject.push({ externalId, outOfRoot: scope.outOfRoot });
    } catch {
      // Advisory only; a classification failure must never abort the import.
    }
  };

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
    droppedCopies: 0,
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
    if (parsed.data.schema_version !== SESSION_IMPORT_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported import schema_version: ${parsed.data.schema_version} ` +
          `(expected ${SESSION_IMPORT_SCHEMA_VERSION}). The envelope's shape is ` +
          `published as @basou/core/schemas/session-import.schema.json; this ` +
          `version may move at a minor release, so a producer should read it ` +
          `from the installed @basou/core rather than pinning it.`,
      );
    }
    return parsed.data;
  };

  for (const { externalId, sourcePath, toPayload, holdsCopies } of candidates) {
    if (seenThisRun.has(externalId)) {
      counts.skippedExisting++;
      continue;
    }
    const priors = existingByExternalId.get(externalId) ?? [];

    // Already imported in a prior run. Default is to skip (idempotent), but a
    // source whose native log GREW is re-imported in place, as is one whose
    // session still holds records it copied from an older source, and --force
    // deletes + replaces regardless.
    if (priors.length > 0 && options.force !== true) {
      const decision = await classifyReimport(priors, sourcePath, externalId, counts, holdsCopies);
      if (decision === null) continue; // skip recorded by classifyReimport
      const { prior, reason } = decision;
      const derived = await toPayload(prior.startedAt);
      const payload = validate(derived.payload);
      if (payload === null) {
        if (reason === "holds_copies") {
          console.error(
            `Import: ${externalId} added no action of its own after the records it copied from an older transcript; its session, imported with those records, is left as it is`,
          );
        }
        counts.skippedNoAction++;
        continue;
      }
      if (reason === "holds_copies" && !derived.leftOutCopies) {
        // The older transcript was not there to read after all: nothing to drop.
        counts.skippedExisting++;
        continue;
      }
      // Re-confirm against the size ACTUALLY read (the decision above used a
      // cheap pre-read stat): if the source was truncated / rotated between the
      // stat and the read, the smaller buffer must not be re-imported as a grow,
      // nor, for a session re-derived to drop its copies, as the same source.
      const readSize = payload.session.source.source_size_bytes;
      if (
        prior.sourceSizeBytes !== undefined &&
        readSize !== undefined &&
        (reason === "grew" ? readSize <= prior.sourceSizeBytes : readSize < prior.sourceSizeBytes)
      ) {
        console.error(
          `Import: ${externalId} source changed during read (now ${readSize} bytes, was ${prior.sourceSizeBytes}); re-import skipped`,
        );
        counts.skippedDecreased++;
        continue;
      }
      const outcome = await reimportPreservingId(paths, manifest, prior.sessionId, payload, {
        dryRun: options.dryRun === true,
        // What an earlier import derived from the copies predates the session's
        // fresh start; anything later that is not reproduced still refuses.
        ...(derived.leftOutCopies ? { dropDerivedBefore: payload.session.started_at } : {}),
      });
      if (outcome.status === "skipped") {
        const detail =
          outcome.reason === "prior_events_unreadable"
            ? "prior events.jsonl has unreadable lines"
            : outcome.reason === "prior_chain_broken"
              ? "prior events.jsonl failed hash-chain verification (run 'basou verify')"
              : outcome.reason === "prior_yaml_invalid"
                ? "prior session.yaml does not load as a whole document"
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
      // The prior session held the copies, and this re-derivation left them out:
      // whether or not they had derived any event, they are gone from it now.
      if (holdsCopies?.(prior) === true) counts.droppedCopies++;
      seenThisRun.add(externalId);
      await noteCrossProject(externalId, payload);
      continue;
    }

    // Under --force the prior session is replaced, but where it began still
    // bounds what the source may bring back (see `notBefore`).
    const payload = validate((await toPayload(earliestStart(priors))).payload);
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

    if (
      priors.length === 0 &&
      (notDirectories.length > 0 || yamlNotFiles.length > 0) &&
      !notDirectoriesWarned
    ) {
      notDirectoriesWarned = true;
      if (notDirectories.length > 0) {
        const one = notDirectories.length === 1;
        console.error(
          `Import: ${notDirectories.join(", ")} ${one ? "is not a directory" : "are not directories"} ` +
            `(a symlink or a file is not followed), so ${one ? "it was" : "they were"} not checked ` +
            "for an earlier import; a session imported there may be imported again",
        );
      }
      if (yamlNotFiles.length > 0) {
        const one = yamlNotFiles.length === 1;
        console.error(
          `Import: the session.yaml of ${yamlNotFiles.join(", ")} ${one ? "is" : "are"} not a regular file ` +
            `(a symlink or anything else is not followed), so ${one ? "it was" : "they were"} not checked ` +
            "for an earlier import; a session imported there may be imported again",
        );
      }
    }
    const result = await importSessionFromJson(paths, manifest, payload, {
      dryRun: options.dryRun === true,
    });
    results.push(result);
    seenThisRun.add(externalId);
    sanitizedPaths +=
      result.pathSanitizeReport.relatedFiles +
      (result.pathSanitizeReport.workingDirectoryRewritten ? 1 : 0);
    await noteCrossProject(externalId, payload);
  }

  if (sanitizedPaths > 0) {
    console.error(`Imported sessions: ${sanitizedPaths} path(s) sanitized`);
  }

  if (crossProject.length > 0) {
    const PATH_SAMPLE = 5;
    for (const { externalId, outOfRoot } of crossProject) {
      // Printed to a terminal: see `displayPath`.
      const sample = outOfRoot.slice(0, PATH_SAMPLE).map(displayPath).join(", ");
      const more =
        outOfRoot.length > PATH_SAMPLE ? ` (... +${outOfRoot.length - PATH_SAMPLE} more)` : "";
      console.error(
        `basou: session ${externalId} edited ${outOfRoot.length} file(s) outside this project's source_roots: ${sample}${more} — they may belong to another project.`,
      );
    }
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
  /**
   * Re-imported in place: the source grew, or its session still held records
   * the source copied from an older one.
   */
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
  /**
   * Of {@link reimported}, the sessions that held records their source copied
   * from an older one, and no longer do.
   */
  droppedCopies: number;
};

/**
 * Decide whether an already-imported external id should be re-imported in place:
 * because its source grew, or because the session an earlier import made from it
 * still holds records the source copied from an older one (`holdsCopies`).
 * Returns the single prior import to re-import into and why, or `null`
 * (recording the right skip count) when it must be left alone: unchanged /
 * shrank / legacy (no recorded size) / anomalously duplicated. The size probe is
 * a parse-free `stat`, so unchanged sources are dismissed cheaply.
 */
async function classifyReimport(
  priors: PriorImport[],
  sourcePath: string,
  externalId: string,
  counts: ImportCounts,
  holdsCopies?: (prior: PriorImport) => boolean,
): Promise<{ prior: PriorImport; reason: "grew" | "holds_copies" } | null> {
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
    if (holdsCopies?.(prior) === true) return { prior, reason: "holds_copies" };
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
  return { prior, reason: "grew" }; // re-import preserving id
}

/** The earliest start among the prior imports of one source, if any. */
function earliestStart(priors: ReadonlyArray<PriorImport>): string | undefined {
  let earliest: string | undefined;
  for (const { startedAt } of priors) {
    if (earliest === undefined || Date.parse(startedAt) < Date.parse(earliest))
      earliest = startedAt;
  }
  return earliest;
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
 *
 * Exported because this encoding is a SECOND Claude-side import guard beside
 * the cwd equality one: the importer only ever lists the transcripts sitting in
 * `encodeProjectDir(root)` for a declared root. The capture-coverage check has
 * to apply it too, or it reports a transcript as captured that import never
 * lists.
 */
export function encodeProjectDir(projectPath: string): string {
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
 * matched either way. Unreadable sessions are skipped. Also returns the
 * entries named as a session id that are not directories: they are not
 * followed, so an earlier import one of them holds is not in the map.
 */
/**
 * A prior Basou session for an external id, with the source byte size recorded
 * at its last import (absent for legacy imports made before the field existed)
 * and when the session began. The size lets a re-import detect that an
 * append-only source GREW.
 */
type PriorImport = { sessionId: string; startedAt: string; sourceSizeBytes?: number };

async function loadExistingByExternalId(
  paths: BasouPaths,
  sourceKind: SessionSourceKind,
): Promise<{
  byExternalId: Map<string, PriorImport[]>;
  notDirectories: string[];
  yamlNotFiles: string[];
}> {
  const byExternalId = new Map<string, PriorImport[]>();
  const add = (externalId: string, prior: PriorImport): void => {
    const list = byExternalId.get(externalId);
    if (list === undefined) byExternalId.set(externalId, [prior]);
    else list.push(prior);
  };
  let sessionIds: string[];
  let notDirectories: string[];
  try {
    ({ dirs: sessionIds, notDirectories } = await enumerateSessionEntries(paths));
  } catch {
    return { byExternalId, notDirectories: [], yamlNotFiles: [] };
  }
  const yamlNotFiles: string[] = [];
  for (const sessionId of sessionIds) {
    let session: Session;
    try {
      session = await readSessionYaml(paths, sessionId);
    } catch (error: unknown) {
      if (error instanceof SessionFileNotAFileError) yamlNotFiles.push(sessionId);
      continue;
    }
    if (session.session.source.kind !== sourceKind) continue;
    const sourceSizeBytes = session.session.source.source_size_bytes;
    const startedAt = session.session.started_at;
    // Build once; omit the size key entirely when absent (legacy import) so the
    // optional property stays absent rather than explicitly undefined.
    const prior: PriorImport =
      sourceSizeBytes !== undefined
        ? { sessionId, startedAt, sourceSizeBytes }
        : { sessionId, startedAt };
    const ext = session.session.source.external_id;
    if (typeof ext === "string" && ext.length > 0) {
      add(ext, prior);
      continue;
    }
    const label = session.session.label;
    const match = typeof label === "string" ? label.match(/^claude-code import (\S+)$/) : null;
    if (match?.[1] !== undefined) add(match[1], prior);
  }
  return { byExternalId, notDirectories, yamlNotFiles };
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

/**
 * Every `.jsonl` transcript in the per-project directories of the source roots,
 * whatever `--session` / `--all` selected. A root without a directory adds
 * nothing and raises nothing: {@link selectTranscriptFiles} raises the error
 * refresh classifies.
 */
async function listTranscriptFiles(
  projectsRoot: string,
  projectPaths: string[],
): Promise<string[]> {
  const files: string[] = [];
  for (const projectPath of projectPaths) {
    const transcriptDir = join(projectsRoot, encodeProjectDir(projectPath));
    let entries: string[];
    try {
      entries = await readdir(transcriptDir);
    } catch (error: unknown) {
      if (findErrorCode(error, "ENOENT")) continue;
      throw new Error("Failed to read Claude transcript directory", { cause: error });
    }
    for (const name of entries) {
      if (name.endsWith(".jsonl")) files.push(join(transcriptDir, name));
    }
  }
  return [...new Set(files)].sort();
}

/** The first record of a transcript that carries a uuid: its conversation's root. */
type ConversationRoot = { uuid: string; timestamp?: string };

/** The transcripts of the source roots, grouped by the conversation they hold. */
type Conversations = {
  /**
   * The root of `file`'s conversation, and the other transcripts of that
   * conversation created before it, oldest first. A transcript with older ones
   * forked from them and opens with copies of their records.
   */
  place(file: string): { root: ConversationRoot | undefined; older: string[] };
  /** Every uuid the records of `files` carry. Each file is read once per run. */
  uuidsOf(files: ReadonlyArray<string>): Promise<Set<string>>;
};

/**
 * Group transcripts by conversation. A transcript forked from another (a session
 * resumed into a new session id, or one started from another's conversation)
 * opens with copies of that one's records under their original uuids, so every
 * transcript of a conversation opens with the same root record, and reading
 * each transcript up to its first uuid is enough to group them.
 *
 * Within a conversation the transcript whose file was created first comes first
 * (`createdAtMs`, the file's birth time). Where a file system records no birth
 * time, or two are equal, the session id decides: an arbitrary order, but one
 * every run agrees on.
 */
async function indexConversations(
  files: ReadonlyArray<string>,
  createdAtMs: (file: string) => Promise<number>,
): Promise<Conversations> {
  type Entry = { file: string; externalId: string; createdAtMs: number };
  const rootOf = new Map<string, ConversationRoot>();
  const byRoot = new Map<string, Entry[]>();
  for (const file of files) {
    const root = await readConversationRoot(file);
    if (root === undefined) continue;
    rootOf.set(file, root);
    const entry: Entry = { file, externalId: basename(file, ".jsonl"), createdAtMs: Number.NaN };
    const list = byRoot.get(root.uuid);
    if (list === undefined) byRoot.set(root.uuid, [entry]);
    else list.push(entry);
  }
  for (const list of byRoot.values()) {
    if (list.length < 2) continue;
    for (const entry of list) entry.createdAtMs = await createdAtMs(entry.file);
    list.sort((a, b) => {
      const knownA = Number.isFinite(a.createdAtMs) && a.createdAtMs > 0;
      const knownB = Number.isFinite(b.createdAtMs) && b.createdAtMs > 0;
      if (knownA && knownB && a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
      if (knownA !== knownB) return knownA ? -1 : 1;
      return a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0;
    });
  }
  const uuidsByFile = new Map<string, Set<string>>();
  return {
    place(file) {
      const root = rootOf.get(file);
      if (root === undefined) return { root: undefined, older: [] };
      const list = byRoot.get(root.uuid) ?? [];
      const at = list.findIndex((entry) => entry.file === file);
      return { root, older: list.slice(0, Math.max(at, 0)).map((entry) => entry.file) };
    },
    async uuidsOf(older) {
      const uuids = new Set<string>();
      for (const file of older) {
        let held = uuidsByFile.get(file);
        if (held === undefined) {
          held = new Set();
          try {
            const { records } = await readJsonlRecords(file);
            for (const record of records) {
              const uuid = claudeTranscriptRecordUuid(record);
              if (uuid !== undefined) held.add(uuid);
            }
          } catch {
            // Gone since it was listed: nothing it held can be named as a copy.
          }
          uuidsByFile.set(file, held);
        }
        for (const uuid of held) uuids.add(uuid);
      }
      return uuids;
    },
  };
}

/**
 * Read a transcript up to its first record that carries a uuid. `undefined` for
 * a transcript with none, or one that cannot be read.
 */
async function readConversationRoot(file: string): Promise<ConversationRoot | undefined> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!isObject(parsed)) continue;
      const uuid = claudeTranscriptRecordUuid(parsed);
      if (uuid === undefined) continue;
      const timestamp = parsed.timestamp;
      return typeof timestamp === "string" && timestamp.length > 0 ? { uuid, timestamp } : { uuid };
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    rl.close();
    stream.destroy();
  }
}

/** A file's birth time, or NaN when it cannot be read. */
async function birthTimeMs(file: string): Promise<number> {
  try {
    return (await stat(file)).birthtimeMs;
  } catch {
    return Number.NaN;
  }
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
 *
 * Exported so the capture-coverage check reads a rollout through the SAME
 * guard the Codex import uses. A looser reader (any record's `payload.cwd`,
 * anywhere in the file) makes coverage claim a rollout is captured that import
 * never treats as a candidate.
 */
export async function readRolloutMeta(
  file: string,
): Promise<{ id: string; cwd: string } | undefined> {
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
    droppedCopies,
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
        dropped_copies_count: droppedCopies,
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
  const copiesPart =
    droppedCopies > 0
      ? ` (${droppedCopies} without the records ${droppedCopies === 1 ? "its transcript" : "their transcripts"} copied from an older one)`
      : "";

  if (isDry) {
    const parts: string[] = [];
    if (results.length > 0) parts.push(`import ${results.length} session(s) (${eventsPart})`);
    if (reimported > 0) parts.push(`re-import ${reimported} changed session(s)${copiesPart}`);
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
      `${results.length > 0 ? "re-imported" : "Re-imported"} ${reimported} changed session(s)${copiesPart}`,
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
