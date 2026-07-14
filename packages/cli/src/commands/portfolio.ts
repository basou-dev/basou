import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { isVerbose, renderCliError } from "../lib/error-render.js";
import { DEFAULT_PORTFOLIO_CONFIG_PATH, loadPortfolioConfig } from "../lib/portfolio-config.js";

export type PortfolioListOptions = {
  json?: boolean;
  verbose?: boolean;
};

/**
 * Injectable seams for {@link doRunPortfolioList} so tests stay hermetic: the
 * config path to read, and the two on-disk probes (existence and `.basou`
 * ownership). Defaults hit the real filesystem.
 */
export type PortfolioListContext = {
  /** Config file to read (default: ~/.basou/portfolio.yaml). */
  configPath?: string;
  /** Whether the workspace path resolves to something on disk (default: fs.existsSync). */
  pathExists?: (path: string) => boolean;
  /** Whether the workspace path owns a `.basou/` store (default: fs.existsSync of `<path>/.basou`). */
  isInitialized?: (path: string) => boolean;
};

/**
 * One resolved portfolio entry as reported by `basou portfolio`. The `--json`
 * shape is part of the CLI contract, so this is kept deliberately minimal and
 * stable: label + path + two cheap on-disk facts, and nothing from the
 * `view --check` safety preflight (that stays its own surface).
 */
export type PortfolioEntry = {
  /** The display label from the config, or null when the entry declared none. */
  label: string | null;
  /** The workspace path, absolute and `~`-expanded (as `loadPortfolioConfig` returns it). */
  path: string;
  /** Whether `path` resolves to something on disk (a stale entry points nowhere). */
  exists: boolean;
  /** Whether `path` owns a `.basou/` store — i.e. it is an initialized planning master. */
  initialized: boolean;
};

/** Result of {@link doRunPortfolioList}: the config that was read plus its resolved entries. */
export type PortfolioListResult = {
  /** The config file that was read. */
  configPath: string;
  /** Every registered workspace, in config order (deduped by resolved path upstream). */
  workspaces: PortfolioEntry[];
};

/**
 * Wire `basou portfolio` onto `program`: a read-only, headless listing of the
 * workspaces registered in `~/.basou/portfolio.yaml`. It is the text/JSON
 * counterpart to the `basou view --portfolio` GUI — an agent oriented in one
 * project can discover where a sibling project lives without opening a browser
 * (the localhost GUI is unreachable in a non-interactive session). It reads
 * nothing but the config, probes only existence + `.basou` presence, and never
 * runs the redundancy/footprint safety preflight (that is `basou view --check`).
 */
export function registerPortfolioCommand(program: Command): void {
  program
    .command("portfolio")
    .description(
      "List the workspaces you orient across (read-only): every planning master registered in ~/.basou/portfolio.yaml, with its path and whether it exists / is initialized. The headless text/JSON counterpart to the `basou view --portfolio` GUI — for discovering where a sibling project lives without opening a browser",
    )
    .option("--json", "Output the result as JSON")
    .option("-v, --verbose", "Show error causes")
    .action(async (opts: PortfolioListOptions) => {
      await runPortfolioList(opts);
    });
}

/** Programmatic entry that owns `process.exitCode`. Tests prefer {@link doRunPortfolioList}. */
export async function runPortfolioList(
  options: PortfolioListOptions,
  ctx: PortfolioListContext = {},
): Promise<void> {
  try {
    await doRunPortfolioList(options, ctx);
  } catch (error: unknown) {
    renderCliError(error, { verbose: isVerbose(options) });
    process.exitCode = 1;
  }
}

/**
 * Load the portfolio config and resolve each entry against disk. A path that
 * does not resolve reports `exists:false` (and therefore `initialized:false` —
 * a missing path cannot be a master), so a stale entry surfaces instead of
 * throwing. A missing/empty/malformed config propagates `loadPortfolioConfig`'s
 * user-facing error to {@link runPortfolioList}.
 */
export async function doRunPortfolioList(
  options: PortfolioListOptions,
  ctx: PortfolioListContext,
): Promise<PortfolioListResult> {
  const configPath = ctx.configPath ?? DEFAULT_PORTFOLIO_CONFIG_PATH;
  const pathExists = ctx.pathExists ?? ((p: string) => existsSync(p));
  const isInitialized = ctx.isInitialized ?? ((p: string) => existsSync(join(p, ".basou")));

  const workspaces = await loadPortfolioConfig(configPath);
  const result: PortfolioListResult = {
    configPath,
    workspaces: workspaces.map((w) => {
      const exists = pathExists(w.path);
      return {
        label: w.label ?? null,
        path: w.path,
        exists,
        initialized: exists && isInitialized(w.path),
      };
    }),
  };

  if (options.json === true) {
    console.log(JSON.stringify(result));
  } else {
    console.log(renderPortfolioList(result));
  }
  return result;
}

const LABEL_COLUMN_CAP = 24;

/**
 * Render the listing. Leads with the count, then one line per workspace
 * (label, path, and a status marker for a stale or uninitialized entry), and
 * closes by pointing at the GUI / safety-preflight surfaces so the read-only
 * framing is not over-read as the whole portfolio story.
 */
export function renderPortfolioList(result: PortfolioListResult): string {
  const lines: string[] = [];
  const n = result.workspaces.length;
  lines.push("# Portfolio (workspaces you orient across)");
  lines.push("");
  lines.push(`${n} workspace${n === 1 ? "" : "s"} registered in ~/.basou/portfolio.yaml:`);
  lines.push("");

  const labelWidth = Math.min(
    LABEL_COLUMN_CAP,
    Math.max(0, ...result.workspaces.map((w) => (w.label ?? "(no label)").length)),
  );
  for (const w of result.workspaces) {
    const label = (w.label ?? "(no label)").padEnd(labelWidth);
    const status = !w.exists
      ? "⚠ path not found"
      : w.initialized
        ? "✓ initialized"
        : "⚠ no .basou (not a planning master?)";
    lines.push(`- ${label}  ${w.path}  ${status}`);
  }
  lines.push("");
  lines.push(
    "Note: read-only listing of ~/.basou/portfolio.yaml. Run `basou view --portfolio` for the cross-workspace GUI, or `basou view --portfolio --check` for the redundancy/footprint safety preflight.",
  );
  return lines.join("\n");
}
