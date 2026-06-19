import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProtocolsConfig } from "./protocols-config.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "basou-protocols-config-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(content: string): Promise<string> {
  const p = join(dir, "protocols.yaml");
  await writeFile(p, content);
  return p;
}

describe("loadProtocolsConfig", () => {
  it("loads entries and resolves source to an absolute path", async () => {
    const source = join(dir, "a.md");
    const p = await writeConfig(`protocols:\n  - source: ${source}\n    title: A\n`);
    expect(await loadProtocolsConfig(p)).toEqual([{ source, title: "A" }]);
  });

  it("throws on a missing config file", async () => {
    await expect(loadProtocolsConfig(join(dir, "nope.yaml"))).rejects.toThrow(
      /No protocols config/,
    );
  });

  it("throws when 'protocols' is not a list", async () => {
    const p = await writeConfig("protocols: not-a-list\n");
    await expect(loadProtocolsConfig(p)).rejects.toThrow(/must contain a 'protocols:' list/);
  });

  it("rejects an unknown top-level key (e.g. a 'target' footgun)", async () => {
    const p = await writeConfig(
      `target: /etc/passwd\nprotocols:\n  - source: ${join(dir, "a.md")}\n`,
    );
    await expect(loadProtocolsConfig(p)).rejects.toThrow(/unknown key 'target'/);
  });

  it("rejects an unknown entry key", async () => {
    const p = await writeConfig(
      `protocols:\n  - source: ${join(dir, "a.md")}\n    enabled: true\n`,
    );
    await expect(loadProtocolsConfig(p)).rejects.toThrow(/unknown key 'enabled'/);
  });

  it("rejects an empty title", async () => {
    const p = await writeConfig(`protocols:\n  - source: ${join(dir, "a.md")}\n    title: ""\n`);
    await expect(loadProtocolsConfig(p)).rejects.toThrow(/title.*non-empty/);
  });

  it("rejects a non-absolute source", async () => {
    const p = await writeConfig("protocols:\n  - source: rel/a.md\n");
    await expect(loadProtocolsConfig(p)).rejects.toThrow(/must be absolute/);
  });

  it("rejects duplicate sources", async () => {
    const a = join(dir, "a.md");
    const p = await writeConfig(`protocols:\n  - source: ${a}\n  - source: ${a}\n`);
    await expect(loadProtocolsConfig(p)).rejects.toThrow(/Duplicate/);
  });

  it("rejects an empty list", async () => {
    const p = await writeConfig("protocols: []\n");
    await expect(loadProtocolsConfig(p)).rejects.toThrow(/no protocols/);
  });
});
