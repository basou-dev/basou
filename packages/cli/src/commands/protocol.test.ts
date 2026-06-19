import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_END, PROTOCOL_START } from "@basou/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  doRunProtocolList,
  doRunProtocolSync,
  doRunProtocolUnsync,
  registerProtocolCommand,
} from "./protocol.js";

let dir: string;
let configPath: string;
let sourcePath: string;
let targetPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "basou-protocol-test-"));
  sourcePath = join(dir, "review.md");
  configPath = join(dir, "protocols.yaml");
  targetPath = join(dir, "CLAUDE.md");
  await writeFile(sourcePath, "## Review protocol\n\nConsult before applying.\n");
  await writeFile(configPath, `protocols:\n  - source: ${sourcePath}\n`);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  process.exitCode = 0;
  vi.restoreAllMocks();
});

function captureStdout(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, "log").mockImplementation(() => undefined);
}

function joinCalls(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
}

describe("basou protocol sync", () => {
  it("creates the target with a wrapped block when it is absent", async () => {
    captureStdout();
    await doRunProtocolSync({ config: configPath, target: targetPath });
    const body = await readFile(targetPath, "utf8");
    expect(body.startsWith(PROTOCOL_START)).toBe(true);
    expect(body).toContain(PROTOCOL_END);
    expect(body).toContain("Consult before applying.");
  });

  it("replaces an existing block while preserving surrounding user content", async () => {
    captureStdout();
    await doRunProtocolSync({ config: configPath, target: targetPath });
    const created = await readFile(targetPath, "utf8");
    await writeFile(targetPath, `# My CLAUDE.md\n\n${created}\nfooter note\n`);

    await writeFile(sourcePath, "## Review protocol\n\nUpdated rule.\n");
    await doRunProtocolSync({ config: configPath, target: targetPath });

    const body = await readFile(targetPath, "utf8");
    expect(body).toContain("# My CLAUDE.md");
    expect(body).toContain("footer note");
    expect(body).toContain("Updated rule.");
    expect(body).not.toContain("Consult before applying.");
    expect(body.split(PROTOCOL_START).length - 1).toBe(1);
  });

  it("appends the block to a file with existing content but no block", async () => {
    await writeFile(targetPath, "# Existing user instructions\n\nkeep me\n");
    captureStdout();
    await doRunProtocolSync({ config: configPath, target: targetPath });

    const body = await readFile(targetPath, "utf8");
    expect(body).toContain("keep me");
    expect(body).toContain(PROTOCOL_START);
    expect(body.indexOf("keep me")).toBeLessThan(body.indexOf(PROTOCOL_START));
  });

  it("is idempotent: a second sync reports up to date and does not duplicate", async () => {
    captureStdout();
    await doRunProtocolSync({ config: configPath, target: targetPath });
    const first = await readFile(targetPath, "utf8");
    const out = captureStdout();
    await doRunProtocolSync({ config: configPath, target: targetPath });
    expect(await readFile(targetPath, "utf8")).toBe(first);
    expect(joinCalls(out)).toContain("already up to date");
  });

  it("refuses a malformed block (only a start marker present)", async () => {
    await writeFile(targetPath, `prose\n${PROTOCOL_START}\nbody\n`);
    await expect(doRunProtocolSync({ config: configPath, target: targetPath })).rejects.toThrow(
      /malformed/,
    );
  });

  it("refuses a source that contains a marker line", async () => {
    await writeFile(sourcePath, `## bad\n${PROTOCOL_START}\nx\n`);
    await expect(doRunProtocolSync({ config: configPath, target: targetPath })).rejects.toThrow(
      /marker line/,
    );
  });

  it("refuses a missing source file", async () => {
    await writeFile(configPath, `protocols:\n  - source: ${join(dir, "missing.md")}\n`);
    await expect(doRunProtocolSync({ config: configPath, target: targetPath })).rejects.toThrow(
      /does not exist/,
    );
  });

  it("refuses a symlinked target", async () => {
    const real = join(dir, "real.md");
    await writeFile(real, "x\n");
    await symlink(real, targetPath);
    await expect(doRunProtocolSync({ config: configPath, target: targetPath })).rejects.toThrow(
      /symlink/,
    );
  });

  it("--dry-run does not create the target", async () => {
    const out = captureStdout();
    await doRunProtocolSync({ config: configPath, target: targetPath, dryRun: true });
    expect(joinCalls(out)).toContain("[dry-run]");
    await expect(lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("backs up the original content once on first modification", async () => {
    await writeFile(targetPath, "# original\n");
    captureStdout();
    await doRunProtocolSync({ config: configPath, target: targetPath });
    expect(await readFile(`${targetPath}.basou-bak`, "utf8")).toBe("# original\n");
  });

  it("creates without leading blank lines when the target is empty", async () => {
    await writeFile(targetPath, "");
    captureStdout();
    await doRunProtocolSync({ config: configPath, target: targetPath });
    const body = await readFile(targetPath, "utf8");
    expect(body.startsWith(PROTOCOL_START)).toBe(true);
    expect(body.startsWith("\n")).toBe(false);
  });

  it("replaces in place (no duplication) when the target has a leading BOM", async () => {
    captureStdout();
    await doRunProtocolSync({ config: configPath, target: targetPath });
    const created = await readFile(targetPath, "utf8");
    // Put the block at the very top behind a BOM, keep user content after it.
    await writeFile(targetPath, `\uFEFF${created}# trailing note\n`);
    await writeFile(sourcePath, "## Review protocol\n\nBOM-updated rule.\n");
    await doRunProtocolSync({ config: configPath, target: targetPath });
    const body = await readFile(targetPath, "utf8");
    expect(body.split(PROTOCOL_START).length - 1).toBe(1); // exactly one block
    expect(body.startsWith("\uFEFF")).toBe(true); // BOM preserved
    expect(body).toContain("BOM-updated rule.");
    expect(body).toContain("# trailing note");
  });

  it("reports Installed (not Updated) when marker text appears only in prose", async () => {
    await writeFile(targetPath, `see ${PROTOCOL_START} inline\n`);
    const out = captureStdout();
    await doRunProtocolSync({ config: configPath, target: targetPath });
    expect(joinCalls(out)).toContain("Installed");
  });
});

describe("basou protocol unsync", () => {
  it("removes the block and preserves surrounding content", async () => {
    await writeFile(targetPath, "# keep\n\n");
    captureStdout();
    await doRunProtocolSync({ config: configPath, target: targetPath });
    await doRunProtocolUnsync({ target: targetPath });
    const body = await readFile(targetPath, "utf8");
    expect(body).toContain("# keep");
    expect(body).not.toContain(PROTOCOL_START);
  });

  it("reports nothing to remove when no block is present", async () => {
    await writeFile(targetPath, "# no block\n");
    const out = captureStdout();
    await doRunProtocolUnsync({ target: targetPath });
    expect(joinCalls(out)).toContain("nothing removed");
  });
});

describe("basou protocol list", () => {
  it("lists declared protocols and the block install state", async () => {
    const out = captureStdout();
    await doRunProtocolList({ config: configPath, target: targetPath });
    const stdout = joinCalls(out);
    expect(stdout).toContain("Declared protocols (1)");
    expect(stdout).toContain("not installed");
  });
});

describe("register", () => {
  it("exposes 'protocol' with sync/list/unsync subcommands", () => {
    const program = new Command();
    registerProtocolCommand(program);
    const protocol = program.commands.find((c) => c.name() === "protocol");
    expect(protocol).toBeDefined();
    const subs = protocol?.commands.map((c) => c.name()) ?? [];
    expect(subs).toEqual(expect.arrayContaining(["sync", "list", "unsync"]));
  });
});
