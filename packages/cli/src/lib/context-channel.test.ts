import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORIENTATION_END, ORIENTATION_START, PROTOCOL_END, PROTOCOL_START } from "@basou/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeMarkerBlock, syncMarkerBlock, syncOrientationChannel } from "./context-channel.js";

let dir: string;
let target: string;

const PROTOCOL_MARKERS = { start: PROTOCOL_START, end: PROTOCOL_END };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "basou-channel-test-"));
  target = join(dir, "AGENTS.md");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("syncOrientationChannel", () => {
  it("installs the orientation block in an absent target", async () => {
    const res = await syncOrientationChannel({ body: "# Orientation\n\nyou are here", target });
    expect(res.action).toBe("installed");
    const body = await readFile(target, "utf8");
    expect(body.startsWith(ORIENTATION_START)).toBe(true);
    expect(body).toContain(ORIENTATION_END);
    expect(body).toContain("Managed by basou");
    expect(body).toContain("you are here");
  });

  it("reports unchanged when the body is identical on re-sync", async () => {
    await syncOrientationChannel({ body: "same body", target });
    const res = await syncOrientationChannel({ body: "same body", target });
    expect(res.action).toBe("unchanged");
  });

  it("updates in place (one block) when the body changes", async () => {
    await syncOrientationChannel({ body: "first", target });
    const res = await syncOrientationChannel({ body: "second position", target });
    expect(res.action).toBe("updated");
    const body = await readFile(target, "utf8");
    expect(body.split(ORIENTATION_START).length - 1).toBe(1); // exactly one block
    expect(body).toContain("second position");
    expect(body).not.toContain("first");
  });

  it("appends without disturbing a pre-existing protocol block", async () => {
    // Codex's AGENTS.md may already carry the protocol block; the orientation
    // block must coexist with it (independent markers).
    await syncMarkerBlock({ target, markers: PROTOCOL_MARKERS, block: "protocol rules\n" });
    await syncOrientationChannel({ body: "where am I", target });
    const body = await readFile(target, "utf8");
    expect(body).toContain(PROTOCOL_START);
    expect(body).toContain(ORIENTATION_START);
    expect(body).toContain("protocol rules");
    expect(body).toContain("where am I");
    // Re-syncing orientation leaves the protocol block byte-identical.
    const before = await readFile(target, "utf8");
    await syncOrientationChannel({ body: "moved on", target });
    const after = await readFile(target, "utf8");
    const protoBefore = before.slice(before.indexOf(PROTOCOL_START), before.indexOf(PROTOCOL_END));
    const protoAfter = after.slice(after.indexOf(PROTOCOL_START), after.indexOf(PROTOCOL_END));
    expect(protoAfter).toBe(protoBefore);
  });

  it("refuses a body that contains a marker line", async () => {
    await expect(
      syncOrientationChannel({ body: `prose\n${ORIENTATION_START}\nx`, target }),
    ).rejects.toThrow(/marker line/);
  });

  it("refuses a symlinked target", async () => {
    const real = join(dir, "real.md");
    await writeFile(real, "x\n");
    await symlink(real, target);
    await expect(syncOrientationChannel({ body: "x", target })).rejects.toThrow(/symlink/);
  });

  it("does not write under dry-run", async () => {
    const res = await syncOrientationChannel({ body: "x", target, dryRun: true });
    expect(res.action).toBe("installed");
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("backs up the original once on first modification", async () => {
    await writeFile(target, "# pre-existing AGENTS.md\n");
    await syncOrientationChannel({ body: "first", target });
    expect(await readFile(`${target}.basou-bak`, "utf8")).toBe("# pre-existing AGENTS.md\n");
    // A later sync does not overwrite the one-time backup.
    await syncOrientationChannel({ body: "second", target });
    expect(await readFile(`${target}.basou-bak`, "utf8")).toBe("# pre-existing AGENTS.md\n");
  });
});

describe("syncMarkerBlock", () => {
  it("refuses a malformed block (only an end marker present)", async () => {
    await writeFile(target, `body\n${ORIENTATION_END}\n`);
    await expect(syncOrientationChannel({ body: "x", target })).rejects.toThrow(/malformed/);
  });

  it("returns updated when a block already exists, installed otherwise", async () => {
    const first = await syncMarkerBlock({
      target,
      markers: PROTOCOL_MARKERS,
      block: "a\n",
    });
    expect(first.action).toBe("installed");
    const second = await syncMarkerBlock({
      target,
      markers: PROTOCOL_MARKERS,
      block: "b\n",
    });
    expect(second.action).toBe("updated");
  });
});

describe("removeMarkerBlock", () => {
  it("is a no-op (removed=false) on an absent target", async () => {
    const res = await removeMarkerBlock({
      target,
      markers: PROTOCOL_MARKERS,
      fileLabel: "AGENTS.md",
    });
    expect(res.removed).toBe(false);
  });

  it("removes the block and preserves surrounding content", async () => {
    await writeFile(target, "# keep me\n\n");
    await syncMarkerBlock({ target, markers: PROTOCOL_MARKERS, block: "transient\n" });
    const res = await removeMarkerBlock({
      target,
      markers: PROTOCOL_MARKERS,
      fileLabel: "AGENTS.md",
    });
    expect(res.removed).toBe(true);
    const body = await readFile(target, "utf8");
    expect(body).toContain("# keep me");
    expect(body).not.toContain(PROTOCOL_START);
  });

  it("is a no-op (removed=false) when the target has no block", async () => {
    await writeFile(target, "# no block\n");
    const res = await removeMarkerBlock({
      target,
      markers: PROTOCOL_MARKERS,
      fileLabel: "AGENTS.md",
    });
    expect(res.removed).toBe(false);
  });
});
