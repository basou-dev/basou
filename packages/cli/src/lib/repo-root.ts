import { realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { basouPaths, readManifest, resolveBasouRepositoryRoot } from "@basou/core";
import { DEFAULT_PORTFOLIO_CONFIG_PATH, loadPortfolioConfig } from "./portfolio-config.js";

/** A planning master that aggregates the queried repo via its `source_roots`. */
export type MemberMaster = { root: string; label: string };

/** Override the portfolio registry path (tests). */
export type ResolveRootOptions = {
  /** Defaults to {@link DEFAULT_PORTFOLIO_CONFIG_PATH}. */
  portfolioConfigPath?: string;
};

/**
 * Resolve the repository root for a CLI command with two fallbacks, shared by
 * `orient` / `refresh` / `note` / `decision capture` / `project *` /
 * `review-gaps` / `session` so they behave identically:
 *
 *  1. A git-untracked workspace *view* dir that symlinks its planning repo
 *     redirects to that repo (handled inside {@link resolveBasouRepositoryRoot},
 *     with a note on stderr).
 *  2. A portfolio *member* repo — a git repo that holds no `.basou/` store of its
 *     own because its trail aggregates into a SEPARATE planning master via that
 *     master's `import.source_roots` — redirects to the master. The git resolver
 *     returns a member as its own toplevel (the view fallback only fires for
 *     non-git dirs), so without this it would die downstream with "Workspace not
 *     initialized". When the resolved repo has no store, the master's declaration
 *     is honored in reverse via the portfolio registry (see
 *     {@link resolveMemberToMaster}).
 *
 * A genuine non-git dir reports a command-specific "run git init" message.
 */
export async function resolveBasouRootForCommand(
  cwd: string,
  commandName: string,
  opts: ResolveRootOptions = {},
): Promise<string> {
  let root: string;
  try {
    root = await resolveBasouRepositoryRoot(cwd, {
      onRedirect: ({ via, root }) =>
        console.error(`Resolved workspace view to ${root} (via ${via}).`),
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Not a git repository") {
      throw new Error(
        `Not a git repository. Run 'git init' first, then re-run 'basou ${commandName}'.`,
        { cause: error },
      );
    }
    throw error;
  }

  // The view fallback already returns a master that has a `.basou/` store, so the
  // reverse-lookup only runs for a git repo that resolved to itself with no store
  // — the exact portfolio-member case (and the genuinely-uninitialized case,
  // where no master claims it and the original "Workspace not initialized"
  // message is preserved). Normal repos pay nothing: the store probe short-circuits.
  if (!(await hasBasouStore(root))) {
    const master = await resolveMemberToMaster(
      root,
      opts.portfolioConfigPath ?? DEFAULT_PORTFOLIO_CONFIG_PATH,
    );
    if (master !== undefined) {
      console.error(
        `Resolved portfolio member to ${master.root} (via portfolio: ${master.label}).`,
      );
      return master.root;
    }
  }
  return root;
}

/** Whether `root` owns a `.basou/` store directory. */
async function hasBasouStore(root: string): Promise<boolean> {
  try {
    return (await stat(basouPaths(root).root)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Reverse the `import.source_roots` declaration: find the planning master that
 * aggregates `repoRoot`. Reads the portfolio registry (`~/.basou/portfolio.yaml`),
 * and for each registered workspace resolves its `source_roots` to absolute,
 * realpath-canonicalized paths and checks whether any equals `repoRoot`'s
 * realpath. Returns the single claiming master, throws on ambiguity (>=2 DISTINCT
 * masters claim it), and returns `undefined` when nothing claims it or the
 * registry is absent (so the caller falls back to the unchanged behavior).
 *
 * Matching is realpath-based on both sides (the master root and each resolved
 * source root) so a symlinked layout, a `~`-relative registry entry, or platform
 * path aliases all collapse to one identity. Claimants are de-duped by that same
 * canonical root, so one master registered twice under different spellings (e.g.
 * a real path and a symlink alias — `loadPortfolioConfig` only de-dupes them
 * LEXICALLY) collapses to a single claimant rather than a false ambiguity; this
 * mirrors {@link resolveBasouRepositoryRoot}'s view fallback, which de-dupes
 * linked repos by resolved root. A master never claims itself (its own `.` source
 * root resolves to its root, which can't equal a storeless member).
 *
 * A present-but-broken registry, or a present-but-unreadable master manifest, is
 * surfaced on stderr (best-effort) rather than silently dropped: a genuinely
 * absent file is the expected case for any storeless repo, but a malformed config
 * is a fixable operator error that would otherwise hide behind the downstream
 * "Workspace not initialized" message (whose advice — run `basou init` — would
 * wrongly create a competing store inside the member). The SessionStart hook
 * discards stderr, so these notes only reach a manual invocation.
 */
export async function resolveMemberToMaster(
  repoRoot: string,
  configPath: string,
): Promise<MemberMaster | undefined> {
  let workspaces: Awaited<ReturnType<typeof loadPortfolioConfig>>;
  try {
    workspaces = await loadPortfolioConfig(configPath);
  } catch (error: unknown) {
    // A genuinely-absent registry is the common case for any storeless repo that
    // is not a portfolio member: stay silent and fall through. A present-but-
    // malformed registry is a fixable operator error worth surfacing.
    if (!(error instanceof Error) || !error.message.startsWith("No portfolio config at")) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`Ignoring ~/.basou/portfolio.yaml: ${detail}`);
    }
    return undefined;
  }

  const memberReal = await realpathOrNull(repoRoot);
  if (memberReal === null) return undefined;

  // De-dupe by canonical master root: the same master reached via two registry
  // spellings (which survive loadPortfolioConfig's lexical de-dup) must count
  // once, or it would self-trigger a false ambiguity. First spelling's label wins.
  const claimants = new Map<string, MemberMaster>();
  const seenMaster = new Set<string>();
  for (const ws of workspaces) {
    const masterReal = await realpathOrNull(ws.path);
    if (masterReal === null) continue;
    if (masterReal === memberReal) continue; // a master never claims itself
    if (seenMaster.has(masterReal)) continue; // same master, another spelling — process once
    seenMaster.add(masterReal);
    let manifest: Awaited<ReturnType<typeof readManifest>>;
    try {
      manifest = await readManifest(basouPaths(masterReal));
    } catch (error: unknown) {
      // A missing manifest = a stale/uninitialized registry entry (master moved
      // or never initialized): expected, skip quietly. A present-but-unreadable
      // manifest (corrupt YAML / schema-invalid) is a real fault in an owned
      // workspace; surface it so a claiming master is not silently lost.
      if (error instanceof Error && error.message !== "YAML file not found") {
        console.error(
          `Skipping portfolio workspace '${ws.label ?? basename(masterReal)}': could not read its manifest (${error.message}).`,
        );
      }
      continue;
    }
    // Absent source_roots means the master aggregates only itself (".") — it can
    // never claim a separate member, so the default is harmless and correct.
    const sourceRoots = manifest.import?.source_roots ?? ["."];
    for (const sr of sourceRoots) {
      const real = await realpathOrNull(resolve(masterReal, sr));
      if (real !== null && real === memberReal) {
        claimants.set(masterReal, { root: masterReal, label: ws.label ?? basename(masterReal) });
        break;
      }
    }
  }

  const matched = [...claimants.values()];
  if (matched.length === 1) return matched[0] as MemberMaster;
  if (matched.length > 1) {
    const names = matched.map((c) => c.label).join(", ");
    throw new Error(
      `This repository is declared as a source root by ${matched.length} portfolio workspaces (${names}). Disambiguate in ~/.basou/portfolio.yaml so only one aggregates it.`,
    );
  }
  return undefined;
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}
