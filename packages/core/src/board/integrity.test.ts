import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChainVerdictStatus, verifyEventsChain } from "../events/verify.js";
import { type BasouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";
import { measureIntegrity } from "./integrity.js";

// Pass-through vi.fn wrapper so one test can return a status this build does
// not give; every other call delegates to the real verifier.
vi.mock("../events/verify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../events/verify.js")>();
  return { ...actual, verifyEventsChain: vi.fn(actual.verifyEventsChain) };
});

let root: string;
let paths: BasouPaths;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "basou-board-integrity-"));
  paths = await ensureBasouDirectory(root);
});

afterEach(async () => {
  vi.mocked(verifyEventsChain).mockReset();
  await rm(root, { recursive: true, force: true });
});

describe("measureIntegrity", () => {
  it("counts a status it does not list as it is, after the others, and as not verified", async () => {
    for (const id of ["ses_01HXABCDEF1234567890ABCS01", "ses_01HXABCDEF1234567890ABCS02"]) {
      await mkdir(join(paths.sessions, id));
    }
    vi.mocked(verifyEventsChain)
      .mockResolvedValueOnce({ status: "revoked" as ChainVerdictStatus, eventCount: 0 })
      .mockResolvedValueOnce({ status: "revoked" as ChainVerdictStatus, eventCount: 0 });
    const { integrity, notFound } = await measureIntegrity(paths);
    expect(integrity.by_status).toEqual({
      verified: 0,
      unchained: 0,
      empty: 0,
      incomplete: 0,
      in_progress: 0,
      unsupported: 0,
      tampered: 0,
      revoked: 2,
    });
    expect(Object.keys(integrity.by_status ?? {}).at(-1)).toBe("revoked");
    expect(integrity.not_verified).toBe(2);
    expect(notFound).toEqual([]);
  });
});
