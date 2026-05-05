import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readYamlFile, writeYamlFile } from "./yaml-store.js";

let workDir: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "basou-yaml-test-"));
});

afterEach(async () => {
  if (workDir !== undefined) {
    await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function getWorkDir(): string {
  if (workDir === undefined) throw new Error("workDir not initialized");
  return workDir;
}

describe("yaml-store", () => {
  it("writes and reads back a simple object", async () => {
    const filePath = join(getWorkDir(), "sample.yaml");
    const value = { name: "basou", version: "0.1.0", flags: ["a", "b"] };
    await writeYamlFile(filePath, value);
    const read = await readYamlFile(filePath);
    expect(read).toEqual(value);
  });

  it("parses a YAML file with multi-line strings and nested objects", async () => {
    const filePath = join(getWorkDir(), "complex.yaml");
    const body = [
      'schema_version: "0.1.0"',
      "project:",
      "  name: foo",
      "  description: |",
      "    multi-line",
      "    description",
      "items:",
      "  - one",
      "  - two",
      "",
    ].join("\n");
    await writeFile(filePath, body, "utf8");
    const read = await readYamlFile(filePath);
    expect(read).toEqual({
      schema_version: "0.1.0",
      project: {
        name: "foo",
        description: "multi-line\ndescription\n",
      },
      items: ["one", "two"],
    });
  });

  it("throws pathless Error for ENOENT on read", async () => {
    const root = getWorkDir();
    const filePath = join(root, "missing.yaml");
    let captured: unknown;
    try {
      await readYamlFile(filePath);
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    const err = captured as Error;
    expect(err.message).toBe("YAML file not found");
    expect(err.message).not.toContain(root);
    expect(err.cause).toBeInstanceOf(Error);
  });

  it("throws pathless Error on YAML parse failure", async () => {
    const root = getWorkDir();
    const filePath = join(root, "broken.yaml");
    // Indentation mismatch — a clear YAML parse failure.
    await writeFile(filePath, "key: value\n bad: indent\n", "utf8");
    let captured: unknown;
    try {
      await readYamlFile(filePath);
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    const err = captured as Error;
    expect(err.message).toBe("Failed to parse YAML content");
    expect(err.message).not.toContain(root);
    expect(err.cause).toBeDefined();
  });

  it("write leaves no leftover tmp file on success", async () => {
    const root = getWorkDir();
    const filePath = join(root, "atomic.yaml");
    await writeYamlFile(filePath, { a: 1 });
    const entries = await readdir(root);
    expect(entries).toContain("atomic.yaml");
    expect(entries.some((name) => name.startsWith("atomic.yaml.tmp."))).toBe(false);
  });

  it("overwrites an existing file", async () => {
    const filePath = join(getWorkDir(), "overwrite.yaml");
    await writeYamlFile(filePath, { v: 1 });
    await writeYamlFile(filePath, { v: 2 });
    const read = await readYamlFile(filePath);
    expect(read).toEqual({ v: 2 });
  });
});
