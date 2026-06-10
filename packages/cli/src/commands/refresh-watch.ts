import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type BasouPaths, findErrorCode } from "@basou/core";
import {
  type ImportOutcome,
  importClaudeCode,
  importCodex,
  type RefreshActionOptions,
  regenerateDecisions,
  regenerateHandoff,
} from "../lib/provenance-actions.js";
import type { ImportContext } from "./import.js";

/** Default poll interval for `--watch`, in seconds. */
export const DEFAULT_WATCH_INTERVAL_SEC = 30;
/** Smallest accepted `--interval`, in seconds. */
export const MIN_WATCH_INTERVAL_SEC = 5;
/** Largest accepted `--interval`, in seconds (1 day; keeps the timer well within the 32-bit ms range). */
export const MAX_WATCH_INTERVAL_SEC = 86_400;

/** A file's change signature: a refresh is triggered when this moves. */
type FileSig = { mtimeMs: number; size: number };
/** Absolute `*.jsonl` path -> its {mtime, size} signature. */
export type SourceLogScan = Map<string, FileSig>;

/**
 * The native-log stores the importers read (Codex rollouts + Claude
 * transcripts), resolved from the context or the `~` defaults. These are the
 * directories the watcher polls -- a new session is a new/grown `*.jsonl` here.
 */
export function watchedRoots(ctx: ImportContext): string[] {
  return [
    ctx.codexSessionsDir ?? join(homedir(), ".codex", "sessions"),
    ctx.claudeProjectsDir ?? join(homedir(), ".claude", "projects"),
  ];
}

/**
 * Recursively collect a `{mtime, size}` signature of every `*.jsonl` under the
 * given roots, keyed by absolute path. A missing root contributes nothing (it
 * may appear later); a file that vanishes mid-walk is skipped. No file content
 * is read, so this is cheap to run every poll.
 */
export async function scanSourceLogs(roots: string[]): Promise<SourceLogScan> {
  const out: SourceLogScan = new Map();
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error: unknown) {
      // Absent (ENOENT) or not a directory (ENOTDIR): nothing to scan here.
      if (findErrorCode(error, "ENOENT") || findErrorCode(error, "ENOTDIR")) return;
      // Surface other errors pathlessly (the native message carries the path).
      throw new Error("Failed to read a source log directory", { cause: error });
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const info = await stat(full);
          out.set(full, { mtimeMs: info.mtimeMs, size: info.size });
        } catch (error: unknown) {
          if (findErrorCode(error, "ENOENT")) continue; // vanished mid-walk; skip
          throw new Error("Failed to stat a source log file", { cause: error });
        }
      }
    }
  };
  for (const root of roots) await walk(root);
  return out;
}

/** Whether two scans describe the same set of files at the same size/mtime. */
export function scansEqual(a: SourceLogScan, b: SourceLogScan): boolean {
  if (a.size !== b.size) return false;
  for (const [path, sig] of a) {
    const other = b.get(path);
    if (other === undefined || other.mtimeMs !== sig.mtimeMs || other.size !== sig.size) {
      return false;
    }
  }
  return true;
}

/**
 * How many sessions an import outcome changed on disk: new imports PLUS
 * in-place re-imports of grown sources PLUS --force replacements. Any
 * non-zero count must trigger a handoff / decisions regeneration, so a session
 * that was re-imported (not freshly imported) does not leave the derived
 * markdown stale.
 */
function changedCount(outcome: ImportOutcome): number {
  return outcome.status === "ran"
    ? outcome.importedCount + outcome.reimportedCount + outcome.replacedCount
    : 0;
}

function describeOutcome(outcome: ImportOutcome): string {
  if (outcome.status !== "ran") return `${outcome.adapter} skipped`;
  const reimported = outcome.reimportedCount > 0 ? ` ~${outcome.reimportedCount}` : "";
  return `${outcome.adapter} +${outcome.importedCount}${reimported}`;
}

function hms(date: Date): string {
  return date.toISOString().slice(11, 19);
}

/** Dependencies for {@link runRefreshWatch}; timers / clock / signal are injectable for tests. */
export type WatchDeps = {
  ctx: ImportContext;
  paths: BasouPaths;
  intervalMs: number;
  /** Import options forwarded to each cycle (project source roots only; no force / dry-run in watch). */
  importOptions: RefreshActionOptions;
  now: () => Date;
  signal: AbortSignal;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  log: (line: string) => void;
};

/** Import both adapters for the workspace's source roots; returns the outcomes + total imported. */
async function runImports(
  deps: WatchDeps,
): Promise<{ claude: ImportOutcome; codex: ImportOutcome; changed: number }> {
  const claude = await importClaudeCode(deps.importOptions, deps.ctx);
  const codex = await importCodex(deps.importOptions, deps.ctx);
  return { claude, codex, changed: changedCount(claude) + changedCount(codex) };
}

/** Regenerate handoff + decisions; returns the handoff session count. */
async function regenerate(deps: WatchDeps): Promise<number> {
  const nowIso = deps.now().toISOString();
  const handoff = await regenerateHandoff(deps.paths, nowIso);
  await regenerateDecisions(deps.paths, nowIso);
  return handoff.sessionCount;
}

/**
 * Poll the native-log stores and keep the workspace current. Does an initial
 * catch-up refresh, then on each interval re-imports ONLY when the logs are
 * quiescent (unchanged since the previous poll, so no session is mid-write) AND
 * have changed since the last import. Handoff / decisions regenerate only when
 * something was imported, so unrelated AI activity elsewhere never rewrites this
 * workspace's files. A failure inside a steady-state cycle is logged and the
 * loop continues; the initial refresh failing is fatal (it propagates). Returns
 * when `signal` aborts (after the in-flight cycle, never mid-write).
 */
export async function runRefreshWatch(deps: WatchDeps): Promise<void> {
  const { intervalMs, ctx, signal, sleep, log } = deps;
  const roots = watchedRoots(ctx);
  log(
    `watching ${roots.join(", ")} every ${Math.round(intervalMs / 1000)}s ` +
      "(imports on change; Ctrl-C to stop)",
  );

  // Baseline BEFORE the initial import, so a session that appears during the
  // import window is not mistaken for "already seen" and missed forever.
  let lastScan = await scanSourceLogs(roots);
  let importedScan = lastScan;

  // Initial catch-up: failure here is fatal (propagates to the caller).
  const initial = await runImports(deps);
  const initialSessions = await regenerate(deps);
  log(
    `[${hms(deps.now())}] refreshed: ${describeOutcome(initial.codex)}, ` +
      `${describeOutcome(initial.claude)} (sessions: ${initialSessions})`,
  );
  if (signal.aborted) {
    log("watch stopped");
    return;
  }

  // Set when an import succeeded but the matching regenerate has not yet (so a
  // regenerate failure cannot leave handoff / decisions stale forever).
  let pendingRegen = false;
  while (!signal.aborted) {
    await sleep(intervalMs, signal);
    if (signal.aborted) break;
    try {
      const current = await scanSourceLogs(roots);
      // Quiescent since the previous poll AND changed since the last import.
      if (scansEqual(current, lastScan) && !scansEqual(current, importedScan)) {
        const { claude, codex, changed } = await runImports(deps);
        if (changed > 0) pendingRegen = true;
        if (pendingRegen) {
          const sessions = await regenerate(deps);
          pendingRegen = false;
          log(
            `[${hms(deps.now())}] refreshed: ${describeOutcome(codex)}, ` +
              `${describeOutcome(claude)} (sessions: ${sessions})`,
          );
        }
        importedScan = current;
      }
      lastScan = current;
    } catch (error: unknown) {
      // A transient fs error must not kill a long-running watcher. Messages from
      // the scan / import / render layers are pathless by contract.
      const message = error instanceof Error ? error.message : String(error);
      log(`[${hms(deps.now())}] refresh cycle skipped: ${message}`);
    }
  }
  log("watch stopped");
}
