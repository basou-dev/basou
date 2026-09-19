import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_END,
  PROTOCOL_START,
  type ProtocolStamp,
  parseProtocolStamp,
  protocolBlockHash,
  protocolSectionsFrom,
} from "@basou/core";
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

function captureStderr(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

function joinCalls(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
}

/** The sync stamp carried by the managed block in a written target. */
function readStamp(body: string): ProtocolStamp {
  const stamp = parseProtocolStamp(body);
  if (stamp === null) throw new Error("expected the block to carry a stamp");
  return stamp;
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

// The protocol block is the one thing basou still renders into a USER-GLOBAL
// file, and it reads no manifest: a standing protocol that names one workspace
// reaches every workspace's sessions. The advisory says so; it does not refuse.
describe("basou protocol sync (foreign-workspace advisory)", () => {
  let portfolioPath: string;

  beforeEach(async () => {
    portfolioPath = join(dir, "portfolio.yaml");
    await writeFile(portfolioPath, `workspaces:\n  - path: ${join(dir, "beta-planning")}\n`);
  });

  it("warns when the block names a registered workspace, and writes it anyway", async () => {
    captureStdout();
    const err = captureStderr();
    await writeFile(sourcePath, "## Review protocol\n\nAlways check beta-planning first.\n");

    await doRunProtocolSync(
      { config: configPath, target: targetPath },
      { portfolioConfigPath: portfolioPath },
    );

    const stderr = joinCalls(err);
    expect(stderr).toContain("the protocol block names a registered workspace");
    expect(stderr).toContain("nothing was withheld");
    expect(stderr).not.toContain("beta-planning");
    const body = await readFile(targetPath, "utf8");
    expect(body).toContain("Always check beta-planning first.");
  });

  it("warns under --dry-run too, when nothing is written", async () => {
    captureStdout();
    const err = captureStderr();
    await writeFile(sourcePath, "## Review protocol\n\nAlways check beta-planning first.\n");

    await doRunProtocolSync(
      { config: configPath, target: targetPath, dryRun: true },
      { portfolioConfigPath: portfolioPath },
    );

    expect(joinCalls(err)).toContain("the protocol block names a registered workspace");
    await expect(readFile(targetPath, "utf8")).rejects.toThrow();
  });

  it("stays silent for a protocol that names no registered workspace", async () => {
    captureStdout();
    const err = captureStderr();

    await doRunProtocolSync(
      { config: configPath, target: targetPath },
      { portfolioConfigPath: portfolioPath },
    );

    expect(joinCalls(err)).toBe("");
  });

  // The warning says the name reaches the user-global file, so it must not be
  // printed by a run that failed before writing anything.
  it("does not warn when the sync fails and writes nothing", async () => {
    captureStdout();
    const err = captureStderr();
    await writeFile(sourcePath, "## Review protocol\n\nAlways check beta-planning first.\n");
    await writeFile(targetPath, `prose\n${PROTOCOL_START}\nbody\n`);

    await expect(
      doRunProtocolSync(
        { config: configPath, target: targetPath },
        { portfolioConfigPath: portfolioPath },
      ),
    ).rejects.toThrow(/malformed/);

    expect(joinCalls(err)).toBe("");
  });

  it("stays silent when there is no portfolio registry", async () => {
    captureStdout();
    const err = captureStderr();
    await writeFile(sourcePath, "## Review protocol\n\nAlways check beta-planning first.\n");

    await doRunProtocolSync(
      { config: configPath, target: targetPath },
      { portfolioConfigPath: join(dir, "absent.yaml") },
    );

    expect(joinCalls(err)).toBe("");
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

describe("basou protocol sync — the sync stamp", () => {
  it("writes a stamp whose digest covers the rendered protocol text", async () => {
    captureStdout();
    await doRunProtocolSync({ config: configPath, target: targetPath });
    const body = await readFile(targetPath, "utf8");
    const sections = protocolSectionsFrom(body);
    expect(sections).not.toBeNull();
    expect(readStamp(body).contentHash).toBe(protocolBlockHash(sections ?? ""));
  });

  it("does not move the date for an edit that changes no rendered text", async () => {
    captureStdout();
    await doRunProtocolSync({ config: configPath, target: targetPath });
    const before = readStamp(await readFile(targetPath, "utf8"));

    // Trailing whitespace is trimmed when the body is rendered, so this reaches
    // no session and must not be announced to one.
    await writeFile(sourcePath, "## Review protocol\n\nConsult before applying.\n\n\n");
    const out = captureStdout();
    await doRunProtocolSync({ config: configPath, target: targetPath });

    expect(readStamp(await readFile(targetPath, "utf8"))).toEqual(before);
    expect(joinCalls(out)).toContain("already up to date");
  });

  it("moves the date when the rendered text changes", async () => {
    captureStdout();
    await doRunProtocolSync({ config: configPath, target: targetPath });
    const before = readStamp(await readFile(targetPath, "utf8"));

    await writeFile(sourcePath, "## Review protocol\n\nConsult, then apply.\n");
    captureStdout();
    await doRunProtocolSync({ config: configPath, target: targetPath });
    const after = readStamp(await readFile(targetPath, "utf8"));

    expect(after.changedAt).not.toBe(before.changedAt);
    expect(after.contentHash).not.toBe(before.contentHash);
  });

  it("moves the date when a protocol is withdrawn, even though no source changed", async () => {
    const second = join(dir, "other.md");
    await writeFile(second, "## Other\n\nkeep this.\n");
    await writeFile(configPath, `protocols:\n  - source: ${sourcePath}\n  - source: ${second}\n`);
    captureStdout();
    await doRunProtocolSync({ config: configPath, target: targetPath });
    const before = readStamp(await readFile(targetPath, "utf8"));

    await writeFile(configPath, `protocols:\n  - source: ${sourcePath}\n`);
    captureStdout();
    await doRunProtocolSync({ config: configPath, target: targetPath });

    expect(readStamp(await readFile(targetPath, "utf8")).changedAt).not.toBe(before.changedAt);
  });

  it("carries nothing operator-authored onto the stamp line", async () => {
    captureStdout();
    await doRunProtocolSync({ config: configPath, target: targetPath });
    const line = (await readFile(targetPath, "utf8"))
      .split("\n")
      .find((l) => l.startsWith("<!-- basou:protocols"));
    expect(line).toBeDefined();
    expect(line).not.toContain(dir);
    expect(line).toContain("changed=");
    expect(line).toContain("content=");
  });

  it("leaves the date alone when an older stamp-less block already held the same text", async () => {
    // Every existing installation takes this path once. The rendered text is
    // identical, so no running session is owed an update -- the new stamp's
    // digest must match what a fresh render produces.
    captureStdout();
    await doRunProtocolSync({ config: configPath, target: targetPath });
    const stamped = await readFile(targetPath, "utf8");
    const sections = protocolSectionsFrom(stamped) ?? "";
    await writeFile(
      targetPath,
      `${PROTOCOL_START}\n<!-- old note -->\n\n${sections}\n${PROTOCOL_END}\n`,
    );

    captureStdout();
    await doRunProtocolSync({ config: configPath, target: targetPath });
    expect(readStamp(await readFile(targetPath, "utf8")).contentHash).toBe(
      protocolBlockHash(sections),
    );
  });
});
