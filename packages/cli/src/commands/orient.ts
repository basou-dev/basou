import {
  assertBasouRootSafe,
  basouPaths,
  type FederatedRoot,
  findErrorCode,
  renderOrientation,
  writeMarkdownFile,
} from "@basou/core";
import type { Command } from "commander";
import {
  isVerbose,
  printReplayWarning,
  printSessionSkip,
  printTaskSkip,
  renderCliError,
} from "../lib/error-render.js";
import { loadHostsConfig } from "../lib/hosts-config.js";
import { probeStaleness, refreshAll } from "../lib/provenance-actions.js";
import { resolveBasouRootForCommand } from "../lib/repo-root.js";
import type { ImportContext } from "./import.js";

export type OrientOptions = { verbose?: boolean; quiet?: boolean; refresh?: boolean };

export type OrientContext = ImportContext & {
  /** Defaults to `() => new Date()`. Injectable for tests. */
  nowProvider?: () => Date;
  /** Override path to the hosts registry (`~/.basou/hosts.yaml`). Injectable for tests. */
  hostsConfigPath?: string;
};

/**
 * Wire `basou orient` onto `program`. A read-first "where am I" command: it
 * renders the current position, writes `.basou/orientation.md`, and prints the
 * body to stdout by default. By default it writes NO provenance — a read-only
 * dry-run probe checks for uncaptured native work so the "これは最新か" verdict is
 * honest (use `basou refresh` to actually re-import). `--refresh` opts into
 * importing first (so a SessionStart hook can guarantee a fresh position in one
 * command) while bare `orient` stays read-only. `--verbose` appends raw
 * freshness telemetry under the verdict.
 */
export function registerOrientCommand(program: Command): void {
  program
    .command("orient")
    .description("Show the workspace's current position (also writes .basou/orientation.md)")
    .option("-q, --quiet", "Write the file without printing the body")
    .option(
      "--refresh",
      "Import all adapters first (writes provenance), then show a guaranteed-fresh position; bare orient is read-only",
    )
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: OrientOptions) => {
      await runOrient(opts);
    });
}

/**
 * Programmatic entry that owns `process.exitCode`. Tests that only care about
 * the happy path or a thrown error should prefer {@link doRunOrient}.
 */
export async function runOrient(options: OrientOptions, ctx: OrientContext = {}): Promise<void> {
  try {
    await doRunOrient(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Pure runner for `orient`. Throws on any failure with a pathless message;
 * native errors are attached as `cause` for verbose surfacing.
 */
export async function doRunOrient(options: OrientOptions, ctx: OrientContext): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const repositoryRoot = await resolveBasouRootForCommand(cwd, "orient");
  const paths = basouPaths(repositoryRoot);
  await assertWorkspaceInitialized(paths.root);

  const nowIso = (ctx.nowProvider?.() ?? new Date()).toISOString();

  // Read-only dry-run probe (writes nothing) so the freshness verdict reflects
  // whether uncaptured native work exists, not just the last-captured state.
  const probeCtx: ImportContext = { cwd: repositoryRoot };
  if (ctx.claudeProjectsDir !== undefined) probeCtx.claudeProjectsDir = ctx.claudeProjectsDir;
  if (ctx.codexSessionsDir !== undefined) probeCtx.codexSessionsDir = ctx.codexSessionsDir;

  // `--refresh` (opt-in) imports every adapter first so the position is
  // guaranteed current — the moat-safe way for a SessionStart hook to close the
  // freshness gate without bare `orient` ever becoming a writer. The subsequent
  // dry-run probe then reports fresh, so the verdict reads "current" honestly.
  if (options.refresh === true) {
    await refreshAll({ options: {}, ctx: probeCtx, paths, nowIso });
  }
  const staleness = await probeStaleness({ ctx: probeCtx, paths, nowIso });

  // Federation (zero-network): merge other hosts' trails listed in
  // ~/.basou/hosts.yaml, each a LOCAL path the operator's own tooling (an SSHFS
  // mount / rsync over their existing SSH) keeps in sync. Best-effort and
  // non-fatal: an absent registry is silent (local-only); a malformed one warns
  // and falls back to local-only so `orient` — the default command — never
  // hard-fails on it.
  let federatedRoots: FederatedRoot[] = [];
  try {
    const hosts = await loadHostsConfig(ctx.hostsConfigPath);
    if (hosts !== null) {
      federatedRoots = hosts.map((h) => ({ paths: basouPaths(h.path), host: h.label }));
    }
  } catch (error: unknown) {
    console.error(
      `basou: ignoring ~/.basou/hosts.yaml (${error instanceof Error ? error.message : String(error)}); showing local sessions only.`,
    );
  }

  const result = await renderOrientation({
    paths,
    nowIso,
    staleness,
    verbose: options.verbose === true,
    federatedRoots,
    onWarning: (w, sid) => printReplayWarning(w, sid),
    onSessionSkip: (sid, reason) => printSessionSkip(sid, reason),
    onTaskSkip: (taskId, reason) => printTaskSkip(taskId, reason),
    onHostUnavailable: (host, error) =>
      console.error(
        `basou: host '${host}' mirror unreadable (${error instanceof Error ? error.message : String(error)}); skipping it.`,
      ),
  });

  // orientation.md is a transient, gitignored snapshot: overwrite the whole
  // file (no GENERATED markers — there is no hand-edited region to preserve).
  await writeMarkdownFile(paths.files.orientation, `${result.body}\n`);

  if (options.quiet === true) {
    console.log(
      `Generated .basou/orientation.md (sessions: ${result.sessionCount}, in-flight tasks: ${result.inFlightTaskCount}, pending approvals: ${result.pendingApprovalsCount}, suspect: ${result.suspectCount})`,
    );
  } else {
    console.log(result.body);
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
