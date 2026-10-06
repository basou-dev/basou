import {
  DEFAULT_PORTFOLIO_CONFIG_PATH,
  loadPortfolioConfig,
  PortfolioConfigMissingError,
  portfolioPathExists,
  portfolioPathInitialized,
} from "../storage/portfolio-config.js";

/**
 * The version of how the `portfolio` section measures. Raised whenever a
 * value of the section would change for the same config and disk, as when
 * `basou portfolio` reads the config or checks an entry differently.
 */
export const BOARD_PORTFOLIO_METHOD = 1;

/**
 * The workspaces registered in `~/.basou/portfolio.yaml` on this host, counted
 * as `basou portfolio` lists them, and nothing else: no name, path or label.
 *
 * Both are null with no not_found entry when there is no portfolio config at
 * all, a null that means so: a board of someone who does not use a portfolio
 * is complete. Both are null with one not_found entry at `portfolio` when the
 * config is there but `basou portfolio` refuses it (it cannot be read, is not
 * YAML, has no `workspaces:` list, names a relative path, or lists nothing),
 * with the reason `basou portfolio` gives.
 */
export type BoardPortfolio = {
  /** The registered workspaces, each path counted once. */
  workspaces: number | null;
  /** Of them, those whose path is there and owns a `.basou/` directory. */
  initialized: number | null;
};

/** The `portfolio` section of a measurement, and why it is missing when it is. */
export async function measurePortfolio(
  configPath: string = DEFAULT_PORTFOLIO_CONFIG_PATH,
): Promise<{ portfolio: BoardPortfolio; notFound: { at: string; reason: string }[] }> {
  const none = { workspaces: null, initialized: null };
  let paths: string[];
  try {
    paths = (await loadPortfolioConfig(configPath)).map((workspace) => workspace.path);
  } catch (error: unknown) {
    if (error instanceof PortfolioConfigMissingError) return { portfolio: none, notFound: [] };
    const reason =
      error instanceof Error ? error.message : "the portfolio config could not be read";
    return { portfolio: none, notFound: [{ at: "portfolio", reason }] };
  }
  const initialized = paths.filter(
    (path) => portfolioPathExists(path) && portfolioPathInitialized(path),
  ).length;
  return { portfolio: { workspaces: paths.length, initialized }, notFound: [] };
}
