import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BasouPaths, ensureBasouDirectory } from "../storage/basou-dir.js";
import { lostAmong } from "./sessions.js";

const SES = "ses_01HXABCDEF1234567890ABCLS1";
// Line 1 is not JSON and complete; line 2 is a torn last line, a write that
// has not finished, which is not counted as lost.
const BODY = '{"bad\n{"torn';

let root: string;
let paths: BasouPaths;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "basou-board-sessions-"));
  paths = await ensureBasouDirectory(root);
  await mkdir(join(paths.sessions, SES));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("lostAmong", () => {
  it("does not count a torn last line of a regular file", async () => {
    await writeFile(join(paths.sessions, SES, "events.jsonl"), BODY);
    expect(await lostAmong(paths, SES, [1, 2])).toBe(1);
  });

  it("counts every line when the log is missing", async () => {
    expect(await lostAmong(paths, SES, [1, 2])).toBe(2);
  });

  // POSIX only: symlinks need privileges on Windows, and it has no mkfifo.
  it.skipIf(process.platform === "win32")(
    "reads nothing through a symlink and does not wait on a FIFO: every line counts",
    async () => {
      // A reader that followed the link would find the torn line and count 1.
      const outside = join(root, "outside-events.jsonl");
      await writeFile(outside, BODY);
      await symlink(outside, join(paths.sessions, SES, "events.jsonl"));
      expect(await lostAmong(paths, SES, [1, 2])).toBe(2);
      await rm(join(paths.sessions, SES, "events.jsonl"));
      execFileSync("mkfifo", [join(paths.sessions, SES, "events.jsonl")]);
      expect(await lostAmong(paths, SES, [1, 2])).toBe(2);
    },
  );
});
