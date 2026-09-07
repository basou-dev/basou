import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORIENTATION_END, ORIENTATION_START } from "@basou/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncOrientationChannel } from "../lib/context-channel.js";
import { doRunChannelClear, registerChannelCommand, runChannelClear } from "./channel.js";

let dir: string;
let target: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "basou-channel-cmd-"));
  // A stand-in for ~/.codex/AGENTS.md: every test overrides the locked path.
  target = join(dir, "AGENTS.md");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  process.exitCode = 0;
  vi.restoreAllMocks();
});

function capture(stream: "log" | "error"): string[] {
  const lines: string[] = [];
  vi.spyOn(console, stream).mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
  return lines;
}

describe("basou channel clear codex", () => {
  it("removes the orientation block and preserves the rest of the file", async () => {
    await writeFile(target, "# my own notes\n");
    await syncOrientationChannel({
      body: "# Orientation\n\nanother workspace's position\n",
      target,
    });
    const withBlock = await readFile(target, "utf8");
    expect(withBlock).toContain(ORIENTATION_START);

    const out = capture("log");
    const result = await doRunChannelClear("codex", { target });

    const after = await readFile(target, "utf8");
    expect(result).toMatchObject({ face: "codex", target, removed: true, dry_run: false });
    expect(after).not.toContain(ORIENTATION_START);
    expect(after).not.toContain(ORIENTATION_END);
    expect(after).not.toContain("another workspace's position");
    expect(after).toContain("# my own notes");
    expect(out.join("\n")).toContain(`Removed the basou:orientation block from ${target}`);
  });

  it("is a no-op that says so when the face carries no block", async () => {
    await writeFile(target, "# my own notes\n");

    const out = capture("log");
    const result = await doRunChannelClear("codex", { target });

    expect(result.removed).toBe(false);
    expect(await readFile(target, "utf8")).toBe("# my own notes\n");
    expect(out.join("\n")).toContain("Nothing to clear");
  });

  it("is a no-op on an absent face", async () => {
    const result = await doRunChannelClear("codex", { target, json: true });
    expect(result.removed).toBe(false);
  });

  it("--dry-run reports a removal without writing", async () => {
    await syncOrientationChannel({ body: "# Orientation\n\nx\n", target });
    const before = await readFile(target, "utf8");

    const out = capture("log");
    const result = await doRunChannelClear("codex", { target, dryRun: true });

    expect(result).toMatchObject({ removed: true, dry_run: true });
    expect(await readFile(target, "utf8")).toBe(before);
    expect(out.join("\n")).toContain("[dry-run] Would remove");
  });

  it("--json emits the result as the sole stdout line", async () => {
    await syncOrientationChannel({ body: "# Orientation\n\nx\n", target });

    const out = capture("log");
    await doRunChannelClear("codex", { target, json: true });

    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] ?? "{}")).toEqual({
      face: "codex",
      target,
      removed: true,
      dry_run: false,
    });
  });

  it("rejects an unknown face with a pointer to `protocol unsync`, exit code 1", async () => {
    const err = capture("error");
    await runChannelClear("claude", { target });

    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("Unknown face 'claude'");
    expect(err.join("\n")).toContain("basou protocol unsync");
  });

  it("registers `channel clear` on the program", () => {
    const program = new Command();
    registerChannelCommand(program);
    const channel = program.commands.find((c) => c.name() === "channel");
    expect(channel?.commands.map((c) => c.name())).toEqual(["clear"]);
  });
});
