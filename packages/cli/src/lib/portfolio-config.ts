import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readYamlFile } from "@basou/core";

/**
 * GUI configuration for `basou view --portfolio`: the set of workspaces a single
 * owner wants to orient across in one screen. This is local GUI config, NOT
 * provenance/trail data — it is not part of the workspace schema bundle and is
 * never committed into a monitored repo. Because it is not a committed manifest,
 * absolute paths are required here (the `import.source_roots` relative-only rule
 * exists to keep committed manifests path-clean; that constraint does not apply
 * to a user-level config under $HOME).
 *
 * Shape:
 *   version: 1            # optional, reserved for future migrations
 *   workspaces:
 *     - path: /abs/path/to/workspace-repo   # required, absolute (~ allowed)
 *       label: my-project                   # optional display label
 */
export type PortfolioWorkspace = { path: string; label?: string };

/** Canonical location of the portfolio config. */
export const DEFAULT_PORTFOLIO_CONFIG_PATH = join(homedir(), ".basou", "portfolio.yaml");

/** Expand a leading `~` / `~/` to the user's home directory. */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read and validate `~/.basou/portfolio.yaml` (or an injected path for tests),
 * returning the workspace list with each `path` expanded and made absolute, and
 * de-duplicated by resolved path (first occurrence wins, preserving its label
 * and order). Throws an Error with a pathless, user-facing message on a missing
 * file, invalid YAML, a malformed shape, a non-absolute path, or an empty list.
 */
export async function loadPortfolioConfig(
  configPath: string = DEFAULT_PORTFOLIO_CONFIG_PATH,
): Promise<PortfolioWorkspace[]> {
  let raw: unknown;
  try {
    raw = await readYamlFile(configPath);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "YAML file not found") {
      throw new Error(
        "No portfolio config at ~/.basou/portfolio.yaml. Create one (a 'workspaces:' list of repo paths) or pass --workspace <path>.",
      );
    }
    if (error instanceof Error && error.message === "Failed to parse YAML content") {
      throw new Error("~/.basou/portfolio.yaml is not valid YAML.");
    }
    throw error;
  }

  if (!isRecord(raw) || !Array.isArray(raw.workspaces)) {
    throw new Error("~/.basou/portfolio.yaml must contain a 'workspaces:' list.");
  }

  const seen = new Set<string>();
  const result: PortfolioWorkspace[] = [];
  for (const entry of raw.workspaces) {
    if (!isRecord(entry) || typeof entry.path !== "string" || entry.path.trim().length === 0) {
      throw new Error("Each portfolio workspace needs a non-empty string 'path'.");
    }
    if (entry.label !== undefined && typeof entry.label !== "string") {
      throw new Error("A portfolio workspace 'label' must be a string when present.");
    }
    const expanded = expandTilde(entry.path.trim());
    if (!isAbsolute(expanded)) {
      throw new Error(
        "Portfolio workspace paths must be absolute (or start with '~'); use --workspace for relative ad-hoc paths.",
      );
    }
    const abs = resolve(expanded);
    if (seen.has(abs)) continue;
    seen.add(abs);
    result.push(entry.label !== undefined ? { path: abs, label: entry.label } : { path: abs });
  }

  if (result.length === 0) {
    throw new Error("~/.basou/portfolio.yaml has no workspaces.");
  }
  return result;
}
