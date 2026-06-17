import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPortfolioConfig } from "./portfolio-config.js";

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
