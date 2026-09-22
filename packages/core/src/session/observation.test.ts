import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  observedFileFrom,
  observedFilesOf,
  readSessionObservation,
  SESSION_OBSERVATION_SCHEMA_VERSION,
  type SessionObservation,
  sessionObservationPath,
  writeSessionObservation,
} from "./observation.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "basou-observation-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function observation(overrides: Partial<SessionObservation> = {}): SessionObservation {
  return {
    schema_version: SESSION_OBSERVATION_SCHEMA_VERSION,
    external_id: "d9630a63-54c1-47d0-bc6f-8d840446433e",
    started_at: "2026-09-22T10:00:00.000Z",
    updated_at: "2026-09-22T10:30:00.000Z",
    repos: [
      {
        path: "/repo",
        base_head: "a".repeat(40),
        base_dirty: [],
        files: [{ path: "/repo/src/a.ts", change_type: "modified" }],
      },
    ],
    ...overrides,
  };
}

describe("sessionObservationPath", () => {
  it("names a file inside the directory for an ordinary vendor id", () => {
    expect(sessionObservationPath(dir, "abc-123_ID.4")).toBe(join(dir, "abc-123_ID.4.json"));
  });

  it.each([
    ["a separator", "a/b"],
    ["a parent segment", ".."],
    ["a leading dot", ".hidden"],
    ["an absolute path", "/etc/passwd"],
    ["an empty id", ""],
    ["a control character", `a${String.fromCharCode(0)}b`],
    ["an id longer than the cap", "a".repeat(129)],
  ])("refuses %s rather than escaping it", (_label, id) => {
    expect(sessionObservationPath(dir, id)).toBeNull();
  });
});

describe("readSessionObservation", () => {
  it("round-trips what was written", async () => {
    const written = observation();
    await writeSessionObservation(dir, written);
    expect(await readSessionObservation(dir, written.external_id)).toEqual(written);
  });

  it("returns null when nothing was written", async () => {
    expect(await readSessionObservation(dir, "missing-id")).toBeNull();
  });

  it("returns null for an unsafe id without touching disk", async () => {
    expect(await readSessionObservation(dir, "../escape")).toBeNull();
  });

  it("returns null for malformed JSON rather than throwing", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "broken.json"), "{ not json");
    expect(await readSessionObservation(dir, "broken")).toBeNull();
  });

  it("returns null for a shape it cannot trust", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "wrong.json"), JSON.stringify({ external_id: 42 }));
    expect(await readSessionObservation(dir, "wrong")).toBeNull();
  });

  it("returns null for a version it does not understand", async () => {
    await writeSessionObservation(dir, observation({ schema_version: "9.9.9" }));
    expect(await readSessionObservation(dir, observation().external_id)).toBeNull();
  });
});

describe("writeSessionObservation", () => {
  it("creates the directory, so a store initialized before observations still works", async () => {
    const nested = join(dir, "deep", "observations");
    await writeSessionObservation(nested, observation());
    expect(await readSessionObservation(nested, observation().external_id)).not.toBeNull();
  });

  it("writes nothing for an unsafe id", async () => {
    await writeSessionObservation(dir, observation({ external_id: "../escape" }));
    await expect(readFile(join(dir, "..", "escape.json"), "utf8")).rejects.toThrow();
  });
});

describe("observedFilesOf", () => {
  it("flattens every repository into one path-ordered list", () => {
    const flat = observedFilesOf(
      observation({
        repos: [
          {
            path: "/b",
            base_head: null,
            base_dirty: [],
            files: [{ path: "/b/z.ts", change_type: "added" }],
          },
          {
            path: "/a",
            base_head: null,
            base_dirty: [],
            files: [{ path: "/a/y.ts", change_type: "deleted" }],
          },
        ],
      }),
    );
    expect(flat.map((f) => f.path)).toEqual(["/a/y.ts", "/b/z.ts"]);
  });
});

describe("observedFileFrom", () => {
  it("makes the repo-relative path absolute, old path included", () => {
    expect(
      observedFileFrom("/repo", { path: "b.ts", status: "renamed", old_path: "a.ts" }),
    ).toEqual({ path: "/repo/b.ts", change_type: "renamed", old_path: "/repo/a.ts" });
  });
});
