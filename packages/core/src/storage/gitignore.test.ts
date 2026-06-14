import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendBasouGitignore } from "./gitignore.js";

let repoRoot: string | undefined;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "basou-gitignore-test-"));
});

afterEach(async () => {
  if (repoRoot !== undefined) {
    // rm with `force: true` removes read-only entries set up by T10/T11.
    await rm(repoRoot, { recursive: true, force: true });
    repoRoot = undefined;
  }
});

function getRepoRoot(): string {
  if (repoRoot === undefined) throw new Error("repoRoot not initialized");
  return repoRoot;
}

// Spec drift detector: this is the Basou v0.1 spec block, kept duplicated
// from the implementation so a one-sided change is caught by T9.
const SPEC_BLOCK =
  "# Basou - default ignore\n" +
  ".basou/logs/\n" +
  ".basou/raw/\n" +
  ".basou/tmp/\n" +
  ".basou/locks/\n" +
  ".basou/status.json\n" +
  ".basou/orientation.md\n" +
  ".basou/sessions/*/events.jsonl\n" +
  ".basou/sessions/*/artifacts/\n" +
  ".basou/approvals/pending/\n" +
  ".basou/approvals/resolved/\n" +
  "\n" +
  "# Basou - default commit\n" +
  "# .basou/manifest.yaml\n" +
  "# .basou/handoff.md\n" +
  "# .basou/decisions.md\n" +
  "# .basou/tasks/\n" +
  "# .basou/sessions/*/session.yaml\n" +
  "# .basou/sessions/*/transcript.md\n" +
  "# .basou/sessions/*/changed-files.json\n";

describe("appendBasouGitignore", () => {
  it("creates .gitignore when absent", async () => {
    const root = getRepoRoot();
    const result = await appendBasouGitignore(root);
    expect(result.appended).toBe(true);
    const body = await readFile(join(root, ".gitignore"), "utf8");
    expect(body).toBe(SPEC_BLOCK);
  });

  it("appends to existing .gitignore preserving prior rules", async () => {
    const root = getRepoRoot();
    await writeFile(join(root, ".gitignore"), "node_modules/\n", "utf8");
    const result = await appendBasouGitignore(root);
    expect(result.appended).toBe(true);
    const body = await readFile(join(root, ".gitignore"), "utf8");
    expect(body.startsWith("node_modules/\n\n# Basou - default ignore\n")).toBe(true);
    expect(body).toContain("# .basou/sessions/*/changed-files.json");
  });

  it("adds trailing newline when existing file lacks one", async () => {
    const root = getRepoRoot();
    await writeFile(join(root, ".gitignore"), "*.log", "utf8");
    const result = await appendBasouGitignore(root);
    expect(result.appended).toBe(true);
    const body = await readFile(join(root, ".gitignore"), "utf8");
    expect(body.startsWith("*.log\n\n# Basou - default ignore\n")).toBe(true);
  });

  it("is idempotent when marker already present", async () => {
    const root = getRepoRoot();
    const existing = "# Basou - default ignore\n.basou/logs/\n";
    await writeFile(join(root, ".gitignore"), existing, "utf8");
    const result = await appendBasouGitignore(root);
    expect(result.appended).toBe(false);
    const body = await readFile(join(root, ".gitignore"), "utf8");
    expect(body).toBe(existing);
  });

  it("detects marker with trailing annotation", async () => {
    const root = getRepoRoot();
    const existing = "# Basou - default ignore (annotated)\n.basou/logs/\n";
    await writeFile(join(root, ".gitignore"), existing, "utf8");
    const result = await appendBasouGitignore(root);
    expect(result.appended).toBe(false);
    const body = await readFile(join(root, ".gitignore"), "utf8");
    expect(body).toBe(existing);
  });

  it("preserves CRLF marker detection", async () => {
    const root = getRepoRoot();
    const existing = "# Basou - default ignore\r\n.basou/logs/\r\n";
    await writeFile(join(root, ".gitignore"), existing, "utf8");
    const result = await appendBasouGitignore(root);
    expect(result.appended).toBe(false);
  });

  it("error message is pathless when read fails", async () => {
    const root = getRepoRoot();
    await mkdir(join(root, ".gitignore"));
    let captured: unknown;
    try {
      await appendBasouGitignore(root);
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    const err = captured as Error;
    // Read fails first on most platforms (EISDIR); on the rare case write
    // is reached first the message should still be pathless.
    expect(["Failed to read .gitignore", "Failed to write .gitignore"]).toContain(err.message);
    expect(err.message).not.toContain(root);
  });

  it("error has native cause attached on read failure", async () => {
    const root = getRepoRoot();
    await mkdir(join(root, ".gitignore"));
    let captured: unknown;
    try {
      await appendBasouGitignore(root);
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    const err = captured as Error;
    expect(err.cause).toBeInstanceOf(Error);
    const cause = err.cause as Error & { code?: string };
    expect(typeof cause.code).toBe("string");
  });

  it("block contents match the Basou v0.1 spec exactly", async () => {
    const root = getRepoRoot();
    await appendBasouGitignore(root);
    const body = await readFile(join(root, ".gitignore"), "utf8");
    expect(body).toBe(SPEC_BLOCK);
  });

  it("error message is pathless when write fails", async () => {
    // Force the write path specifically by making `.gitignore` read-only.
    // The body has no Basou marker so readFile succeeds and the implementation
    // proceeds to writeFile, which then fails with EACCES because the file
    // mode does not permit writing. T7 covers the read-failure path; this
    // test exclusively guarantees the writeFile pathless contract.
    const root = getRepoRoot();
    const gitignorePath = join(root, ".gitignore");
    await writeFile(gitignorePath, "node_modules/\n", "utf8");
    await chmod(gitignorePath, 0o444);
    let captured: unknown;
    try {
      await appendBasouGitignore(root);
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    const err = captured as Error;
    expect(err.message).toBe("Failed to write .gitignore");
    expect(err.message).not.toContain(root);
  });

  it("error has native cause attached on write failure", async () => {
    const root = getRepoRoot();
    const gitignorePath = join(root, ".gitignore");
    await writeFile(gitignorePath, "node_modules/\n", "utf8");
    await chmod(gitignorePath, 0o444);
    let captured: unknown;
    try {
      await appendBasouGitignore(root);
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    const err = captured as Error;
    expect(err.cause).toBeInstanceOf(Error);
    const cause = err.cause as Error & { code?: string };
    expect(typeof cause.code).toBe("string");
  });
});
