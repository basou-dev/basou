import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadPortfolioConfig,
  PortfolioConfigMissingError,
  portfolioPathExists,
  portfolioPathInitialized,
} from "./portfolio-config.js";

let dir: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "basou-portfolio-cfg-"));
});

afterEach(async () => {
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

describe("loadPortfolioConfig", () => {
  it("parses absolute workspaces with optional labels, preserving order", async () => {
    const a = join(getDir(), "a");
    const b = join(getDir(), "b");
    const path = await writeConfig(
      `version: 1\nworkspaces:\n  - path: ${a}\n    label: alpha\n  - path: ${b}\n`,
    );
    const result = await loadPortfolioConfig(path);
    expect(result).toEqual([{ path: a, label: "alpha" }, { path: b }]);
  });

  it("expands a leading ~ to the home directory", async () => {
    const path = await writeConfig("workspaces:\n  - path: ~/basou-portfolio-fixture\n");
    const result = await loadPortfolioConfig(path);
    expect(result).toEqual([{ path: join(homedir(), "basou-portfolio-fixture") }]);
  });

  it("de-duplicates by resolved path (first wins)", async () => {
    const a = join(getDir(), "a");
    const path = await writeConfig(
      `workspaces:\n  - path: ${a}\n    label: first\n  - path: ${a}\n    label: second\n`,
    );
    const result = await loadPortfolioConfig(path);
    expect(result).toEqual([{ path: a, label: "first" }]);
  });

  it("throws a helpful error when the file is missing", async () => {
    await expect(loadPortfolioConfig(join(getDir(), "nope.yaml"))).rejects.toThrow(
      /No portfolio config/,
    );
  });

  it("rejects invalid YAML", async () => {
    const path = await writeConfig("workspaces: [unclosed\n");
    await expect(loadPortfolioConfig(path)).rejects.toThrow(/not valid YAML/);
  });

  it("requires a workspaces list", async () => {
    const path = await writeConfig("something: else\n");
    await expect(loadPortfolioConfig(path)).rejects.toThrow(/'workspaces:' list/);
  });

  it("rejects a non-absolute path", async () => {
    const path = await writeConfig("workspaces:\n  - path: relative/here\n");
    await expect(loadPortfolioConfig(path)).rejects.toThrow(/must be absolute/);
  });

  it("rejects an empty workspaces list", async () => {
    const path = await writeConfig("workspaces: []\n");
    await expect(loadPortfolioConfig(path)).rejects.toThrow(/no workspaces/);
  });

  it("rejects a non-string path", async () => {
    const path = await writeConfig("workspaces:\n  - path: 123\n");
    await expect(loadPortfolioConfig(path)).rejects.toThrow(/non-empty string 'path'/);
  });
});

describe("the portfolio's own checks", () => {
  it("says there is no config with its own error, and the message basou portfolio prints", async () => {
    const error = await loadPortfolioConfig(join(getDir(), "absent.yaml")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortfolioConfigMissingError);
    expect((error as Error).message).toMatch(
      /^No portfolio config at ~\/\.basou\/portfolio\.yaml\./,
    );
    const broken = await loadPortfolioConfig(await writeConfig("workspaces: [\n")).catch(
      (e: unknown) => e,
    );
    expect(broken).not.toBeInstanceOf(PortfolioConfigMissingError);
  });

  it("counts a path as initialized only when it owns a .basou directory", async () => {
    const master = join(getDir(), "master");
    const stray = join(getDir(), "stray");
    await mkdir(join(master, ".basou"), { recursive: true });
    await mkdir(stray);
    await writeFile(join(stray, ".basou"), "not a store\n");
    expect([master, stray, join(getDir(), "gone")].map(portfolioPathExists)).toEqual([
      true,
      true,
      false,
    ]);
    expect([master, stray, join(getDir(), "gone")].map(portfolioPathInitialized)).toEqual([
      true,
      false,
      false,
    ]);
  });
});

describe("the default portfolio config path", () => {
  it("is worked out when it is asked for, not when the module is imported", async () => {
    vi.resetModules();
    const homedir = vi.fn((): string => {
      throw new Error("no home");
    });
    vi.doMock("node:os", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:os")>()),
      homedir,
    }));
    try {
      const loaded = await import("./portfolio-config.js");
      expect(homedir).not.toHaveBeenCalled();
      expect(() => loaded.defaultPortfolioConfigPath()).toThrow("no home");
    } finally {
      vi.doUnmock("node:os");
      vi.resetModules();
    }
  });
});
