import {
  type BasouPaths,
  readMarkdownFile,
  renderDecisions,
  renderHandoff,
  renderOrientation,
  renderWithMarkers,
  writeMarkdownFile,
} from "@basou/core";
import {
  doRunImportClaudeCode,
  doRunImportCodex,
  type ImportContext,
  type ImportOptions,
} from "../commands/import.js";

/**
 * Shared provenance actions reused by both `basou refresh` (one-shot CLI) and
 * the `basou view` server's action endpoints, so the two stay behaviourally
 * identical. These wrap the existing import commands and markdown renderers;
 * they own no process state and print nothing of their own.
 */

/** Which native-log adapter an import outcome came from. */
export type ImportAdapter = "claude-code" | "codex";

/** Result of running one adapter's import, or a note that it was skipped. */
export type ImportOutcome =
  | {
      adapter: ImportAdapter;
      status: "ran";
      importedCount: number;
      replacedCount: number;
      /** Sessions re-imported in place because their source grew. */
      reimportedCount: number;
      skippedNoAction: number;
      skippedAlreadyImported: number;
      /** Already imported but with no recorded source size (pre-size-tracking); not re-imported. */
      skippedLegacyUntracked: number;
      eventTotal: number;
      dryRun: boolean;
    }
  | { adapter: ImportAdapter; status: "skipped"; reason: string };

/** Counts from regenerating handoff.md / decisions.md, or a skip note. */
export type GenerateOutcome<TExtra> =
  | ({ status: "generated" } & TExtra)
  | { status: "skipped"; reason: string };

export type HandoffCounts = {
  sessionCount: number;
  taskCount: number;
  decisionCount: number;
  pendingApprovalsCount: number;
};

export type OrientationCounts = {
  sessionCount: number;
  inFlightTaskCount: number;
  pendingApprovalsCount: number;
  suspectCount: number;
};

/** Structured result of {@link refreshAll}. */
export type RefreshResult = {
  claudeCode: ImportOutcome;
  codex: ImportOutcome;
  handoff: GenerateOutcome<HandoffCounts>;
  decisions: GenerateOutcome<{ decisionCount: number }>;
  orientation: GenerateOutcome<OrientationCounts>;
  dryRun: boolean;
};

export type RefreshActionOptions = {
  project?: string[];
  force?: boolean;
  dryRun?: boolean;
};

/**
 * Run `fn` (an import command invoked with `json: true`) while capturing its
 * console output, then return the single machine-readable JSON result line.
 * The import commands print their result as one JSON object on stdout; that
 * line is the result contract. `console` is always restored, even on throw.
 */
async function captureImportJson(fn: () => Promise<void>): Promise<Record<string, unknown>> {
  const stdout: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = ((...args: unknown[]) => {
    stdout.push(args.map((a) => String(a)).join(" "));
  }) as typeof console.log;
  // The import path writes an informational "N path(s) sanitized" line to
  // stderr; swallow it so refresh / the view server stay quiet.
  console.error = (() => {}) as typeof console.error;
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  for (let i = stdout.length - 1; i >= 0; i--) {
    const line = stdout[i];
    if (line === undefined) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object" && "imported_count" in parsed) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not the JSON result line; keep scanning earlier lines.
    }
  }
  throw new Error("Import produced no parseable result");
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * A source-log directory that does not exist for the requested project is a
 * normal "this adapter has nothing here" condition for refresh, not a failure.
 */
function isMissingSourceDir(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message === "Claude transcript directory not found for project" ||
    error.message === "Codex sessions directory not found"
  );
}

/** Run one adapter import as a best-effort action, classifying a missing source dir as skipped. */
async function runImport(adapter: ImportAdapter, fn: () => Promise<void>): Promise<ImportOutcome> {
  try {
    const json = await captureImportJson(fn);
    return {
      adapter,
      status: "ran",
      importedCount: readCount(json.imported_count),
      replacedCount: readCount(json.replaced_count),
      reimportedCount: readCount(json.reimported_count),
      skippedNoAction: readCount(json.skipped_no_action),
      skippedAlreadyImported: readCount(json.skipped_already_imported),
      skippedLegacyUntracked: readCount(json.skipped_legacy_untracked),
      eventTotal: readCount(json.event_total),
      dryRun: json.dry_run === true,
    };
  } catch (error: unknown) {
    if (isMissingSourceDir(error)) {
      return { adapter, status: "skipped", reason: "no source logs for this project" };
    }
    throw error;
  }
}

function importOptions(options: RefreshActionOptions): ImportOptions {
  return {
    all: true,
    json: true,
    ...(options.project !== undefined ? { project: options.project } : {}),
    ...(options.force === true ? { force: true } : {}),
    ...(options.dryRun === true ? { dryRun: true } : {}),
  };
}

/** Import Claude Code transcripts for the project (best-effort). */
export function importClaudeCode(
  options: RefreshActionOptions,
  ctx: ImportContext,
): Promise<ImportOutcome> {
  return runImport("claude-code", () => doRunImportClaudeCode(importOptions(options), ctx));
}

/** Import Codex rollouts for the project (best-effort). */
export function importCodex(
  options: RefreshActionOptions,
  ctx: ImportContext,
): Promise<ImportOutcome> {
  return runImport("codex", () => doRunImportCodex(importOptions(options), ctx));
}

type RenderCallbacks = Parameters<typeof renderHandoff>[0];

/** Regenerate `.basou/handoff.md` and return the renderer's counts. */
export async function regenerateHandoff(
  paths: BasouPaths,
  nowIso: string,
  callbacks?: Omit<RenderCallbacks, "paths" | "nowIso">,
): Promise<HandoffCounts> {
  const result = await renderHandoff({ paths, nowIso, ...callbacks });
  const existing = await readMarkdownFile(paths.files.handoff);
  await writeMarkdownFile(
    paths.files.handoff,
    renderWithMarkers(existing, result.body, "handoff.md"),
  );
  return {
    sessionCount: result.sessionCount,
    taskCount: result.taskCount,
    decisionCount: result.decisionCount,
    pendingApprovalsCount: result.pendingApprovalsCount,
  };
}

/** Regenerate `.basou/decisions.md` and return the decision count. */
export async function regenerateDecisions(
  paths: BasouPaths,
  nowIso: string,
  callbacks?: Omit<Parameters<typeof renderDecisions>[0], "paths" | "nowIso">,
): Promise<{ decisionCount: number }> {
  const result = await renderDecisions({ paths, nowIso, ...callbacks });
  const existing = await readMarkdownFile(paths.files.decisions);
  await writeMarkdownFile(
    paths.files.decisions,
    renderWithMarkers(existing, result.body, "decisions.md"),
  );
  return { decisionCount: result.decisionCount };
}

/**
 * Regenerate `.basou/orientation.md` and return the orientation counts. Unlike
 * handoff/decisions this is a transient, gitignored snapshot, so the whole file
 * is overwritten (no GENERATED markers to preserve a hand-edited region).
 */
export async function regenerateOrientation(
  paths: BasouPaths,
  nowIso: string,
  callbacks?: Omit<Parameters<typeof renderOrientation>[0], "paths" | "nowIso">,
): Promise<OrientationCounts> {
  const result = await renderOrientation({ paths, nowIso, ...callbacks });
  await writeMarkdownFile(paths.files.orientation, `${result.body}\n`);
  return {
    sessionCount: result.sessionCount,
    inFlightTaskCount: result.inFlightTaskCount,
    pendingApprovalsCount: result.pendingApprovalsCount,
    suspectCount: result.suspectCount,
  };
}

/**
 * The shared refresh pipeline: import both adapters (best-effort) for the
 * project, then regenerate handoff + decisions. Under `dryRun`, imports run in
 * preview mode and the markdown files are left untouched. The caller resolves
 * `paths` / `nowIso` and supplies the import `ctx`.
 */
export async function refreshAll(args: {
  options: RefreshActionOptions;
  ctx: ImportContext;
  paths: BasouPaths;
  nowIso: string;
}): Promise<RefreshResult> {
  const { options, ctx, paths, nowIso } = args;
  const dryRun = options.dryRun === true;

  const claudeCode = await importClaudeCode(options, ctx);
  const codex = await importCodex(options, ctx);

  if (dryRun) {
    const skipped = { status: "skipped" as const, reason: "dry-run" };
    return {
      claudeCode,
      codex,
      handoff: skipped,
      decisions: skipped,
      orientation: skipped,
      dryRun,
    };
  }

  const handoffCounts = await regenerateHandoff(paths, nowIso);
  const decisionCounts = await regenerateDecisions(paths, nowIso);
  // A full refresh just imported every root, so the snapshot is current — record
  // a zero staleness so the file's "これは最新か" verdict reads as up to date
  // instead of "run refresh to check". A `--project`-scoped refresh only touched
  // some roots, so leave staleness unset (verdict: "cannot confirm") rather than
  // claim the whole workspace is current.
  const scoped = options.project !== undefined && options.project.length > 0;
  const orientationCounts = await regenerateOrientation(
    paths,
    nowIso,
    scoped ? {} : { staleness: { newSessions: 0, updatedSessions: 0 } },
  );
  return {
    claudeCode,
    codex,
    handoff: { status: "generated", ...handoffCounts },
    decisions: { status: "generated", ...decisionCounts },
    orientation: { status: "generated", ...orientationCounts },
    dryRun,
  };
}

/** Sessions a refresh would newly import for this adapter; 0 unless it ran. */
function wouldImport(outcome: ImportOutcome): number {
  return outcome.status === "ran" ? outcome.importedCount : 0;
}

/** Already-imported sessions a refresh would re-import (grown) or replace. */
function wouldUpdate(outcome: ImportOutcome): number {
  return outcome.status === "ran" ? outcome.reimportedCount + outcome.replacedCount : 0;
}

/** Counts of uncaptured / changed native sessions a real refresh would pick up. */
export type StalenessProbe = { newSessions: number; updatedSessions: number };

/**
 * Make a stale capture measurable instead of silent: run a read-only DRY-RUN
 * refresh (reads the native logs, writes nothing) and count the sessions a real
 * `basou refresh` would add or update. Shared by the portfolio cards and the
 * single-workspace `basou orient` verdict so both judge freshness identically.
 * Returns `null` if the probe could not run (the caller renders "can't confirm"
 * rather than a false "current").
 *
 * NOTE: the import capture swaps the process-global console and is NOT
 * reentrant, so callers must never run two probes concurrently (e.g. the
 * portfolio runs them serially).
 */
export async function probeStaleness(args: {
  ctx: ImportContext;
  paths: BasouPaths;
  nowIso: string;
}): Promise<StalenessProbe | null> {
  try {
    const dry = await refreshAll({
      options: { dryRun: true },
      ctx: args.ctx,
      paths: args.paths,
      nowIso: args.nowIso,
    });
    return {
      newSessions: wouldImport(dry.claudeCode) + wouldImport(dry.codex),
      updatedSessions: wouldUpdate(dry.claudeCode) + wouldUpdate(dry.codex),
    };
  } catch {
    return null;
  }
}
