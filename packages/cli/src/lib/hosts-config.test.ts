import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHostsConfig } from "./hosts-config.js";

let dir: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "basou-hosts-cfg-"));
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
  const path = join(getDir(), "hosts.yaml");
  await writeFile(path, body);
  return path;
}

describe("loadHostsConfig", () => {
  it("parses absolute host mirrors with required labels, preserving order", async () => {
    const a = join(getDir(), "a");
    const b = join(getDir(), "b");
    const path = await writeConfig(
      `version: 1\nhosts:\n  - label: laptop\n    path: ${a}\n  - label: devbox\n    path: ${b}\n`,
    );
    const result = await loadHostsConfig(path);
    expect(result).toEqual([
      { label: "laptop", path: a },
      { label: "devbox", path: b },
    ]);
  });

  it("expands a leading ~ to the home directory", async () => {
    const path = await writeConfig("hosts:\n  - label: home\n    path: ~/basou-hosts-fixture\n");
    const result = await loadHostsConfig(path);
    expect(result).toEqual([{ label: "home", path: join(homedir(), "basou-hosts-fixture") }]);
  });

  it("de-duplicates by resolved path (first wins)", async () => {
    const a = join(getDir(), "a");
    const path = await writeConfig(
      `hosts:\n  - label: first\n    path: ${a}\n  - label: second\n    path: ${a}\n`,
    );
    const result = await loadHostsConfig(path);
    expect(result).toEqual([{ label: "first", path: a }]);
  });

  it("rejects two distinct paths sharing one label (orientation collapses by label)", async () => {
    const a = join(getDir(), "a");
    const b = join(getDir(), "b");
    const path = await writeConfig(
      `hosts:\n  - label: dup\n    path: ${a}\n  - label: dup\n    path: ${b}\n`,
    );
    await expect(loadHostsConfig(path)).rejects.toThrow(/Duplicate host label 'dup'/);
  });

  it("returns null (silent, no federation) when the file is missing", async () => {
    const result = await loadHostsConfig(join(getDir(), "nope.yaml"));
    expect(result).toBeNull();
  });

  it("returns an empty list for an empty hosts list (benign no-op)", async () => {
    const path = await writeConfig("hosts: []\n");
    const result = await loadHostsConfig(path);
    expect(result).toEqual([]);
  });

  it("rejects invalid YAML", async () => {
    const path = await writeConfig("hosts: [unclosed\n");
    await expect(loadHostsConfig(path)).rejects.toThrow(/not valid YAML/);
  });

  it("requires a hosts list", async () => {
    const path = await writeConfig("something: else\n");
    await expect(loadHostsConfig(path)).rejects.toThrow(/'hosts:' list/);
  });

  it("rejects a missing or empty label", async () => {
    const a = join(getDir(), "a");
    const path = await writeConfig(`hosts:\n  - path: ${a}\n`);
    await expect(loadHostsConfig(path)).rejects.toThrow(/non-empty string 'label'/);
  });

  it("rejects a missing path", async () => {
    const path = await writeConfig("hosts:\n  - label: x\n");
    await expect(loadHostsConfig(path)).rejects.toThrow(/non-empty string 'path'/);
  });

  it("rejects a non-absolute path", async () => {
    const path = await writeConfig("hosts:\n  - label: x\n    path: relative/here\n");
    await expect(loadHostsConfig(path)).rejects.toThrow(/must be absolute/);
  });
});
