import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { basouPaths } from "@basou/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { warnIfObservationsRefused } from "./observation-warn.js";

const CONSEQUENCE =
  "The files a session changes through the shell are not observed there, so a session imported now records only the files its transcript names.";

let dir: string | undefined;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "basou-observation-warn-")));
});

afterEach(async () => {
  if (dir !== undefined) {
    await chmod(join(dir, ".basou", "tmp"), 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
  dir = undefined;
  vi.restoreAllMocks();
});

function getDir(): string {
  if (dir === undefined) throw new Error("dir not initialized");
  return dir;
}

function printed(err: { mock: { calls: unknown[][] } }): string[] {
  return err.mock.calls.map((c) => String(c[0]));
}

describe.skipIf(process.platform === "win32")("warnIfObservationsRefused", () => {
  it("is silent when the store has no .basou/tmp, and when it is a plain directory", async () => {
    const paths = basouPaths(getDir());
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await warnIfObservationsRefused(paths);
    await mkdir(paths.observations, { recursive: true });
    await warnIfObservationsRefused(paths);

    expect(printed(err)).toEqual([]);
  });

  it("keeps a workspace path with control characters on one line", async () => {
    const root = join(getDir(), "ws-\n\u001b[31m-x");
    const paths = basouPaths(root);
    await mkdir(paths.root, { recursive: true });
    await symlink(join(root, "outside-tmp"), paths.tmp);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await warnIfObservationsRefused(paths);

    expect(printed(err)).toEqual([
      `basou: .basou/tmp is a symlink; refusing to operate (in ${getDir()}/ws-\\n\\x1b[31m-x). ${CONSEQUENCE}`,
    ]);
  });

  // An unreadable .basou/tmp cannot be checked; root reads it regardless.
  it.skipIf(process.getuid?.() === 0)(
    "says so when the directory cannot be inspected",
    async () => {
      const paths = basouPaths(getDir());
      await mkdir(paths.observations, { recursive: true });
      await chmod(paths.tmp, 0o000);
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await warnIfObservationsRefused(paths);

      expect(printed(err)).toEqual([
        `basou: Failed to inspect .basou/tmp/observations (in ${getDir()}). ${CONSEQUENCE}`,
      ]);
    },
  );
});
