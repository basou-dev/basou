import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureBasouDirectory, readManifest } from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BasouSdkError, SessionStoreUnsafeError } from "./errors.js";
import { openWorkspace } from "./workspace.js";

// Wrap readManifest in a pass-through vi.fn so a test can make it fail the way
// core's store check does. `manifest` and `status` check no store today, so a
// failure injected on their path is the only way to see that they are guarded
// too; every other call delegates to the real implementation.
vi.mock("@basou/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@basou/core")>();
  return { ...actual, readManifest: vi.fn(actual.readManifest) };
});

const REFUSAL = ".basou/sessions is a symlink; refusing to operate";

let root: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "basou-sdk-guard-test-"));
});

afterEach(async () => {
  if (root !== undefined) {
    await rm(root, { recursive: true, force: true });
    root = undefined;
  }
  vi.clearAllMocks();
});

describe("the reads that check no store today", () => {
  it.each(["manifest", "status"] as const)(
    "%s retypes a store refusal that core comes to throw on its path",
    async (name) => {
      if (root === undefined) throw new Error("root not initialized");
      await ensureBasouDirectory(root);
      const ws = await openWorkspace(root);
      vi.mocked(readManifest).mockRejectedValueOnce(new Error(REFUSAL));
      const thrown = await ws[name]().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(thrown).toBeInstanceOf(SessionStoreUnsafeError);
      expect((thrown as SessionStoreUnsafeError).message).toBe(REFUSAL);
      expect((thrown as SessionStoreUnsafeError).cause).not.toBeInstanceOf(BasouSdkError);
    },
  );
});
