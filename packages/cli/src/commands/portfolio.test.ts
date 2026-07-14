import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  doRunPortfolioList,
  type PortfolioListContext,
  type PortfolioListResult,
  renderPortfolioList,
} from "./portfolio.js";

let dir: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "basou-portfolio-cmd-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

function getDir(): string {
  if (dir === undefined) throw new Error("dir not initialized");
  return dir;
}

async function writeConfig(body: string): Promise<string> {
  const path = join(getDir(), "portfolio.yaml");
  await writeFile(path, body);
  return path;
}

describe("doRunPortfolioList", () => {
  it("resolves each entry's label / path / exists / initialized", async () => {
    const a = join(getDir(), "alpha-planning");
    const b = join(getDir(), "beta-planning");
    const configPath = await writeConfig(
      `version: 1\nworkspaces:\n  - path: ${a}\n    label: alpha\n  - path: ${b}\n`,
    );
    // Injected probes: alpha exists + initialized, beta exists but no .basou.
    const ctx: PortfolioListContext = {
      configPath,
      pathExists: (p) => p === a || p === b,
      isInitialized: (p) => p === a,
    };
    const result = await doRunPortfolioList({}, ctx);
    expect(result).toEqual<PortfolioListResult>({
      configPath,
      workspaces: [
        { label: "alpha", path: a, exists: true, initialized: true },
        { label: null, path: b, exists: true, initialized: false },
      ],
    });
  });

  it("reports a stale entry (path gone) as exists:false, initialized:false — never probing .basou", async () => {
    const gone = join(getDir(), "moved-away");
    const configPath = await writeConfig(`workspaces:\n  - path: ${gone}\n    label: stale\n`);
    const isInitialized = vi.fn(() => true); // would lie; must not be consulted
    const result = await doRunPortfolioList(
      {},
      { configPath, pathExists: () => false, isInitialized },
    );
    expect(result.workspaces).toEqual([
      { label: "stale", path: gone, exists: false, initialized: false },
    ]);
    expect(isInitialized).not.toHaveBeenCalled();
  });

  it("prints JSON when --json is set", async () => {
    const a = join(getDir(), "alpha-planning");
    const configPath = await writeConfig(`workspaces:\n  - path: ${a}\n    label: alpha\n`);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await doRunPortfolioList(
      { json: true },
      { configPath, pathExists: () => true, isInitialized: () => true },
    );
    expect(log).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(log.mock.calls[0]?.[0] as string) as PortfolioListResult;
    expect(printed).toEqual({
      configPath,
      workspaces: [{ label: "alpha", path: a, exists: true, initialized: true }],
    });
  });

  it("prints the human listing when --json is not set", async () => {
    const a = join(getDir(), "alpha-planning");
    const configPath = await writeConfig(`workspaces:\n  - path: ${a}\n    label: alpha\n`);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await doRunPortfolioList({}, { configPath, pathExists: () => true, isInitialized: () => true });
    const out = log.mock.calls[0]?.[0] as string;
    expect(out).toContain("# Portfolio (workspaces you orient across)");
    expect(out).toContain("1 workspace registered");
    expect(out).toContain(a);
    expect(out).toContain("basou view --portfolio");
  });

  it("propagates a helpful error when the config is missing", async () => {
    await expect(
      doRunPortfolioList({}, { configPath: join(getDir(), "nope.yaml") }),
    ).rejects.toThrow(/No portfolio config/);
  });
});

describe("renderPortfolioList", () => {
  it("marks a healthy master as initialized", () => {
    const out = renderPortfolioList({
      configPath: "/x",
      workspaces: [{ label: "acme", path: "/p/acme-planning", exists: true, initialized: true }],
    });
    expect(out).toContain("acme");
    expect(out).toContain("/p/acme-planning");
    expect(out).toContain("✓ initialized");
  });

  it("marks a missing path and an uninitialized path distinctly", () => {
    const out = renderPortfolioList({
      configPath: "/x",
      workspaces: [
        { label: "gone", path: "/p/gone", exists: false, initialized: false },
        { label: "bare", path: "/p/bare", exists: true, initialized: false },
      ],
    });
    expect(out).toContain("⚠ path not found");
    expect(out).toContain("⚠ no .basou (not a planning master?)");
  });

  it("falls back to (no label) when an entry has none", () => {
    const out = renderPortfolioList({
      configPath: "/x",
      workspaces: [{ label: null, path: "/p/x", exists: true, initialized: true }],
    });
    expect(out).toContain("(no label)");
  });
});
